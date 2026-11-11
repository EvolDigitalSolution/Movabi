// Compares Vitest JSON reports (baseline vs patched) and prints a compact, pasteable summary.
// Usage: node compare-summary.cjs <outDir>   (reads baseline.json, patched.json, focused.json, exit-codes.json, build.log)
'use strict';
const fs = require('node:fs'), path = require('node:path');
const out = process.argv[2];
const lines = [];
const say = (s = '') => { lines.push(s); };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')); } catch (e) { return { __error: String(e.message).slice(0, 200) }; } };
const codes = readJson('exit-codes.json');
const rel = (n) => n.replace(/\\/g, '/').replace(/^.*?\/(src\/testing\/)/, '$1');
function index(report) {
  const m = new Map();
  if (!report || report.__error || !Array.isArray(report.testResults)) return m;
  for (const f of report.testResults) {
    const file = rel(f.name);
    const asserts = f.assertionResults || [];
    if (!asserts.length || (f.status === 'failed' && asserts.every(a => a.status !== 'failed')))
      m.set(file + ' :: <suite>', { status: f.status === 'failed' ? 'failed' : 'passed', msg: (f.message || '').split('\n').find(Boolean) || '' });
    for (const a of asserts) m.set(file + ' :: ' + a.fullName, { status: a.status, msg: ((a.failureMessages || [])[0] || '').split('\n').find(Boolean) || '' });
  }
  return m;
}
const counts = (r) => r && !r.__error ? `tests passed=${r.numPassedTests} failed=${r.numFailedTests} skipped=${(r.numPendingTests || 0) + (r.numTodoTests || 0)}; files failed=${r.numFailedTestSuites}/${r.numTotalTestSuites}` : `NO REPORT (${r && r.__error})`;
const base = readJson('baseline.json'), patch = readJson('patched.json'), focused = readJson('focused.json');
const B = index(base), P = index(patch);
const failed = (x) => x && x.status === 'failed';
say('=== VAYDU TOP-UP BASELINE COMPARISON ===');
say(`exit codes: ${JSON.stringify(codes)}`);
say(`current tree unchanged by script: ${codes.currentTreeUnchanged}`);
say(`baseline 95d745b: ${counts(base)}`);
say(`patched tree    : ${counts(patch)}`);
const introduced = [...P].filter(([k, v]) => failed(v) && !failed(B.get(k)));
const preexisting = [...P].filter(([k, v]) => failed(v) && failed(B.get(k)));
const fixedByPatch = [...B].filter(([k, v]) => failed(v) && P.has(k) && !failed(P.get(k)));
const baseOnlyFail = [...B].filter(([k, v]) => failed(v) && !P.has(k));
say(`failing in both (pre-existing): ${preexisting.length}`);
say(`failing only with patch (INTRODUCED): ${introduced.length}`);
for (const [k, v] of introduced) say(`  NEW ${k}\n      baseline=${B.has(k) ? B.get(k).status : 'absent'} | ${v.msg.slice(0, 220)}`);
say(`failing only at baseline (passing with patch): ${fixedByPatch.length}`);
for (const [k] of fixedByPatch) say(`  FIXED ${k}`);
if (baseOnlyFail.length) say(`failing at baseline, absent in patched: ${baseOnlyFail.length}`);
const byFile = {};
for (const [k] of preexisting) { const f = k.split(' :: ')[0]; byFile[f] = (byFile[f] || 0) + 1; }
say('pre-existing failures by file:');
for (const [f, n] of Object.entries(byFile).sort()) say(`  ${String(n).padStart(3)} ${f}`);
say(`focused top-up specs: ${counts(focused)}`);
const F = index(focused);
for (const [k, v] of F) if (failed(v)) say(`  FOCUSED FAIL ${k} | ${v.msg.slice(0, 200)}`);
let build = '';
try { build = fs.readFileSync(path.join(out, 'build.log'), 'utf8'); } catch { build = '(no build.log)'; }
const buildTail = build.split(/\r?\n/).filter(l => /error|warning|Application bundle|Output location|complete|failed|\bERR/i.test(l)).slice(-8);
say(`build:mobile:develop exit=${codes.build}`);
for (const l of buildTail) say(`  ${l.trim().slice(0, 200)}`);
say('=== END ===');
const text = lines.join('\n');
fs.writeFileSync(path.join(out, 'summary.txt'), text + '\n');
console.log(text);
