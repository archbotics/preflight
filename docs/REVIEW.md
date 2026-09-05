# Release review · 2026-09-05

Independent backend reviewer and product critic both passed the release candidate after correction. The integrator owns the deployment verification in RELEASE.md. Review is scoped evidence, not a security or accessibility certification.

| Finding | Correction and observed evidence |
|---|---|
| Worker utility exports prevented native startup | Dedicated runtime entry exports only the Worker and Durable Object. Native workerd startup test passes. |
| Oversized HTML title could produce an unshareable report | Every report string is bounded; a 100,000-character title produces a shareable signed payload. |
| Operator stats could forward its bearer token through redirects | Redirects are refused. No-network regression covers redirect statuses. |
| Browser download bypassed the safe Markdown renderer | One canonical browser/server renderer; actual downloaded bytes match. CommonMark and GFM adversarial rendering produced no active links, images or scripts. |
| Documentation navigation discarded an unsaved report | Documentation opens a modal and preserves URL, report, filter, signing token and creator state. Hidden report header removed the second destructive navigation route. |
| Passed checks appeared before the actionable fix | Report and Markdown group Fix, Review, Passed, Information. |
| Ordinary coming-soon text was treated as a confirmed defect | Ambiguous phrases require review; source evidence preserves context. |
| Metadata in the wrong HTML region and relative base URLs misled checks | Head-only metadata, first base with an href, explicit invalid/duplicate canonical handling. The [HTML Standard](https://html.spec.whatwg.org/multipage/urls-and-fetching.html#document-base-urls) fixes selection order; an invalid first base does not promote a later one. |
| Live self-scan treated a JavaScript-rendered H1 as a confirmed omission | Empty app/main mounts with module or recognized classic bundles are marked as shells; supporting footer/docs text does not establish rendered main content. Static pages with substantive main content retain definite missing-H1 findings. |

The independent product review exercised Chromium at 1440 and 390 pixels, zero observed Axe violations on landing/report/privacy, keyboard focus and modal return, no horizontal overflow, hostile source text, explicit share action, denied local storage, creator reload, recipient capability boundaries, deletion, and expired/unavailable states. Its backend states were mocked. The release additionally has a real deployed scan/share/read/delete smoke test and an actual mobile creator/recipient browser flow.

Native SQLite tests exercise serialized scan/share caps, physical deletion, absent reads after deletion, expiry and real alarm invocation. Network tests cover private/IP/query-bearing targets, mixed DNS answers, bounded responses, redirect validation and deadline cancellation. Production seven-day passage is not claimed; expiry is verified with controlled native-runtime time/state.

Known limits: source-only heuristics; no visual verdict; DNS preflight does not pin later resolution; rate limits are local to a Cloudflare location; aggregate completion counters are best effort. No demand, repeat-use, conversion or paid outcome was measured by this release.
