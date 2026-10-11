// Bake-off: run one candidate model over every case and score it against cases/mast-expected.json.
//   node run.mjs --model <hub id> --revision <sha> --dtype q4 --variant <name>
//                [--thinking] [--prefix "["] [--download-only]
// Uses ../labeller.js for the prompt, the generation call and the parser, so what is measured
// here is exactly what the Clinic ships. Weights are cached outside the repo
// (BAKEOFF_CACHE, default ~/.cache/agent-trace-clinic-bakeoff). Each finished case is saved
// to results/<name>.partial.json, so a long run can be stopped and resumed; the final
// results/<name>.json is written when every case is done.

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, cpus } from 'node:os';
import { createHash } from 'node:crypto';
import * as tf from '@huggingface/transformers';
import { normalise } from '../normalise.js';
import { loadLabeller, systemPrompt, MAST_SOURCE } from '../labeller.js';
import { score } from './score.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const casesDir = join(here, '..', 'cases');

const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const model = opt('model');
const revision = opt('revision');
const dtype = opt('dtype', 'q4');
const answerPrefix = opt('prefix', '');
const thinking = args.includes('--thinking');
const repetitionPenalty = Number(opt('repetition-penalty', '1'));
const variant = opt('variant', thinking ? 'thinking' : 'plain');
if (!model || !revision) {
  console.error('usage: node run.mjs --model <id> --revision <sha> --dtype q4 [--variant name] [--thinking] [--prefix "["]');
  process.exit(2);
}

tf.env.cacheDir = process.env.BAKEOFF_CACHE ?? join(homedir(), '.cache', 'agent-trace-clinic-bakeoff');
tf.env.allowLocalModels = false;

const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);

// transformers.js file suffix per dtype (onnx/model<suffix>.onnx, plus .onnx_data when external).
const SUFFIX = { fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8', uint8: '_uint8', q4: '_q4', q4f16: '_q4f16', bnb4: '_bnb4' };

// Progress lines at most every 10 s so a long download is visibly alive.
let lastProgress = 0;
const progress_callback = (p) => {
  if (p.status === 'progress' && Date.now() - lastProgress > 10000) {
    lastProgress = Date.now();
    log(`download ${p.file} ${(p.loaded / 1e6).toFixed(0)}/${(p.total / 1e6).toFixed(0)} MB`);
  } else if (p.status === 'done') log(`fetched ${p.file}`);
};

const t0 = performance.now();
const labeller = await loadLabeller({ transformers: tf, model, revision, dtype, device: 'cpu', progress_callback, answerPrefix, thinking, repetitionPenalty });
const loadMs = performance.now() - t0;

// What this dtype needs from the pinned revision: the shared tokenizer/config files and its own
// ONNX file(s). Read from the revision-keyed cache path, which also proves the pin was used.
const cachePath = join(tf.env.cacheDir, model, revision);
if (!existsSync(cachePath)) throw new Error('nothing cached at the pinned revision: revision pin not honoured?');
const all = readdirSync(cachePath, { recursive: true }).filter((f) => statSync(join(cachePath, f)).isFile());
const own = `onnx/model${SUFFIX[dtype]}.onnx`;
const files = all.filter((f) => !f.startsWith('onnx/') || f === own || f === `${own}_data`).sort();
if (!files.includes(own)) throw new Error(`${own} not in the cache at the pinned revision`);
const downloadBytes = files.reduce((n, f) => n + statSync(join(cachePath, f)).size, 0);
log(`loaded ${model}@${revision.slice(0, 10)} dtype ${dtype} in ${(loadMs / 1000).toFixed(1)} s; ${(downloadBytes / 1e9).toFixed(2)} GB for this dtype`);

if (args.includes('--download-only')) process.exit(0);

const expected = JSON.parse(readFileSync(join(casesDir, 'mast-expected.json'), 'utf8'));
const caseFiles = Object.keys(expected).filter((k) => !k.startsWith('_') && expected[k].expected !== 'n/a').sort();
const promptSha = createHash('sha256').update(JSON.stringify({ system: systemPrompt(), thinking, answerPrefix, repetitionPenalty })).digest('hex');

mkdirSync(join(here, 'results'), { recursive: true });
const name = `${model.split('/').pop()}-${dtype}-${variant}`;
const partialPath = join(here, 'results', `${name}.partial.json`);
let runs = [];
if (existsSync(partialPath)) {
  const prev = JSON.parse(readFileSync(partialPath, 'utf8'));
  if (prev.prompt_sha256 === promptSha && prev.revision === revision) runs = prev.runs;
  if (runs.length) log(`resuming: ${runs.length} cases already done`);
}

for (const file of caseFiles) {
  if (runs.some((r) => r.case === file)) continue;
  const { steps } = normalise(readFileSync(join(casesDir, file), 'utf8'));
  const r = await labeller.label(steps);
  runs.push({ case: file, status: r.status, reason: r.reason, labels: r.labels, dropped: r.dropped.map((d) => d.why), raw: r.raw, timing: r.timing });
  writeFileSync(partialPath, JSON.stringify({ revision, prompt_sha256: promptSha, runs }));
  log(`${file}: ${r.status} [${r.labels.map((l) => `${l.mode}@${l.step}`).join(', ')}] ${(r.timing.total_ms / 1000).toFixed(1)} s, first token ${(r.timing.first_token_ms / 1000).toFixed(2)} s, ${r.timing.new_tokens} tokens`);
}

const s = score(runs, expected);
const median = (a) => (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2);
const lat = runs.map((r) => r.timing.total_ms).sort((a, b) => a - b);
const ftt = runs.map((r) => r.timing.first_token_ms).sort((a, b) => a - b);
const result = {
  model,
  revision,
  dtype,
  variant,
  thinking,
  repetition_penalty: repetitionPenalty,
  answer_prefix: answerPrefix,
  prompt_sha256: promptSha,
  device: 'cpu (onnxruntime-node)',
  transformers_js: JSON.parse(readFileSync(join(here, 'node_modules/@huggingface/transformers/package.json'), 'utf8')).version,
  host: `${cpus()[0].model}, Node ${process.version}`,
  taxonomy: MAST_SOURCE,
  download_bytes: downloadBytes,
  files,
  load_ms_from_cache: Math.round(loadMs),
  latency_ms: { median: Math.round(median(lat)), max: Math.round(lat.at(-1)) },
  first_token_ms: { median: Math.round(median(ftt)), max: Math.round(ftt.at(-1)) },
  score: s,
  runs,
};
writeFileSync(join(here, 'results', `${name}.json`), `${JSON.stringify(result, null, 1)}\n`);
rmSync(partialPath, { force: true });
log(`score: exact ${s.exact}/${s.cases}, overlap ${s.overlap}/${s.failure_cases}, control false positives ${s.control_fp}/${s.controls}, no opinion ${s.no_opinion}`);
log(`wrote results/${name}.json`);
await labeller.dispose();
