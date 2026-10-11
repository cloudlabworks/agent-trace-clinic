# Agent Trace Clinic

Paste an AI agent's trace and get a triage report. This repository holds the parts that need no model: a normaliser that turns four trace formats into one step list, deterministic detectors that look for common agent failures, a usage calculator, a test suite of synthetic traces with their expected findings, and a small CLI.

Everything is plain JavaScript (ES modules), with no build step and no dependencies. `normalise.js`, `detectors.js` and `usage.js` use no Node built-ins, so the same files run in a browser page and under Node. Nothing is sent anywhere: the analysis is local.

```
node test.mjs                      # run every case and unit check
node cli.mjs trace.json            # text report
node cli.mjs trace.jsonl --json    # machine-readable report
node cli.mjs trace.json --steps    # also list the normalised steps
node cli.mjs trace.json --price-in N --price-out N   # optional: your price per million tokens
node cli.mjs trace.json --price N                    # optional: one price for all tokens
node cli.mjs trace.json --tasks 10,1000              # tasks per day to project (default 10 and 1,000)
node cli.mjs - < trace.json        # read from stdin
```

Needs a current Node.js (tested with Node 26). The CLI exits 0 after a report, and 2 on unreadable input or an unrecognised format.

## Input formats

A trace is one task: one run of an agent from request to final answer. The input can be a single JSON document, or JSONL with one message or span per line. JSON is tried first; if it fails to parse, each non-empty line is parsed separately, and the first bad line is reported by number.

| Format | Recognised by | What becomes a step |
| --- | --- | --- |
| `openai`: OpenAI chat-completions messages (an array, or `{"messages": [...]}`) | any message with `tool_calls`, or with role `tool` | each message; an assistant message becomes its text (if any) and then one `tool_call` step per entry in `tool_calls`; each `tool` message becomes a `tool_result` |
| `anthropic`: Anthropic Messages (an array, or `{"system": ..., "messages": [...]}`) | any content block of type `tool_use` or `tool_result` | adjacent `text` blocks become one `message`, `tool_use` becomes `tool_call`, `tool_result` becomes `tool_result`, in block order; `thinking`, `redacted_thinking`, `image` and `document` blocks are skipped |
| `chat-text`: plain role/content chat with no tool use | every message has text-only content | one `message` step per message |
| `otel-genai`: OpenTelemetry GenAI spans: OTLP JSON (`resourceSpans[].scopeSpans[].spans[]`), a flat span array, or `{"spans": [...]}` | spans carrying `gen_ai.operation.name` | each `execute_tool` span becomes a `tool_call` plus a `tool_result`; each `chat`, `text_completion` or `generate_content` span becomes one assistant `message` carrying its token counts |

Anything else fails with an error that starts `Unrecognised trace format:` and says why. That includes an empty list, an unknown role, an unknown Anthropic block type, legacy OpenAI `function_call` messages, a list that mixes OpenAI and Anthropic tool markers, a list that mixes messages and spans, and spans with no `gen_ai.operation.name`. The normaliser never guesses a format.

### Step shape

```
{ i, role, kind: "message" | "tool_call" | "tool_result", tool, args, text, tokens_in, tokens_out, error }
```

- `i` is the 0-based position in the step list.
- `args` is canonical JSON: the arguments are parsed (OpenAI sends them as a string), object keys are sorted at every depth, and whitespace is removed. So `{"b": 1, "a": 2}` and `{"a":2,"b":1}` are the same call. An argument string that is not valid JSON is kept as a JSON string literal.
- On a `tool_result`, `tool` and `args` are copied from the call it answers, which is matched by `tool_call_id` (OpenAI) or `tool_use_id` (Anthropic). OTel `execute_tool` spans carry both on the span.
- `tokens_in` and `tokens_out` are `null` when the trace does not record them. Nothing is estimated. A message's counts go on the first step that message produced, never on more than one step.
  - OpenAI: `usage.prompt_tokens` and `usage.completion_tokens` on an assistant message (or `input_tokens` and `output_tokens`). Chat-completions responses carry usage, but a stored message list often drops it.
  - Anthropic: `usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens` in, and `output_tokens` out. Anthropic's `input_tokens` counts only the tokens after the last cache breakpoint, so the sum is the real context size.
  - OTel: `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` on inference spans. The spec says input tokens SHOULD include cached tokens.
- `error` is true on a failed tool result:
  - Anthropic: the `tool_result` block has `is_error: true`.
  - OTel: the span status code is ERROR (`2`, `"STATUS_CODE_ERROR"` or `"ERROR"`), or the span has an `error.type` attribute.
  - OpenAI: the message format has no error flag, so the rule is that the tool message sets `is_error` or `error` to true, or its content is a JSON object with a non-null, non-false top-level `error` key, or its content starts with `Error`, `Exception` or `Traceback` (case-insensitive, after leading whitespace). A tool that reports failure any other way is read as a success.

### OpenTelemetry details

Written against the OpenTelemetry GenAI semantic conventions, which have moved out of the main semantic-conventions repository into [open-telemetry/semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai). That repository has no tagged release yet. This code follows its `main` branch at commit `6fd0d76` (2026-10-09), which builds on core semantic conventions v1.44.0. All GenAI attributes used here have status Development, so they may still change.

- Spans: [docs/gen-ai/gen-ai-spans.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md) (execute tool span)
- Inference: [docs/gen-ai/client-inference.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/client-inference.md) (chat spans, `gen_ai.output.messages`, usage)

Attributes read: `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.output.messages` (parts of type `text` and `tool_call`), and `error.type`, plus the span status.

- OTLP attribute lists (`[{key, value: {stringValue | intValue | ...}}]`) and plain attribute objects are both accepted. `gen_ai.tool.call.arguments` and `gen_ai.output.messages` may be JSON strings or structured values.
- Spans are ordered by start time (`startTimeUnixNano`, compared as big integers, or an ISO `start_time`) when every GenAI span has one. Otherwise input order is kept.
- `gen_ai.input.messages` is not read. It replays the whole history on every inference span, so reading it would count tokens twice and create false loops. As a result, the user's request does not appear as a step in OTel traces.
- When a trace has `execute_tool` spans, tool calls come only from those spans. When it has none, `tool_call` parts in `gen_ai.output.messages` become `tool_call` steps with no results. Only the first output message (the first choice) is read.
- `invoke_agent`, `create_agent`, `invoke_workflow`, `plan`, `embeddings`, `retrieval` and memory operations are skipped, as are non-GenAI spans such as HTTP spans.

## Detectors

Each detector is a pure function over the step list. Each one returns findings shaped `{id, severity, steps: [i...], evidence, explain}`, and some add a `data` field. Evidence is a quote of at most 80 characters. Severity is one of `high`, `medium`, `low` or `info`. The exact rules:

| id | Severity | Rule |
| --- | --- | --- |
| `tool_loop` | high | Three or more `tool_call` steps with the same `tool` and identical canonical `args`, anywhere in the trace (not only back to back). One finding per tool+args group; `steps` lists the calls. |
| `retry_storm` | high | Three or more `tool_result` steps with `error: true` for the same `tool`, whatever the args. One finding per tool; `steps` lists the failed results. |
| `context_growth` | medium if the multiple is at least 2, high if at least 5 | Take every step with a recorded `tokens_in` (the context curve). Fire if there are at least 3 points, the curve never goes down, the first value is above 0, and last / first is at least 2. `steps` lists the points. `data` carries the curve, first, last and the multiple. A curve that dips once (for example after compaction) does not fire. |
| `unhandled_tool_error` | medium | A failed `tool_result` is unhandled when the next `tool_call` after it has the same tool and identical canonical args, or when the failed result is the last step of the trace. One finding per tool+args group; `steps` lists the unhandled failed results. |
| `unproven_completion` | high | An assistant `message` contains a completion claim, and no `tool_call` step comes after it. One finding per message. |
| `token_totals` | info | Present when any step records tokens. `steps` lists those steps. `data` holds the per-step counts and the task totals (in, out, total, model calls). |

A completion claim is a sentence (split on `.`, `!`, `?` and newlines) that contains one of these whole words, in any case: done, fixed, deployed, passed, passes, passing, complete, completed, resolved, succeeded, successfully, shipped, merged. Questions (sentences ending in `?`) are skipped. So is a match when any of the three words right before it is one of: not, no, never, cannot, unable, failed, fail, will, once, until, after, if, when, before, yet, still, need, needs, should, would, could, might, may, or any word ending in `n't` or `'ll`. That way "not done yet", "could not be completed" and "I'll get it done" don't count.

## Usage at scale

`usage.js` adds up tokens for the task, which is the whole trace, and multiplies them per day at 10 and 1,000 tasks (configurable). No prices ship with this project. You can pass a price per million tokens, either in and out separately or one price for both, in whatever unit you use. Cost is then computed in that same unit. With no price, no cost is computed or printed. `per_task.complete` is false when some model call recorded only one side of its token counts.

## Cases

`cases/` holds 17 synthetic traces. Every one is made up for this suite and none comes from a real agent. `cases/expected.json` lists the exact findings each must produce (id, severity, steps, and an evidence substring), or the error it must raise. The expected findings were written from each case's design, before the detectors were run on it. The test fails on a missing finding or an extra one.

| Case | Format | Designed failure | Expected findings |
| --- | --- | --- | --- |
| `openai-tool-loop.json` | openai | same search 3 times, argument keys reordered | tool_loop, token_totals |
| `openai-unproven-completion.json` | openai (`{messages}`) | edits a file, says "Fixed." without re-running the test; an earlier "Not done yet" must not count | unproven_completion, token_totals |
| `openai-clean.json` | openai | control: set, then read back; a JSON result with `"error": null` is not an error | token_totals |
| `openai-unhandled-error.jsonl` | openai, JSONL | permission error, identical retry, then a change of tool | unhandled_tool_error (first error only), token_totals |
| `anthropic-retry-storm.json` | anthropic | migration fails 3 times with different timeouts | retry_storm, token_totals |
| `anthropic-context-growth.json` | anthropic (`{system, messages}`) | reads ever-larger logs; one turn reports cache reads | context_growth (high, 8.5x), token_totals |
| `anthropic-clean.json` | anthropic | control: "Deployed." followed by a health check | token_totals |
| `anthropic-false-done-after-error.json` | anthropic | restart fails, agent says "Done" | unproven_completion, token_totals |
| `anthropic-unproven.jsonl` | anthropic, JSONL | CI still pending, agent says it merged; no token counts | unproven_completion |
| `otel-tool-loop.json` | otel-genai, OTLP | same fetch 4 times; spans shuffled in the file; an HTTP span and an `invoke_agent` span to skip | tool_loop, token_totals |
| `otel-retry-storm.json` | otel-genai, flat spans | identical query times out 3 times, then a cache read | tool_loop, retry_storm, unhandled_tool_error (first two errors), token_totals |
| `otel-clean.json` | otel-genai, OTLP | control: one tool call, structured result | token_totals |
| `otel-growth-unproven.jsonl` | otel-genai, JSONL | tests fail, a patch, then "All tests passed" with no re-run; context grows 2.3x | context_growth (medium), unproven_completion, token_totals |
| `chat-text-plain.json` | chat-text | control: no tools, no claims | none |
| `unknown-format.json` | none | an unrelated JSON document | error |
| `mixed-formats.json` | none | OpenAI tool_calls with an Anthropic tool_result | error |
| `bad-line.jsonl` | none | line 3 is not valid JSON | error naming line 3 |

`node test.mjs` runs every case plus unit checks on canonical JSON, each format's edge cases, each detector's thresholds, and usage with and without a price. It prints pass and fail counts and exits non-zero on any failure.

## Limits

What these checks cannot see:

- Intent. A loop of three identical calls may be legitimate polling, and a "done" may be true. The findings point at steps to read; they are not verdicts.
- Whether a later tool call actually checks the claim. `unproven_completion` clears a claim if any tool call follows it, even an unrelated one. It also flags a final "done" that follows a verification, because the receipt has to come after the claim. Claim words outside the list ("it works now", "all good") are missed, and claim words used in other senses ("what I've done so far") can match.
- Tool failures a tool doesn't mark. An OpenAI tool that returns "could not connect" without a leading `Error` reads as a success. So does an OTel span with no error status.
- An agent that stops after a failure. `unhandled_tool_error` only looks at the next tool call. If the agent writes a message after the error and then makes no more calls, that does not count as unhandled. A false "done" in that message is caught by `unproven_completion` instead.
- Retries inside a tool, or retries done automatically by an SDK. The OTel spec puts those inside one span, so they don't show in the trace.
- Tokens the trace doesn't record. There is no estimate, so a trace without usage gets no context curve and no totals.
- Anything outside one trace. There is no cross-task view: no memory that forgets between sessions, and no daily bill. Per-day figures are one trace times N.
- Multi-agent traces. Steps from sub-agents are flattened into one list, so their tool calls are pooled.
- Other trace schemas, such as framework-specific session logs and OpenAI Responses API items. These are rejected rather than guessed at.

---

Independent project by Alex Alvord, CloudLab Works. MIT licence.
