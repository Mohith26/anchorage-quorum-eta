import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  rng, satisfied, quorumTime, minSigners, sampleResponse, bucketOfLocal, fitRates, reviewSample, predict,
  backtest, calibrationStats, addApprover, fromDate, heatmap, workingAvg, awaySet, approverImpact,
} from '../core/quorum.js';
import { generate } from '../scripts/generate.mjs';

const D = JSON.parse(readFileSync(new URL('../data/org.json', import.meta.url)));
const org = D.org;
const model = { ...fitRates(org, D.ops), review: reviewSample(D.ops) };

test('committed data is reproduced by the seeded generator', () => {
  const g = JSON.parse(JSON.stringify(generate()));
  assert.equal(g.ops.length, D.ops.length);
  assert.deepEqual(g.ops.slice(0, 50), D.ops.slice(0, 50));
  assert.deepEqual(g.pending, D.pending);
});

test('quorum rules: threshold, sub-quorum, and first satisfying time', () => {
  const pol = org.policies.treasury; // 3 of 6, at least 1 of {priya, amelia}
  assert.equal(satisfied(pol, new Set(['maya', 'tom', 'wei'])), false); // no compliance approver
  assert.equal(satisfied(pol, new Set(['maya', 'tom', 'amelia'])), true);
  assert.equal(quorumTime(pol, { maya: 1, tom: 2, wei: 3, jonas: 4, priya: 9 }), 9);
  assert.equal(quorumTime(pol, { maya: 1, tom: 2, priya: 3 }), 3);
  assert.equal(minSigners(pol), 3);
});

test('duty buckets follow local time', () => {
  assert.equal(bucketOfLocal(9), 0);        // Mon 9:00 working
  assert.equal(bucketOfLocal(19), 1);       // Mon 19:00 evening
  assert.equal(bucketOfLocal(3), 2);        // Mon 03:00 night
  assert.equal(bucketOfLocal(5 * 24 + 12), 3); // Sat noon weekend
});

test('piecewise-exponential sampler matches the exponential law for a constant rate', () => {
  const r = rng(9); const rate = 2; let s = 0, n = 20000, under = 0;
  for (let i = 0; i < n; i++) { const x = sampleResponse(r, 0, [rate, rate, rate, rate], 0, 1e6); s += x; if (x <= 0.5) under++; }
  assert.ok(Math.abs(s / n - 1 / rate) < 0.01);
  assert.ok(Math.abs(under / n - (1 - Math.exp(-rate * 0.5))) < 0.01);
});

test('censoring-aware fit recovers true rates; dropping censored approvers inflates them', () => {
  // two-member 1-of-2 race with known rates: the slower member is mostly censored
  const tiny = { approvers: [{ id: 'a', offset: 0 }, { id: 'b', offset: 0 }], policies: { p: { m: 1, members: ['a', 'b'], sub: null } } };
  const r = rng(3); const ops = []; const ra = 3, rb = 1;
  for (let i = 0; i < 4000; i++) {
    const t0 = 24 * 7 * 2 + 10 + (i % 5) * 0.1; // Monday mornings, working bucket
    const ta = t0 + sampleResponse(r, t0, [ra, ra, ra, ra], 0, 50), tb = t0 + sampleResponse(r, t0, [rb, rb, rb, rb], 0, 50);
    const q = Math.min(ta, tb); const appr = {}; if (ta <= q) appr.a = ta; if (tb <= q) appr.b = tb;
    ops.push({ policy: 'p', notifiedAt: t0, quorumAt: q, approvals: appr });
  }
  const fit = fitRates(tiny, ops, { prior: 0 }), naive = fitRates(tiny, ops, { prior: 0, naive: true });
  const w = x => x.rates.b.find((v, i) => x.exposure.b[i] > 0);
  assert.ok(Math.abs(fit.rates.a[0] - ra) / ra < 0.05, 'a ' + fit.rates.a[0]);
  assert.ok(Math.abs(fit.rates.b[0] - rb) / rb < 0.08, 'b ' + fit.rates.b[0]);
  assert.ok(naive.rates.b[0] > 2.5 * rb, 'naive b ' + w(naive));
});

test('prediction respects what is already approved and the deadline ordering', () => {
  const op = D.pending.find(o => o.id === 'op-p1'); const now = D.meta.now;
  const p = predict(org, model, op, now, { N: 2000 });
  assert.ok(p.by(op.deadline) > 0 && p.by(op.deadline) < 1);
  assert.ok(p.by(op.deadline + 2) >= p.by(op.deadline));
  assert.ok(p.p50 <= p.p90 && p.p50 > now);
  // a fully approved quorum leaves only the review step
  const all = predict(org, model, { ...op, approvedSoFar: { maya: now, tom: now, amelia: now } }, now, { N: 2000 });
  assert.ok(all.p90 - now < 1.5);
  // the conditional "if X approves now" never lowers the on-time chance
  for (const x of approverImpact(org, model, op, now, op.deadline, { N: 1000 })) assert.ok(x.ifNow >= x.base - 0.03, x.id);
});

test('backtest: model beats the base rate on Brier and the naive fit is overconfident', () => {
  const split = fromDate(new Date(Date.UTC(2026, 8, 1)));
  const bt = backtest(org, D.ops, split, { N: 200 });
  const rows = bt.rows.filter(r => r.h === 1);
  const m = calibrationStats(rows, 'model'), n = calibrationStats(rows, 'naive'), b = calibrationStats(rows, 'base');
  assert.ok(bt.nTest > 500);
  assert.ok(m.brier < 0.8 * b.brier, `model ${m.brier} base ${b.brier}`);
  assert.ok(m.ece < 0.07);
  assert.ok(n.meanP - n.meanY > 0.1);
  assert.ok(Math.abs(m.meanP - m.meanY) < 0.04);
});

test('calibration stats on a perfectly calibrated toy set', () => {
  const r = rng(1); const rows = [];
  for (let i = 0; i < 20000; i++) { const p = r(); rows.push({ p, y: r() < p ? 1 : 0 }); }
  const s = calibrationStats(rows, 'p');
  assert.ok(s.ece < 0.02); assert.ok(Math.abs(s.brier - 1 / 6) < 0.01);
});

test('what-ifs never weaken a policy and adding a backup does not lower coverage', () => {
  const pol = org.policies.treasury;
  const p2 = addApprover(pol, 'luis', true);
  assert.equal(p2.m, pol.m); assert.equal(p2.sub.min, pol.sub.min); assert.equal(minSigners(p2), minSigners(pol));
  const base = workingAvg(heatmap(org, model, 'treasury', 1, { N: 120 }));
  const plus = workingAvg(heatmap(org, model, 'treasury', 1, { N: 120, policy: p2 }));
  assert.ok(plus >= base - 0.02);
});

test('away detector only uses the past and flags silent approvers', () => {
  const sorted = [...D.ops].sort((a, b) => a.notifiedAt - b.notifiedAt);
  const t = sorted[1500].notifiedAt;
  const a1 = awaySet(org, model, sorted, t);
  const a2 = awaySet(org, model, sorted.map(o => (o.notifiedAt >= t ? { ...o, approvals: {} } : o)), t);
  assert.deepEqual(a1, a2); // future events cannot change the answer
  // an approver with many waiting requests and no approvals is flagged
  const fake = sorted.slice(0, 1500).map(o => ({ ...o, approvals: Object.fromEntries(Object.entries(o.approvals).filter(([id]) => id !== 'maya')) }));
  assert.ok(awaySet(org, model, fake, t).includes('maya'));
});
