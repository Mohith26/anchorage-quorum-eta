import {
  fitRates, reviewSample, predict, approverImpact, backtest, calibrationStats, heatmap, workingAvg,
  singlePoints, bestBackup, awaySet, fromDate, toDate, satisfied,
} from './core/quorum.js';

const $ = id => document.getElementById(id);
const ET = -5; // Eastern (EST) for the November scenario
const pct = v => Math.round(v * 100) + '%';
const sleep = () => new Promise(r => setTimeout(r, 0));
const etDate = t => new Date(toDate(t).getTime() + ET * 3600000);
const clock = t => { const d = etDate(t); let h = d.getUTCHours(); const m = d.getUTCMinutes(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${String(m).padStart(2, '0')} ${ap}`; };
const dayName = t => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][etDate(t).getUTCDay()];
const when = (t, now) => (Math.floor((t + ET) / 24) === Math.floor((now + ET) / 24) ? '' : dayName(t) + ' ') + clock(t) + ' ET';
const fmtAmt = (n, a) => n.toLocaleString('en-US') + ' ' + a;
const usd = v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USD';
const cls = p => (p < 0.4 ? 'lo' : p < 0.8 ? 'mid' : 'hi');

let D, org, model, away, now, sorted;
const state = { open: 'op-p1', policy: 'treasury' };
const cache = { pred: {}, health: {} };
const charts = {};

function person(id) { return org.approvers.find(a => a.id === id); }
function localClock(t, off) { const d = new Date(toDate(t).getTime() + off * 3600000); let h = d.getUTCHours(); const m = d.getUTCMinutes(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${String(m).padStart(2, '0')} ${ap}`; }

function predFor(op) {
  if (cache.pred[op.id]) return cache.pred[op.id];
  const p = predict(org, model, op, now, { N: 4000, seed: 5, away });
  const imp = approverImpact(org, model, op, now, op.deadline, { N: 2000, seed: 5, away });
  return (cache.pred[op.id] = { p, imp, onTime: p.by(op.deadline) });
}

function renderPending() {
  const rows = D.pending.map(op => {
    const { onTime, p } = predFor(op); const pol = org.policies[op.policy];
    const got = Object.keys(op.approvedSoFar).filter(id => pol.members.includes(id)).length;
    const neg = op.type === 'Withdrawal';
    return `<div class="op${state.open === op.id ? ' open' : ''}" data-id="${op.id}">
      <div class="op-main">
        <div class="op-ic"><i data-lucide="${op.type === 'Stake' ? 'layers' : 'arrow-up-from-line'}"></i></div>
        <div><div class="op-title">${op.type}</div><div class="op-desc">${fmtAmt(op.amount, op.asset)} from “${pol.vault}” to “${op.dest}”</div></div>
        <div class="amt"><div class="a ${neg ? 'neg' : ''}">${neg ? '— ' : ''}${fmtAmt(op.amount, op.asset)}</div><div class="u">${usd(op.usd)}</div></div>
        <div class="st"><div class="s"><i class="d"></i>Needs approvals</div>
          <div class="eta">${got} of ${pol.m} · <b class="${cls(onTime)}">${pct(onTime)}</b> by ${clock(op.deadline)} · ETA ${clock(p.p50)}</div></div>
      </div>
      <div class="op-detail">${state.open === op.id ? detail(op) : ''}</div>
    </div>`;
  });
  $('pendingRows').innerHTML = rows.join('');
  $('nReview').textContent = D.pending.length; $('reviewAll').textContent = `Review all (${D.pending.length})`;
  document.querySelectorAll('#pendingRows .op').forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('.op-detail')) return;
    state.open = state.open === el.dataset.id ? null : el.dataset.id; renderPending();
  }));
  lucide.createIcons();
  const op = D.pending.find(o => o.id === state.open); if (op) drawCdf(op);
}

function detail(op) {
  const { p, imp, onTime } = predFor(op); const pol = org.policies[op.policy];
  const got = Object.keys(op.approvedSoFar).filter(id => pol.members.includes(id));
  const subLeft = pol.sub ? pol.sub.members.filter(id => !got.includes(id)) : [];
  const subNeeded = pol.sub && !satisfied({ m: 0, members: pol.members, sub: pol.sub }, new Set(got));
  const review = model.review; const revMed = review[review.length >> 1] * 60;
  const quorumP50 = p.p50 - review[review.length >> 1];
  const steps = `
    <div class="step done"><div class="dot"><i data-lucide="check"></i></div><div><div class="nm">Initiated</div><div class="sm">${when(op.initiatedAt, now)}</div></div></div>
    <div class="step cur"><div class="dot"></div><div><div class="nm">Quorum Formation</div><div class="sm">${got.length} of ${pol.m} accepted · likely ${when(quorumP50, now)}</div></div></div>
    <div class="step fut"><div class="dot"></div><div><div class="nm">Anchorage Digital Review</div><div class="sm">typically ${Math.round(revMed)} min</div></div></div>
    <div class="step fut"><div class="dot"></div><div><div class="nm">Complete</div><div class="sm">median ${when(p.p50, now)} · 90% by ${when(p.p90, now)}</div></div></div>`;
  const ap = imp.map(x => {
    const a = person(x.id); const isAway = away.includes(x.id); const sub = pol.sub && pol.sub.members.includes(x.id);
    return `<div class="appr"><div class="av">${a.initials}</div><div><div class="n">${a.name}${sub ? '<span class="tag">' + pol.sub.name + '</span>' : ''}${isAway ? '<span class="tag away">Likely away</span>' : ''}</div><div class="c">${a.city} · ${localClock(now, a.offset)} local · acts before cutoff ${pct(x.pBefore)}</div></div>
      <div class="v">if approved now<br><b>${pct(x.ifNow)}</b></div></div>`;
  }).join('');
  return `<div>
      <div class="big ${cls(onTime)}" style="color:${onTime < 0.4 ? 'var(--red)' : onTime < 0.8 ? 'var(--amber-n)' : 'var(--green)'}">${pct(onTime)}</div>
      <div class="big-s">chance to complete by the ${op.deadlineLabel}<br>${D.meta.nowLabel}</div>
      <div class="prog">${steps}</div>
    </div>
    <div><div class="col-t">Completion time forecast</div><div class="cdf"><canvas id="cdf"></canvas></div>
      <div class="note">${got.length ? 'Approved: ' + got.map(id => person(id).name).join(', ') + '. ' : ''}Still needs ${pol.m - got.length} more of ${pol.members.length - got.length} eligible approvers${subNeeded ? `, including 1 from ${pol.sub.name} (${subLeft.map(id => person(id).name.split(' ')[0]).join(' or ')})` : ''}. Forecast from each approver's fitted response rates by local time of day; 4,000 draws.</div></div>
    <div><div class="col-t">Who unblocks this</div>${ap}</div>`;
}

function drawCdf(op) {
  const { p } = predFor(op); const s = p.samples; const N = s.length;
  const start = now, end = Math.max(op.deadline + 1, Math.min(p.p90 + 0.5, now + 30));
  const pts = []; const steps = 120;
  for (let i = 0; i <= steps; i++) { const t = start + (end - start) * i / steps; let lo = 0, hi = N; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] <= t) lo = m + 1; else hi = m; } pts.push({ x: t, y: lo / N * 100 }); }
  if (charts.cdf) charts.cdf.destroy();
  charts.cdf = new Chart($('cdf'), {
    type: 'line',
    data: { datasets: [
      { data: pts, borderColor: '#4070f5', backgroundColor: 'rgba(64,112,245,.14)', fill: true, pointRadius: 0, borderWidth: 2, tension: 0.15 },
      { data: [{ x: op.deadline, y: 0 }, { x: op.deadline, y: 100 }], borderColor: '#ffd764', borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0 },
    ] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#161718', borderColor: '#313233', borderWidth: 1, callbacks: { title: i => when(i[0].parsed.x, now), label: i => `${i.parsed.y.toFixed(0)}% complete by then` } } },
      scales: {
        x: { type: 'linear', min: start, max: end, grid: { color: '#1f2021' }, ticks: { color: '#9a9b9d', font: { family: 'Inter', size: 11 }, maxTicksLimit: 6, callback: v => clock(v) } },
        y: { min: 0, max: 100, grid: { color: '#1f2021' }, ticks: { color: '#9a9b9d', font: { family: 'Inter', size: 11 }, stepSize: 25, callback: v => v + '%' } },
      } },
  });
}

async function healthFor(pid) {
  if (cache.health[pid]) return cache.health[pid];
  const cells = heatmap(org, model, pid, 1, { N: 200 }); await sleep();
  const sp = singlePoints(org, model, pid, 1, { N: 200 }); await sleep();
  const pol = org.policies[pid];
  const cands = pol.sub ? org.approvers.filter(a => a.role && !pol.members.includes(a.id)).map(a => a.id) : org.approvers.filter(a => !pol.members.includes(a.id)).map(a => a.id);
  const bb = cands.length ? bestBackup(org, model, pid, cands, 1, { N: 200 }) : null;
  return (cache.health[pid] = { cells, sp, bb, work: workingAvg(cells) });
}

async function renderHealth() {
  const pid = state.policy; const pol = org.policies[pid];
  $('polTabs').innerHTML = Object.values(org.policies).map(p => `<span data-p="${p.id}" class="${p.id === pid ? 'on' : ''}">${p.name}</span>`).join('');
  document.querySelectorAll('#polTabs span').forEach(el => el.addEventListener('click', async () => { state.policy = el.dataset.p; $('loading').classList.remove('hide'); await sleep(); await renderHealth(); $('loading').classList.add('hide'); }));
  const h = await healthFor(pid);
  $('healthSub').textContent = `${pol.name}: ${pol.m} of ${pol.members.length} approvers${pol.sub ? `, at least ${pol.sub.min} from ${pol.sub.name} (${pol.sub.members.map(id => person(id).name.split(' ')[0]).join(', ')})` : ''}. Simulated from each approver's fitted response model.`;
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const nowHow = ((Math.floor(now + ET) % 168) + 168) % 168;
  let html = '<div></div>' + Array.from({ length: 24 }, (_, i) => `<div class="hl">${i % 3 === 0 ? (i % 12 || 12) + (i < 12 ? 'a' : 'p') : ''}</div>`).join('');
  for (let d = 0; d < 7; d++) {
    html += `<div class="lab">${days[d]}</div>`;
    for (let hh = 0; hh < 24; hh++) {
      const v = h.cells[d * 24 + hh];
      const bg = v < 0.4 ? `rgba(255,122,133,${0.08 + 0.14 * (0.4 - v) / 0.4})` : v < 0.8 ? `rgba(240,195,92,${0.14 + 0.2 * (0.8 - v) / 0.4})` : `rgba(133,214,160,${0.12 + 0.35 * (v - 0.8) / 0.2})`;
      html += `<div class="c${d * 24 + hh === nowHow ? ' now' : ''}" style="background:${bg}" title="${days[d]} ${hh}:00 ET: ${pct(v)}">${Math.round(v * 100)}</div>`;
    }
  }
  $('heat').innerHTML = html;
  $('hWork').textContent = pct(h.work);
  const maxDrop = Math.max(...h.sp.map(x => x.drop), 0.01);
  $('spList').innerHTML = h.sp.slice(0, 5).map(x => `<div class="sp"><div>${person(x.id).name} <span class="c" style="color:var(--muted);font-size:11.5px">${person(x.id).city}</span></div><div class="bar"><b style="width:${Math.max(2, 100 * x.drop / maxDrop)}%"></b></div><div class="v">${x.drop > 0.005 ? '−' + Math.round(x.drop * 100) : '0'} pts</div></div>`).join('');
  const fri3 = 4 * 24 + 15;
  if (h.bb && h.bb.options.length) {
    const o = h.bb.options[0]; const a = person(o.id); const lift = o.work - h.work;
    $('whatIf').innerHTML = `<div class="t">Suggested change</div>Add ${a.name} (${a.city}${a.role ? ', ' + a.role : ''}) as an approver${pol.sub ? ` in the ${pol.sub.name} sub-quorum` : ''}: working-hours on-time rises <span class="k">${pct(h.work)} → ${pct(o.work)}</span>${lift > 0 ? '' : ' (no gain)'}; Friday 3 PM ET goes ${pct(h.cells[fri3])} → ${pct(o.cells[fri3])}.
      <div class="safe"><i data-lucide="shield-check"></i>Threshold unchanged: still ${pol.m} distinct approvals${pol.sub ? ` including ${pol.sub.min} from ${pol.sub.name}` : ''}. Eligible approvers ${pol.members.length} → ${o.policy.members.length}.</div>`;
  } else $('whatIf').innerHTML = `<div class="t">No change suggested</div>All team members are already eligible for this policy.`;
  lucide.createIcons();
}

function renderAccuracy(bt) {
  const rows = bt.rows.filter(r => r.h === 1);
  const st = { model: calibrationStats(rows, 'model'), naive: calibrationStats(rows, 'naive'), base: calibrationStats(rows, 'base') };
  const curve = k => st[k].curve.filter(Boolean).map(c => ({ x: c.p * 100, y: c.y * 100 }));
  if (charts.rel) charts.rel.destroy();
  charts.rel = new Chart($('relChart'), {
    type: 'scatter',
    data: { datasets: [
      { label: 'Perfect calibration', data: [{ x: 0, y: 0 }, { x: 100, y: 100 }], showLine: true, borderColor: '#3a3b3d', borderDash: [4, 4], pointRadius: 0, borderWidth: 1 },
      { label: 'Quorum ETA', data: curve('model'), showLine: true, borderColor: '#4070f5', backgroundColor: '#4070f5', pointRadius: 3.5, borderWidth: 2 },
      { label: 'Ignores pending approvers', data: curve('naive'), showLine: true, borderColor: '#ff7a85', backgroundColor: '#ff7a85', pointRadius: 3, borderWidth: 1.5 },
    ] },
    options: { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { labels: { color: '#d6d6d7', font: { family: 'Inter', size: 11.5 }, boxWidth: 10, boxHeight: 10 } }, tooltip: { backgroundColor: '#161718', callbacks: { label: i => `${i.dataset.label}: predicted ${i.parsed.x.toFixed(0)}%, observed ${i.parsed.y.toFixed(0)}%` } } },
      scales: { x: { min: 0, max: 100, title: { display: true, text: 'Predicted chance to clear within 1 hour', color: '#9a9b9d', font: { family: 'Inter', size: 11 } }, grid: { color: '#1f2021' }, ticks: { color: '#9a9b9d', callback: v => v + '%' } },
        y: { min: 0, max: 100, title: { display: true, text: 'Observed', color: '#9a9b9d', font: { family: 'Inter', size: 11 } }, grid: { color: '#1f2021' }, ticks: { color: '#9a9b9d', callback: v => v + '%' } } } },
  });
  const brierGain = 1 - st.model.brier / st.base.brier;
  $('accSub').textContent = `Fit on ${bt.nTrain.toLocaleString()} operations before Sep 1, 2026; every one of the ${bt.nTest} later operations predicted at the moment it was initiated.`;
  $('accStats').innerHTML = `
    <div><b>${(st.model.meanP * 100).toFixed(0)}% vs ${(st.model.meanY * 100).toFixed(0)}%</b><span>average predicted vs observed, cleared within 1 hour</span></div>
    <div><b>${(st.model.ece * 100).toFixed(1)} pts</b><span>calibration error (ECE, 10 bins)</span></div>
    <div><b>${Math.round(brierGain * 100)}% lower</b><span>Brier score than each policy's historical on-time rate (${st.model.brier.toFixed(3)} vs ${st.base.brier.toFixed(3)})</span></div>
    <div><b style="color:var(--red)">+${Math.round((st.naive.meanP - st.naive.meanY) * 100)} pts</b><span>overconfidence if approvers still pending at quorum are dropped instead of censored</span></div>`;
}

function renderDone() {
  const last = D.ops.filter(o => !o.expired && o.completedAt <= now).slice(-3).reverse();
  $('dayLabel').textContent = etDate(last[0].completedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  $('doneRows').innerHTML = last.map(op => {
    const pol = org.policies[op.policy]; const neg = op.type === 'Withdrawal'; const mins = Math.round((op.completedAt - op.initiatedAt) * 60);
    return `<div class="op"><div class="op-main"><div class="op-ic"><i data-lucide="${op.type === 'Stake' ? 'layers' : 'arrow-up-from-line'}"></i></div>
      <div><div class="op-title">${op.type}</div><div class="op-desc">${fmtAmt(op.amount, op.asset)} from “${pol.vault}” to “${op.dest}”</div></div>
      <div class="amt"><div class="a ${neg ? 'neg' : ''}">${neg ? '— ' : ''}${fmtAmt(op.amount, op.asset)}</div><div class="u">${usd(op.usd)}</div></div>
      <div class="st"><div class="s"><i class="g"></i>Completed</div><div class="eta">cleared in ${mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + ' min'}</div></div></div></div>`;
  }).join('');
}

(async function main() {
  D = await (await fetch('data/org.json')).json();
  Chart.defaults.font.family = 'Inter'; Chart.defaults.color = '#9a9b9d';
  org = D.org; now = D.meta.now;
  D.meta.nowLabel = `as of ${dayName(now)} ${clock(now)} ET`;
  $('orgName').textContent = org.name;
  model = { ...fitRates(org, D.ops), review: reviewSample(D.ops) };
  sorted = [...D.ops].sort((a, b) => a.notifiedAt - b.notifiedAt);
  away = awaySet(org, model, sorted, now);
  $('kDep').textContent = D.deposits.pendingAttribution;
  $('kPend').textContent = D.pending.length;
  const octStart = fromDate(new Date(Date.UTC(2026, 9, 1, 5))), novStart = fromDate(new Date(Date.UTC(2026, 10, 1, 5)));
  $('kDone').textContent = D.ops.filter(o => !o.expired && o.completedAt >= octStart && o.completedAt < novStart).length.toLocaleString();
  const p = new URLSearchParams(location.search);
  if (p.get('op')) state.open = p.get('op');
  if (p.get('policy')) state.policy = p.get('policy');
  lucide.createIcons();
  await sleep(); renderPending(); renderDone();
  await sleep(); await renderHealth();
  await sleep();
  const split = fromDate(new Date(Date.UTC(2026, 8, 1)));
  renderAccuracy(backtest(org, D.ops, split, { N: 300 }));
  lucide.createIcons();
  $('loading').classList.add('hide');
  document.body.dataset.ready = '1';
})();
