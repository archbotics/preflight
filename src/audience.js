// Transient request heuristics. Never store raw headers or derive a visitor identifier.
export const AUDIENCES = ['browser_like', 'bot_like', 'unknown'];
export const USAGE_EVENTS = ['page', 'scan_started', 'scan_completed', 'scan_failed', 'shared'];
export const usageExcluded = request => ['DNT', 'Sec-GPC', 'X-Archbotics-QA'].some(header => request.headers.get(header) === '1');
export function classifyAudience(request) {
  const ua = request.headers.get('user-agent') || '';
  if (/\bbot\b|bot[-\/;)]|crawl|spider|slurp|curl|wget|python|go-http|headless|scanner|monitor|preview|facebookexternalhit|httpclient|http-client|node-fetch|scrapy|lighthouse|uptime/i.test(ua)) return 'bot_like';
  if (/^Mozilla\/5\.0 \(.+(AppleWebKit|Chrome|Firefox|Safari|Edg|OPR)\//.test(ua) && request.headers.get('accept-language') && /^(cors|same-origin|navigate)$/.test(request.headers.get('sec-fetch-mode') || '') && (/^(same-origin|same-site|none)$/.test(request.headers.get('sec-fetch-site') || '') || (request.headers.get('sec-fetch-mode') === 'navigate' && request.headers.get('sec-fetch-site') === 'cross-site'))) return 'browser_like';
  return 'unknown';
}
export function homeNavigation(request, response) {
  return new URL(request.url).pathname === '/' && request.method === 'GET' && [200, 304].includes(response.status) &&
    /text\/html/i.test(response.headers.get('content-type') || '') && /text\/html/i.test(request.headers.get('accept') || '') &&
    request.headers.get('sec-fetch-mode') === 'navigate' && request.headers.get('sec-fetch-dest') === 'document' &&
    /^(none|same-origin|same-site|cross-site)$/.test(request.headers.get('sec-fetch-site') || '');
}
