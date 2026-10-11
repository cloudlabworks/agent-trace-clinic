// Import a patient matrix run into cases/patient/.
//   node scripts/import-patient.mjs <matrix-out-dir> <patient-commit>
// <matrix-out-dir> is the --out of:  python3 -m patient.local --out DIR --night 2026-10-10 --matrix
// Copies every trace and ground-truth record byte for byte, then writes
// expected.json and mast-expected.json from the ground truth alone.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveExpected, FAULT_MAST } from './patient-expected.mjs';

const [src, commit] = process.argv.slice(2);
if (!src || !commit) {
  console.error('usage: node scripts/import-patient.mjs <matrix-out-dir> <patient-commit>');
  process.exit(2);
}
const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'cases', 'patient');
for (const d of ['traces', 'ground-truth']) {
  rmSync(join(dest, d), { recursive: true, force: true });
  mkdirSync(join(dest, d), { recursive: true });
}
const expected = {
  _about:
    'Derived from the patient ground-truth records in ground-truth/ by scripts/patient-expected.mjs, never from detector output. ' +
    'primary is the finding the fault must produce, with exactly these steps. allowed_extra are findings the patient says the fault also causes. ' +
    'Ground truth has no severity, so severity is not compared. token_totals must count model_calls model calls.',
};
const mast = {
  _about:
    'Expected MAST modes per patient trace, mapped from the injected fault (scripts/patient-expected.mjs). Same schema as ../mast-expected.json. ' +
    'Kept apart from that file so the bake-off case list and its denominators do not change.',
};
let night = null;
let seed = null;
for (const fault of readdirSync(src).sort()) {
  const gtDir = join(src, fault, 'ground-truth');
  if (!existsSync(gtDir)) continue;
  for (const n of readdirSync(gtDir).sort()) {
    for (const f of readdirSync(join(gtDir, n)).sort()) {
      const truth = JSON.parse(readFileSync(join(gtDir, n, f), 'utf8'));
      const base = `${fault}--${truth.task_id}`;
      copyFileSync(join(gtDir, n, f), join(dest, 'ground-truth', `${base}.json`));
      copyFileSync(join(src, fault, truth.trace_key), join(dest, 'traces', `${base}.otel.json`));
      expected[`${base}.otel.json`] = deriveExpected(truth);
      const m = FAULT_MAST[truth.fault];
      mast[`${base}.otel.json`] = { ...m, ...(m.expected === 'none' ? {} : { steps: [...truth.steps] }) };
      night = truth.night;
      seed = truth.seed;
    }
  }
}
const provenance = {
  generator: 'agent-trace-clinic-patient',
  patient_commit: commit,
  command: `PYTHONPATH=src python3 -m patient.local --out DIR --night ${night} --matrix`,
  night,
  seed,
  model: 'stub-model (deterministic; token counts are its characters/4 estimates)',
  traces: Object.keys(expected).filter((k) => !k.startsWith('_')).length,
};
writeFileSync(join(dest, 'expected.json'), JSON.stringify(expected, null, 1) + '\n');
writeFileSync(join(dest, 'mast-expected.json'), JSON.stringify(mast, null, 1) + '\n');
writeFileSync(join(dest, 'provenance.json'), JSON.stringify(provenance, null, 1) + '\n');
console.log(`imported ${provenance.traces} traces into cases/patient/`);
