# Quorum ETA: a concept feature for the Anchorage Digital Operations page

**Live demo:** https://mohith26.github.io/anchorage-quorum-eta/

Unofficial concept demo by Mohith Gajjela. Not affiliated with Anchorage Digital. Synthetic data.

## What it is

Every Anchorage Digital withdrawal waits on a quorum of biometric approvals, then on Anchorage
Digital review. That is the security model, and it should not change. What clients cannot see today
is *when* a pending operation will clear. Quorum ETA adds that to the Operations page:

- **Per operation:** the chance it completes before its deadline (a settlement cutoff, a wire window),
  a median and 90% completion time, the progress steps with predicted times, and for each approver
  still pending, the chance they act before the cutoff and the on-time chance *if they approved now*.
- **Quorum health (per policy):** the chance a fresh operation clears within an hour for every start hour
  of the week, how much each approver's absence costs, and a suggested change that only ever *adds* an
  eligible approver. Thresholds, sub-quorum minimums and the minimum number of distinct signers never go down.
- **Forecast accuracy:** a held-out backtest so the numbers can be trusted.

## How it works (`core/quorum.js`)

1. **Approver response model.** Each approver gets a piecewise-constant hazard (approvals per hour) in four
   duty buckets of their local time: working hours, evening, night, weekend. The fit is the censoring-aware
   maximum likelihood estimate, events / exposure: an approver who had not approved when quorum filled was
   still "at risk" until then, so that time counts as exposure. Rates are shrunk toward the pooled rate.
2. **Availability signal.** A Poisson silence test: if the fitted model expected at least 3 approvals from a
   person over the last 48 hours, given the requests that were actually waiting on them, and saw none
   (chance about 5%), they are treated as likely away. It only reads events before the prediction time.
3. **Time to quorum.** Monte Carlo (4,000 draws): sample each remaining approver's response from their
   hazard, walking hour by hour through their local schedule; quorum time is the first moment the policy
   (threshold plus sub-quorum) is satisfied; add an Anchorage Digital review time drawn from history.
   Operations expire after 14 days, as in the product.
4. **Policy health.** The same simulation for a fresh operation at each of the 168 hours of the week,
   leave-one-out for single points of failure, and a search over existing team members to add as approvers.

### Results on the synthetic organization (from `node scripts/report.mjs`)

- Halyard Capital (fictional): 10 approvers in New York, Chicago, San Francisco, London, Zurich and
  Singapore; 3 vault policies; 2,469 operations from Feb 2 to Nov 6, 2026.
- **Backtest:** fit on 1,840 operations before Sep 1, then predict each of the 629 later operations at the
  moment it was initiated. For "cleared within 1 hour": average predicted 65.2% vs observed 67.2%, ECE 4.5
  points, Brier 0.119 vs 0.195 for each policy's historical rate (39% lower). Dropping approvers who were
  still pending at quorum (instead of treating them as censored) makes the model 20 points overconfident
  (87.2% predicted vs 67.2%). At 4 hours: ECE 1.5 points.
- **Pending 250 ETH withdrawal** from the Treasury Reserve vault (3 of 6, at least 1 from Compliance),
  1 of 3 approvals at Friday 2:40 PM ET: 60% chance to clear by the 4:00 PM ET cutoff; if Amelia Hart
  (London, Compliance) approved now it would be 89%.
- **Treasury Reserve health:** 57% of operations started Mon-Fri 9-5 ET clear within an hour, 37% on Friday
  at 3 PM. Adding Luis Ortega (Chicago, compliance backup) to the Compliance sub-quorum raises that to 79%
  (Friday 3 PM: 69%) with the threshold unchanged at 3 approvals including 1 from Compliance.

## Run it

```
node scripts/generate.mjs      # regenerates data/org.json (seeded)
node --test test/              # 10 tests
node scripts/report.mjs        # prints every headline number
python3 -m http.server         # then open http://localhost:8000
```

Tests cover generator determinism, quorum and sub-quorum rules, duty buckets, the sampler against the
exponential law, recovery of known rates under censoring (and the naive fit's inflation), prediction
invariants, the backtest claims, calibration statistics on a calibrated toy set, that what-ifs never
weaken a policy, and that the away detector cannot see the future.

## Honest limitations

- **Synthetic data.** People, policies and operations are fictional. The truth generator includes things
  the model does not see (vacation weeks, one slow week per person, slower Friday afternoons), which is why
  calibration is checked out of sample rather than assumed.
- **Independence.** Approvers are modeled as independent given the time; in reality a Slack ping or a
  shared meeting couples them.
- **No DST, fixed offsets**, hourly resolution for duty buckets; nudges are not modeled (the "if approved now"
  number is a conditional, not a promise about what a reminder would do).
- **Calibration is not uniform:** some middle probability bins are off by 5-15 points on this data (see the reliability chart), even though the average is within 2 points.
- **UI** is rebuilt from public screenshots in the Anchorage Digital knowledge base; spacing and some
  components are approximations.

## Security note

This feature reads approval timestamps only. It never changes who can approve or how many approvals are
required, and its only suggestion type is adding an existing team member as an eligible approver, checked
in code (`addApprover`) to never lower a threshold, a sub-quorum minimum or the minimum distinct signers.

## Novelty note

Anchorage Digital's knowledge base documents quorum rules, sub-quorums, approval windows and expiry, and a
"why is my operation stuck pending" checklist; I found no completion-time forecast. Fireblocks offers a
pending-approvals dashboard and a policy inspector, Copper and BitGo offer approval workflows; I did not find
a custodian that forecasts time to quorum or reports per-policy quorum health. If Anchorage already does this
internally, this is a second take.
