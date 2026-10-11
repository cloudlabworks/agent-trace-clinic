// Agent Trace Clinic: usage at scale.
// Tokens for one task (one trace), and per day at a given number of tasks.
// No prices ship with this project. A price is an optional caller input, in
// whatever unit the caller uses, per million tokens; the result is in the
// same unit. Without a price, no cost is computed.

import { tokenTotals } from './detectors.js';

export const DEFAULT_TASKS_PER_DAY = [10, 1000];

function checkPrice(name, v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`${name} must be a number of at least 0 (price per million tokens)`);
  return n;
}

// price (optional): { per_million_in, per_million_out } or { per_million }
// (one price for all tokens). Returns:
// { per_task: {tokens_in, tokens_out, total, model_calls, complete},
//   per_day: [{tasks, tokens_in, tokens_out, total, cost?}],
//   price: null | {...}, cost_per_task: null | number }
export function usage(steps, { price = null, tasksPerDay = DEFAULT_TASKS_PER_DAY } = {}) {
  const t = tokenTotals(steps);
  // complete is false when a model call recorded only one side of its counts.
  const complete = t.per_step.length > 0 && t.per_step.every((p) => p.tokens_in !== null && p.tokens_out !== null);
  const per_task = { tokens_in: t.tokens_in, tokens_out: t.tokens_out, total: t.total, model_calls: t.model_calls, complete };

  let p = null;
  if (price) {
    const all = checkPrice('per_million', price.per_million);
    const pin = checkPrice('per_million_in', price.per_million_in);
    const pout = checkPrice('per_million_out', price.per_million_out);
    if (all !== null && (pin !== null || pout !== null)) {
      throw new RangeError('give either per_million, or per_million_in and per_million_out, not both');
    }
    if (all !== null) p = { per_million_in: all, per_million_out: all };
    else if (pin !== null || pout !== null) {
      if (pin === null || pout === null) throw new RangeError('give both per_million_in and per_million_out');
      p = { per_million_in: pin, per_million_out: pout };
    }
  }

  const costOf = (tin, tout) => (p === null ? null : (tin / 1e6) * p.per_million_in + (tout / 1e6) * p.per_million_out);
  const cost_per_task = costOf(per_task.tokens_in, per_task.tokens_out);

  const per_day = tasksPerDay.map((tasks) => {
    const row = {
      tasks,
      tokens_in: per_task.tokens_in * tasks,
      tokens_out: per_task.tokens_out * tasks,
      total: per_task.total * tasks,
    };
    if (p !== null) row.cost = cost_per_task * tasks;
    return row;
  });

  return { per_task, per_day, price: p, cost_per_task };
}
