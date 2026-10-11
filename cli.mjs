#!/usr/bin/env node
// Agent Trace Clinic CLI.
//   node cli.mjs trace.json            text report
//   node cli.mjs trace.jsonl --json    JSON report
//   node cli.mjs trace.json --price-in 2 --price-out 10   (per million tokens)
//   node cli.mjs trace.json --price 3                      (one price for all tokens)
//   node cli.mjs - < trace.json        read from stdin
// Everything runs locally; nothing is sent anywhere.

import { readFileSync } from 'node:fs';
import { normalise, TraceFormatError } from './normalise.js';
import { runDetectors, contextCurve } from './detectors.js';
import { usage } from './usage.js';

const USAGE = 'usage: node cli.mjs <trace.json|trace.jsonl|-> [--json] [--steps] [--price N | --price-in N --price-out N] [--tasks 10,1000]';

function parseArgs(argv) {
  const opts = { file: null, json: false, steps: false, price: null, tasks: null };
  const price = {};
  for (let n = 0; n < argv.length; n++) {
    const a = argv[n];
    const val = () => {
      if (n + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++n];
    };
    if (a === '--json') opts.json = true;
    else if (a === '--steps') opts.steps = true;
    else if (a === '--price') price.per_million = val();
    else if (a === '--price-in') price.per_million_in = val();
    else if (a === '--price-out') price.per_million_out = val();
    else if (a === '--tasks') opts.tasks = val().split(',').map((x) => {
      const t = Number(x);
      if (!Number.isInteger(t) || t < 1) throw new Error(`--tasks wants whole numbers, got "${x}"`);
      return t;
    });
    else if (a === '-h' || a === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (opts.file === null) opts.file = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (Object.keys(price).length) opts.price = price;
  if (opts.file === null) throw new Error('no trace file given');
  return opts;
}

const n = (x) => Number(x).toLocaleString('en-US');
const cost = (x) => Number(x.toPrecision(6)).toLocaleString('en-US', { maximumFractionDigits: 6 });

function textReport(file, result, findings, u, showSteps) {
  const out = [];
  out.push('Agent Trace Clinic report');
  out.push(`Trace: ${file === '-' ? 'stdin' : file.split(/[\\/]/).pop()}  Format: ${result.format} (${result.container}), ${result.steps.length} steps`);
  out.push('');
  const problems = findings.filter((f) => f.severity !== 'info');
  out.push(problems.length ? `Findings (${problems.length}):` : 'Findings: none from the deterministic detectors.');
  for (const f of problems) {
    out.push(`  [${f.severity}] ${f.id}  steps ${f.steps.join(', ')}`);
    out.push(`    evidence: ${f.evidence}`);
    out.push(`    why: ${f.explain}`);
    if (f.id === 'context_growth') {
      out.push(`    curve: ${f.data.curve.map((p) => `#${p.i} ${n(p.tokens_in)}`).join(' -> ')}`);
    }
  }
  out.push('');
  if (u.per_task.model_calls === 0) {
    out.push('Tokens: this trace records no token counts.');
  } else {
    const t = u.per_task;
    out.push(`Tokens per task: in ${n(t.tokens_in)}, out ${n(t.tokens_out)}, total ${n(t.total)} (${t.model_calls} model calls${t.complete ? '' : '; some counts missing'})`);
    const curve = contextCurve(result.steps);
    if (curve.length > 1) out.push(`Context curve (tokens_in): ${curve.map((p) => n(p.tokens_in)).join(' -> ')}`);
    for (const d of u.per_day) {
      out.push(`  per day at ${n(d.tasks)} tasks: in ${n(d.tokens_in)}, out ${n(d.tokens_out)}, total ${n(d.total)}${'cost' in d ? `, cost ${cost(d.cost)} (your price units)` : ''}`);
    }
    if (u.price) out.push(`  cost per task: ${cost(u.cost_per_task)} (at your price per million tokens: in ${u.price.per_million_in}, out ${u.price.per_million_out})`);
    else out.push('  no price given; add --price-in and --price-out (per million tokens) to compute cost');
  }
  if (showSteps) {
    out.push('');
    out.push('Steps:');
    for (const s of result.steps) {
      const what = s.kind === 'message' ? s.text : s.kind === 'tool_call' ? `${s.tool}(${s.args ?? ''})` : `${s.tool ?? '?'} -> ${s.text}`;
      const tok = s.tokens_in !== null || s.tokens_out !== null ? `  [in ${s.tokens_in ?? '?'} / out ${s.tokens_out ?? '?'}]` : '';
      out.push(`  #${s.i} ${s.role} ${s.kind}${s.error ? ' ERROR' : ''}: ${what.replace(/\s+/g, ' ').slice(0, 100)}${tok}`);
    }
  }
  out.push('');
  out.push('Deterministic checks only; see README.md for each rule and what it cannot see.');
  return out.join('\n');
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exit(2);
  }
  let text;
  try {
    text = readFileSync(opts.file === '-' ? 0 : opts.file, 'utf8');
  } catch (e) {
    console.error(`cannot read ${opts.file}: ${e.code || e.message}`);
    process.exit(2);
  }
  let result;
  let u;
  try {
    result = normalise(text);
    u = usage(result.steps, { price: opts.price, ...(opts.tasks ? { tasksPerDay: opts.tasks } : {}) });
  } catch (e) {
    if (e instanceof TraceFormatError || e instanceof RangeError) {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }
  const findings = runDetectors(result.steps);
  if (opts.json) {
    console.log(JSON.stringify({ format: result.format, container: result.container, steps: result.steps, findings, usage: u }, null, 2));
  } else {
    console.log(textReport(opts.file, result, findings, u, opts.steps));
  }
}

main();
