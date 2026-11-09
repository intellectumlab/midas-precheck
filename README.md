# midas-precheck

Check MiCA **MIDAS** submission files on your own machine, before ESMA does.

[![test](https://github.com/intellectumlab/midas-precheck/actions/workflows/test.yml/badge.svg)](https://github.com/intellectumlab/midas-precheck/actions/workflows/test.yml)

On 21 October 2026 ESMA published the MIDAS Reporting Instructions (`ESMA65-955014868-17690`): CASPs submit
`CryptoAssetRecordKeeping` (executions, `auth.117`) and `CryptoAssetOrderBook` (orders, `auth.118`) files as JSON,
every two weeks, against published rejection rules. `midas-precheck` runs those rules locally:

| Codes | Level | What |
|---|---|---|
| `FIL-101` | file rejected | name is `<FileType>_<DDMMYYYY>_<partN>_<partM>.json`: known FileType, real date, 1 ≤ partN ≤ partM |
| `FIL-102` | file rejected | valid JSON, right root element, conforms to ESMA's official `auth.117` / `auth.118` V1.0 JSON schemas |
| `MET-001`–`MET-016` | record rejected | mandatory fields, positive quantities and prices, duplicates, one timestamp format with milliseconds, validity-period rules, FILL/PARF dependencies, quantity bounds, fills inside the limit price |
| `QUA-001`–`QUA-008` | warning | field lengths, MIC/DTI format, cancelled-order and buy/sell ratios, isolated price prints ≥1,000%, Segment MIC and passive/aggressive population, midnight-defaulted timestamps |
| `PRE-101`, `PRE-102` | ours | missing parts of a multi-part set; files over 500 MB (ESMA describes both, without codes) |

Findings come out as a CSV in the column layout of ESMA's MIDAS feedback-file sample, with `AppliesTo = PRE-CHECK`
so nobody mistakes it for ESMA's own feedback.

**Prefer a browser?** The same engine runs at **[intellectumlab.com/midas-precheck.html](https://intellectumlab.com/midas-precheck.html)** — files never leave the tab.

## Use

Node 18 or newer.

```sh
npx github:intellectumlab/midas-precheck CryptoAssetOrderBook_21052026_1_1.json
```

or

```sh
git clone https://github.com/intellectumlab/midas-precheck && cd midas-precheck && npm install
node bin/midas-precheck.js --csv feedback.csv CryptoAssetRecordKeeping_21052026_*.json
```

```
CryptoAssetOrderBook_21052026_1_1.json
  40 records · 16 would be rejected · 4 warning(s)

MET-008  REJECTED      CryptoAssetOrderBook_21052026_1_1.json · Ord_1779321887089541910 CAME
         Validity period and time: Validity period and time (2026-05-21T00:04:52.552) must be after Date and time (2026-05-21T00:04:52.552).
MET-013  REJECTED      CryptoAssetOrderBook_21052026_1_1.json · Ord_1779321895392319176 PARF
         Limit price: A filled limit order (LMTO) needs a Limit price.
…
```

| Option | |
|---|---|
| `--csv <path>` | write every finding as CSV |
| `--json` | print the full result as JSON |
| `--no-warnings` | hide warnings in the text report |
| `--max <n>` | findings shown in the text report (default 50) |

Exit code `0` — nothing would be rejected; `1` — at least one file or record would be rejected; `2` — usage error.
That makes it usable as a gate in the pipeline that produces the files.

As a library:

```js
const Ajv2020 = require('ajv/dist/2020').default;
const precheck = require('midas-precheck');
const engine = precheck.create(() => new Ajv2020({ allErrors: true, strict: false }), {
  auth117: require('midas-precheck/schemas/auth117.schema.json'),
  auth118: require('midas-precheck/schemas/auth118.schema.json'),
});
const { files, rows } = engine.checkFiles([{ name, size, text }]);
```

## What it does not prove

- **It is not ESMA's validator.** It is our reading of the public MIDAS Reporting Instructions and the official schemas.
  Where the text is ambiguous, the finding says so. A clean result is a good sign, not a guarantee of acceptance.
- **No registries.** MIC codes are checked for format, not against ISO 10383; DTIs for format, not against the ISO 24165
  registry; fiat currency codes are left to the schema.
- **Duplicates within the files you pass only.** MIDAS also checks against everything you have submitted before.
- **Thresholds ESMA does not publish are ours.** Midnight timestamps are flagged above 5%; order ratios are only
  assessed with 20 or more orders. ESMA configures the timestamp mask per CASP; we take the most common mask in the file.
- **Whole-file parsing.** Files are read into memory. Very large parts are slow; ESMA's own guidance is 50–300 MB per part.
- **The rules will move.** ESMA phases the MIDAS data scope in. This version follows the 21 October 2026 text.

## Running ESMA's own samples

`test/fixtures/` holds the samples ESMA published with the instructions. The record-keeping sample (637 executions)
passes. Read literally, the order-book sample (40 events) would lose 16 records — 14 under `MET-013` (one `LMTO` order
reports "no price" as its limit price on every fill) and 3 under `MET-008` (orders ending at exactly their validity time,
where the rule says "after"), one overlapping — plus 4 `QUA-006` warnings. A sample shows structure, not conformance; we
include it because it shows where the rules have edges. Write-up:
[What MIDAS rejects — and what it means for your records](https://intellectumlab.com/blog/what-midas-rejects.html).

Two more things worth knowing before a first submission, both checked here:

- the instructions' prose writes timestamps as `2026-03-15 14:25:36.125` (with a space); the published schema requires
  `T` between date and time, and a schema failure rejects the whole file (`FIL-102`);
- the Annex 4 sample files are named `..._part1.json`, which fails the naming convention (`FIL-101`).

```sh
npm test
```

## Sources

- ESMA, *Reporting Instructions — MIDAS System*, ESMA65-955014868-17690, 21 October 2026, and the record-keeping,
  order-book and feedback-file samples — [ESMA MiCA page](https://www.esma.europa.eu/esmas-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica).
- ESMA, *MiCA order book and records keeping message specifications*, ESMA65-955014868-15160 (November 2025), source of
  `schemas/auth117.schema.json` and `schemas/auth118.schema.json` (unchanged, minified).
- Regulation (EU) 2023/1114 (MiCA), Articles 68(9), 76(15), 94; Commission Delegated Regulation (EU) 2025/1140.

## Found a misreading?

That is the most useful report this project can get — see [SECURITY.md](SECURITY.md).

## License

Apache 2.0 for the code. The schemas and sample files are ESMA publications, included for reproducibility with
attribution; see [NOTICE](NOTICE).

Built by [Intellectum Lab](https://intellectumlab.com) — production systems for MiCA-authorised CASPs:
order-book and trade records in ESMA format, Travel Rule, DORA, EU AI Act governance.
