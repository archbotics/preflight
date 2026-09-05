# Preflight 1.0.0 · public beta

Released 2026-09-05 at https://preflight.archbotics.workers.dev.

- Application source: [`0cbe541c79d525167731886edcd290702c049b84`](https://github.com/archbotics/preflight/commit/0cbe541c79d525167731886edcd290702c049b84).
- Active Cloudflare version: `9ffac7d6-1d7d-4bcf-a485-59266702de5e`, 100% traffic.
- Active deployment after the recovery drill: `ee63d0b6-16ac-4df4-89ad-1b607ec60ae6`.
- [GitHub CI](https://github.com/archbotics/preflight/actions/runs/33953745471) passed on the application source. Local validation: 42/42 automated tests, all JavaScript syntax checks, dry-run Worker build. Independent [review findings and disposition](REVIEW.md).

## Observed deployed behavior

The final-version [smoke test](evidence/smoke.json) completed a real Archbotics webpage scan, signed report sharing, public read and creator deletion. Private/IP targets and modified signed reports were rejected; private stats require authentication. Every test share was deleted and subsequent reads returned 404.

The [actual mobile browser flow](evidence/browser-live.json) checked Archbotics Sivut, opened privacy without losing the report, shared, reloaded the creator browser, opened a fresh recipient browser, deleted from the creator UI, and confirmed absence in the recipient. That flow preceded the final analyzer-only corrections. After rollback to the released version, the durable browser verifier again passed at 1440 and 390 pixels: zero observed Axe violations on landing/report, no horizontal overflow, 16 example checks, docs-state preservation, and downloaded Markdown byte-equal to the canonical renderer.

Three controlled pages were successfully inspected: the Archbotics company homepage and Sivut returned 16 passed source checks; Preflight's own JavaScript app returned 10 passed and 6 Review findings, with no confirmed missing-H1 defect after correction. These are bounded source observations, not full-site verdicts. A separate obsolete preview address returned non-HTML and was refused rather than turned into a passing report. No raw fetched HTML was retained.

## Recovery drill

1. Created an explicitly shared test report on the released version.
2. Deployed the same code with new work paused, version `94db1e3a-0c70-4e94-982e-d52e47bc2b82`.
3. Verified health disabled and new scan/share requests returned 503, while the existing report remained readable and creator deletion still worked.
4. Rolled back to released version `9ffac7d6-1d7d-4bcf-a485-59266702de5e`; health became enabled. The deleted report stayed absent, and final public smoke/browser checks passed.

Evidence: [pause](evidence/pause-drill.json), [rollback](evidence/rollback.json), [deployment metadata](evidence/deployments.json), [corrected self-scan](evidence/final-selfscan.json). Local configuration is restored to enabled. No existing service, DNS zone, mail lane, or scheduler was changed by this drill.

## Operating limits and next evidence

Existing Cloudflare Workers paid account; no new subscription or paid inference. Application limits: 250 scans and 250 shares per UTC day, 6 writes/minute/IP and 60 report reads/minute/IP per Cloudflare location, 512 KiB HTML, 12-second fetch deadline, 100 ms CPU. Shared reports expire after seven days. See [Operations](OPERATIONS.md) for secrets, stats, pause and rollback.

This release demonstrates an operational product and a completed build/review/deploy/recovery loop. It does not establish independent users, accepted fixes, repeat use, revenue, or willingness to pay. Next useful evidence is use in three real website handovers with findings accepted/rejected and repair steps saved recorded explicitly.
