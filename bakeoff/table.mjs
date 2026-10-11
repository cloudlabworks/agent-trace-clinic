// Print the bake-off table (Markdown) from results/*.json and apply the pick rule in score.mjs.
//   node table.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pick, score } from './score.mjs';
import { normalise } from '../normalise.js';
import { parseLabels } from '../labeller.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'results');
const results = readdirSync(dir)
  .filter((f) => f.endsWith('.json') && !f.endsWith('.partial.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  .sort((a, b) => a.download_bytes - b.download_bytes || a.model.localeCompare(b.model) || a.variant.localeCompare(b.variant));

// Re-parse every saved raw output with the current parser, so a parser change after a run
// cannot leave a stale score in the table.
const casesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'cases');
const expected = JSON.parse(readFileSync(join(casesDir, 'mast-expected.json'), 'utf8'));
let changed = 0;
for (const r of results) {
  const runs = r.runs.map((run) => {
    const p = parseLabels(run.raw, normalise(readFileSync(join(casesDir, run.case), 'utf8')).steps);
    return { ...run, status: p.status, labels: p.labels };
  });
  const fresh = score(runs, expected);
  if (JSON.stringify(fresh) !== JSON.stringify(r.score)) changed++;
  r.score = fresh;
}
if (changed) console.log(`note: ${changed} result file(s) scored differently with the current parser; the table uses the current parser\n`);

const gb = (b) => `${(b / 1e9).toFixed(2)} GB`;
const s = (ms) => `${(ms / 1000).toFixed(1)} s`;
console.log('| Model @ revision | dtype | Variant | Download | Load (cached) | Latency per case, median / max | First token, median | Exact (of 14) | Any-overlap (of 9) | Control false positives (of 5) | No model opinion (of 14) |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of results) {
  const c = r.score;
  console.log(`| ${r.model} @ ${r.revision.slice(0, 7)} | ${r.dtype} | ${r.variant} | ${gb(r.download_bytes)} | ${s(r.load_ms_from_cache)} | ${s(r.latency_ms.median)} / ${s(r.latency_ms.max)} | ${s(r.first_token_ms.median)} | ${c.exact} | ${c.overlap} | ${c.control_fp} | ${c.no_opinion} |`);
}
const p = pick(results);
console.log(`\nrule picks the model: ${p.pick.model} (smallest download: ${p.pick.dtype}); met the bar: ${p.usable}`);
console.log('the rule does not choose between variants of one model; see README.md for that choice');
