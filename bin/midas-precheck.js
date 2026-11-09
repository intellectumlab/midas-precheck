#!/usr/bin/env node
'use strict';
/*
 * midas-precheck — check MIDAS submission files on your own machine.
 *
 *   midas-precheck [options] <file.json> [<file.json> ...]
 *
 *   --csv <path>     write findings as CSV (layout of ESMA's MIDAS feedback file)
 *   --json           print the full result as JSON instead of the text report
 *   --no-warnings    hide QUA-* and PRE-101 warnings from the text report
 *   --max <n>        show at most n findings in the text report (default 50)
 *   -h, --help       show this help
 *   -v, --version    print the version
 *
 * Exit codes: 0 no rejections · 1 at least one file or record would be rejected · 2 usage error
 */
const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020').default;
const precheck = require('../lib/precheck.js');

const HELP = fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 16)
  .map((l) => l.replace(/^ \* ?/, '')).join('\n');

function parseArgs(argv) {
  const opts = { files: [], csv: null, json: false, warnings: true, max: 50 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--no-warnings') opts.warnings = false;
    else if (a === '--csv') opts.csv = argv[++i];
    else if (a === '--max') opts.max = parseInt(argv[++i], 10);
    else if (a.startsWith('-')) throw new Error('unknown option ' + a);
    else opts.files.push(a);
  }
  if (opts.csv === undefined) throw new Error('--csv needs a path');
  if (Number.isNaN(opts.max)) throw new Error('--max needs a number');
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error('midas-precheck: ' + e.message + '\n\n' + HELP);
    return 2;
  }
  if (opts.help) { console.log(HELP); return 0; }
  if (opts.version) { console.log(precheck.VERSION); return 0; }
  if (!opts.files.length) { console.error(HELP); return 2; }

  const schemaDir = path.join(__dirname, '..', 'schemas');
  const schemas = {
    auth117: JSON.parse(fs.readFileSync(path.join(schemaDir, 'auth117.schema.json'), 'utf8')),
    auth118: JSON.parse(fs.readFileSync(path.join(schemaDir, 'auth118.schema.json'), 'utf8')),
  };
  const engine = precheck.create(() => new Ajv2020({ allErrors: true, strict: false }), schemas);

  const inputs = [];
  for (const f of opts.files) {
    let stat;
    try {
      stat = fs.statSync(f);
    } catch (e) {
      console.error('midas-precheck: cannot read ' + f);
      return 2;
    }
    // Over 500 MB is reported as PRE-102 without reading the file
    const text = stat.size > 500 * 1024 * 1024 ? '' : fs.readFileSync(f, 'utf8');
    inputs.push({ name: path.basename(f), size: stat.size, text });
  }

  const result = engine.checkFiles(inputs);
  if (opts.csv) fs.writeFileSync(opts.csv, precheck.toCsv(result.rows));

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const f of result.files) {
      const line = f.verdict === 'REJECTED'
        ? 'FILE REJECTED — no records processed'
        : `${f.records} records · ${f.rejected} would be rejected · ${f.warnings} warning(s)`;
      console.log(`${f.name}\n  ${line}`);
    }
    const rows = result.rows.filter((r) => opts.warnings || r.Outcome !== 'WARNING');
    if (rows.length) console.log('');
    rows.slice(0, opts.max).forEach((r) => {
      const where = [r.SubmittedFileName, r.RecordRef].filter(Boolean).join(' · ');
      console.log(`${r.ErrorCode.padEnd(8)} ${r.Outcome.padEnd(13)} ${where}\n         ${r.Field}: ${r.ValidationReason}`);
    });
    if (rows.length > opts.max) console.log(`\n… ${rows.length - opts.max} more. Use --csv to get every finding.`);
    if (opts.csv) console.log(`\nCSV written to ${opts.csv}`);
    console.log('\nOur reading of ESMA\'s public MIDAS rules, not ESMA\'s validator. See README: "What it does not prove".');
  }

  const rejected = result.files.some((f) => f.verdict === 'REJECTED' || f.rejected > 0);
  return rejected ? 1 : 0;
}

process.exitCode = main();
