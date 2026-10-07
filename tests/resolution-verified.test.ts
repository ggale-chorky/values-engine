import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { listVerifiedRelationships } from '../src/review/verified-relationships.js';
import { main } from '../src/scripts/resolution-verified.js';

const row = { id: '12345678-1234-4234-8234-123456789abc', relationship_type: 'seller', source_url: 'https://example.com/terms',
  verification_status: 'human_verified' as const, last_verified_at: '2026-01-02T12:00:00Z',
  brands: { canonical_name: 'Example' }, legal_entities: { canonical_name: 'ALPHA LIMITED', company_number: '00123456', jurisdiction: 'GB' } };
const client = (fetch: typeof globalThis.fetch) => createClient('https://example.test', 'test-only', { global: { fetch } });
const response = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

describe('read-only human-verified relationship listing', () => {
  it('uses only GET, filters human_verified, joins identities and paginates below server caps', async () => {
    const requests: URL[] = [];
    const records = [row, { ...row, id: '22345678-1234-4234-8234-123456789abc', relationship_type: 'site_operator',
      legal_entities: { canonical_name: 'BETA LIMITED', company_number: 'SC012345', jurisdiction: 'GB' } }];
    const result = await listVerifiedRelationships(client(async (value, init) => {
      expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined();
      const url = new URL(String(value)); requests.push(url);
      const offset = Number(url.searchParams.get('offset'));
      return response(records[offset] ? [records[offset]] : []);
    }));
    expect(requests.map(url => url.searchParams.get('offset'))).toEqual(['0', '1', '2']);
    for (const url of requests) {
      expect(url.pathname).toBe('/rest/v1/brand_entity_relationships');
      expect(url.searchParams.get('verification_status')).toBe('eq.human_verified');
      expect(url.searchParams.get('order')).toBe('id.asc');
      expect(url.searchParams.get('select')).toContain('brands!inner(canonical_name)');
      expect(url.searchParams.get('select')).toContain('legal_entities!inner(canonical_name,company_number,jurisdiction)');
    }
    expect(result[0]).toEqual({ relationship_id: row.id, brand: 'Example', legal_entity: 'ALPHA LIMITED', company_number: '00123456', jurisdiction: 'GB',
      relationship_type: 'seller', source_url: row.source_url, verification_status: 'human_verified', last_verified_at: row.last_verified_at });
    expect(result[1]).toMatchObject({ relationship_type: 'site_operator', company_number: 'SC012345', jurisdiction: 'GB' });
  });
  it.each(['auto_verified', 'candidate', 'rejected'])('rejects an unexpected %s record rather than displaying it', async verification_status => {
    await expect(listVerifiedRelationships(client(async () => response([{ ...row, verification_status }])))).rejects.toThrow('Could not read human-verified');
  });
  it('preserves nullable dates/company numbers and exact relationship semantics', async () => {
    let calls = 0;
    const result = await listVerifiedRelationships(client(async () => response(calls++ ? [] : [{ ...row, relationship_type: 'licensor',
      last_verified_at: null, legal_entities: { canonical_name: 'ALPHA LIMITED', company_number: null, jurisdiction: 'IE' } }])));
    expect(result[0]).toMatchObject({ relationship_type: 'licensor', last_verified_at: null, company_number: null, jurisdiction: 'IE' });
  });
  it('sorts globally by brand name across pages with relationship ID breaking ties', async () => {
    const records = [
      { ...row, brands: { canonical_name: 'Zulu' } },
      { ...row, id: '32345678-1234-4234-8234-123456789abc', brands: { canonical_name: 'Alpha' } },
      { ...row, id: '22345678-1234-4234-8234-123456789abc', brands: { canonical_name: 'Alpha' } },
    ];
    let page = 0;
    const result = await listVerifiedRelationships(client(async () => response(records[page] ? [records[page++]] : [])));
    expect(result.map(item => [item.brand, item.relationship_id])).toEqual([
      ['Alpha', records[2]!.id], ['Alpha', records[1]!.id], ['Zulu', records[0]!.id],
    ]);
  });
  it('returns an empty list without additional requests when nothing is verified', async () => {
    const request = vi.fn<typeof fetch>(async () => response([]));
    expect(await listVerifiedRelationships(client(request))).toEqual([]); expect(request).toHaveBeenCalledOnce();
  });
  it('stops on repeated pages instead of looping or duplicating output', async () => {
    await expect(listVerifiedRelationships(client(async () => response([row])))).rejects.toThrow('Unstable pagination');
  });
  it('does not expose backend error details or credentials', async () => {
    await expect(listVerifiedRelationships(client(async () => new Response(JSON.stringify({ message: 'private-secret' }), { status: 403 }))))
      .rejects.toThrow(/^Could not read human-verified relationships\.$/);
  });
  it('CLI prints one structured row per relationship and validates arguments before reading', async () => {
    const rows = [{ relationship_id: row.id, brand: 'Example', legal_entity: 'ALPHA LIMITED', company_number: '00123456', jurisdiction: 'GB',
      relationship_type: 'seller', source_url: row.source_url, verification_status: 'human_verified' as const, last_verified_at: row.last_verified_at }];
    const read = vi.fn(async () => rows); const log = vi.fn();
    await expect(main(['--approve'], { read, log })).rejects.toThrow('no arguments'); expect(read).not.toHaveBeenCalled();
    await main([], { read, log }); expect(read).toHaveBeenCalledOnce(); expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(rows[0]));
  });
  it('CLI emits no rows when the read is empty', async () => {
    const log = vi.fn(); await main([], { read: async () => [], log }); expect(log).not.toHaveBeenCalled();
  });
});
