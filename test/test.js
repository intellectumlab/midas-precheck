// Tests for lib/precheck.js against ESMA's own MIDAS samples
// and one mutation per rule. Run: node test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const Ajv2020 = require('ajv/dist/2020').default;
const P = require(path.join(ROOT, 'lib/precheck.js'));
const schemas = {
  auth117: JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas/auth117.schema.json'), 'utf8')),
  auth118: JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas/auth118.schema.json'), 'utf8')),
};
const pc = P.create(() => new Ajv2020({ allErrors: true, strict: false }), schemas);
const rk = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/esma_midas_recordkeeping.json'), 'utf8'));
const ob = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/esma_midas_orderbook.json'), 'utf8'));
const RK = 'CryptoAssetRecordKeeping_21052026_1_1.json';
const OBN = 'CryptoAssetOrderBook_21052026_1_1.json';
const clone = (o) => JSON.parse(JSON.stringify(o));
const run = (name, doc, text) => pc.checkFiles([{ name, size: 1, text: text !== undefined ? text : JSON.stringify(doc) }]);
const codes = (res) => res.rows.map((r) => r.ErrorCode);
let n = 0;
function t(label, fn) { fn(); n++; console.log('ok', label); }

// --- baselines: ESMA's own samples
const base1 = run(RK, rk);
console.log('ESMA RK sample:', base1.files[0].records, 'records;', JSON.stringify(codes(base1)));
const base2 = run(OBN, ob);
console.log('ESMA OB sample:', base2.files[0].records, 'records;', JSON.stringify([...new Set(codes(base2))]), base2.rows.length, 'rows');
base2.rows.slice(0, 6).forEach((r) => console.log('   ', r.ErrorCode, r.RecordRef, r.ValidationReason.slice(0, 110)));
t('OB sample: ESMA rules vs ESMA sample', () => { const c = codes(base2); assert(c.includes('QUA-006') && c.includes('MET-013') && c.includes('MET-008')); });
t('RK sample has no rejections', () => assert(!base1.rows.some((r) => r.Outcome !== 'WARNING')));

// --- file level
t('FIL-101 csv extension', () => assert.deepStrictEqual(codes(run('CryptoAssetRecordKeeping_06082026_1_1.csv', rk)), ['FIL-101']));
t('FIL-101 ESMA annex sample name "_part1"', () => assert.deepStrictEqual(codes(run('CryptoAssetRecordKeeping_21052026_part1.json', rk)), ['FIL-101']));
t('FIL-101 impossible date', () => assert.deepStrictEqual(codes(run('CryptoAssetOrderBook_31022026_1_1.json', ob)), ['FIL-101']));
t('FIL-101 partN > partM', () => assert.deepStrictEqual(codes(run('CryptoAssetOrderBook_21052026_3_2.json', ob)), ['FIL-101']));
t('FIL-102 broken JSON', () => assert.deepStrictEqual(codes(run(RK, null, '{"Document": {,}}')), ['FIL-102']));
t('FIL-102 wrong root for file type', () => assert.deepStrictEqual(codes(run(OBN, rk)), ['FIL-102']));
t('FIL-102 schema violation', () => {
  const d = clone(rk); d.Document.CrptAsstRcrdKeepgRpt.Tx[0].New.Tx.TradVn = 'TOOLONGMIC';
  const r = run(RK, d); assert(codes(r).every((c) => c === 'FIL-102') && r.files[0].verdict === 'REJECTED');
});
t('PRE-101 incomplete set', () => {
  const r = pc.checkFiles([
    { name: 'CryptoAssetRecordKeeping_24052026_1_4.json', size: 1, text: JSON.stringify(rk) },
    { name: 'CryptoAssetRecordKeeping_24052026_3_4.json', size: 1, text: JSON.stringify(rk) }]);
  assert(codes(r).includes('PRE-101') && /2, 4/.test(r.rows.find((x) => x.ErrorCode === 'PRE-101').SubmittedValue));
});
t('PRE-102 size', () => assert.deepStrictEqual(codes(pc.checkFiles([{ name: RK, size: 600 * 1024 * 1024, text: '{}' }])), ['PRE-102']));

// --- executions
const tx0 = (d) => d.Document.CrptAsstRcrdKeepgRpt.Tx[0].New;
t('MET-005 duplicate execution', () => {
  const d = clone(rk); d.Document.CrptAsstRcrdKeepgRpt.Tx.push(clone(d.Document.CrptAsstRcrdKeepgRpt.Tx[0]));
  assert(codes(run(RK, d)).includes('MET-005'));
});
t('MET-006 execution timestamp without millis', () => {
  const d = clone(rk); tx0(d).Tx.TradDt = '2026-05-21T10:00:03';
  const r = run(RK, d); assert(codes(r).includes('MET-006') || codes(r).includes('FIL-102'), JSON.stringify(codes(r)));
  console.log('    (no-millis TradDt ->', [...new Set(codes(r))].join(','), ')');
});
t('MET-006 execution mixed separator', () => {
  const d = clone(rk); tx0(d).Tx.TradDt = '2026-05-21 10:00:03.123';
  const r = run(RK, d); console.log('    (space separator ->', r.rows[0] && r.rows[0].ValidationReason.slice(0, 120)); console.log('    (space separator ->', [...new Set(codes(r))].join(','), ')');
  assert(codes(r).includes('MET-006') || codes(r).includes('FIL-102'));
});
t('QUA-005 isolated price print', () => {
  const d = clone(rk);
  const txs = d.Document.CrptAsstRcrdKeepgRpt.Tx.filter((x) => x.New.Tx.Pric.DgtlTknPric.DgtlTknQty.Idr.DTIShrtNm === 'ETH/USDC');
  txs.sort((a, b) => a.New.Tx.TradDt.localeCompare(b.New.Tx.TradDt));
  txs[1].New.Tx.Pric.DgtlTknPric.DgtlTknQty.Unit = '212832.00';
  assert(codes(run(RK, d)).includes('QUA-005'));
});
t('QUA-008 midnight execution timestamps', () => {
  const d = clone(rk); d.Document.CrptAsstRcrdKeepgRpt.Tx.forEach((x, i) => { x.New.Tx.TradDt = '2026-05-21T00:00:00.000'; x.New.TxRcrdId = 'R' + i; });
  assert(codes(run(RK, d)).includes('QUA-008'));
});

// --- order book
const orders = (d) => d.Document.CrptAsstOrdrBookRpt.OrdrRpt.New.Ordr;
const first = (d, st) => orders(d).find((o) => o.OrdrIdData.EvtTp.Cd === st);
t('MET-009 PARF without TxId', () => { const d = clone(ob); delete first(d, 'PARF').OrdrData.TxData.TxId; const c = codes(run(OBN, d)); assert(c.includes('MET-009') || c.includes('FIL-102'), c); console.log('    (PARF w/o TxId ->', [...new Set(c)].join(','), ')'); });
t('MET-010 NEWO with TxId', () => { const d = clone(ob); const o = first(d, 'NEWO'); o.OrdrData.TxData = { TxId: '123' }; const c = codes(run(OBN, d)); console.log('    (NEWO with TxId ->', [...new Set(c)].join(','), ')'); assert(c.includes('MET-010') || c.includes('FIL-102')); });
t('MET-012/014 quantities above initial', () => {
  const d = clone(ob); const o = first(d, 'PARF');
  o.OrdrData.TxData.TraddQty.DgtlTknQty.Unit = '999999'; o.OrdrData.InstrData.RmngQty.DgtlTknQty.Unit = '999999';
  const c = codes(run(OBN, d)); assert(c.includes('MET-012') && c.includes('MET-014'), c);
});
t('MET-015 buy filled above limit', () => {
  const d = clone(ob); const o = orders(d).find((x) => x.OrdrIdData.EvtTp.Cd === 'PARF' && x.OrdrData.InstrData.BuySellInd === 'BUYI');
  o.OrdrData.TxData.TxPric.DgtlTknPric.DgtlTknQty.Unit = '99999';
  assert(codes(run(OBN, d)).includes('MET-015'));
});
t('MET-004 zero initial quantity', () => { const d = clone(ob); first(d, 'NEWO').OrdrData.InstrData.InitlQty.DgtlTknQty.Unit = '0'; const c = codes(run(OBN, d)); console.log('    (zero InitlQty ->', [...new Set(c)].join(','), ')'); assert(c.includes('MET-004') || c.includes('FIL-102')); });
t('MET-007 GTDV without validity time', () => { const d = clone(ob); const o = first(d, 'NEWO'); o.OrdrIdData.VldtyPrd.VldtyPrdCd = 'GTDV'; delete o.OrdrIdData.VldtyDtTm; const r = run(OBN, d); console.log('    (GTDV w/o VldtyDtTm ->', r.rows.map((x) => x.ErrorCode + ' ' + x.ValidationReason.slice(0, 90)).join(' | '), ')'); assert(codes(r).includes('MET-007') || codes(r).includes('FIL-102')); });
t('MET-008 validity before event', () => { const d = clone(ob); first(d, 'NEWO').OrdrIdData.VldtyDtTm = '2026-05-20T00:00:00.000'; assert(codes(run(OBN, d)).includes('MET-008')); });
t('QUA-007 passive/aggressive on CAME', () => { const d = clone(ob); const o = first(d, 'CAME'); o.OrdrData.TxData = Object.assign({}, o.OrdrData.TxData, { PssvOrAggrssvInd: 'PASV' }); const c = codes(run(OBN, d)); console.log('    (PA on CAME ->', [...new Set(c)].join(','), ')'); assert(c.includes('QUA-007') || c.includes('FIL-102')); });
t('MET-005 duplicate order event', () => { const d = clone(ob); orders(d).push(clone(orders(d)[0])); assert(codes(run(OBN, d)).includes('MET-005')); });
t('CSV output has MIDAS columns', () => assert(P.toCsv(base2.rows).startsWith(fs.readFileSync(path.join(__dirname, 'fixtures/esma_midas_feedback_sample.csv'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0])));
console.log(n, 'tests passed');

// --- CLI
const { spawnSync } = require('child_process');
const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'midas-'));
const cli = (args) => spawnSync(process.execPath, [path.join(ROOT, 'bin/midas-precheck.js'), ...args], { encoding: 'utf8' });
const rkFile = path.join(tmp, RK); fs.writeFileSync(rkFile, JSON.stringify(rk));
const obFile = path.join(tmp, OBN); fs.writeFileSync(obFile, JSON.stringify(ob));
t('CLI exit 0 on clean RK sample', () => assert.strictEqual(cli([rkFile]).status, 0));
t('CLI exit 1 on OB sample, CSV written', () => {
  const csv = path.join(tmp, 'out.csv'); const r = cli(['--csv', csv, obFile]);
  assert.strictEqual(r.status, 1); assert(/16 would be rejected/.test(r.stdout)); assert(fs.readFileSync(csv, 'utf8').includes('MET-013'));
});
t('CLI exit 2 on usage error', () => assert.strictEqual(cli(['--bogus']).status, 2));
t('CLI --json', () => assert.strictEqual(JSON.parse(cli(['--json', obFile]).stdout).files[0].records, 40));
console.log(n, 'tests passed (with CLI)');
