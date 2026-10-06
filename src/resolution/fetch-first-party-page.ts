import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { RESOLVER_USER_AGENT } from './companies-house.js';
import { parseDocument } from 'htmlparser2';
import { extractCompanyCandidates, pageText } from './extract-company-candidates.js';

export type FetchOutcome = 'success' | 'blocked' | 'empty_or_shell' | 'retrieved_content_incomplete' | 'unsupported_content' | 'network_error' | 'http_error';
export interface RetrievalDiagnostics {
  requested_url: string;
  final_url: string | null;
  http_status: number | null;
  content_type: string | null;
  response_byte_count: number;
  visible_text_character_count: number | null;
  html_title: string | null;
  contains_company_number_pattern: boolean | null;
  outcome: FetchOutcome;
  content_heuristic?: 'low_visible_text' | 'large_html_low_text_ratio' | null;
}
// Query values, fragments and URL credentials do not belong in diagnostics.
function safeUrl(value: string): string {
  try { const url = new URL(value); return `${url.protocol}//${url.host}${url.pathname}`; }
  catch { return '[invalid URL]'; }
}
export function contentDiagnostics(content: string, type: 'text/html' | 'text/plain') {
  const visible = pageText(content, type);
  let title: string | null = null;
  if (type === 'text/html') {
    type Node = ReturnType<typeof parseDocument>['children'][number];
    const text = (nodes: Node[]): string => nodes.map(node => node.type === 'text' ? node.data : 'children' in node ? text(node.children) : '').join('');
    const visit = (nodes: Node[]) => { for (const node of nodes) if ('name' in node && 'children' in node) {
      if (node.name === 'title' && title === null) title = text(node.children).replace(/\s+/g, ' ').trim().slice(0, 200);
      else visit(node.children);
    } };
    visit(parseDocument(content).children);
  }
  const contains = extractCompanyCandidates(content, '', type).length > 0;
  const bytes = Buffer.byteLength(content);
  const sparse = type === 'text/html' && bytes >= 250_000 && visible.length < 5_000 && visible.length / bytes < 0.01;
  return { visible_text_character_count: visible.length, html_title: title, contains_company_number_pattern: contains,
    ...(!contains && sparse ? { content_heuristic: 'large_html_low_text_ratio' as const } : {}),
    ...(!contains && !sparse && visible.length < 100 ? { content_heuristic: 'low_visible_text' as const } : {}),
    outcome: !contains && sparse ? 'retrieved_content_incomplete' as const
      : !contains && visible.length < 100 ? 'empty_or_shell' as const : 'success' as const };
}

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
class PageError extends Error { constructor(public readonly reason: FailureReason, public readonly response?: PageResponse) { super(reason); } }
export type PageResult = ({ ok: true; source_url: string; final_url: string; content_type: 'text/html' | 'text/plain'; content: string }
  | { ok: false; status: 'source_unavailable'; source_url: string; reason: FailureReason; http_status: number | null }) & { diagnostics?: RetrievalDiagnostics };
export interface PageResponse { status: number; headers: Record<string, string | undefined>; body: string; byte_count?: number }

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
      const failure = (reason: FailureReason, byte_count = 0) => new PageError(reason, { status, headers, body: '', byte_count });
      if (type !== 'text/html' && type !== 'text/plain') { response.destroy(); reject(failure('unsupported_content_type')); return; }
      if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') {
        response.destroy(); reject(failure('unsupported_encoding')); return;
      }
      if (Number(headers['content-length']) > MAX_BYTES) { response.destroy(); reject(failure('response_too_large')); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) { response.destroy(); reject(failure('response_too_large', size)); }
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({ status, headers, body: Buffer.concat(chunks).toString('utf8'), byte_count: size }));
      response.on('error', () => reject(failure('network_error', size)));
    });
    request.on('error', () => reject(new PageError(signal.aborted ? 'timeout' : 'network_error')));
    request.end();
  });
}

export async function fetchFirstPartyPage(sourceUrl: string,
  request: (url: URL, signal: AbortSignal) => Promise<PageResponse> = requestPublicPage): Promise<PageResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const diagnostics: RetrievalDiagnostics = { requested_url: safeUrl(sourceUrl), final_url: null, http_status: null,
    content_type: null, response_byte_count: 0, visible_text_character_count: null, html_title: null,
    contains_company_number_pattern: null, outcome: 'network_error' };
  const record = (response: PageResponse) => {
    diagnostics.http_status = response.status;
    diagnostics.content_type = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase() ?? null;
    diagnostics.response_byte_count = response.byte_count ?? Buffer.byteLength(response.body);
  };
  try {
    const initial = publicUrl(sourceUrl);
    let current = initial;
    const operation = async (): Promise<PageResult> => {
      for (let redirects = 0; redirects <= 5; redirects++) {
        diagnostics.final_url = safeUrl(current.href);
        diagnostics.http_status = null;
        diagnostics.content_type = null;
        diagnostics.response_byte_count = 0;
        const response = await request(current, controller.signal);
        record(response);
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
        if (response.status !== 200) throw new PageError([401, 403, 429].includes(response.status) ? 'blocked' : 'http_error');
        const type = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
        if (type !== 'text/html' && type !== 'text/plain') throw new PageError('unsupported_content_type');
        if (Buffer.byteLength(response.body) > MAX_BYTES) throw new PageError('response_too_large');
        Object.assign(diagnostics, contentDiagnostics(response.body, type));
        if (/(?:<title[^>]*>\s*(?:just a moment|access denied|sign in|log in)|cf-chl-|verify (?:that )?you are human|captcha challenge)/i.test(response.body)) {
          throw new PageError('blocked');
        }
        return { ok: true, source_url: sourceUrl, final_url: current.href, content_type: type, content: response.body, diagnostics };
      }
      throw new PageError('too_many_redirects');
    };
    return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new PageError('timeout')); }, TIMEOUT_MS);
    })]);
  } catch (error) {
    if (error instanceof PageError && error.response) record(error.response);
    const reason = error instanceof PageError ? error.reason : 'network_error';
    diagnostics.outcome = reason === 'blocked' ? 'blocked' : reason === 'http_error' ? 'http_error'
      : ['unsupported_content_type', 'unsupported_encoding', 'response_too_large'].includes(reason) ? 'unsupported_content' : 'network_error';
    return { ok: false, status: 'source_unavailable', source_url: sourceUrl,
      reason, http_status: diagnostics.http_status, diagnostics };
  } finally { if (timer) clearTimeout(timer); }
}
