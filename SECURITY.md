# Security and correctness

Two kinds of report belong here, and they are different.

## The reading is wrong

If a finding contradicts the MIDAS Reporting Instructions — a rule we apply that the text does not say, a rule
we miss, a field mapped to the wrong path, or an ambiguity we resolved the wrong way — that is the report this
project exists to invite.

**Please open a public issue.** Include:

- the rule code (e.g. `MET-008`) and the section or table of ESMA65-955014868-17690 it comes from
- what `midas-precheck` reports, and for which record
- what the instructions or the schema actually say, quoted
- if you can, a minimal JSON file that reproduces it — **synthetic data only, never real client records**

We will respond on the issue. If the misreading is real, the fix lands with a test that pins it.

## Real security issue

If you have found a security defect — for example input that makes the CLI read or write outside the paths it
was given — email **viktor@intellectumlab.com** instead of opening a public issue. We will acknowledge within
three business days.
