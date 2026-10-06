import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchFirstPartyPage, isPublicAddress } from '../src/resolution/fetch-first-party-page.js';

const url = 'https://www.example.com/legal';
const html = { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<p>Company number 08037372</p>' };
afterEach(() => vi.useRealTimers());
describe('public first-party page fetch', () => {
  it('returns HTML and follows bounded same-site redirects', async () => {
    const request = vi.fn().mockResolvedValueOnce({ status: 302, headers: { location: '/terms' }, body: '' }).mockResolvedValueOnce(html);
    expect(await fetchFirstPartyPage(url, request)).toMatchObject({ ok: true, final_url: 'https://www.example.com/terms', content: html.body });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 429, 404, 500])('returns source_unavailable for %s', async status => {
    const request = vi.fn().mockResolvedValue({ ...html, status });
    expect(await fetchFirstPartyPage(url, request)).toMatchObject({ ok: false, status: 'source_unavailable', http_status: status });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(['<title>Just a moment...</title>', '<p>Please verify you are human</p>', '<title>Sign in</title>'])
    ('does not attempt to bypass a challenge/login wall', async body => {
      expect(await fetchFirstPartyPage(url, vi.fn().mockResolvedValue({ ...html, body }))).toMatchObject({ ok: false, reason: 'blocked' });
    });

  it('does not mistake a newsletter form for an inaccessible legal page', async () => {
    expect(await fetchFirstPartyPage(url, vi.fn().mockResolvedValue({ ...html, body: html.body + '<input type="password">' })))
      .toMatchObject({ ok: true });
  });

  it('returns structured errors for network failures, oversized data and wrong content types', async () => {
    expect(await fetchFirstPartyPage(url, vi.fn().mockRejectedValue(new Error('raw detail')))).toMatchObject({ ok: false, reason: 'network_error' });
    expect(await fetchFirstPartyPage(url, vi.fn().mockResolvedValue({ ...html, body: 'a'.repeat(2_000_001) }))).toMatchObject({ reason: 'response_too_large' });
    expect(await fetchFirstPartyPage(url, vi.fn().mockResolvedValue({ ...html, headers: { 'content-type': 'application/pdf' } })))
      .toMatchObject({ reason: 'unsupported_content_type' });
  });

  it('enforces a total timeout', async () => {
    vi.useFakeTimers();
    const result = fetchFirstPartyPage(url, () => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await result).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('limits redirect loops and refuses cross-site redirects', async () => {
    const loop = vi.fn().mockResolvedValue({ status: 302, headers: { location: '/legal' }, body: '' });
    expect(await fetchFirstPartyPage(url, loop)).toMatchObject({ reason: 'too_many_redirects' });
    expect(loop).toHaveBeenCalledTimes(6);
    expect(await fetchFirstPartyPage(url, vi.fn().mockResolvedValue({ status: 302, headers: { location: 'https://other.example.com/' }, body: '' })))
      .toMatchObject({ reason: 'cross_site_redirect' });
  });

  it.each(['file:///etc/passwd', 'http://localhost/', 'http://127.0.0.1/', 'http://169.254.169.254/',
    'http://[::1]/', 'https://user:password@example.com/', 'http://example.com:8080/'])('refuses non-public/unsafe URL %s', async source => {
    const request = vi.fn();
    expect(await fetchFirstPartyPage(source, request)).toMatchObject({ ok: false, status: 'source_unavailable' });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['10.0.0.1', '172.16.0.1', '192.168.0.1', '100.64.0.1', '127.0.0.1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1'])
    ('rejects private/reserved DNS answers %s', address => expect(isPublicAddress(address)).toBe(false));
  it('allows globally routable addresses', () => {
    expect(isPublicAddress('1.1.1.1')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
});
