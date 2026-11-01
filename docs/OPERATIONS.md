# Operating Preflight

## Deployment

Dedicated Worker: `preflight`; public origin `https://preflight.archbotics.workers.dev`. No existing website, DNS zone, mail lane, or scheduler needs modification. Configuration lives in `wrangler.jsonc`; assets are only `public/`. The Worker entry exports only the handler and `Control` Durable Object class. Utility exports must not be added to the runtime entry (native workerd rejects non-handler constants).

```sh
npm ci
npm test
npm run check
npm run build
python3 scripts/cloudflare.py deploy
python3 scripts/cloudflare.py secrets  # initial install; later runs preserve local values
```

The operator wrapper reads Cloudflare account credentials from `~/.config/hq/cloudflare.env` (override `PREFLIGHT_CF_ENV`) and passes them through subprocess environment. It generates application secrets once in `~/.config/hq/preflight.env`, mode 600 (override `PREFLIGHT_APP_ENV`), and installs them through stdin. Never print these files or pass their values in shell arguments. Source control contains neither credentials nor application secret values. On first deploy, sharing remains disabled until its signing secret is installed.

`REPORT_SECRET` signs unchanged scan reports for 30 minutes. Rotating it invalidates unshared scan tokens; already shared reports still work. `ADMIN_TOKEN` protects aggregate stats. Deletion keys are independent per report; only their hashes are stored server-side. Keep existing secrets on redeploy. The Cloudflare token used to deploy is never a Worker binding.

## Verify the deployed version

```sh
curl --fail https://preflight.archbotics.workers.dev/api/health
PREFLIGHT_BASE_URL=https://preflight.archbotics.workers.dev npm run smoke
PREFLIGHT_BASE_URL=https://preflight.archbotics.workers.dev npm run test:browser
python3 scripts/cloudflare.py deployments
python3 scripts/cloudflare.py stats
```

The smoke/browser commands exercise public flows on controlled public pages and remove test shares. Counts from these tests are operational test traffic, not customers. Record the exact Cloudflare deployment/version IDs and source commit in the release receipt. A changed code version is not proof that the assets or actual deployed behavior work: inspect the live page.

## Budget and metrics

No paid inference, Browser Run, new subscription, email service, or domain purchase. Uses the existing Workers paid account; ordinary Workers/Durable Object use is subject to that account's included quotas and overage pricing. This is not a claim of zero possible cost. The application limits scans and shares to 250 each per UTC day, with bounded network/CPU work, and uses per-IP rate limits before writes/public report reads. Rate limits are not a DDoS service guarantee.

`/api/stats` reports started/completed/failed scans, shares and deletes by day. Reservations and share counts are serialized; completion/failure/delete event recording is best effort. No person, IP, target URL, prompt, raw HTML or report text enters these counters. They diagnose usage and failures; they do not measure accepted fixes, customers or revenue.

## Data lifetime

Unshared HTML/report processing is in memory. Explicitly shared derived reports live in SQLite Durable Object storage for seven days. The public URL is a bearer capability; it has noindex/no-referrer/no-store headers but is readable by anyone with the link. Query strings and authentication-bearing targets are rejected. Report expiry is enforced on every read; alarms remove expired entries in batches of 100 and retry promptly if more remain. Deletion uses a transaction and removes both report and expiry index immediately. Cloudflare may retain infrastructure-level data under its own policies; Worker observability logging is disabled and application code does not log requests, fetched bodies or secrets.

The ordinary browser keeps only creator deletion keys for shared reports, not a browsing history or analytics identifier. It can be cleared by the user. Recipients cannot recover a deletion key from the report. If a user loses it, the report still expires; an authorized operator can delete a specific report using the platform tools after verifying the request.

## Pause and rollback

To pause **new scans and shares** while keeping existing reports readable/deletable, set `SERVICE_ENABLED` to `"false"` in `wrangler.jsonc`, validate, and deploy. Restore `"true"` to resume. This is application state, not a license to delete storage. Do not delete the Durable Object namespace to stop traffic.

```sh
python3 scripts/cloudflare.py deployments
python3 scripts/cloudflare.py rollback <previous-version-id>
```

Rollback preserves existing Durable Object data. It must target a version with a compatible storage schema and the expected bindings. Initial-release recovery is the pause deployment if no earlier product version exists. No storage migration beyond the initial SQLite namespace is introduced in v1. Keep the migration tag and class stable across routine releases.

## Known technical boundaries

DNS checks validate A/AAAA answers but do not bind the later hostname resolution. `global_fetch_strictly_public` routes through the public Internet instead of an own-zone private origin; there are no private-network bindings or target credentials. Do not reuse this architecture inside a private network and claim DNS-rebinding protection. All redirects are independently checked and fetched with explicit headers and no cookies/auth.

`redirect: 'error'` is not supported by edge fetch. The fixed-origin DNS call uses `manual` and rejects non-2xx; target requests use manual redirects with validation. Native runtime tests cover behavior rather than Node-only mocks.

Analysis is source-level. A JS-rendered site may need manual browser review; a valid source signal is not a design, performance, security, accessibility or SEO verdict. Product changes should be driven by actual accepted/rejected findings and repeat use, not larger checklist counts.


## Prospective audience totals (November 2026 candidate)

`python3 scripts/cloudflare.py stats --days 7` (or `30`) requests the existing protected stats route. `GET /api/stats?days=7|30` keeps operational `days` separate (existing eight-day retention) and adds `audience` with schemaVersion/windowDays/from/to/observedSince/coverage/days. New `audience:YYYY-MM-DD` records in the same Control object are retained 35 days. Missing dates or observedSince=null mean unobserved coverage, never evidence of no visitors. Historical operational totals are unclassified and must not be presented as browser usage or humans. The current UTC date is partial.

Each audience day contains browser_like/bot_like/unknown maps of observed page/scan_started/scan_completed/scan_failed/shared counts. Omitted counters within an observed day are zero accepted events; no unique visitors, conversion attribution or event history is available. Browser-like requires browser UA, language and Fetch Metadata evidence; explicit crawler/headless/tool tokens win as bot-like, and incomplete clients stay unknown. Signals are forgeable, so browser-like never means verified human. No raw UA/IP, identifiers, cookies or fingerprints are persisted in audience totals.

Homepage counts require successful GET / HTML document navigation with same-origin/same-site/none/cross-site Fetch Metadata, including ordinary external referrals. This deliberately excludes arbitrary scanner paths, fetches and clients without navigation metadata; it is not all edge traffic. Worker-first routing now includes `/`. The existing READ_LIMITER bounds page writes under an `audience:` key prefix, separate from shared-report reads; scan/share events use the existing write limiter and actual accepted operation outcomes. There is no new public event endpoint or service.

`X-Archbotics-QA: 1`, DNT:1 and Sec-GPC:1 skip audience recording before the page usage limiter or audience storage. Operational scan limits, reports and existing operational counters still run. QA checks should always send the explicit QA header. All audience writes are best effort and do not establish payment/customer outcomes or complete usage coverage. Source changes require root integration and live verification before being called deployed.

Audience cleanup alarms run at least daily while audience records exist, or at the next report expiry when that is sooner. A report with a later expiry cannot postpone daily audience retention cleanup.
