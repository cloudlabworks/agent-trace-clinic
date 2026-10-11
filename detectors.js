// Agent Trace Clinic: deterministic detectors.
// Pure functions over the step list from normalise.js (forgotten_instruction
// also reads the instructions normalise() returns beside the steps). No model,
// no I/O, no Node built-ins. Each returns findings:
//   { id, severity, steps: [i...], evidence: "short quote", explain, data? }
// Severity is one of: "high", "medium", "low", "info".

export const RULES = {
  loopMin: 3, // tool_loop: same tool + identical canonical args at least this many times
  retryMin: 3, // retry_storm: same tool returning an error at least this many times
  growthMinPoints: 3, // context_growth: model calls with a recorded tokens_in
  growthMultiple: 2, // context_growth: last / first at least this
  growthMinPerCall: 300, // context_growth: and (last - first) / (points - 1) at least this many tokens
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
  const perCall = (last - first) / (curve.length - 1);
  // Both gates: the context at least doubled, and it grew by enough tokens per
  // call to matter. The second gate keeps a small first call from tripping
  // the first one on ordinary turn-by-turn growth.
  if (multiple < RULES.growthMultiple || perCall < RULES.growthMinPerCall) return [];
  const m = Math.round(multiple * 10) / 10;
  const pc = Math.round(perCall);
  return [
    {
      id: 'context_growth',
      severity: multiple >= RULES.growthHighMultiple ? 'high' : 'medium',
      steps: curve.map((p) => p.i),
      evidence: `tokens_in ${fmt(first)} -> ${fmt(last)} (${m}x) over ${curve.length} model calls, +${fmt(pc)} per call`,
      explain:
        `Input tokens rose on every model call, by ${fmt(pc)} per call on average, and ended ${m} times where they started. ` +
        'Each call re-sends the whole history, so cost and latency per call keep climbing; ' +
        'summarising or trimming tool output is the usual fix.',
      data: { curve, first, last, multiple, per_call: perCall },
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

// ---- tool calls: check or change
// A check reads state without changing it. Everything that is not a check is
// treated as a change, including tools whose names say nothing either way.
export const CHECK_WORDS = new Set([
  'get', 'read', 'list', 'ls', 'show', 'view', 'describe', 'status', 'check', 'verify', 'validate', 'test', 'tests',
  'health', 'healthz', 'healthcheck', 'search', 'query', 'fetch', 'find', 'lookup', 'inspect', 'diff', 'log', 'logs',
  'ping', 'lint', 'cat', 'grep', 'curl', 'wget', 'poll', 'count', 'exists',
]);
// A change word overrides a check word in the same name (update_status is a change).
export const CHANGE_WORDS = new Set([
  'set', 'update', 'write', 'edit', 'patch', 'create', 'add', 'insert', 'delete', 'remove', 'drop', 'put', 'post',
  'deploy', 'restart', 'start', 'stop', 'kill', 'merge', 'push', 'commit', 'apply', 'install', 'uninstall', 'send',
  'upload', 'move', 'rename', 'copy', 'reset', 'close', 'open', 'approve', 'publish', 'release', 'rollback',
  'migrate', 'scale', 'enable', 'disable', 'assign', 'submit', 'save', 'replace', 'append', 'clear', 'revert',
]);
// Shell-style tools: every word of the name is one of these. They are classified by their command.
const SHELL_WORDS = new Set(['bash', 'shell', 'sh', 'zsh', 'terminal', 'exec', 'execute', 'run', 'command', 'cmd', 'local']);
const SHELL_CHECK_FIRST = new Set([
  'cat', 'ls', 'head', 'tail', 'grep', 'rg', 'find', 'stat', 'wc', 'diff', 'curl', 'wget', 'ping', 'pytest', 'jest',
  'vitest', 'mocha', 'tox',
]);
const SHELL_CHECK_TWO = new Set([
  'git status', 'git diff', 'git log', 'git show', 'npm test', 'pnpm test', 'yarn test', 'node --test', 'make test',
  'make check', 'go test', 'go vet', 'cargo test', 'cargo check', 'kubectl get', 'kubectl describe', 'kubectl logs',
  'systemctl status', 'docker ps', 'docker logs', 'docker inspect',
]);

// Words of a tool name: split on anything that is not a letter or digit, and at camelCase humps.
export function nameWords(name) {
  return String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function shellCommand(args) {
  let a;
  try {
    a = JSON.parse(args ?? 'null');
  } catch {
    return null;
  }
  const c = a && typeof a === 'object' && !Array.isArray(a) ? a.command ?? a.cmd : null;
  if (Array.isArray(c) && c.every((x) => typeof x === 'string')) return c.join(' ');
  return typeof c === 'string' ? c : null;
}

function shellIsCheck(command) {
  if (/>|\btee\b/.test(command)) return false; // writes a file
  const segments = command.split(/&&|\|\||;|\|/).map((x) => x.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((seg) => {
    const words = seg.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && w !== 'sudo');
    const first = (words[0] ?? '').split('/').pop();
    if (first === 'curl' || first === 'wget') {
      return !/(^|\s)(-X|--request|-d|--data\S*|-F|--form|-T|--upload-file|--post-data|--method)(\s|=|$)/.test(seg) || /(-X|--request)[\s=]+GET\b/.test(seg);
    }
    if (SHELL_CHECK_FIRST.has(first)) return true;
    return SHELL_CHECK_TWO.has(`${first} ${words[1] ?? ''}`) || (first === 'npm' && words[1] === 'run' && words[2] === 'test');
  });
}

// True when a tool call only reads state (a check), false when it is a change.
export function isCheckCall(step) {
  const words = nameWords(step.tool);
  if (words.length > 0 && words.every((w) => SHELL_WORDS.has(w))) {
    const command = shellCommand(step.args);
    return command !== null && shellIsCheck(command);
  }
  return words.some((w) => CHECK_WORDS.has(w)) && !words.some((w) => CHANGE_WORDS.has(w));
}

// A claim at step c is proven when a check runs after the last change made
// before c: before the claim or after it. A check whose result is marked as an
// error proves nothing. A change counts as a change even when it failed.
export function detectUnprovenCompletion(steps) {
  const findings = [];
  const calls = steps.filter((t) => t.kind === 'tool_call');
  // The result of a call: the first unused tool_result after it with the same tool and args.
  const used = new Set();
  const results = new Map();
  for (const call of calls) {
    const r = steps.find((t) => t.i > call.i && t.kind === 'tool_result' && !used.has(t.i) && t.tool === call.tool && t.args === call.args);
    if (r) {
      used.add(r.i);
      results.set(call.i, r);
    }
  }
  const goodCheck = (call) => isCheckCall(call) && !(results.get(call.i)?.error === true);
  for (const s of steps) {
    if (s.kind !== 'message' || s.role !== 'assistant') continue;
    const claim = findClaim(s.text);
    if (claim === null) continue;
    const changes = calls.filter((t) => t.i < s.i && !isCheckCall(t));
    const lastChange = changes.length ? changes[changes.length - 1].i : -1;
    if (calls.some((t) => t.i > lastChange && goodCheck(t))) continue;
    findings.push({
      id: 'unproven_completion',
      severity: 'high',
      steps: [s.i],
      evidence: quote(claim),
      explain:
        (lastChange >= 0
          ? `The agent says the work is finished, and no check (a read, a test, a status call) ran after its last change at step ${lastChange}. `
          : 'The agent says the work is finished, and no check (a read, a test, a status call) ran in this task. ') +
        'A receipt after the change, before or after the claim, is what turns "done" into a fact.',
    });
  }
  return findings;
}

// ---------------------------------------------------------------- forgotten_instruction

// Understood phrasings (each must start a sentence of the system/developer
// instructions; see README.md for the exact grammar):
//   forbidden_tool  Never|Do not|Don't|(You) must not|(You) must never  call|use|run|invoke|execute  [the] TOOL [tool].
//   tools_only      Only call|use / (You) may only call|use / Use only / Call only  TOOL[, TOOL]* [and|or TOOL] [tools].
//   forbidden_text  Never|Do not|Don't|(You) must not|(You) must never  VERB ... "LITERAL" ...
//   required_text   Always|(You) must  ... "LITERAL" ...   (only when the sentence names a tool, see below)
const NEG = String.raw`(?:never|do not|don't|don’t|(?:you )?must not|(?:you )?must never|you mustn't|mustn't)`;
const FORBID_TOOL_RE = new RegExp(String.raw`^${NEG} (?:call|use|run|invoke|execute) (?:the )?\x60?([A-Za-z][\w-]*(?:\.[\w-]+)*)\x60?(?: tool)?[.!]?$`, 'i');
const ONLY_RE = /^(?:only (?:call|use)|(?:you )?may only (?:call|use)|use only|call only) (?:the )?(?:tools? )?(.+?)(?: tools?)?[.!]?$/i;
const FORBID_TEXT_RE = new RegExp(String.raw`^${NEG} (?:say|write|mention|use|include|output|print|reveal|send|share|type|enter|promise|add|put)\b`, 'i');
const REQUIRE_RE = /^(?:always|(?:you )?must)\s+(?!not\b|never\b)/i;
// A sentence with any of these words has a condition or an order the detector does not model; it is skipped.
const CONDITION_RE = /\b(?:unless|except|if|when|whenever|until|before|after|without|while|otherwise|instead|once|first|then|more than|less than|fewer than|at most|at least|twice|again)\b/i;
const QUOTED_RE = /"([^"\n]{1,60})"|“([^”\n]{1,60})”|`([^`\n]{1,60})`/g;

// Split instruction text into sentences without breaking inside quotes.
export function instructionSentences(text) {
  const out = [];
  let cur = '';
  let inStraight = false;
  let inCurly = false;
  let inTick = false;
  const t = String(text ?? '');
  for (let k = 0; k < t.length; k++) {
    const ch = t[k];
    cur += ch;
    if (ch === '"') inStraight = !inStraight;
    else if (ch === '“') inCurly = true;
    else if (ch === '”') inCurly = false;
    else if (ch === '`') inTick = !inTick;
    const quoted = inStraight || inCurly || inTick;
    if (ch === '\n' || (!quoted && /[.!?;]/.test(ch) && (k + 1 >= t.length || /\s/.test(t[k + 1])))) {
      out.push(cur);
      cur = '';
      inStraight = inCurly = inTick = false;
    }
  }
  out.push(cur);
  return out
    .map((x) => x.replace(/\s+/g, ' ').trim().replace(/^(?:\d+[.)]|[-*•])\s+/, '').replace(/;$/, '.'))
    .filter((x) => x !== '' && !/^(?:\d+[.)]|[-*\u2022])$/.test(x));
}

function literals(sentence) {
  return [...sentence.matchAll(QUOTED_RE)].map((m) => m[1] ?? m[2] ?? m[3]);
}

function escapeRe(x) {
  return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsLiteral(text, lit) {
  const edge = (c) => (/\w/.test(c) ? '\\b' : '');
  return new RegExp(`${edge(lit[0])}${escapeRe(lit)}${edge(lit[lit.length - 1])}`, 'i').test(String(text ?? ''));
}

function argStrings(args) {
  let v;
  try {
    v = JSON.parse(args ?? 'null');
  } catch {
    return [];
  }
  const out = [];
  const walk = (x) => {
    if (typeof x === 'string') out.push(x);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  };
  walk(v);
  return out;
}

// Tools a sentence is about: named exactly, or every word of the tool's name
// appears in the sentence (allowing -s, -es, -d, -ed, -ing endings).
function targetTools(sentence, tools) {
  const words = new Set(sentence.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean));
  const has = (w) => [w, `${w}s`, `${w}es`, `${w}d`, `${w}ed`, `${w}ing`, `${w.replace(/e$/, '')}ing`].some((f) => words.has(f));
  return [...tools].filter((tool) => {
    if (new RegExp(`(^|[^\\w.-])\x60?${escapeRe(tool)}\x60?($|[^\\w-]|\\.(\\s|$))`).test(sentence)) return true;
    const nw = nameWords(tool);
    return nw.length >= 2 && nw.every(has);
  });
}

// Parse one sentence into a constraint, or null when it is not understood.
export function parseConstraint(sentence, tools) {
  if (CONDITION_RE.test(sentence)) return null;
  const isTool = (x) => tools.has(x);
  let m = sentence.match(FORBID_TOOL_RE);
  if (m && isTool(m[1])) return { kind: 'forbidden_tool', sentence, tools: [m[1]] };
  m = sentence.match(ONLY_RE);
  if (m) {
    const items = m[1].split(/\s*,\s*(?:and |or )?|\s+(?:and|or)\s+/).map((x) => x.replace(/^\x60|\x60$/g, '').trim());
    if (items.length > 0 && items.every((x) => /^[A-Za-z][\w.-]*$/.test(x) && (isTool(x) || /[_.-]|[a-z][A-Z]/.test(x)))) {
      return { kind: 'tools_only', sentence, tools: items };
    }
    return null;
  }
  const lits = literals(sentence);
  if (lits.length !== 1 || lits[0].trim() === '') return null;
  const lit = lits[0].trim();
  if (FORBID_TEXT_RE.test(sentence)) return { kind: 'forbidden_text', sentence, literal: lit, tools: targetTools(sentence, tools) };
  if (REQUIRE_RE.test(sentence)) {
    const targets = targetTools(sentence, tools);
    if (targets.length === 0) return null; // a requirement we cannot tie to a tool call is not checked
    return { kind: 'required_text', sentence, literal: lit, tools: targets };
  }
  return null;
}

// Instructions from normalise() (ctx.instructions), or else the system and
// developer messages in the step list.
function instructionsOf(steps, ctx) {
  if (ctx && Array.isArray(ctx.instructions)) return ctx.instructions;
  return steps
    .filter((s) => s.kind === 'message' && (s.role === 'system' || s.role === 'developer') && s.text.trim() !== '')
    .map((s) => ({ step: s.i, text: s.text, per_call: false }));
}

function violates(c, s) {
  if (c.kind === 'forbidden_tool') return s.kind === 'tool_call' && c.tools.includes(s.tool);
  if (c.kind === 'tools_only') return s.kind === 'tool_call' && !c.tools.includes(s.tool);
  if (c.kind === 'forbidden_text') {
    if (c.tools.length) return s.kind === 'tool_call' && c.tools.includes(s.tool) && argStrings(s.args).some((x) => containsLiteral(x, c.literal));
    return s.kind === 'message' && s.role === 'assistant' && containsLiteral(s.text, c.literal);
  }
  if (c.kind === 'required_text') {
    return s.kind === 'tool_call' && c.tools.includes(s.tool) && !argStrings(s.args).some((x) => containsLiteral(x, c.literal));
  }
  return false;
}

export function detectForgottenInstructions(steps, ctx = {}) {
  const instructions = instructionsOf(steps, ctx);
  if (instructions.length === 0) return [];
  const tools = new Set(steps.filter((s) => s.kind === 'tool_call' && s.tool !== null).map((s) => s.tool));
  // Every understood sentence, once, from the first step it applies to.
  const constraints = new Map();
  for (const ins of [...instructions].sort((a, b) => a.step - b.step)) {
    for (const sentence of instructionSentences(ins.text)) {
      if (constraints.has(sentence)) continue;
      const c = parseConstraint(sentence, tools);
      if (c) constraints.set(sentence, { ...c, from: ins.step });
    }
  }
  const perCall = instructions.filter((x) => x.per_call).sort((a, b) => a.step - b.step);
  const findings = [];
  for (const c of constraints.values()) {
    const bad = steps.filter((s) => s.i > c.from && violates(c, s));
    if (bad.length === 0) continue;
    // With per-call instructions (OTel), was the sentence still there at each violation?
    const dropped = bad
      .filter((s) => {
        const inForce = perCall.filter((x) => x.step <= s.i).pop();
        return inForce !== undefined && !instructionSentences(inForce.text).includes(c.sentence);
      })
      .map((s) => s.i);
    const what = {
      forbidden_tool: `called ${c.tools[0]}`,
      tools_only: `called ${[...new Set(bad.map((s) => s.tool))].join(', ')}`,
      forbidden_text: `wrote "${c.literal}"`,
      required_text: `called ${[...new Set(bad.map((s) => s.tool))].join(', ')} without "${c.literal}"`,
    }[c.kind];
    findings.push({
      id: 'forgotten_instruction',
      severity: 'high',
      steps: bad.map((s) => s.i),
      evidence: quote(c.sentence),
      explain:
        `The instructions say: ${quote(c.sentence, 160)} The agent ${what} at step${bad.length > 1 ? 's' : ''} ${bad.map((s) => s.i).join(', ')}. ` +
        (dropped.length
          ? `The sentence was no longer in the per-call system instructions in force at step${dropped.length > 1 ? 's' : ''} ${dropped.join(', ')}: it was dropped from what the agent was given.`
          : 'The sentence was still in the instructions the agent had, so the agent ignored it.'),
      data: { kind: c.kind, instruction: c.sentence, literal: c.literal ?? null, tools: c.tools, from_step: c.from, dropped_at: dropped },
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
  detectForgottenInstructions,
  detectTokenTotals,
];

// ctx: optional extras from normalise(), currently { instructions }.
export function runDetectors(steps, ctx = {}) {
  const findings = DETECTORS.flatMap((d) => d(steps, ctx));
  return findings.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.steps[0] - b.steps[0] || a.id.localeCompare(b.id),
  );
}
