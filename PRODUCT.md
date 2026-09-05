# Preflight by Archbotics

Owner-authorized end-to-end product build, HQ #212, 2026-09-05.

## Job

A solo developer or small agency has a newly built small-business website. Before handing it over, catch forgotten launch details and turn each into an actionable fix brief. Free public beta, no login or paid inference. Demand and willingness to pay are untested. This is a supporting product for HQ's web spearhead, not a portfolio promotion.

## First release

Submit a public HTTP(S) page URL, choose Preview or Live. Inspect the returned HTML and HTTP response, not JavaScript rendering. Return grounded findings grouped as Fix, Review, Passed, with concrete evidence, remediation and acceptance checks. No numerical quality score, no SEO/ranking/revenue promises, no security or accessibility certification. Main-page scope must remain visible. Copy/download Markdown fix brief and JSON. Share only by explicit action; an unguessable report link expires in seven days and its creator can delete it using a browser-held secret. Never store fetched HTML. No analytics cookies or third-party fonts/scripts. First-party operational counters only if implemented honestly.

Checks cover response/HTTPS, noindex (preview expected vs live fix), title/description, canonical, viewport/language, headings, OG metadata, placeholder text/dev URLs/empty navigation and contact route signals, image alt attributes. Missing HTML signals on a JS shell are unknown/review, not confidently missing from the rendered page. Contact and hash links are heuristics, never launch blockers by themselves. Noindex is never interpreted as a privacy control.

## API contract

- `POST /api/check` JSON `{url:string, mode:"preview"|"live"}`. `200 {ok:true, report:Report, shareToken:string}`. Inputs fail with `{ok:false,error:{code,message}}` and suitable status. Token available only when signing is configured.
- `POST /api/share` JSON `{report:Report, token:string}`. Verifies server signature and scan age (30 min), stores trusted report with a 7-day TTL. `201 {ok:true,id,url,expiresAt,deleteKey}`. Browser holds deleteKey locally; never put it in share URL.
- `GET /api/reports/:id` → `{ok:true,report,expiresAt}` or 404/410. `DELETE` requires `X-Delete-Key`; returns `{ok:true}`.
- `/r/:id` serves same client shell and loads the report; noindex, no referrer.
- `GET /api/example` → `{ok:true,report}`. Clearly marked synthetic example, never a claimed live scan. Example cannot be shared.
- `GET /api/health` minimal version and status.

`Report = {schemaVersion:1,engineVersion:string,requestedUrl:string,url:string,mode:"preview"|"live",checkedAt:ISO,title:string,summary:{fix:number,review:number,pass:number,info:number},checks:Check[],page:{status:number,bytes:number,redirects:number,contentType:string},limits:string[],example?:boolean}`

`Check = {id:string,category:"launch"|"discovery"|"content"|"accessibility",status:"fix"|"review"|"pass"|"info",title:string,detail:string,evidence:string[],recommendation:string,acceptance:string}`

Contract can only change through integrator coordination. Evidence is untrusted text; render as text, never HTML. Limits: URL 2048 chars, no credentials/query strings/IP literals/local hostnames/nonstandard ports; every redirect independently validated; public DNS preflight; 3 redirects, 512 KiB HTML, 12s total network deadline, no cookies, authorization or incoming headers sent to target. API body cap 96 KiB. Rate limits before expensive operations. Requests are GET only; don't submit forms, execute code or fetch images/scripts.

## Design

English product-company surface, established Archbotics mark/fonts. Paper #F6F3EC, ink #14120F, secondary #5E5850, line #DFDDD6. Ember #C64518 fills, #B53E13 small text. Schibsted Grotesk + Geist Mono labels. No other accent hue, gradients, decorative motion, external assets, fake customer proof or fabricated testimonials. Responsive, keyboard-accessible, text wrap for arbitrary evidence. Product UX speaks in plain language. Explain the actual scan limit where people decide to scan.

## Done

Independent review resolves material findings; unit tests exercise malformed HTML, SSRF inputs/redirects, limits, signature/expiry/delete, XSS rendering and preview/live differences; real browser check at 390 and 1440 plus keyboard/axe; deployed real URL checks and share/read/delete in a fresh browser. Source pushed, reproducible deployment and rollback documented, exact live version and honest limits recorded. No implementation on existing outreach or siteforge claims.
