// Seeded synthetic organization: 10 approvers across New York, Chicago, San Francisco, London,
// Zurich and Singapore; three vault policies (one with a compliance sub-quorum); nine months of
// operations with initiation, notification, approval, quorum, review and completion times.
// The truth includes things the model does not see (vacation weeks, a slow week per person,
// slower Friday afternoons, per-person duty patterns), so the backtest has something real to catch.
import { writeFileSync } from 'node:fs';
import { rng, randn, sampleResponse, quorumTime, fromDate, localHow } from '../core/quorum.js';

export function generate(seed = 20261106) {
  const r = rng(seed);
  const approvers = [
    { id: 'maya', name: 'Maya Chen', city: 'New York', offset: -5, med: 10 },
    { id: 'daniel', name: 'Daniel Osei', city: 'New York', offset: -5, med: 26 },
    { id: 'priya', name: 'Priya Raman', city: 'New York', offset: -5, med: 38, role: 'Compliance' },
    { id: 'luis', name: 'Luis Ortega', city: 'Chicago', offset: -6, med: 20, role: 'Compliance (backup)' },
    { id: 'sarah', name: 'Sarah Kim', city: 'San Francisco', offset: -8, med: 15 },
    { id: 'tom', name: 'Tom Becker', city: 'London', offset: 0, med: 12 },
    { id: 'amelia', name: 'Amelia Hart', city: 'London', offset: 0, med: 30, role: 'Compliance' },
    { id: 'jonas', name: 'Jonas Weber', city: 'Zurich', offset: 1, med: 22 },
    { id: 'wei', name: 'Wei Lin', city: 'Singapore', offset: 8, med: 18 },
    { id: 'ravi', name: 'Ravi Menon', city: 'Singapore', offset: 8, med: 34 },
  ].map(a => ({ ...a, initials: a.name.split(' ').map(s => s[0]).join('') }));
  const policies = {
    trading: { id: 'trading', name: 'Trading Ops', vault: 'Trading Ops vault', m: 2, members: ['maya', 'daniel', 'luis', 'sarah', 'tom'], sub: null },
    treasury: { id: 'treasury', name: 'Treasury Reserve', vault: 'Treasury Reserve vault', m: 3, members: ['maya', 'priya', 'tom', 'amelia', 'wei', 'jonas'], sub: { name: 'Compliance', min: 1, members: ['priya', 'amelia'] } },
    fund2: { id: 'fund2', name: 'Long Hold - Fund II', vault: 'Long Hold Vault - Fund II', m: 3, members: ['daniel', 'priya', 'sarah', 'wei', 'ravi'], sub: null },
  };
  // truth duty multipliers per person (working, evening, night, weekend)
  const truth = {};
  for (const a of approvers) {
    const lam = Math.log(2) / (a.med / 60);
    truth[a.id] = [lam, lam * (0.18 + 0.15 * r()), lam * (0.015 + 0.02 * r()), lam * (0.06 + 0.1 * r())];
  }
  const nowDate = new Date(Date.UTC(2026, 10, 6, 19, 40)); // Fri Nov 6 2026, 2:40 PM ET
  const now = fromDate(nowDate);
  const weeks = Math.floor(now / 168);
  // vacations: 3 working weeks per person, plus one slow week at 40%
  const away = {}, slow = {};
  for (const a of approvers) {
    const ws = new Set(); while (ws.size < 3) ws.add(1 + Math.floor(r() * (weeks - 1)));
    away[a.id] = [...ws]; slow[a.id] = 1 + Math.floor(r() * (weeks - 1));
  }
  const truthAway = id => t => { const w = Math.floor(t / 168), how = t % 168; return away[id].includes(w) && how < 120; };
  const truthRates = (id, t) => { // hazard multiplier tweaks the model does not include
    const w = Math.floor(t / 168); const f = w === slow[id] ? 0.4 : 1;
    const a = approvers.find(x => x.id === id); const lh = localHow(t, a.offset);
    const friPM = lh >= 4 * 24 + 13 && lh < 4 * 24 + 18 ? 0.7 : 1;
    return truth[id].map(v => v * f * friPM);
  };
  const ops = []; let n = 0;
  const assets = { trading: [['USDC', 1, 250000, 3000000], ['ETH', 2400, 40, 600], ['BTC', 98000, 2, 40]], treasury: [['ETH', 2400, 100, 800], ['BTC', 98000, 5, 60], ['USDC', 1, 1000000, 8000000]], fund2: [['SOL', 165, 2000, 30000], ['ETH', 2400, 50, 400]] };
  const dests = { trading: ['Prime Settlement', 'Exchange Collateral', 'Market Maker A'], treasury: ['US Treasury Reserve Operations', 'Prime Settlement', 'Cold Reserve 2'], fund2: ['Staking: Figment', 'Fund II Distributions'] };
  const perDay = { trading: 9, treasury: 2.4, fund2: 0.8 };
  for (let day = 0; day * 24 < now + 24; day++) {
    const dow = day % 7; // 0 = Monday
    for (const p of Object.keys(policies)) {
      const lam = dow >= 5 ? perDay[p] * 0.05 : perDay[p];
      let k = 0; { const L = Math.exp(-lam); let pp = 1; do { k++; pp *= r(); } while (pp > L); k--; }
      for (let j = 0; j < k; j++) {
        // initiation mostly in NY hours, some London mornings, a few Singapore hours
        const u = r(); let etHour;
        if (u < 0.72) etHour = 9 + 8 * r(); else if (u < 0.92) etHour = 3 + 6 * r(); else etHour = 19 + 5 * r();
        const t = day * 24 + etHour + 5; // ET (UTC-5) -> UTC hours
        if (t > now - 0.01) continue;
        const pol = policies[p]; const notifiedAt = t + Math.exp(Math.log(3 / 60) + 0.5 * randn(r));
        const approvals = {};
        for (const id of pol.members) {
          const a = approvers.find(x => x.id === id);
          // truth hazard can change hour to hour; approximate with the rates at notification
          approvals[id] = notifiedAt + sampleResponse(r, notifiedAt, truthRates(id, notifiedAt), a.offset, 336, truthAway(id));
        }
        const q = quorumTime(pol, approvals);
        const [asset, px, lo, hi] = assets[p][Math.floor(r() * assets[p].length)];
        const amount = Math.round(lo + (hi - lo) * r() ** 2);
        const op = { id: 'op-' + String(++n).padStart(5, '0'), policy: p, type: p === 'fund2' && asset === 'SOL' ? 'Stake' : 'Withdrawal', asset, amount, usd: Math.round(amount * px), dest: dests[p][Math.floor(r() * dests[p].length)], initiatedAt: +t.toFixed(4), notifiedAt: +notifiedAt.toFixed(4) };
        if (!Number.isFinite(q)) { ops.push({ ...op, approvals: {}, quorumAt: notifiedAt + 336, completedAt: Infinity, expired: true }); continue; }
        const rec = {}; for (const id of pol.members) if (approvals[id] <= q) rec[id] = +approvals[id].toFixed(4);
        const review = Math.exp(Math.log(11 / 60) + 0.55 * randn(r));
        ops.push({ ...op, approvals: rec, quorumAt: +q.toFixed(4), completedAt: +(q + review).toFixed(4) });
      }
    }
  }
  const done = ops.filter(o => o.completedAt <= now || o.expired && o.quorumAt <= now);
  // pending operations in the queue right now (fixed scenario for the page)
  const at = (hEt, mEt) => fromDate(new Date(Date.UTC(2026, 10, 6, hEt + 5, mEt)));
  const pending = [
    { id: 'op-p1', policy: 'treasury', type: 'Withdrawal', asset: 'ETH', amount: 250, usd: 600000, dest: 'US Treasury Reserve Operations', initiatedAt: at(14, 5), notifiedAt: at(14, 8), approvedSoFar: { maya: at(14, 11) }, deadline: at(16, 0), deadlineLabel: '4:00 PM ET settlement cutoff' },
    { id: 'op-p2', policy: 'trading', type: 'Withdrawal', asset: 'USDC', amount: 1200000, usd: 1200000, dest: 'Prime Settlement', initiatedAt: at(14, 31), notifiedAt: at(14, 33), approvedSoFar: {}, deadline: at(17, 0), deadlineLabel: '5:00 PM ET wire window' },
    { id: 'op-p3', policy: 'fund2', type: 'Stake', asset: 'SOL', amount: 12000, usd: 1980000, dest: 'Staking: Figment', initiatedAt: at(13, 20), notifiedAt: at(13, 23), approvedSoFar: { daniel: at(13, 52) }, deadline: at(23, 59), deadlineLabel: 'before epoch boundary (11:59 PM ET)' },
  ];
  const fix = o => JSON.parse(JSON.stringify(o, (k, v) => (v === Infinity ? 1e9 : v)));
  return fix({
    meta: { seed, note: 'Synthetic data. Organization, people, policies and operations are fictional.', now, nowISO: nowDate.toISOString() },
    org: { name: 'Halyard Capital', approvers, policies },
    ops: done.sort((a, b) => a.initiatedAt - b.initiatedAt), pending,
    deposits: { pendingAttribution: 3 },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const d = generate();
  writeFileSync(new URL('../data/org.json', import.meta.url), JSON.stringify(d));
  console.log('ops', d.ops.length, 'pending', d.pending.length);
}
