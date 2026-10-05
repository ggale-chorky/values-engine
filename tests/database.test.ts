import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReadDatabase, createWriteDatabase } from '../src/db/database.js';
import { createServerClient } from '../src/db/supabase.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('server client and database transport', () => {
  it('requires named configuration without disclosing values or connecting', () => {
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    expect(() => createServerClient({})).toThrow('SUPABASE_URL is required');
    expect(() => createServerClient({ SUPABASE_URL: 'https://example.test' })).toThrow('SUPABASE_SECRET_KEY is required');
    expect(() => createServerClient({ SUPABASE_URL: 'not-a-url', SUPABASE_SECRET_KEY: 'test-only' })).toThrow('valid HTTP(S) URL');
    createServerClient({ SUPABASE_URL: 'https://example.test', SUPABASE_SECRET_KEY: 'test-only' });
    expect(network).not.toHaveBeenCalled();
  });

  it('rejects browser usage', () => {
    vi.stubGlobal('window', {});
    expect(() => createServerClient({})).toThrow('requires Node.js');
  });

  it('paginates despite a server cap below requested page size using only GET', async () => {
    const requests: URL[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      expect(init?.method).toBe('GET');
      const url = new URL(String(input));
      requests.push(url);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const rows = offset < 3 ? [{ id: String(offset) }] : [];
      return new Response(JSON.stringify(rows), { headers: { 'Content-Type': 'application/json' } });
    };
    const db = createReadDatabase(createClient('https://example.test', 'test-only', { global: { fetch: fakeFetch } }));
    expect(await db.read('evidence', { legal_entity_id: 'entity', product_id: null })).toEqual([{ id: '0' }, { id: '1' }, { id: '2' }]);
    expect(requests.map(url => url.searchParams.get('offset'))).toEqual(['0', '1', '2', '3']);
    expect(requests.every(url => url.searchParams.get('order') === 'id.asc' && url.searchParams.get('product_id') === 'is.null')).toBe(true);
    expect('insert' in db).toBe(false);
    expect('update' in db).toBe(false);
  });

  it('does not expose transport errors and rejects silent write failures', async () => {
    const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({ message: 'sensitive-request-details' }), { status: 400 });
    const client = createClient('https://example.test', 'test-only', { global: { fetch: fakeFetch } });
    await expect(createReadDatabase(client).read('evidence', {})).rejects.toThrow(/^Read failed for evidence\.$/);
    await expect(createWriteDatabase(client).insert('brands', { id: 'x' })).rejects.toThrow(/^Insert failed for brands/);
    const empty = createClient('https://example.test', 'test-only', { global: { fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }) } });
    await expect(createWriteDatabase(empty).update('brands', 'missing', {})).rejects.toThrow(/^Update failed for brands/);
  });
});
