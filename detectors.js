// Agent Trace Clinic: deterministic detectors.
// Pure functions over the step list from normalise.js. No model, no I/O,
// no Node built-ins. Each returns findings:
//   { id, severity, steps: [i...], evidence: "short quote", explain, data? }
// Severity is one of: "high", "medium", "low", "info".

export const RULES = {
  loopMin: 3, // tool_loop: same tool + identical canonical args at least this many times
  retryMin: 3, // retry_storm: same tool returning an error at least this many times
  growthMinPoints: 3, // context_growth: model calls with a recorded tokens_in
  growthMultiple: 2, // context_growth: last / first at least this
  growthHighMultiple: 5, // context_growth: severity high at or above this
  quoteMax: 80, // evidence quotes are cut to this many characters
};

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, info: 3 };

export function quote(text, max = RULES.quoteMax) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 3)}...`;
}

function fmt(n) {
  return Number(n).toLocaleString('en-US');
}

function callLabel(tool, args) {
  return `${tool}(${args === null ? '' : args})`;
}

// ---------------------------------------------------------------- tool_loop

export function detectToolLoops(steps) {
  const groups = new Map();
  for (const s of steps) {
    if (s.kind !== 'tool_call') continue;
    const key = `${s.tool}\u0000${s.args}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const findings = [];
  for (const group of groups.values()) {
    if (group.length < RULES.loopMin) continue;
    const { tool, args } = group[0];
    findings.push({
      id: 'tool_loop',
      severity: 'high',
      steps: group.map((s) => s.i),
      evidence: quote(`${callLabel(tool, args)} called ${group.length} times`),
      explain:
        `The agent called ${tool} with identical arguments ${group.length} times. ` +
        'Repeating the same call expects a different answer from the same input; the usual fix is ' +
        'to feed the result back into the plan, or to stop after a set number of identical calls.',
    });
  }
  return findings;
}

// ---------------------------------------------------------------- retry_storm

export function detectRetryStorms(steps) {
  const groups = new Map();
  for (const s of steps) {
    if (s.kind !== 'tool_result' || !s.error || s.tool === null) continue;
    if (!groups.has(s.tool)) groups.set(s.tool, []);
    groups.get(s.tool).push(s);
  }
  const findings = [];
  for (const [tool, errs] of groups) {
    if (errs.length < RULES.retryMin) continue;
    findings.push({
      id: 'retry_storm',
      severity: 'high',
      steps: errs.map((s) => s.i),
      evidence: quote(`${tool} failed ${errs.length} times; first error: ${errs[0].text}`),
      explain:
        `${tool} returned an error ${errs.length} times in one task. ` +
        'Retries without backoff, a cap, or a change of input burn tokens and can hammer the service behind the tool.',
    });
  }
  return findings;
}

// ---------------------------------------------------------------- context_growth

export function contextCurve(steps) {
  return steps.filter((s) => s.tokens_in !== null && s.tokens_in !== undefined).map((s) => ({ i: s.i, tokens_in: s.tokens_in }));
}

export function detectContextGrowth(steps) {
  const curve = contextCurve(steps);
  if (curve.length < RULES.growthMinPoints) return [];
  for (let n = 1; n < curve.length; n++) {
    if (curve[n].tokens_in < curve[n - 1].tokens_in) return []; // not rising (e.g. compaction)
  }
  const first = curve[0].tokens_in;
  const last = curve[curve.length - 1].tokens_in;
  if (!(first > 0)) return [];
  const multiple = last / first;
  if (multiple < RULES.growthMultiple) return [];
  const m = Math.round(multiple * 10) / 10;
  return [
    {
      id: 'context_growth',
      severity: multiple >= RULES.growthHighMultiple ? 'high' : 'medium',
      steps: curve.map((p) => p.i),
      evidence: `tokens_in ${fmt(first)} -> ${fmt(last)} (${m}x) over ${curve.length} model calls`,
      explain:
        `Input tokens rose on every model call and ended ${m} times where they started. ` +
        'Each call re-sends the whole history, so cost and latency per call keep climbing; ' +
        'summarising or trimming tool output is the usual fix.',
      data: { curve, first, last, multiple },
    },
  ];
}

// ---------------------------------------------------------------- unhandled_tool_error

// An error result is unhandled when the next tool call after it repeats the
// same tool with identical arguments, or when it is the last step of the trace.
export function detectUnhandledErrors(steps) {
  const groups = new Map();
  for (const r of steps) {
    if (r.kind !== 'tool_result' || !r.error || r.tool === null) continue;
    let flagged = false;
    if (r.i === steps.length - 1) {
      flagged = true;
    } else {
      const next = steps.find((s) => s.i > r.i && s.kind === 'tool_call');
      if (next && next.tool === r.tool && next.args === r.args) flagged = true;
    }
    if (!flagged) continue;
    const key = `${r.tool}\u0000${r.args}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const findings = [];
  for (const errs of groups.values()) {
    const { tool, args } = errs[0];
    findings.push({
      id: 'unhandled_tool_error',
      severity: 'medium',
      steps: errs.map((s) => s.i),
      evidence: quote(`${callLabel(tool, args)} -> ${errs[0].text}`),
      explain:
        `${tool} failed${errs.length > 1 ? ` (${errs.length} times here)` : ''} and the next tool call was the identical call, ` +
        'or the trace ended on the error. Retrying unchanged input rarely changes the outcome; ' +
        'read the error, then change the arguments, switch tools, or stop and report it.',
    });
  }
  return findings;
}

// ---------------------------------------------------------------- unproven_completion

const CLAIM = /\b(done|fixed|deployed|passed|passes|passing|complete|completed|resolved|succeeded|successfully|shipped|merged)\b/i;
const HEDGE = new Set([
  'not', 'no', 'never', 'cannot', 'unable', 'failed', 'fail', 'will', 'once', 'until', 'after',
  'if', 'when', 'before', 'yet', 'still', 'need', 'needs', 'should', 'would', 'could', 'might', 'may',
]);
const HEDGE_WINDOW = 3; // words checked immediately before the claim word

// Returns the first sentence of text that claims completion, or null.
export function findClaim(text) {
  const sentences = String(text ?? '').split(/(?<=[.!?])\s+|\n+/);
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (sentence === '' || sentence.endsWith('?')) continue;
    const re = new RegExp(CLAIM.source, 'gi');
    let m;
    while ((m = re.exec(sentence)) !== null) {
      const before = sentence
        .slice(0, m.index)
        .toLowerCase()
        .replace(/\u2019/g, "'")
        .split(/\s+/)
        .map((w) => w.replace(/[^a-z']/g, ''))
        .filter(Boolean)
        .slice(-HEDGE_WINDOW);
      const hedged = before.some((w) => HEDGE.has(w) || w.endsWith("n't") || w.endsWith("'ll"));
      if (!hedged) return sentence;
    }
  }
  return null;
}

export function detectUnprovenCompletion(steps) {
  const findings = [];
  for (const s of steps) {
    if (s.kind !== 'message' || s.role !== 'assistant') continue;
    const claim = findClaim(s.text);
    if (claim === null) continue;
    const checked = steps.some((t) => t.i > s.i && t.kind === 'tool_call');
    if (checked) continue;
    findings.push({
      id: 'unproven_completion',
      severity: 'high',
      steps: [s.i],
      evidence: quote(claim),
      explain:
        'The agent says the work is finished, and no tool call comes after that claim. ' +
        'A receipt (a test run, a health check, a read-back) after the claim is what turns "done" into a fact.',
    });
  }
  return findings;
}

// ---------------------------------------------------------------- token_totals

export function tokenTotals(steps) {
  const per_step = steps
    .filter((s) => s.tokens_in !== null || s.tokens_out !== null)
    .map((s) => ({ i: s.i, tokens_in: s.tokens_in, tokens_out: s.tokens_out }));
  const tokens_in = per_step.reduce((a, p) => a + (p.tokens_in ?? 0), 0);
  const tokens_out = per_step.reduce((a, p) => a + (p.tokens_out ?? 0), 0);
  return { per_step, tokens_in, tokens_out, total: tokens_in + tokens_out, model_calls: per_step.length };
}

export function detectTokenTotals(steps) {
  const t = tokenTotals(steps);
  if (t.per_step.length === 0) return [];
  return [
    {
      id: 'token_totals',
      severity: 'info',
      steps: t.per_step.map((p) => p.i),
      evidence: `in ${fmt(t.tokens_in)}, out ${fmt(t.tokens_out)}, total ${fmt(t.total)} over ${t.model_calls} model calls`,
      explain: 'Token counts as recorded in the trace, per model call and summed for the task. Nothing is estimated.',
      data: t,
    },
  ];
}

// ---------------------------------------------------------------- all

export const DETECTORS = [
  detectToolLoops,
  detectRetryStorms,
  detectContextGrowth,
  detectUnhandledErrors,
  detectUnprovenCompletion,
  detectTokenTotals,
];

export function runDetectors(steps) {
  const findings = DETECTORS.flatMap((d) => d(steps));
  return findings.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.steps[0] - b.steps[0] || a.id.localeCompare(b.id),
  );
}
