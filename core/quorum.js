// Quorum ETA core: censoring-aware approver response models, Monte Carlo time-to-quorum,
// calibration backtest, and policy health (time-of-week coverage, single points of failure,
// and what-ifs that never lower a threshold). Pure ES module for the browser and node --test.
// Time unit: hours since T0 = Monday 2026-02-02 00:00 UTC.

export const T0 = Date.UTC(2026, 1, 2);
export const HOUR_MS = 3600000;
export const BUCKETS = ['Working hours', 'Evening', 'Night', 'Weekend'];
export const EXPIRY_H = 14 * 24;

export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function randn(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
export function expo(r) { let u = 0; while (u === 0) u = r(); return -Math.log(u); }

export const toDate = t => new Date(T0 + t * HOUR_MS);
export const fromDate = d => (d.getTime() - T0) / HOUR_MS;

// duty bucket for local hour-of-week (0 = Monday 00:00 local)
export function bucketOfLocal(how) {
  const day = Math.floor(how / 24), h = how % 24;
  if (day >= 5) return h >= 9 && h < 21 ? 3 : 2;
  if (h >= 8 && h < 18) return 0;
  if ((h >= 18 && h < 23) || h === 7) return 1;
  return 2;
}
export function localHow(t, offset) { return (((Math.floor(t) + offset) % 168) + 168) % 168; }
export function bucketAt(t, offset) { return bucketOfLocal(localHow(t, offset)); }

// ---------- quorum rules ----------
// policy: { m, members: [ids], sub: { min, members: [ids] } | null }
export function satisfied(policy, approvedSet) {
  let n = 0, s = 0;
  for (const id of approvedSet) if (policy.members.includes(id)) { n++; if (policy.sub && policy.sub.members.includes(id)) s++; }
  return n >= policy.m && (!policy.sub || s >= policy.sub.min);
}
// time at which the policy is first satisfied given approval times (Infinity if never)
export function quorumTime(policy, times) {
  const ev = Object.entries(times).filter(([, t]) => Number.isFinite(t)).sort((a, b) => a[1] - b[1]);
  const got = new Set();
  for (const [id, t] of ev) { got.add(id); if (satisfied(policy, got)) return t; }
  return Infinity;
}
// smallest number of distinct people who can satisfy the policy (a safety invariant)
export function minSigners(policy) {
  const sub = policy.sub ? policy.sub.min : 0; return Math.max(policy.m, sub);
}

// ---------- piecewise-exponential sampling ----------
// time from t until the approver acts, with hazard rates[b] per hour in duty bucket b.
// away: optional function (t) -> true if unavailable (generator truth only).
export function sampleResponse(r, t, rates, offset, cap = EXPIRY_H, away = null) {
  let H = expo(r), cur = t; const end = t + cap;
  while (cur < end) {
    const next = Math.min(Math.floor(cur) + 1, end);
    const rate = away && away(cur) ? 0 : rates[bucketAt(cur, offset)];
    const need = rate * (next - cur);
    if (need >= H) return cur + H / rate - t;
    H -= need; cur = next;
  }
  return Infinity;
}

// ---------- fitting ----------
// Censoring-aware MLE for a piecewise-constant hazard: rate = events / exposure in each duty
// bucket. Every eligible approver is "at risk" from notification until they approve or the
// operation leaves the queue (quorum met, rejected or expired); time after that is censored.
// Per-approver rates are shrunk toward the pooled bucket rate with `prior` pseudo-hours.
export function exposureSplit(t0, t1, offset, acc) {
  let cur = t0;
  while (cur < t1) { const next = Math.min(Math.floor(cur) + 1, t1); acc[bucketAt(cur, offset)] += next - cur; cur = next; }
}

export function fitRates(org, ops, opts = {}) {
  const prior = opts.prior ?? 3; const naive = !!opts.naive;
  const ids = org.approvers.map(a => a.id); const off = Object.fromEntries(org.approvers.map(a => [a.id, a.offset]));
  const E = Object.fromEntries(ids.map(id => [id, [0, 0, 0, 0]])), X = Object.fromEntries(ids.map(id => [id, [0, 0, 0, 0]]));
  for (const op of ops) {
    const pol = org.policies[op.policy]; const end = op.quorumAt;
    for (const id of pol.members) {
      const ta = op.approvals[id];
      if (Number.isFinite(ta)) {
        exposureSplit(op.notifiedAt, ta, off[id], X[id]); E[id][bucketAt(ta, off[id])] += 1;
      } else if (!naive) {
        // still pending when the operation left the queue: censored, but the exposure counts
        exposureSplit(op.notifiedAt, Math.min(end, op.notifiedAt + EXPIRY_H), off[id], X[id]);
      }
    }
  }
  const pooled = [0, 1, 2, 3].map(b => { let e = 0, x = 0; for (const id of ids) { e += E[id][b]; x += X[id][b]; } return x > 0 ? e / x : 0; });
  const rates = {};
  for (const id of ids) rates[id] = [0, 1, 2, 3].map(b => (E[id][b] + prior * pooled[b]) / (X[id][b] + prior));
  return { rates, events: E, exposure: X, pooled };
}

export function reviewSample(ops) { return ops.filter(o => !o.expired).map(o => o.completedAt - o.quorumAt).filter(Number.isFinite).sort((a, b) => a - b); }

// ---------- availability signal ----------
// Poisson silence test: over the last `windowH` hours, add up how many approvals the fitted
// model expected from each person given the requests that were actually waiting on them
// (exposure x rate). If the model expected at least `minExpected` approvals and saw none
// (P <= e^-minExpected), the person is treated as likely away. Uses only events before t.
export function awaySet(org, model, opsSorted, t, opts = {}) {
  const W = opts.windowH ?? 48, minE = opts.minExpected ?? 3;
  const off = Object.fromEntries(org.approvers.map(a => [a.id, a.offset]));
  let lo = 0, hi = opsSorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (opsSorted[m].notifiedAt < t - W) lo = m + 1; else hi = m; }
  const E = {}, O = {};
  for (let i = lo; i < opsSorted.length && opsSorted[i].notifiedAt < t; i++) {
    const op = opsSorted[i]; const pol = org.policies[op.policy];
    for (const id of pol.members) {
      const ta = op.approvals?.[id];
      const end = Math.min(Number.isFinite(ta) ? ta : Infinity, op.quorumAt ?? Infinity, t);
      if (Number.isFinite(ta) && ta < t) O[id] = (O[id] || 0) + 1;
      const acc = [0, 0, 0, 0]; if (end > op.notifiedAt) exposureSplit(op.notifiedAt, end, off[id], acc);
      E[id] = (E[id] || 0) + acc.reduce((s2, x, b) => s2 + x * model.rates[id][b], 0);
    }
  }
  return Object.keys(E).filter(id => E[id] >= minE && !(O[id] > 0));
}
export const AWAY_FACTOR = 0.05;

// ---------- prediction ----------
// Monte Carlo completion time for an operation in the queue at time `now`.
export function predict(org, model, op, now, opts = {}) {
  const N = opts.N ?? 2000, r = rng(opts.seed ?? 5); const pol = org.policies[op.policy];
  const approved = { ...(opts.approved ?? op.approvedSoFar ?? {}) };
  const remaining = pol.members.filter(id => !Number.isFinite(approved[id]) && !(opts.unavailable || []).includes(id));
  const off = Object.fromEntries(org.approvers.map(a => [a.id, a.offset]));
  const rev = model.review; const out = new Float64Array(N);
  const startFrom = Math.max(now, op.notifiedAt);
  const cap = op.notifiedAt + EXPIRY_H - startFrom;
  const away = new Set(opts.away || []);
  const rates = Object.fromEntries(remaining.map(id => [id, away.has(id) ? model.rates[id].map(v => v * AWAY_FACTOR) : model.rates[id]]));
  for (let k = 0; k < N; k++) {
    const times = { ...approved };
    for (const id of remaining) times[id] = startFrom + sampleResponse(r, startFrom, rates[id], off[id], cap);
    const q = quorumTime(pol, times);
    out[k] = Number.isFinite(q) ? q + rev[Math.floor(r() * rev.length)] : Infinity;
  }
  out.sort();
  const by = d => { let c = 0; for (let k = 0; k < N; k++) if (out[k] <= d) c++; return c / N; };
  const qtl = p => out[Math.min(N - 1, Math.floor(p * N))];
  return { samples: out, by, p50: qtl(0.5), p90: qtl(0.9), pExpire: 1 - by(op.notifiedAt + EXPIRY_H + 24) };
}

// approver-level view: chance each remaining approver acts before a deadline, and the
// operation's on-time chance if that approver approved right now
export function approverImpact(org, model, op, now, deadline, opts = {}) {
  const base = predict(org, model, op, now, opts).by(deadline);
  const pol = org.policies[op.policy]; const r = rng(17);
  const approved = op.approvedSoFar ?? {};
  const off = Object.fromEntries(org.approvers.map(a => [a.id, a.offset]));
  return pol.members.filter(id => !Number.isFinite(approved[id])).map(id => {
    let c = 0; const N = 2000;
    for (let k = 0; k < N; k++) if (sampleResponse(r, now, model.rates[id], off[id], deadline - now) <= deadline - now) c++;
    const ifNow = predict(org, model, op, now, { ...opts, approved: { ...approved, [id]: now } }).by(deadline);
    return { id, pBefore: c / N, ifNow, lift: ifNow - base };
  }).sort((a, b) => b.lift - a.lift).map(x => ({ ...x, base }));
}

// ---------- backtest ----------
// Train on operations initiated before `split`, then predict each later operation from its
// initiation: P(complete within h hours) for h in horizons, versus what happened.
export function backtest(org, ops, split, opts = {}) {
  const horizons = opts.horizons ?? [1, 4];
  const train = ops.filter(o => o.initiatedAt < split && o.completedAt < split);
  const test = ops.filter(o => o.initiatedAt >= split);
  const fit = m => ({ ...fitRates(org, train, { naive: m === 'naive' }), review: reviewSample(train) });
  const models = { model: fit('model'), naive: fit('naive') };
  const base = {}; for (const h of horizons) base[h] = {};
  for (const h of horizons) for (const p of Object.keys(org.policies)) {
    const tr = train.filter(o => o.policy === p); base[h][p] = tr.filter(o => o.completedAt - o.initiatedAt <= h).length / Math.max(1, tr.length);
  }
  const sorted = [...ops].sort((a, b) => a.notifiedAt - b.notifiedAt); // only events before each prediction time are read
  const rows = [];
  test.forEach((op, i) => {
    const q = { ...op, approvedSoFar: {} };
    const away = opts.noAway ? [] : awaySet(org, models.model, sorted, op.notifiedAt);
    const pm = predict(org, models.model, q, op.notifiedAt, { N: opts.N ?? 400, seed: 100 + i, away });
    const pr = predict(org, models.model, q, op.notifiedAt, { N: opts.N ?? 400, seed: 100 + i });
    const pn = predict(org, models.naive, q, op.notifiedAt, { N: opts.N ?? 400, seed: 100 + i });
    for (const h of horizons) {
      const y = op.completedAt - op.initiatedAt <= h ? 1 : 0; const d = op.initiatedAt + h;
      rows.push({ op: op.id, policy: op.policy, h, y, model: pm.by(d), noAway: pr.by(d), naive: pn.by(d), base: base[h][op.policy], nAway: away.length });
    }
  });
  return { rows, nTrain: train.length, nTest: test.length, models };
}

export function calibrationStats(rows, key, bins = 10) {
  const B = Array.from({ length: bins }, () => ({ n: 0, p: 0, y: 0 }));
  let brier = 0, meanP = 0, meanY = 0;
  for (const r of rows) {
    const p = r[key]; const b = Math.min(bins - 1, Math.floor(p * bins));
    B[b].n++; B[b].p += p; B[b].y += r.y; brier += (p - r.y) ** 2; meanP += p; meanY += r.y;
  }
  const n = rows.length; let ece = 0;
  const curve = B.map(b => b.n ? { n: b.n, p: b.p / b.n, y: b.y / b.n } : null);
  for (const c of curve) if (c) ece += (c.n / n) * Math.abs(c.p - c.y);
  return { ece, brier: brier / n, meanP: meanP / n, meanY: meanY / n, curve, n };
}

// ---------- policy health ----------
// P(complete within h) for a fresh operation initiated at each hour of the week (ET, offset -5)
export function heatmap(org, model, policyId, h = 1, opts = {}) {
  const N = opts.N ?? 200, etOff = opts.etOffset ?? -5; const cells = [];
  const pol = org.policies[policyId];
  const policy = opts.policy ?? pol;
  const orgX = { ...org, policies: { ...org.policies, [policyId]: policy } };
  const week = opts.week ?? 0;
  for (let how = 0; how < 168; how++) {
    const t = week * 168 + how - etOff + 0.25; // initiation at :15 past the ET hour
    const op = { policy: policyId, notifiedAt: t, approvedSoFar: {} };
    const p = predict(orgX, model, op, t, { N, seed: 1000 + how, unavailable: opts.unavailable }).by(t + h);
    cells.push(p);
  }
  return cells;
}
export function workingAvg(cells) { // Mon-Fri 9:00-17:00 ET
  let s = 0, n = 0; for (let d = 0; d < 5; d++) for (let hh = 9; hh < 17; hh++) { s += cells[d * 24 + hh]; n++; } return s / n;
}
export function weekAvg(cells) { return cells.reduce((a, b) => a + b, 0) / cells.length; }

// leave-one-out: how much the working-hours on-time chance drops if one approver is unavailable
export function singlePoints(org, model, policyId, h = 1, opts = {}) {
  const baseCells = heatmap(org, model, policyId, h, opts); const base = workingAvg(baseCells);
  return org.policies[policyId].members.map(id => {
    const cells = heatmap(org, model, policyId, h, { ...opts, unavailable: [id] });
    return { id, without: workingAvg(cells), drop: base - workingAvg(cells), worstCell: Math.min(...cells.slice(0, 120)) };
  }).sort((a, b) => b.drop - a.drop).map(x => ({ ...x, base }));
}

// what-if: add one existing team member to the policy (and, if given, to its sub-quorum).
// Thresholds and minimum distinct signers never decrease.
export function addApprover(policy, id, toSub = false) {
  const p = { ...policy, members: [...policy.members, id] };
  if (toSub && policy.sub) p.sub = { ...policy.sub, members: [...policy.sub.members, id] };
  if (p.m < policy.m || (policy.sub && p.sub.min < policy.sub.min) || minSigners(p) < minSigners(policy)) throw new Error('what-if weakened the policy');
  return p;
}
export function bestBackup(org, model, policyId, candidates, h = 1, opts = {}) {
  const pol = org.policies[policyId]; const base = workingAvg(heatmap(org, model, policyId, h, opts));
  const res = candidates.filter(id => !pol.members.includes(id)).map(id => {
    const p = addApprover(pol, id, !!pol.sub); const cells = heatmap(org, model, policyId, h, { ...opts, policy: p });
    return { id, policy: p, work: workingAvg(cells), week: weekAvg(cells), cells };
  }).sort((a, b) => b.work - a.work);
  return { base, options: res };
}
