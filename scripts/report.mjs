// Prints every headline number the page shows (same core, data, seeds and draw counts as app.js).
import { readFileSync } from 'node:fs';
import { fitRates, reviewSample, predict, approverImpact, backtest, calibrationStats, heatmap, workingAvg, singlePoints, bestBackup, awaySet, fromDate, toDate } from '../core/quorum.js';

const d = JSON.parse(readFileSync(new URL('../data/org.json', import.meta.url)));
const org = d.org, now = d.meta.now;
const t0 = Date.now();
const model = { ...fitRates(org, d.ops), review: reviewSample(d.ops) };
const sorted = [...d.ops].sort((a, b) => a.notifiedAt - b.notifiedAt);
const away = awaySet(org, model, sorted, now);
console.log('away now:', away.join(', ') || 'none');
const fmtT = t => toDate(t).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
for (const op of d.pending) {
  const p = predict(org, model, op, now, { N: 4000, seed: 5, away });
  const imp = approverImpact(org, model, op, now, op.deadline, { N: 2000, seed: 5, away });
  console.log(`${op.id} ${op.policy} ${op.amount} ${op.asset}: P(by ${op.deadlineLabel}) ${(p.by(op.deadline) * 100).toFixed(1)}% | p50 ${fmtT(p.p50)} p90 ${fmtT(p.p90)}`);
  console.log('   impact: ' + imp.map(x => `${x.id} before=${(x.pBefore * 100).toFixed(0)}% ifNow=${(x.ifNow * 100).toFixed(0)}%`).join('; '));
}
const split = fromDate(new Date(Date.UTC(2026, 8, 1)));
const bt = backtest(org, d.ops, split, { N: 300 });
console.log(`backtest: train ${bt.nTrain}, test ${bt.nTest}`);
for (const h of [1, 4]) {
  const rows = bt.rows.filter(r => r.h === h);
  for (const k of ['model', 'noAway', 'naive', 'base']) { const s = calibrationStats(rows, k); console.log(`  ${h}h ${k}: ECE ${(s.ece * 100).toFixed(1)} pts, Brier ${s.brier.toFixed(3)}, mean predicted ${(s.meanP * 100).toFixed(1)}% vs observed ${(s.meanY * 100).toFixed(1)}%`); }
}
for (const pid of Object.keys(org.policies)) {
  const cells = heatmap(org, model, pid, 1, { N: 200 });
  console.log(`${pid}: P(<=1h) Mon-Fri 9-5 ET ${(workingAvg(cells) * 100).toFixed(1)}%, Fri 3 PM ET ${(cells[4 * 24 + 15] * 100).toFixed(0)}%`);
}
const sp = singlePoints(org, model, 'treasury', 1, { N: 200 });
console.log('treasury single points: ' + sp.map(x => `${x.id} -${(x.drop * 100).toFixed(1)}pts (to ${(x.without * 100).toFixed(1)}%)`).join('; '));
const bb = bestBackup(org, model, 'treasury', org.approvers.map(a => a.id).filter(id => org.approvers.find(a => a.id === id).role), 1, { N: 200 });
console.log(`treasury backup: base ${(bb.base * 100).toFixed(1)}% -> ` + bb.options.map(o => `${o.id} ${(o.work * 100).toFixed(1)}% (Fri 3PM ${(o.cells[4 * 24 + 15] * 100).toFixed(0)}%)`).join('; '));
console.log('ms', Date.now() - t0);
