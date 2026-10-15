import { normalise } from './normalise.js';
import { runDetectors } from './detectors.js';
import { usage } from './usage.js';
export function analyse(text) {
  const trace = normalise(text);
  return { schema_version: '1.0', ...trace,
    findings: runDetectors(trace.steps, { instructions: trace.instructions }),
    usage: usage(trace.steps) };
}
