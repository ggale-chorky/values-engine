import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { RESOLVER_USER_AGENT } from './companies-house.js';

const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 15_000;
const blocked = new BlockList();
for (const [network, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) {
  blocked.addSubnet(network, bits);
}
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
blocked.addSubnet('2001::', 32, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

type FailureReason = 'invalid_url' | 'non_public_address' | 'timeout' | 'network_error' | 'http_error'
  | 'blocked' | 'too_many_redirects' | 'cross_site_redirect' | 'unsupported_content_type' | 'response_too_large' | 'unsupported_encoding';
class PageError extends Error { constructor(public readonly reason: FailureReason) { super(reason); } }
export type PageResult = { ok: true; source_url: string; final_url: string; content_type: 'text/html' | 'text/plain'; content: string }
  | { ok: false; status: 'source_unavailable'; source_url: string; reason: FailureReason; http_status: number | null };
export interface PageResponse { status: number; headers: Record<string, string | undefined>; body: string }

function publicUrl(input: string): URL {
  let url;
  try { url = new URL(input); } catch { throw new PageError('invalid_url'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw new PageError('invalid_url');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host.includes('.') && !isIP(host)) throw new PageError('non_public_address');
  if (isIP(host) && !isPublicAddress(host)) throw new PageError('non_public_address');
  if (/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) throw new PageError('non_public_address');
  return url;
}

/** Pin the checked DNS result to this request; do not resolve again on connect. */
export async function requestPublicPage(url: URL, signal: AbortSignal): Promise<PageResponse> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new PageError('non_public_address');
  const address = addresses[0]!;
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET', signal,
      headers: { 'User-Agent': RESOLVER_USER_AGENT, Accept: 'text/html, text/plain;q=0.9', 'Accept-Encoding': 'identity' },
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address: address.address, family: address.family }]);
        else callback(null, address.address, address.family);
      },
    }, response => {
      const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value]));
      const status = response.statusCode ?? 0;
      if (status !== 200) { response.destroy(); resolve({ status, headers, body: '' }); return; }
      const type = headers['content-type']?.split(';')[0]?.trim().toLowerCase();
      if (type !== 'text/html' && type !== 'text/plain') { response.destroy(); reject(new PageError('unsupported_content_type')); return; }
      if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') {
        response.destroy(); reject(new PageError('unsupported_encoding')); return;
      }
      if (Number(headers['content-length']) > MAX_BYTES) { response.destroy(); reject(new PageError('response_too_large')); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) { response.destroy(); reject(new PageError('response_too_large')); }
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({ status, headers, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', () => reject(new PageError('network_error')));
    });
    request.on('error', () => reject(new PageError(signal.aborted ? 'timeout' : 'network_error')));
    request.end();
  });
}

export async function fetchFirstPartyPage(sourceUrl: string,
  request: (url: URL, signal: AbortSignal) => Promise<PageResponse> = requestPublicPage): Promise<PageResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const initial = publicUrl(sourceUrl);
    let current = initial;
    const operation = async (): Promise<PageResult> => {
      for (let redirects = 0; redirects <= 5; redirects++) {
        const response = await request(current, controller.signal);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (redirects === 5) throw new PageError('too_many_redirects');
          if (!response.headers.location) throw new PageError('invalid_url');
          const next = publicUrl(new URL(response.headers.location, current).href);
          // A supplied first-party page does not confer trust on another site.
          if (next.hostname.replace(/^www\./, '') !== initial.hostname.replace(/^www\./, '')
            || (current.protocol === 'https:' && next.protocol === 'http:')) throw new PageError('cross_site_redirect');
          current = next;
          continue;
        }
        if (response.status !== 200) return { ok: false, status: 'source_unavailable', source_url: sourceUrl,
          reason: [401, 403, 429].includes(response.status) ? 'blocked' : 'http_error', http_status: response.status };
        const type = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
        if (type !== 'text/html' && type !== 'text/plain') throw new PageError('unsupported_content_type');
        if (Buffer.byteLength(response.body) > MAX_BYTES) throw new PageError('response_too_large');
        if (/(?:<title[^>]*>\s*(?:just a moment|access denied|sign in|log in)|cf-chl-|verify (?:that )?you are human|captcha challenge)/i.test(response.body)) {
          throw new PageError('blocked');
        }
        return { ok: true, source_url: sourceUrl, final_url: current.href, content_type: type, content: response.body };
      }
      throw new PageError('too_many_redirects');
    };
    return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new PageError('timeout')); }, TIMEOUT_MS);
    })]);
  } catch (error) {
    return { ok: false, status: 'source_unavailable', source_url: sourceUrl,
      reason: error instanceof PageError ? error.reason : 'network_error', http_status: null };
  } finally { if (timer) clearTimeout(timer); }
}
