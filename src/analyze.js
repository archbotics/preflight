import { parse } from 'parse5';

const ENGINE_VERSION = 'preflight-html/1.0.0';
const MAX_ANALYZED_NODES = 50_000;
const SKIP_TEXT = new Set(['script', 'style', 'template']);
const SHELL_IGNORED = new Set(['noscript', 'script', 'style', 'template']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'poster']);
const STRONG_PLACEHOLDERS = [
  /\blorem ipsum\b/iu,
  /\b(?:(?:replace|insert) (?:(?:this|the) )?(?:text|copy|content)|replace me)\b/iu,
  /\b(?:dummy|sample|placeholder) (?:text|copy|content)\b/iu,
];
const AMBIGUOUS_PLACEHOLDERS = [/\b(?:todo|tbd)\b/iu, /\bcoming soon\b/iu];

const clean = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
const clip = (value, max = 220) => {
  const text = clean(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};
const uniq = (values) => [...new Set(values.filter(Boolean))];
const attr = (node, name) => node?.attrs?.find((item) => item.name.toLowerCase() === name)?.value;
const hasAttr = (node, name) => node?.attrs?.some((item) => item.name.toLowerCase() === name) ?? false;

function hidden(node, inherited = false) {
  if (inherited || !node?.tagName) return inherited;
  if (hasAttr(node, 'hidden') || node.tagName === 'template') return true;
  if (node.tagName === 'input' && attr(node, 'type')?.toLowerCase() === 'hidden') return true;
  if (attr(node, 'aria-hidden')?.toLowerCase() === 'true') return true;
  const style = (attr(node, 'style') ?? '').replace(/\s+/gu, '').toLowerCase();
  return /(?:^|;)display:none(?:!important)?(?:;|$)/u.test(style) ||
    /(?:^|;)visibility:hidden(?:!important)?(?:;|$)/u.test(style);
}

export class AnalyzeError extends Error {
  constructor() {
    super('The returned HTML is too structurally complex to analyze safely.');
    this.name = 'AnalyzeError';
    this.code = 'page_too_complex';
    this.status = 422;
  }
}

function walk(root, visit, inheritedHidden = false) {
  const stack = [{ node: root, inheritedHidden }];
  let visited = 0;
  while (stack.length) {
    const current = stack.pop();
    if (++visited > MAX_ANALYZED_NODES) throw new AnalyzeError();
    const isHidden = hidden(current.node, current.inheritedHidden);
    if (current.node?.tagName) visit(current.node, isHidden);
    if (current.node?.tagName === 'template') continue;
    const children = current.node?.childNodes ?? [];
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ node: children[index], inheritedHidden: isHidden });
    }
  }
}

function textOf(root, visible = false, inheritedHidden = false) {
  const parts = [];
  const stack = [{ node: root, inheritedHidden }];
  let visited = 0;
  while (stack.length) {
    const current = stack.pop();
    if (++visited > MAX_ANALYZED_NODES) throw new AnalyzeError();
    const isHidden = visible ? hidden(current.node, current.inheritedHidden) : current.inheritedHidden;
    if (visible && (isHidden || (current.node?.tagName && SKIP_TEXT.has(current.node.tagName)))) continue;
    if (current.node?.nodeName === '#text') { parts.push(current.node.value ?? ''); continue; }
    const children = current.node?.childNodes ?? [];
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ node: children[index], inheritedHidden: isHidden });
    }
  }
  return parts.join(' ');
}

function headerMap(headers) {
  const result = new Map();
  if (!headers) return result;
  if (typeof headers.entries === 'function') {
    for (const [key, value] of headers.entries()) result.set(key.toLowerCase(), String(value));
  } else {
    for (const [key, value] of Object.entries(headers)) {
      result.set(key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
    }
  }
  return result;
}

function resolveHttp(value, base) {
  if (!clean(value)) return null;
  try {
    const result = new URL(clean(value), base);
    return ['http:', 'https:'].includes(result.protocol) ? result : null;
  } catch { return null; }
}

function documentBaseUrl(baseNode, fallback) {
  if (!baseNode) return fallback;
  try {
    const resolved = new URL(attr(baseNode, 'href'), fallback);
    return ['data:', 'javascript:'].includes(resolved.protocol) ? fallback : resolved;
  }
  catch { return fallback; }
}

function safeUrl(value, base) {
  const raw = clean(value);
  if (!raw) return '[empty]';
  try {
    const result = new URL(raw, base);
    result.username = '';
    result.password = '';
    const hadQuery = Boolean(result.search);
    result.search = '';
    return clip(`${result.toString()}${hadQuery ? ' [query removed]' : ''}`);
  } catch {
    return clip(raw.split(/[?#]/u, 1)[0] || '[invalid URL]');
  }
}

function sameUrl(left, right) {
  const a = new URL(left.toString());
  const b = new URL(right.toString());
  a.hash = '';
  b.hash = '';
  return a.toString() === b.toString();
}

function check(id, category, status, title, detail, evidence, recommendation, acceptance) {
  return {
    id: clip(id, 80), category, status, title: clip(title, 200), detail: clip(detail, 600),
    evidence: uniq(evidence).slice(0, 4).map((value) => clip(value)),
    recommendation: clip(recommendation, 500), acceptance: clip(acceptance, 500),
  };
}

const missingStatus = (shell, normal = 'fix') => shell ? 'review' : normal;
const missingDetail = (what, shell) => shell
  ? `${what} was not found in the returned HTML. This appears to be a JavaScript shell, so the rendered page is unknown.`
  : `${what} was not found in the returned HTML source.`;

function isJsShell(elements, visibleText) {
  const moduleScript = elements.some(({ node }) => node.tagName === 'script' &&
    attr(node, 'type')?.toLowerCase() === 'module' && hasAttr(node, 'src'));
  const bundleScript = moduleScript || elements.some(({ node }) => node.tagName === 'script' && hasAttr(node, 'src'));

  function emptyMount(node) {
    const stack = [...(node.childNodes ?? [])];
    let visited = 0;
    while (stack.length) {
      const child = stack.pop();
      if (++visited > MAX_ANALYZED_NODES) throw new AnalyzeError();
      if (child?.tagName && SHELL_IGNORED.has(child.tagName)) continue;
      if (child?.tagName || (child?.nodeName === '#text' && clean(child.value))) return false;
      stack.push(...(child?.childNodes ?? []));
    }
    return true;
  }

  const explicitMount = elements.some(({ node }) => {
    const id = (attr(node, 'id') ?? '').toLowerCase();
    return ((node.tagName === 'main' && id === 'main') || ['app', 'root'].includes(id)) && emptyMount(node);
  });
  if (moduleScript && explicitMount) return true;

  const frameworkMount = elements.some(({ node }) => {
    const id = (attr(node, 'id') ?? '').toLowerCase();
    return (['app', 'root', '__next', '__nuxt', 'svelte'].includes(id) || hasAttr(node, 'data-reactroot')) && emptyMount(node);
  });
  return bundleScript && frameworkMount && visibleText.length <= 320;
}

function blocksIndexing(value, allowAgentPrefix = false) {
  return String(value).split(',').some((part) => {
    const directive = part.trim().toLowerCase();
    if (directive === 'noindex' || directive === 'none') return true;
    if (!allowAgentPrefix || !directive.includes(':')) return false;
    const [agent, ...rest] = directive.split(':');
    const rule = rest.join(':').trim();
    return !agent.trim().startsWith('max-') && (rule === 'noindex' || rule === 'none');
  });
}

function noindexEvidence(elements, headers) {
  const found = [];
  for (const { node } of elements) {
    const name = attr(node, 'name')?.toLowerCase();
    const content = attr(node, 'content') ?? '';
    if (node.tagName === 'meta' && ['robots', 'googlebot', 'bingbot'].includes(name) && blocksIndexing(content)) {
      found.push(`Meta ${name}: ${clip(content, 140)}`);
    }
  }
  const header = headers.get('x-robots-tag') ?? '';
  if (blocksIndexing(header, true)) found.push(`X-Robots-Tag: ${clip(header, 140)}`);
  return uniq(found);
}

function devUrlEvidence(elements, visibleText, base) {
  const pattern = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\p{L}\p{N}.-]+\.(?:local|localhost|test))(?::\d+)?(?:\/[^\s"'<>]*)?/giu;
  const found = [...visibleText.matchAll(pattern)].map((item) => item[0]);
  for (const { node, isHidden } of elements) {
    if (isHidden) continue;
    for (const item of node.attrs ?? []) {
      if (!URL_ATTRS.has(item.name.toLowerCase())) continue;
      pattern.lastIndex = 0;
      if (pattern.test(item.value)) found.push(item.value);
    }
  }
  return uniq(found).map((value) => `Development URL: ${safeUrl(value, base)}`);
}

export function analyze({ html, url, requestedUrl = url, mode = 'preview', status = 200,
  headers = {}, bytes, redirects = 0, checkedAt = new Date().toISOString() }) {
  if (typeof html !== 'string') throw new TypeError('html must be a string');
  if (!['preview', 'live'].includes(mode)) throw new TypeError('mode must be "preview" or "live"');
  const finalUrl = resolveHttp(url);
  if (!finalUrl) throw new TypeError('url must be an absolute HTTP(S) URL');

  const document = parse(html);
  const elements = [];
  walk(document, (node, isHidden) => elements.push({ node, isHidden }));
  const nodes = (tag) => elements.filter(({ node }) => node.tagName === tag).map(({ node }) => node);
  const head = nodes('head')[0];
  const headElements = [];
  if (head) walk(head, (node, isHidden) => headElements.push({ node, isHidden }));
  const headNodes = (tag) => headElements.filter(({ node }) => node.tagName === tag &&
    node.namespaceURI === 'http://www.w3.org/1999/xhtml').map(({ node }) => node);
  const baseNode = headNodes('base').find((node) => hasAttr(node, 'href'));
  const documentBase = documentBaseUrl(baseNode, finalUrl);
  const visible = elements.filter(({ node, isHidden }) => !isHidden && !SKIP_TEXT.has(node.tagName));
  const body = nodes('body')[0] ?? document;
  const visibleText = clean(textOf(body, true));
  const shell = isJsShell(elements, visibleText);
  const responseHeaders = headerMap(headers);
  const checks = [];
  const responseStatus = Number.isFinite(Number(status)) ? Number(status) : 0;
  const redirectCount = Number.isFinite(Number(redirects)) ? Number(redirects) : 0;

  checks.push(check('response-status', 'launch', responseStatus >= 200 && responseStatus < 300 ? 'pass' : 'fix',
    responseStatus >= 200 && responseStatus < 300 ? 'Page response succeeded' : 'Page response needs attention',
    responseStatus >= 200 && responseStatus < 300 ? 'The final HTML response used a successful HTTP status.' : 'The final HTML response did not use a successful 2xx status.',
    [`HTTP status: ${responseStatus}`, `Redirects followed: ${redirectCount}`],
    'Make the public page return a successful 2xx response without an error document.',
    'A fresh request reaches the intended page and its final response status is between 200 and 299.'));

  checks.push(check('https', 'launch', finalUrl.protocol === 'https:' ? 'pass' : 'fix',
    finalUrl.protocol === 'https:' ? 'Final page uses HTTPS' : 'Final page does not use HTTPS',
    finalUrl.protocol === 'https:' ? 'The final response URL uses HTTPS.' : 'The final response URL uses unencrypted HTTP.',
    [`Final URL scheme: ${finalUrl.protocol.slice(0, -1).toUpperCase()}`],
    'Serve the page over HTTPS and redirect its HTTP address to the HTTPS address.',
    'A fresh request ends on an HTTPS URL with a successful response.'));

  const noindex = noindexEvidence(headElements, responseHeaders);
  if (noindex.length) {
    checks.push(check('indexing', 'discovery', mode === 'live' ? 'fix' : 'info',
      mode === 'live' ? 'Live page blocks indexing' : 'Preview page blocks indexing',
      mode === 'live' ? 'A noindex directive was found in the returned response.' : 'A noindex directive was found, which is expected for many previews. It is not a privacy control.', noindex,
      mode === 'live' ? 'Remove every noindex directive when this page is ready for indexing.' : 'Control preview access separately and remove noindex only when publishing.',
      mode === 'live' ? 'The live HTML and response headers contain no noindex directive.' : 'The preview has an intentional indexing policy and private work uses real access control.'));
  } else {
    const result = mode === 'preview' ? 'info' : shell ? 'review' : 'pass';
    checks.push(check('indexing', 'discovery', result,
      mode === 'preview' ? 'No noindex directive found in preview source' : shell ? 'Live indexing needs rendered-page review' : 'No noindex directive found',
      mode === 'preview' ? 'No noindex directive was found in the preview HTML or headers. Preview access needs a separate decision.' :
        shell ? 'No noindex directive was found in returned HTML or headers, but the rendered head is unknown.' : 'No noindex directive was found in returned HTML or headers. This does not promise search indexing.',
      ['Robots meta noindex signals: 0', 'X-Robots-Tag noindex signals: 0'],
      mode === 'preview' ? 'Decide whether this preview should be discoverable and use access control for private work.' : 'Keep the live response free of noindex if it should be eligible for indexing.',
      mode === 'preview' ? 'The preview has an intentional indexing policy.' : 'The final live HTML and headers contain no noindex directive.'));
  }

  const titleNodes = headNodes('title');
  const titles = titleNodes.map((node) => clean(textOf(node))).filter(Boolean);
  if (titles.length === 1 && titleNodes.length === 1) {
    checks.push(check('title', 'discovery', 'pass', 'Page title found', 'The returned HTML contains one non-empty title element.', [`Title: “${clip(titles[0], 150)}”`],
      'Keep the title specific to this page and business.', 'The final HTML contains one accurate, non-empty title element.'));
  } else if (titleNodes.length > 1) {
    checks.push(check('title', 'discovery', 'review', 'Multiple title elements found', 'Browsers and crawlers may choose among conflicting title elements.', [`Title elements: ${titleNodes.length}`, ...titles.slice(0, 2).map((v) => `Title: “${clip(v, 120)}”`)],
      'Keep one non-empty title element in the document head.', 'The final HTML contains exactly one accurate, non-empty title element.'));
  } else {
    checks.push(check('title', 'discovery', missingStatus(shell), 'Page title not found', missingDetail('A non-empty title element', shell), ['Non-empty title elements: 0'],
      'Add a specific, non-empty title element to the document head.', 'The final HTML contains exactly one accurate, non-empty title element.'));
  }

  const descriptions = headElements.filter(({ node }) => node.tagName === 'meta' && attr(node, 'name')?.toLowerCase() === 'description')
    .map(({ node }) => clean(attr(node, 'content'))).filter(Boolean);
  if (descriptions.length === 1) checks.push(check('description', 'discovery', 'pass', 'Meta description found', 'The returned HTML contains one non-empty meta description.', [`Description: “${clip(descriptions[0], 170)}”`],
    'Keep the description accurate and specific.', 'The final HTML contains one accurate, non-empty meta description.'));
  else if (descriptions.length > 1) checks.push(check('description', 'discovery', 'review', 'Multiple meta descriptions found', 'The returned HTML contains more than one non-empty meta description.', [`Non-empty descriptions: ${descriptions.length}`],
    'Keep one accurate meta description.', 'The final HTML contains exactly one accurate, non-empty meta description.'));
  else checks.push(check('description', 'discovery', missingStatus(shell), 'Meta description not found', missingDetail('A non-empty meta description', shell), ['Non-empty meta descriptions: 0'],
    'Add one accurate meta description to the document head.', 'The final HTML contains exactly one accurate, non-empty meta description.'));

  const canonicalNodes = headElements.filter(({ node }) => node.tagName === 'link' && (attr(node, 'rel') ?? '').toLowerCase().split(/\s+/u).includes('canonical'));
  const canonicalValues = canonicalNodes.map(({ node }) => attr(node, 'href') ?? '');
  const resolved = canonicalValues.map((value) => resolveHttp(value, documentBase));
  const valid = resolved.filter(Boolean);
  const destinations = uniq(valid.map((value) => { const copy = new URL(value); copy.hash = ''; return copy.toString(); }));
  const canonicalEvidence = canonicalValues.slice(0, 3).map((value) => `Canonical href: ${safeUrl(value, documentBase)}`);
  if (!canonicalNodes.length) checks.push(check('canonical', 'discovery', missingStatus(shell, mode === 'live' ? 'fix' : 'review'), 'Canonical link not found', missingDetail('A canonical link', shell), ['Canonical links: 0'],
    'Add one canonical link pointing to the intended public page.', 'The final HTML contains exactly one valid canonical for the intended public page.'));
  else if (valid.length !== canonicalNodes.length) checks.push(check('canonical', 'discovery', 'fix', 'Canonical link is invalid', 'At least one canonical href cannot resolve as an HTTP(S) URL.', [`Canonical links: ${canonicalNodes.length}`, ...canonicalEvidence],
    'Replace invalid canonical values with one correctly resolving HTTP(S) URL.', 'The final HTML contains exactly one valid canonical for the intended public page.'));
  else if (destinations.length > 1) checks.push(check('canonical', 'discovery', 'fix', 'Canonical links conflict', 'The HTML declares more than one canonical destination.', [`Distinct canonical destinations: ${destinations.length}`, ...canonicalEvidence],
    'Remove conflicting links and keep one canonical destination.', 'The final HTML contains exactly one valid canonical for the intended public page.'));
  else {
    const duplicate = canonicalNodes.length > 1;
    const self = sameUrl(valid[0], finalUrl);
    const review = duplicate || !self || mode === 'preview';
    checks.push(check('canonical', 'discovery', review ? 'review' : 'pass', duplicate ? 'Duplicate canonical links found' : !self ? 'Canonical points to another URL' : mode === 'preview' ? 'Preview canonical needs a live target check' : 'Canonical matches the final URL',
      duplicate ? 'The links resolve to one destination, but duplicate declarations should be removed.' : !self ? 'The canonical resolves but points elsewhere; confirm that destination is intentional.' : mode === 'preview' ? 'The canonical points to the inspected preview. That does not establish the live target.' : 'The single canonical resolves to the inspected final URL.',
      [`Canonical links: ${canonicalNodes.length}`, ...canonicalEvidence], 'Keep one canonical link pointing to the intended public page.', 'The final live HTML contains exactly one valid canonical for the intended public page.'));
  }

  const viewports = headElements.filter(({ node }) => node.tagName === 'meta' && attr(node, 'name')?.toLowerCase() === 'viewport');
  if (viewports.length === 1 && clean(attr(viewports[0].node, 'content'))) checks.push(check('viewport', 'launch', 'pass', 'Viewport metadata found', 'The returned HTML contains a non-empty viewport declaration.', [`Viewport: ${clip(attr(viewports[0].node, 'content'), 140)}`],
    'Keep a viewport suited to responsive layouts.', 'The final HTML contains one appropriate viewport meta tag.'));
  else checks.push(check('viewport', 'launch', viewports.length > 1 ? 'review' : missingStatus(shell), viewports.length > 1 ? 'Multiple viewport declarations found' : 'Viewport metadata not found',
    viewports.length > 1 ? 'The returned HTML contains multiple viewport declarations.' : missingDetail('A non-empty viewport declaration', shell), [`Viewport meta tags: ${viewports.length}`],
    'Keep one appropriate, non-empty viewport meta tag.', 'The final HTML contains exactly one appropriate viewport meta tag.'));

  const language = clean(attr(nodes('html')[0], 'lang'));
  const validLanguage = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/iu.test(language);
  checks.push(check('language', 'accessibility', validLanguage ? 'pass' : language ? 'review' : missingStatus(shell),
    validLanguage ? 'Document language declared' : language ? 'Document language needs review' : 'Document language not declared',
    validLanguage ? 'The root HTML element has a language tag.' : language ? 'The language value does not look like a standard language tag.' : missingDetail('An HTML lang attribute', shell),
    [language ? `HTML lang: “${language}”` : 'HTML lang attributes: 0'], 'Set the root HTML lang attribute to the page’s primary language.', 'The final HTML declares a valid primary language tag.'));

  const h1s = visible.filter(({ node }) => node.tagName === 'h1').map(({ node }) => clean(textOf(node, true))).filter(Boolean);
  checks.push(check('h1', 'content', h1s.length === 1 ? 'pass' : h1s.length > 1 ? 'review' : missingStatus(shell),
    h1s.length === 1 ? 'One source H1 found' : h1s.length > 1 ? 'Multiple source H1 headings found' : 'Source H1 not found',
    h1s.length === 1 ? 'The returned HTML contains one non-empty H1 outside explicit source-hidden regions.' : h1s.length > 1 ? 'The returned HTML contains more than one such H1. CSS and visual layout were not evaluated.' : missingDetail('A non-empty H1 outside explicit source-hidden regions', shell),
    h1s.length ? [`Source H1 headings: ${h1s.length}`, ...h1s.slice(0, 2).map((v) => `H1: “${clip(v, 120)}”`)] : ['Non-empty source H1 headings: 0'],
    'Keep one clear primary heading on the rendered main page.', 'The rendered main page has one clear primary heading.'));

  for (const [id, property, label] of [['og-title', 'og:title', 'Open Graph title'], ['og-image', 'og:image', 'Open Graph image']]) {
    const values = headElements.filter(({ node }) => node.tagName === 'meta' && attr(node, 'property')?.toLowerCase() === property)
      .map(({ node }) => clean(attr(node, 'content'))).filter(Boolean);
    const validImage = id !== 'og-image' || (values[0] && resolveHttp(values[0], documentBase));
    if (values.length === 1 && validImage) checks.push(check(id, 'discovery', 'pass', `${label} found`, `The returned HTML contains one non-empty ${property} value.`,
      [`${property}: ${id === 'og-image' ? safeUrl(values[0], documentBase) : `“${clip(values[0], 150)}”`}`], `Keep ${property} accurate for this page.`, `The final HTML contains one accurate ${property} value.`));
    else checks.push(check(id, 'discovery', 'review', `${label} needs review`, values.length > 1 ? `The HTML contains multiple ${property} values.` : values.length ? `The ${property} value does not resolve to an HTTP(S) URL.` : missingDetail(`A non-empty ${property} value`, shell),
      [`Non-empty ${property} values: ${values.length}`], `Add or correct ${property} if this page should have a useful social preview.`, `A shared link has the intended ${property} preview when applicable.`));
  }

  const strongPlaceholders = uniq(STRONG_PLACEHOLDERS.map((pattern) => pattern.exec(visibleText)?.[0]).filter(Boolean));
  const ambiguousPlaceholders = uniq(AMBIGUOUS_PLACEHOLDERS.map((pattern) => pattern.exec(visibleText)?.[0]).filter(Boolean));
  const placeholders = [...strongPlaceholders, ...ambiguousPlaceholders].map((value) => `Source text: “${value}”`);
  const placeholderStatus = strongPlaceholders.length ? 'fix' : ambiguousPlaceholders.length || shell ? 'review' : 'pass';
  checks.push(check('placeholder-copy', 'content', placeholderStatus,
    strongPlaceholders.length ? 'Unfinished placeholder copy found' : ambiguousPlaceholders.length ? 'Possible unfinished copy' : shell ? 'Placeholder copy needs rendered-page review' : 'No common placeholder copy found',
    strongPlaceholders.length ? 'Strong unfinished-copy markers appear in returned text outside explicit source-hidden regions.' :
      ambiguousPlaceholders.length ? 'Phrases such as “coming soon,” “todo,” or “tbd” can be intentional or unfinished. Review their context before changing them.' :
        shell ? 'No common placeholder phrase was found in source text, but rendered copy is unknown.' : 'No common placeholder phrase was found in returned text outside explicit source-hidden regions. CSS and visual presentation were not evaluated.',
    placeholders.length ? placeholders : ['Common source placeholder phrase matches: 0'],
    strongPlaceholders.length ? 'Replace unfinished phrases with final page-specific copy.' : 'Review the phrase in the rendered page and change it only if it is unfinished copy.',
    'A rendered-page review finds no unintended placeholder copy.'));

  const devUrls = devUrlEvidence(elements, visibleText, finalUrl);
  checks.push(check('development-urls', 'launch', devUrls.length ? 'fix' : shell ? 'review' : 'pass', devUrls.length ? 'Development URL found' : shell ? 'Development URLs need rendered-page review' : 'No literal development URL found',
    devUrls.length ? 'A development-only URL appears in returned text or an element URL attribute outside explicit source-hidden regions.' : shell ? 'No development URL was found in source content, but rendered links are unknown.' : 'No localhost or common development-only URL was found outside explicit source-hidden regions. CSS and JavaScript were not evaluated.',
    devUrls.length ? devUrls : ['Literal development URL matches: 0'], 'Replace development-only URLs with intended public destinations.', 'The rendered main page contains no development-only destination.'));

  const ids = new Set(visible.map(({ node }) => attr(node, 'id')).filter(Boolean));
  const names = new Set(visible.filter(({ node }) => node.tagName === 'a').map(({ node }) => attr(node, 'name')).filter(Boolean));
  let empty = 0, unresolved = 0, fragments = 0;
  for (const { node } of visible.filter(({ node }) => node.tagName === 'a')) {
    const href = attr(node, 'href');
    if (href === undefined || clean(href) === '' || clean(href) === '#') { empty += 1; continue; }
    if (href.startsWith('#')) {
      const resolvedFragment = resolveHttp(href, documentBase);
      let target = resolvedFragment?.hash.slice(1) ?? href.slice(1);
      try { target = decodeURIComponent(target); } catch { /* malformed target remains unresolved */ }
      if (resolvedFragment && sameUrl(resolvedFragment, finalUrl) && (ids.has(target) || names.has(target))) fragments += 1;
      else unresolved += 1;
    }
  }
  checks.push(check('link-targets', 'launch', empty + unresolved ? 'review' : shell ? 'review' : 'pass', empty + unresolved ? 'Empty or unresolved anchor targets found' : shell ? 'Anchor targets need rendered-page review' : 'No empty or unresolved anchor targets found',
    empty + unresolved ? 'These source anchors may be unfinished. Fragment links with matching targets are excluded.' : shell ? 'Source anchors have no target issue, but rendered links are unknown.' : 'No source anchor has an empty target or an unmatched fragment.',
    [`Empty anchor targets: ${empty}`, `Unresolved fragment targets: ${unresolved}`, `Valid fragment targets: ${fragments}`], 'Give each unfinished anchor a real destination or matching fragment target.', 'Every rendered call-to-action and navigation link reaches its intended destination.'));

  const anchors = visible.filter(({ node }) => node.tagName === 'a');
  const direct = anchors.filter(({ node }) => /^(?:mailto|tel):/iu.test(attr(node, 'href') ?? '')).length;
  const contactLinks = anchors.filter(({ node }) => /(?:^|[/#_-])contact(?:$|[/#?_-])/iu.test(attr(node, 'href') ?? '') || /\b(?:contact|support|get in touch)\b/iu.test(clean(textOf(node, true)))).length;
  const forms = visible.filter(({ node }) => node.tagName === 'form' && /\b(?:contact|message|inquiry|enquiry)\b/iu.test(`${attr(node, 'action') ?? ''} ${attr(node, 'id') ?? ''} ${clean(textOf(node, true))}`)).length;
  checks.push(check('contact-route', 'content', direct + contactLinks + forms ? 'pass' : 'review', direct + contactLinks + forms ? 'Contact route signal found' : 'Contact route needs review',
    direct + contactLinks + forms ? 'The HTML contains a plausible contact route. This heuristic does not verify it works.' : shell ? 'No contact signal was found in returned HTML; the rendered route is unknown.' : 'No contact signal was found. A route may use wording this heuristic does not recognize.',
    [`Direct mail or phone links: ${direct}`, `Plausible contact anchors: ${contactLinks}`, `Plausible contact forms: ${forms}`], 'Provide a clear, working contact route when the page requires one.', 'A visitor can find and use the intended contact route.'));

  const images = visible.filter(({ node }) => node.tagName === 'img');
  const missingAlt = images.filter(({ node }) => !hasAttr(node, 'alt')).length;
  const emptyAlt = images.filter(({ node }) => hasAttr(node, 'alt') && attr(node, 'alt') === '').length;
  checks.push(check('image-alt', 'accessibility', missingAlt ? 'review' : images.length ? 'pass' : shell ? 'review' : 'info', missingAlt ? 'Images without alt attributes found' : images.length ? 'Source images have alt attributes' : shell ? 'Image alt attributes need rendered-page review' : 'No source images found',
    missingAlt ? 'Some source images outside explicit source-hidden regions omit alt. Empty alt is counted separately because it can be correct for decorative images.' : images.length ? 'Every such source image has alt. CSS, rendered visibility, text quality, and accessibility were not evaluated.' : shell ? 'No source images were found, but rendered images are unknown.' : 'No img elements were found outside explicit source-hidden regions in returned HTML.',
    [`Source images checked: ${images.length}`, `Missing alt attributes: ${missingAlt}`, `Empty alt attributes: ${emptyAlt}`], 'Add useful alt text to informative images and empty alt only to decorative images.', 'Every rendered informative image has accurate alt text and decorative images use intentional empty alt.'));

  const summary = { fix: 0, review: 0, pass: 0, info: 0 };
  for (const item of checks) summary[item.status] += 1;
  return {
    schemaVersion: 1, engineVersion: ENGINE_VERSION, requestedUrl: clip(requestedUrl, 2048), url: clip(finalUrl.toString(), 2048), mode,
    checkedAt: clip(checkedAt, 64), title: clip(titles[0] || 'Preflight report', 200), summary, checks,
    page: { status: responseStatus, bytes: Number.isFinite(Number(bytes)) ? Number(bytes) : new TextEncoder().encode(html).byteLength,
      redirects: redirectCount, contentType: clip(responseHeaders.get('content-type') ?? 'unknown', 200) },
    limits: [
      'This report checks the returned main-page HTML and response headers only; it does not inspect linked pages.',
      'JavaScript and CSS are not executed or fully evaluated, and no visual checks are performed.',
      'HTML hidden attributes and a few explicit inline hiding signals are excluded, but rendered visibility is not known.',
      'Contact routes, link targets, and image alt attributes are source signals that still need human review.',
      ...(shell ? ['This page appears to be a JavaScript shell; signals missing from source HTML may exist after rendering and are marked for review.'] : []),
    ],
  };
}

export function exampleReport() {
  const report = analyze({
    html: '<!doctype html><html lang="en"><head><title>Example &amp; Sons — Home</title><meta name="description" content="A fictional small-business page used to demonstrate Preflight."><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><link rel="canonical" href="https://example.com/"><meta property="og:title" content="Example &amp; Sons"><meta property="og:image" content="https://example.com/example-card.png"></head><body><main><h1>Example &amp; Sons</h1><p>Coming soon: a fictional spring collection.</p><img src="/example-work.png" alt="A fictional example project"></main></body></html>',
    url: 'https://example.com/', mode: 'live', headers: { 'content-type': 'text/html; charset=utf-8' }, checkedAt: '2026-01-01T00:00:00.000Z',
  });
  return { ...report, title: 'Synthetic Preflight example — Example & Sons', example: true, limits: [
    'This is a synthetic example built from fictional example.com HTML. It is not a live scan and makes no claims about a real website.', ...report.limits,
  ] };
}
