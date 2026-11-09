/*
 * MIDAS pre-check — Intellectum Lab
 *
 * Checks CASP submission files against the rules ESMA published in the MIDAS
 * Reporting Instructions (ESMA65-955014868-17690, 21 October 2026) and the
 * official JSON schemas from ESMA65-955014868-15160 (auth.117 / auth.118).
 *
 * Runs entirely where it is loaded: in the browser nothing is uploaded, in
 * Node it reads local files. It is our reading of public rules, not ESMA's
 * validator — codes that are ours, not ESMA's, start with "PRE-".
 *
 * Usage: MidasPrecheck.create(ajvInstanceFactory, {auth117, auth118})
 *        .checkFiles([{name, size, text}]) -> {files: [...], rows: [...]}
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MidasPrecheck = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FILE_TYPES = {
    CryptoAssetRecordKeeping: { root: 'CrptAsstRcrdKeepgRpt', schema: 'auth117', kind: 'executions' },
    CryptoAssetOrderBook: { root: 'CrptAsstOrdrBookRpt', schema: 'auth118', kind: 'orderbook' }
  };
  var NAME_RE = /^(CryptoAssetRecordKeeping|CryptoAssetOrderBook)_(\d{2})(\d{2})(\d{4})_(\d+)_(\d+)\.json$/;
  var MAX_BYTES = 500 * 1024 * 1024;
  var FILLED = { FILL: 1, PARF: 1 };
  var CANCELLED = { CAME: 1, CAMO: 1 };
  // ISO 24165 DTI: 9 characters, digits and consonants (no vowels)
  var DTI_RE = /^[0-9B-DF-HJ-NP-TV-Z]{9}$/;
  var MIC_RE = /^[A-Z0-9]{4}$/;
  // ESMA does not publish the midnight threshold (QUA-008); this one is ours
  var MIDNIGHT_SHARE = 0.05;

  var EXEC = '/Document/CrptAsstRcrdKeepgRpt/Tx/New';
  var OB = '/Document/CrptAsstOrdrBookRpt/OrdrRpt/New/Ordr';

  function get(obj, path) {
    var parts = path.split('.');
    for (var i = 0; i < parts.length; i++) {
      if (obj === null || obj === undefined) return undefined;
      obj = obj[parts[i]];
    }
    return obj;
  }

  function empty(v) {
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  }

  function num(v) {
    if (empty(v)) return NaN;
    return Number(v);
  }

  function asList(v) {
    if (v === undefined || v === null) return [];
    return Array.isArray(v) ? v : [v];
  }

  // "2026-05-21T00:03:47.549" -> "9999-99-99T99:99:99.999"
  function mask(ts) {
    return String(ts).replace(/\d/g, '9');
  }

  function hasMillis(ts) {
    return /[ T]\d{2}:\d{2}:\d{2}\.\d{3,}/.test(String(ts));
  }

  function isMidnight(ts) {
    return /[ T]00:00:00(\.0+)?Z?$/.test(String(ts));
  }

  function parseTs(ts) {
    var s = String(ts).replace(' ', 'T');
    if (!/Z$|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
    var t = Date.parse(s);
    return isNaN(t) ? null : t;
  }

  function checkName(name) {
    var m = NAME_RE.exec(name);
    if (!m) return null;
    var d = +m[2], mo = +m[3], y = +m[4], n = +m[5], total = +m[6];
    var date = new Date(Date.UTC(y, mo - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
    if (n < 1 || total < 1 || n > total) return null;
    return { fileType: m[1], date: m[2] + m[3] + m[4], partN: n, partM: total };
  }

  function create(makeAjv, schemas) {
    var validators = {};
    function validator(key) {
      if (!validators[key]) {
        var ajv = makeAjv();
        validators[key] = ajv.compile(schemas[key]);
      }
      return validators[key];
    }

    function checkFiles(files) {
      var now = new Date().toISOString().replace('Z', '');
      var rows = [];
      var results = [];
      var sets = {};

      files.forEach(function (f) {
        var res = checkOne(f, now);
        results.push(res);
        rows = rows.concat(res.rows);
        if (res.meta) {
          var key = res.meta.fileType + '_' + res.meta.date;
          (sets[key] = sets[key] || []).push(res.meta);
        }
      });

      // Incomplete multi-part submissions (ESMA's own example: parts 1 and 3 of 3)
      Object.keys(sets).forEach(function (key) {
        var parts = sets[key];
        var totals = {};
        parts.forEach(function (p) { totals[p.partM] = 1; });
        var declared = Math.max.apply(null, parts.map(function (p) { return p.partM; }));
        var have = {};
        parts.forEach(function (p) { have[p.partN] = 1; });
        var missing = [];
        for (var i = 1; i <= declared; i++) if (!have[i]) missing.push(i);
        if (Object.keys(totals).length > 1 || missing.length) {
          rows.push(row(now, '-', key + '_*.json', 'TRANSMISSION_FILE_VALIDATION', '-', '', 'WARNING',
            'PRE-101', 'INCOMPLETE_SUBMISSION', 'WARNING', 'partN/partM', '-',
            missing.length ? 'missing parts: ' + missing.join(', ') : 'partM differs between files',
            'The set for ' + key + ' declares ' + declared + ' part(s) but ' +
              (missing.length ? 'parts ' + missing.join(', ') + ' are not in this check' : 'the files disagree on the total') + '.',
            'Submit every part of the set, numbered 1..M with the same M.'));
        }
      });

      return { files: results, rows: rows };
    }

    function checkOne(f, now) {
      var out = { name: f.name, verdict: 'PROCESSED', records: 0, rejected: 0, warnings: 0, rows: [], meta: null };
      var lei = '-';
      function fileReject(code, label, field, value, reason, action) {
        out.verdict = 'REJECTED';
        out.rows.push(row(now, lei, f.name, 'TRANSMISSION_FILE_VALIDATION', 'REJECTED', '', 'FILE_REJECTED',
          code, label, 'FILE_REJECTION', field, '-', value, reason, action || 'Correct the file and resubmit it in full.'));
      }

      var meta = checkName(f.name);
      if (!meta) {
        fileReject('FIL-101', 'FILE_NAMING_CONVENTION', 'SubmittedFileName', f.name,
          'File name does not match <FileType>_<DateDDMMYYYY>_<partN>_<partM>.json (FileType CryptoAssetRecordKeeping or CryptoAssetOrderBook, a real date, 1 <= partN <= partM, .json extension).',
          'Correct the file name and resubmit the file in full.');
        return out;
      }
      out.meta = meta;
      if (f.size > MAX_BYTES) {
        fileReject('PRE-102', 'FILE_SIZE', 'size', String(f.size),
          'Each JSON file must not exceed 500 MB; larger datasets must be split into parts.',
          'Split the data into parts under 500 MB and renumber partN/partM.');
        return out;
      }

      var doc;
      try {
        doc = JSON.parse(f.text);
      } catch (e) {
        fileReject('FIL-102', 'FILE_SCHEMA_CONFORMANCE', '-', '-',
          'Not valid JSON: ' + e.message + '. A malformed file is rejected and no records are processed.');
        return out;
      }

      var type = FILE_TYPES[meta.fileType];
      if (!doc || !doc.Document || !doc.Document[type.root]) {
        var other = doc && doc.Document ? Object.keys(doc.Document).join(', ') : 'none';
        fileReject('FIL-102', 'FILE_SCHEMA_CONFORMANCE', 'Document', other,
          meta.fileType + ' files must contain Document/' + type.root + '; found: ' + other + '.');
        return out;
      }

      var report = doc.Document[type.root];
      lei = get(report, 'RptHdr.RptgNtty.LEI') || '-';

      var validate = validator(type.schema);
      if (!validate(doc)) {
        // anyOf/oneOf branches produce generic parent errors ("must be array",
        // "must match a schema in anyOf"); keep only the most specific ones
        var errs = validate.errors.filter(function (e) {
          if (['type', 'anyOf', 'oneOf', 'if'].indexOf(e.keyword) === -1) return true;
          return !validate.errors.some(function (o) {
            return o !== e && o.instancePath.indexOf(e.instancePath + '/') === 0;
          });
        }).filter(function (e) { return e.keyword !== 'anyOf' && e.keyword !== 'oneOf'; });
        if (!errs.length) errs = validate.errors;
        validate.errors = errs;
        validate.errors.slice(0, 50).forEach(function (e) {
          var reason = 'JSON Schema validation failure (' + type.schema + '): ' + e.message +
            (e.params && e.params.allowedValues ? ' [' + e.params.allowedValues.join(', ') + ']' : '') +
            (e.params && e.params.additionalProperty ? ' (' + e.params.additionalProperty + ')' : '') + '.';
          fileReject('FIL-102', 'FILE_SCHEMA_CONFORMANCE', '-', e.instancePath || '/', reason);
        });
        if (validate.errors.length > 50) {
          fileReject('FIL-102', 'FILE_SCHEMA_CONFORMANCE', '-', '-',
            (validate.errors.length - 50) + ' more schema errors not listed.');
        }
        return out;
      }

      var ctx = { now: now, lei: lei, file: f.name, out: out, rejected: {} };
      if (type.kind === 'executions') checkExecutions(report, ctx);
      else checkOrderBook(report, ctx);
      out.rejected = Object.keys(ctx.rejected).length;
      return out;
    }

    return { checkFiles: checkFiles, checkName: checkName };
  }

  function addRecordRow(ctx, ref, idx, outcome, code, label, field, path, value, reason) {
    var warn = outcome === 'WARNING';
    if (warn) ctx.out.warnings++;
    else if (idx !== null) ctx.rejected[idx] = 1;
    ctx.out.rows.push(row(ctx.now, ctx.lei, ctx.file, 'RECORD_CONTENT_VALIDATION', 'PROCESSED',
      ref, outcome, code, label, warn ? 'WARNING' : 'REJECTION', field, path,
      value === undefined || value === null ? '' : String(value), reason,
      warn ? 'Review; a warning does not reject the record.' :
        'Correct the record at source and resubmit only the corrected record in the next submission.'));
  }

  function timestampRules(ctx, items, field, path, label) {
    // MET-006: one configured mask per file, with sub-second precision.
    // ESMA configures the mask per CASP; we take the file's most common mask.
    var counts = {};
    items.forEach(function (it) { if (!empty(it.v)) counts[mask(it.v)] = (counts[mask(it.v)] || 0) + 1; });
    var top = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
    items.forEach(function (it) {
      if (empty(it.v)) return;
      if (!hasMillis(it.v)) {
        addRecordRow(ctx, it.ref, it.idx, 'REJECTED', 'MET-006', 'TIMESTAMP_SCHEMA_MISMATCH', label, path, it.v,
          label + ' drops sub-second precision; MIDAS expects milliseconds (e.g. YYYY-MM-DD HH:mm:ss.fff).');
      } else if (mask(it.v) !== top) {
        addRecordRow(ctx, it.ref, it.idx, 'REJECTED', 'MET-006', 'TIMESTAMP_SCHEMA_MISMATCH', label, path, it.v,
          label + ' format differs from the rest of the file (' + top.replace(/9/g, '0') + ').');
      }
    });
  }

  function midnightRule(ctx, values, label, path) {
    var vals = values.filter(function (v) { return !empty(v); });
    if (!vals.length) return;
    var n = vals.filter(isMidnight).length;
    if (n / vals.length > MIDNIGHT_SHARE) {
      addRecordRow(ctx, '', null, 'WARNING', 'QUA-008', 'MIDNIGHT_TIMESTAMPS', label, path,
        n + ' of ' + vals.length,
        Math.round(100 * n / vals.length) + '% of ' + label + ' values are exactly midnight, which suggests a defaulting issue upstream. ESMA does not publish its threshold; this check flags above ' + (MIDNIGHT_SHARE * 100) + '%.');
    }
  }

  function priceJumps(ctx, series, label, path) {
    // QUA-005: isolated print >= +1,000% away from both neighbours that agree with each other
    Object.keys(series).forEach(function (key) {
      var s = series[key].filter(function (x) { return x.p > 0 && x.t !== null; })
        .sort(function (a, b) { return a.t - b.t; });
      function far(a, b) { return Math.max(a, b) / Math.min(a, b) >= 11; }
      for (var i = 1; i < s.length - 1; i++) {
        var a = s[i - 1].p, b = s[i].p, c = s[i + 1].p;
        if (far(a, b) && far(b, c) && !far(a, c)) {
          addRecordRow(ctx, s[i].ref, null, 'WARNING', 'QUA-005', 'PRICE_DISCREPANCY', label, path, b,
            'Price ' + b + ' differs by 1,000% or more from both neighbours (' + a + ', ' + c + ') under ' + key + '.');
        }
      }
    });
  }

  function checkExecutions(report, ctx) {
    var txs = asList(report.Tx);
    var seen = {};
    var ts = [], series = {};
    ctx.out.records = txs.length;
    txs.forEach(function (tx, idx) {
      var n = tx.New;
      if (!n) return;
      var r = {
        tradDt: get(n, 'Tx.TradDt'),
        rcrdId: get(n, 'TxRcrdId'),
        mtchgId: get(n, 'Tx.TradPlcMtchgId'),
        venue: get(n, 'Tx.TradVn'),
        qty: get(n, 'Tx.Qty.DgtlTknQty.Unit'),
        price: get(n, 'Tx.Pric.DgtlTknPric.DgtlTknQty.Unit'),
        ccy: get(n, 'Tx.Pric.DgtlTknPric.DgtlTknQty.Idr.DTIShrtNm') || get(n, 'Tx.Pric.DgtlTknPric.DgtlTknQty.Idr.DTI'),
        dti: get(n, 'CrptAsst.DgtlTknIdr.DTI')
      };
      var ref = r.rcrdId || r.mtchgId || ('#' + (idx + 1));
      var req = [
        ['tradDt', 'Trading date time', EXEC + '/Tx/TradDt'],
        ['rcrdId', 'Transaction Record Number', EXEC + '/TxRcrdId'],
        ['mtchgId', 'Trading platform for crypto-asset transaction identification code', EXEC + '/Tx/TradPlcMtchgId'],
        ['ccy', 'Price currency', EXEC + '/Tx/Pric/DgtlTknPric/DgtlTknQty/Idr/DTIShrtNm'],
        ['dti', 'Crypto Asset Identification Code', EXEC + '/CrptAsst/DgtlTknIdr/DTI'],
        ['qty', 'Quantity', EXEC + '/Tx/Qty/DgtlTknQty/Unit'],
        ['price', 'Price', EXEC + '/Tx/Pric/DgtlTknPric/DgtlTknQty/Unit'],
        ['venue', 'Trading platform for crypto-asset', EXEC + '/Tx/TradVn']
      ];
      req.forEach(function (q) {
        if (empty(r[q[0]])) addRecordRow(ctx, ref, idx, 'REJECTED', 'MET-001', 'FIELD_MANDATORY_MISSING', q[1], q[2], '',
          'Missing required field: ' + q[1] + '.');
      });
      if (!n.Buyr && !n.Sellr) {
        addRecordRow(ctx, ref, idx, 'REJECTED', 'MET-001', 'FIELD_MANDATORY_MISSING', 'Buyer / Seller identification code',
          EXEC + '/Buyr|Sellr', '', 'At least the buyer leg or the seller leg must be reported.');
      }
      [['qty', 'Quantity', EXEC + '/Tx/Qty/DgtlTknQty/Unit'], ['price', 'Price', EXEC + '/Tx/Pric/DgtlTknPric/DgtlTknQty/Unit']]
        .forEach(function (q) {
          if (!empty(r[q[0]]) && !(num(r[q[0]]) > 0)) addRecordRow(ctx, ref, idx, 'REJECTED', 'MET-004',
            'VALUE_NOT_POSITIVE', q[1], q[2], r[q[0]], q[1] + ' must be strictly greater than zero.');
        });
      if (!empty(r.rcrdId) && String(r.rcrdId).length > 52) addRecordRow(ctx, ref, idx, 'WARNING', 'QUA-001', 'FIELD_LENGTH',
        'Transaction Record Number', EXEC + '/TxRcrdId', r.rcrdId, 'Longer than 52 characters.');
      if (!empty(r.mtchgId) && String(r.mtchgId).length > 52) addRecordRow(ctx, ref, idx, 'WARNING', 'QUA-001', 'FIELD_LENGTH',
        'Trading platform transaction identification code', EXEC + '/Tx/TradPlcMtchgId', r.mtchgId, 'Longer than 52 characters.');
      if (!empty(r.venue) && r.venue !== 'XOFF' && r.venue !== 'XXXX' && !MIC_RE.test(r.venue)) addRecordRow(ctx, ref, idx,
        'WARNING', 'QUA-002', 'INVALID_MIC', 'Trading platform for crypto-asset', EXEC + '/Tx/TradVn', r.venue,
        'Not a 4-character MIC. (This page checks the format only, not the ISO 10383 list.)');
      if (!empty(r.dti) && !DTI_RE.test(r.dti)) addRecordRow(ctx, ref, idx, 'WARNING', 'QUA-003', 'INVALID_DTI',
        'Crypto Asset Identification Code', EXEC + '/CrptAsst/DgtlTknIdr/DTI', r.dti,
        'Not a well-formed ISO 24165 DTI. (Format only; the DTI registry is not queried.)');

      var key = [r.venue, r.rcrdId, r.mtchgId, r.tradDt].join('|');
      if (seen[key] !== undefined) addRecordRow(ctx, ref, idx, 'REJECTED', 'MET-005', 'DUPLICATE_RECORD', 'Record key',
        EXEC, key, 'Duplicate of record #' + (seen[key] + 1) + ' (Trading platform + Transaction Record Number + transaction identification code + Trading date time). The first record is accepted, later ones are rejected.');
      else seen[key] = idx;

      ts.push({ v: r.tradDt, ref: ref, idx: idx });
      var sk = (r.ccy || '?') + ' @ ' + (r.venue || '?');
      (series[sk] = series[sk] || []).push({ p: num(r.price), t: parseTs(r.tradDt), ref: ref });
    });
    timestampRules(ctx, ts, 'Trading date time', EXEC + '/Tx/TradDt', 'Trading date time');
    midnightRule(ctx, ts.map(function (x) { return x.v; }), 'Trading date time', EXEC + '/Tx/TradDt');
    priceJumps(ctx, series, 'Price', EXEC + '/Tx/Pric/DgtlTknPric/DgtlTknQty/Unit');
  }

  function checkOrderBook(report, ctx) {
    var orders = [];
    asList(report.OrdrRpt).forEach(function (rpt) {
      asList(rpt && rpt.New).forEach(function (nw) { orders = orders.concat(asList(nw && nw.Ordr)); });
    });
    ctx.out.records = orders.length;
    var seen = {};
    var tsAll = [], series = {};
    var ids = {}, cancelledIds = {}, buys = 0, sides = 0;

    orders.forEach(function (o, idx) {
      var r = {
        tm: get(o, 'OrdrIdData.TmStmp'),
        oid: get(o, 'OrdrIdData.OrdrId'),
        st: get(o, 'OrdrIdData.EvtTp.Cd'),
        vp: get(o, 'OrdrIdData.VldtyPrd.VldtyPrdCd'),
        vdt: get(o, 'OrdrIdData.VldtyDtTm'),
        mic: get(o, 'OrdrIdData.TradVn'),
        txid: get(o, 'OrdrData.TxData.TxId'),
        tq: get(o, 'OrdrData.TxData.TraddQty.DgtlTknQty.Unit'),
        tp: get(o, 'OrdrData.TxData.TxPric.DgtlTknPric.DgtlTknQty.Unit'),
        pa: get(o, 'OrdrData.TxData.PssvOrAggrssvInd'),
        otype: get(o, 'OrdrData.OrdrClssfctn.OrdrTpClssfctn'),
        side: get(o, 'OrdrData.InstrData.BuySellInd'),
        iq: get(o, 'OrdrData.InstrData.InitlQty.DgtlTknQty.Unit'),
        rq: get(o, 'OrdrData.InstrData.RmngQty.DgtlTknQty.Unit'),
        lp: get(o, 'OrdrData.OrdrPrics.LmtPric.DgtlTknPric.DgtlTknQty.Unit'),
        pccy: get(o, 'OrdrData.OrdrPrics.LmtPric.DgtlTknPric.DgtlTknQty.Idr.DTIShrtNm')
      };
      var ref = (r.oid || '#' + (idx + 1)) + (r.st ? ' ' + r.st : '');
      var filled = !!FILLED[r.st];
      var P = {
        tm: OB + '/OrdrIdData/TmStmp', oid: OB + '/OrdrIdData/OrdrId', st: OB + '/OrdrIdData/EvtTp/Cd',
        vp: OB + '/OrdrIdData/VldtyPrd/VldtyPrdCd', vdt: OB + '/OrdrIdData/VldtyDtTm', mic: OB + '/OrdrIdData/TradVn',
        txid: OB + '/OrdrData/TxData/TxId', tq: OB + '/OrdrData/TxData/TraddQty/DgtlTknQty/Unit',
        tp: OB + '/OrdrData/TxData/TxPric/DgtlTknPric/DgtlTknQty/Unit', pa: OB + '/OrdrData/TxData/PssvOrAggrssvInd',
        otype: OB + '/OrdrData/OrdrClssfctn/OrdrTpClssfctn', side: OB + '/OrdrData/InstrData/BuySellInd',
        iq: OB + '/OrdrData/InstrData/InitlQty/DgtlTknQty/Unit', rq: OB + '/OrdrData/InstrData/RmngQty/DgtlTknQty/Unit',
        lp: OB + '/OrdrData/OrdrPrics/LmtPric/DgtlTknPric/DgtlTknQty/Unit'
      };
      function rej(code, label, field, key, value, reason) { addRecordRow(ctx, ref, idx, 'REJECTED', code, label, field, P[key], value, reason); }
      function warn(code, label, field, key, value, reason) { addRecordRow(ctx, ref, idx, 'WARNING', code, label, field, P[key], value, reason); }

      [['tm', 'Date and time'], ['oid', 'Order identification code'], ['st', 'Status'], ['otype', 'Order type classification'],
        ['side', 'Buy-sell indicator'], ['iq', 'Initial quantity'], ['vp', 'Validity period']].forEach(function (q) {
        if (empty(r[q[0]])) rej('MET-001', 'FIELD_MANDATORY_MISSING', q[1], q[0], '', 'Missing required field: ' + q[1] + '.');
      });

      if (!empty(r.iq) && !(num(r.iq) > 0)) rej('MET-004', 'VALUE_NOT_POSITIVE', 'Initial quantity', 'iq', r.iq, 'Initial quantity must be strictly greater than zero.');
      if (!empty(r.lp) && !(num(r.lp) > 0)) rej('MET-004', 'VALUE_NOT_POSITIVE', 'Limit price', 'lp', r.lp, 'Limit price must be strictly greater than zero.');

      if (r.vp === 'GTDV' && empty(r.vdt)) rej('MET-007', 'VALIDITY_TIME_MISSING', 'Validity period and time', 'vdt', '', 'Validity period is GTDV, so Validity period and time is mandatory.');
      if (!empty(r.vdt) && !empty(r.tm)) {
        var a = parseTs(r.tm), b = parseTs(r.vdt);
        if (a !== null && b !== null && !(b > a)) rej('MET-008', 'VALIDITY_BEFORE_EVENT', 'Validity period and time', 'vdt', r.vdt,
          'Validity period and time (' + r.vdt + ') must be after Date and time (' + r.tm + ').');
      }

      if (filled) {
        if (empty(r.txid)) rej('MET-009', 'FILL_WITHOUT_TRANSACTION', 'Transaction identification code', 'txid', '', 'Status is ' + r.st + ', so Transaction identification code must be populated.');
        if (empty(r.rq)) rej('MET-009', 'FILL_WITHOUT_TRANSACTION', 'Remaining quantity', 'rq', '', 'Status is ' + r.st + ', so Remaining quantity must be populated.');
        if (empty(r.tq)) rej('MET-009', 'FILL_WITHOUT_TRANSACTION', 'Traded quantity', 'tq', '', 'Status is ' + r.st + ', so Traded quantity must be populated.');
      } else if (!empty(r.txid)) {
        rej('MET-010', 'TRANSACTION_ON_NON_FILL', 'Transaction identification code', 'txid', r.txid, 'Status is ' + (r.st || 'empty') + ', so Transaction identification code must be empty.');
      }

      if (empty(r.txid)) {
        if (!empty(r.tq)) rej('MET-011', 'TRADE_FIELDS_WITHOUT_TRANSACTION', 'Traded quantity', 'tq', r.tq, 'Traded quantity must be empty when Transaction identification code is not populated.');
        if (!empty(r.tp)) rej('MET-011', 'TRADE_FIELDS_WITHOUT_TRANSACTION', 'Transaction price', 'tp', r.tp, 'Transaction price must be empty when Transaction identification code is not populated.');
        if (!empty(r.mic)) warn('QUA-006', 'MIC_WITHOUT_TRANSACTION', 'Segment MIC', 'mic', r.mic, 'Segment MIC should be empty when Transaction identification code is not populated (warning under QUA-006; MET-011 lists Segment MIC but rejects only on traded quantity and price).');
      } else {
        if (!empty(r.tq) && !empty(r.iq) && !(num(r.tq) >= 0 && num(r.tq) <= num(r.iq))) rej('MET-012', 'TRADED_QTY_OUT_OF_RANGE', 'Traded quantity', 'tq', r.tq, 'Traded quantity must be between 0 and Initial quantity (' + r.iq + ').');
        if (!empty(r.mic) && r.mic !== 'XOFF' && r.mic !== 'XXXX' && !MIC_RE.test(r.mic)) warn('QUA-002', 'INVALID_MIC', 'Segment MIC', 'mic', r.mic, 'Not a 4-character MIC. (Format only, not the ISO 10383 list.)');
      }

      if (filled && r.otype === 'LMTO') {
        if (empty(r.lp)) rej('MET-013', 'LIMIT_PRICE_MISSING', 'Limit price', 'lp', '', 'A filled limit order (LMTO) needs a Limit price.');
        if (empty(r.tp)) rej('MET-013', 'LIMIT_PRICE_MISSING', 'Transaction price', 'tp', '', 'A filled limit order (LMTO) needs a Transaction price.');
      }
      if (!empty(r.rq) && !empty(r.iq) && !(num(r.rq) >= 0 && num(r.rq) <= num(r.iq))) rej('MET-014', 'REMAINING_QTY_OUT_OF_RANGE', 'Remaining quantity', 'rq', r.rq, 'Remaining quantity must be between 0 and Initial quantity (' + r.iq + ').');
      if (filled && !empty(r.lp) && !empty(r.txid)) {
        var tp = num(r.tp), lp = num(r.lp);
        if (!(tp > 0)) rej('MET-015', 'PRICE_OUT_OF_BOUNDS', 'Transaction price', 'tp', r.tp, 'Transaction price must be greater than zero.');
        else if (r.side === 'BUYI' && tp > lp) rej('MET-015', 'PRICE_OUT_OF_BOUNDS', 'Transaction price', 'tp', r.tp, 'Buy order filled above its Limit price (' + r.lp + ').');
        else if (r.side === 'SELL' && tp < lp) rej('MET-015', 'PRICE_OUT_OF_BOUNDS', 'Transaction price', 'tp', r.tp, 'Sell order filled below its Limit price (' + r.lp + ').');
      }

      if (!empty(r.pa) && !filled) warn('QUA-007', 'PASSIVE_AGGRESSIVE_ON_NON_FILL', 'Passive or Aggressive Indicator', 'pa', r.pa, 'Passive or Aggressive Indicator must be empty unless Status is FILL or PARF.');
      if (!empty(r.oid) && String(r.oid).length > 50) warn('QUA-001', 'FIELD_LENGTH', 'Order identification code', 'oid', r.oid, 'Longer than 50 characters.');
      if (!empty(r.txid) && String(r.txid).length > 52) warn('QUA-001', 'FIELD_LENGTH', 'Transaction identification code', 'txid', r.txid, 'Longer than 52 characters.');

      var key = [r.oid, r.tm, r.st, r.txid || '', r.txid ? r.mic || '' : ''].join('|');
      if (seen[key] !== undefined) rej('MET-005', 'DUPLICATE_RECORD', 'Record key', 'oid', key,
        'Duplicate of record #' + (seen[key] + 1) + ' (Order identification code + Date and time + Status + Transaction identification code + Segment MIC). The first record is accepted, later ones are rejected.');
      else seen[key] = idx;

      tsAll.push({ v: r.tm, ref: ref, idx: idx });
      if (!empty(r.vdt)) tsAll.push({ v: r.vdt, ref: ref, idx: idx, vdt: true });
      if (!empty(r.oid)) {
        ids[r.oid] = 1;
        if (CANCELLED[r.st]) cancelledIds[r.oid] = 1;
      }
      if (r.st === 'NEWO' && (r.side === 'BUYI' || r.side === 'SELL')) { sides++; if (r.side === 'BUYI') buys++; }
      if (filled) {
        var sk = (r.pccy || '?') + ' @ ' + (r.mic || '?');
        (series[sk] = series[sk] || []).push({ p: num(r.tp), t: parseTs(r.tm), ref: ref });
      }
    });

    timestampRules(ctx, tsAll, 'Date and time / Validity period and time', OB + '/OrdrIdData/TmStmp|VldtyDtTm', 'Timestamp');
    midnightRule(ctx, tsAll.filter(function (x) { return !x.vdt; }).map(function (x) { return x.v; }), 'Date and time', OB + '/OrdrIdData/TmStmp');
    priceJumps(ctx, series, 'Transaction price', OB + '/OrdrData/TxData/TxPric/DgtlTknPric/DgtlTknQty/Unit');

    var total = Object.keys(ids).length;
    if (total >= 20) {
      var share = Object.keys(cancelledIds).length / total;
      if (share < 0.05 || share > 0.95) addRecordRow(ctx, '', null, 'WARNING', 'QUA-004', 'EXTREME_RATIO', 'Cancelled orders', OB,
        Math.round(share * 100) + '%', 'Cancelled orders are ' + Math.round(share * 100) + '% of ' + total + ' orders; ESMA expects between 5% and 95%.');
    }
    if (sides >= 20 && (buys / sides > 0.9 || buys / sides < 0.1)) addRecordRow(ctx, '', null, 'WARNING', 'QUA-004', 'EXTREME_RATIO',
      'Buy/sell ratio', OB, Math.round(100 * buys / sides) + '% buy', 'New orders are ' + Math.round(100 * buys / sides) + '% buy; ESMA flags extreme ratios such as >90% on one side.');
  }

  var COLUMNS = ['ReportTimestamp', 'CaspIdentifier', 'SubmittedFileName', 'FeedbackType', 'FileVerdict', 'RecordRef',
    'JSONLineNumber', 'Outcome', 'ErrorCode', 'AppliesTo', 'Label', 'Severity', 'Field', 'LogicalPath', 'SubmittedValue',
    'ValidationReason', 'CorrectiveAction'];

  function row(ts, lei, file, type, verdict, ref, outcome, code, label, severity, field, path, value, reason, action) {
    return {
      ReportTimestamp: ts, CaspIdentifier: lei, SubmittedFileName: file, FeedbackType: type, FileVerdict: verdict,
      RecordRef: ref || '', JSONLineNumber: '-', Outcome: outcome, ErrorCode: code, AppliesTo: 'PRE-CHECK',
      Label: label, Severity: severity, Field: field, LogicalPath: path, SubmittedValue: value,
      ValidationReason: reason, CorrectiveAction: action
    };
  }

  function toCsv(rows) {
    function esc(v) {
      v = v === undefined || v === null ? '' : String(v);
      // Values come from untrusted files: neutralise spreadsheet formulas
      if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
      return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }
    return [COLUMNS.join(',')].concat(rows.map(function (r) {
      return COLUMNS.map(function (c) { return esc(r[c]); }).join(',');
    })).join('\n') + '\n';
  }

  return { create: create, checkName: checkName, toCsv: toCsv, COLUMNS: COLUMNS, VERSION: '0.1.0' };
}));
