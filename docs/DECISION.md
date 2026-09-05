# Product decision · 2026-09-05

HQ #212: the owner authorized an autonomous new-product build and Cloudflare deployment as an end-to-end test. Preflight supports the existing web venture; it does not replace the spearhead.

Considered: a public small-business website grader, a lightweight client-approval board, and a pre-handover website checker. Chose the third: it has an immediate internal consumer and its output is directly useful to a coding agent. The release is deliberately a bounded HTML check, not an AI consultant or automated visual reviewer.

The strongest counterargument is commodity overlap. [Screaming Frog](https://www.screamingfrog.co.uk/seo-spider/) already checks broken links, redirects, titles, robots and canonicals, including a free crawl allowance. [PageSpeed Insights](https://pagespeed.web.dev/) covers performance. [HubSpot Website Grader](https://www.hubspot.com/tests) illustrates generic-score crowding. The intended wedge is URL → evidence → fix → acceptance check, with staging-aware severity and an expiring handoff link. No defensible market advantage has been established yet.

Approval software has a harder first-release burden: [MarkUp](https://www.markup.io/), [Pastel](https://usepastel.com/plans) and [BugHerd](https://bugherd.com/features) already combine contextual comments, screenshots and workflow. Proxying arbitrary live websites safely also introduces auth/CSP complexity. That candidate was not built.

The working name Launchcheck was dropped before publication: [launchcheck.io](https://launchcheck.io/) and [golaunchcheck.com](https://golaunchcheck.com/) already use it in adjacent categories. The public name is descriptive under Archbotics' own brand: Preflight by Archbotics. This is a name-conflict screen, not a trademark clearance opinion.

Technical sources checked: [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/), [rate-limit bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [public fetch routing](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public), [Google crawling/indexing](https://developers.google.com/search/docs/crawling-indexing). Actual local and deployed receipts take precedence over remembered platform behavior.

Next evidence: use the product during three real website handovers, record findings accepted/rejected and whether the fix brief saved a repair step. Then seek repeat use by independent builders. Do not add payment, monitoring, accounts or browser rendering before that evidence. No customer outreach is part of this build.
