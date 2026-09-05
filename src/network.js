import ipaddr from 'ipaddr.js';

export class PublicError extends Error {
  constructor(code, message, status = 400) {
    super(message); this.code = code; this.status = status;
  }
}

export const MAX_HTML_BYTES = 512 * 1024;
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'intranet', 'home', 'lan', 'test', 'invalid', 'onion', 'arpa', 'example'];

export function normalizeTarget(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 2048)
    throw new PublicError('invalid_url', 'Enter a public website address, up to 2,048 characters.');
  let value = input.trim();
  if (!/^[a-z][a-z\d+.-]*:/i.test(value)) value = `https://${value}`;
  let url;
  try { url = new URL(value); } catch { throw new PublicError('invalid_url', 'That address could not be read. Try https://example.com.'); }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new PublicError('invalid_url', 'Only HTTP and HTTPS pages can be checked.');
  if (url.username || url.password || url.search)
    throw new PublicError('private_url', 'Use a public page without a password or query string. Do not submit private preview tokens.');
  if (url.port)
    throw new PublicError('invalid_port', 'Only the standard HTTP and HTTPS ports are supported.');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (ipaddr.isValid(host) || !host.includes('.') || host.split('.').some(label => !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label)) ||
      LOCAL_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`)))
    throw new PublicError('private_host', 'Use a public domain name. IP addresses and local or private hosts are not supported.');
  url.hostname = host;
  url.hash = '';
  return url;
}

export function isPublicAddress(value) {
  try { return ipaddr.parse(value).range() === 'unicast'; } catch { return false; }
}

export async function readLimited(response, limit = MAX_HTML_BYTES) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel();
    throw new PublicError('page_too_large', 'This page exceeds the 512 KiB HTML limit. Try a smaller public page.', 422);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new PublicError('page_too_large', 'This page exceeds the 512 KiB HTML limit. Try a smaller public page.', 422);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export async function assertPublicDNS(host, fetcher, signal) {
  const answers = await Promise.all(['A', 'AAAA'].map(async type => {
    const response = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: {'Accept': 'application/dns-json'}, signal, redirect: 'manual',
    });
    if (!response.ok) throw new PublicError('dns_unavailable', 'The public DNS check is temporarily unavailable. Try again shortly.', 503);
    let data;
    try { data = JSON.parse(new TextDecoder().decode(await readLimited(response, 16384))); }
    catch (error) { if (error.name === 'AbortError') throw error; throw new PublicError('dns_unavailable', 'The public DNS check could not be completed. Try again shortly.', 503); }
    if (data.Status !== 0) throw new PublicError('dns_failed', 'That domain could not be resolved publicly. Check the spelling and try again.', 422);
    if (data.Answer !== undefined && !Array.isArray(data.Answer)) throw new PublicError('dns_unavailable', 'The public DNS answer was incomplete.', 503);
    return (data.Answer || []).filter(row => row.type === 1 || row.type === 28).map(row => row.data);
  }));
  const addresses = answers.flat();
  if (!addresses.length) throw new PublicError('dns_failed', 'That domain has no public web address.', 422);
  if (addresses.some(address => !isPublicAddress(address)))
    throw new PublicError('private_host', 'This domain resolves to a private or reserved address and cannot be checked.', 422);
}

export async function fetchPage(input, {fetcher = (...args) => globalThis.fetch(...args), timeoutMs = 12000} = {}) {
  let url = normalizeTarget(input);
  const requestedUrl = url.href;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      await assertPublicDNS(url.hostname, fetcher, controller.signal);
      const response = await fetcher(url.href, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: {
          'User-Agent': 'ArchboticsPreflight/1.0 (+https://preflight.archbotics.workers.dev)',
          'Accept': 'text/html, application/xhtml+xml;q=0.9',
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (redirects === 3) throw new PublicError('redirect_limit', 'The page redirects more than three times. Check the final public URL directly.', 422);
        if (!location) throw new PublicError('invalid_redirect', 'The page returned a redirect without a destination.', 422);
        let destination;
        try { destination = new URL(location, url).href; } catch { throw new PublicError('invalid_redirect', 'The page returned an unreadable redirect.', 422); }
        url = normalizeTarget(destination);
        continue;
      }
      if ([401, 403, 429].includes(response.status)) {
        await response.body?.cancel();
        throw new PublicError('access_blocked', `The website returned HTTP ${response.status}. Preflight cannot inspect a login page, bot challenge, or rate-limited response.`, 422);
      }
      const contentType = response.headers.get('content-type') || '';
      if (!/^(text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(contentType)) {
        await response.body?.cancel();
        throw new PublicError('not_html', 'That address did not return an HTML page. Try a public website page instead of a file or API.', 422);
      }
      const bytes = await readLimited(response);
      const encoding = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1] || 'utf-8';
      let decoder;
      try { decoder = new TextDecoder(encoding); } catch { decoder = new TextDecoder(); }
      return {html: decoder.decode(bytes), requestedUrl, url: url.href, status: response.status,
        headers: Object.fromEntries(response.headers), bytes: bytes.byteLength, redirects, contentType};
    }
  } catch (error) {
    if (error instanceof PublicError) throw error;
    if (controller.signal.aborted) throw new PublicError('page_timeout', 'The website did not finish responding within 12 seconds. Try again, or check a smaller page.', 504);
    throw new PublicError('fetch_failed', 'The website could not be reached from Preflight. Check that it is public and try again.', 422);
  } finally { clearTimeout(timer); }
}
