// CI suite integrity guard (2026-09-09): a run that accidentally executed only a
// few files (e.g. an unquoted glob becoming positional filters) must never be
// judged a full pass. Reads the vitest JSON result produced by the test step and
// fails unless every required suite file actually ran and no test failed.
import fs from 'node:fs'

const file = process.argv[2] ?? 'vitest-results.json'
const required = [
  'tests/unit/scanner.test.ts',
  'tests/unit/manifest.test.ts',
  'tests/unit/p2a.test.ts',
  'tests/unit/restore-boundaries.test.ts',
  'tests/integration/presnapshot.test.ts',
  'tests/integration/p2b.test.ts',
  'tests/integration/p2b-process.test.ts',
  'tests/integration/p3-cli.test.ts',
  'tests/integration/p3-lifecycle.test.ts',
  'tests/integration/p4-resolve.test.ts',
  'tests/integration/p4-doctor.test.ts',
]
let raw
try {
  raw = fs.readFileSync(file, 'utf8')
} catch {
  console.error('GUARD FAIL: cannot read vitest results: ' + file)
  process.exit(1)
}
const report = JSON.parse(raw)
const files = (report.testResults ?? []).map((t) => String(t.name).replace(/\\/g, '/'))
const missing = required.filter((r) => !files.some((f) => f.endsWith(r)))
if (missing.length > 0) {
  console.error('GUARD FAIL: required suite files did not run: ' + JSON.stringify(missing))
  process.exit(1)
}
if ((report.numFailedTests ?? -1) !== 0) {
  console.error('GUARD FAIL: failed tests=' + report.numFailedTests)
  process.exit(1)
}
console.log('GUARD OK: files=' + files.length + ' passed=' + report.numPassedTests +
  ' failed=' + report.numFailedTests + ' skipped=' + report.numPendingTests)
