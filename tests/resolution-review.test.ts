import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareResolution, createResolutionReviewStore, ingestResolutionResult } from '../src/review/resolution-review.js';
import type { IngestResolutionInput, ResolutionReviewStore } from '../src/review/resolution-review.js';
import { main } from '../src/scripts/resolution-review.js';
import { unresolved } from '../src/resolution/resolve-brand-legal-entity.js';
import type { ResolverResult } from '../src/resolution/resolve-with-discovery.js';

const source = 'https://example.com/terms';
const fixedId = '12345678-1234-4234-8234-123456789abc';
function input(): IngestResolutionInput {
  const proposal = unresolved('Example', source, 'fixture');
  Object.assign(proposal, { company_number: '00123456', candidate_legal_entity_name: 'ALPHA LIMITED', company_status: 'active',
    inferred_role: 'seller', recommended_action: 'PROPOSE', reason: 'verified_operating_entity', source_snippet: 'The seller is Alpha Limited, company number 00123456.',
    companies_house_match: { company_number: '00123456', company_name: 'ALPHA LIMITED', company_status: 'active' },
    verification: { source_validated: true, identifier_extracted_deterministically: true, registry_verified: true, registry_active: true,
      legal_name_verified: true, role_relevant: true, market_context_match: true, brand_context_match: true, blocking_conflict: false } });
  const result: ResolverResult = { overall: { recommended_action: 'PROPOSE', reason: 'verified_operating_entity', company_number: '00123456' },
    selected_candidate: proposal, proposals: [proposal], direct_proposals: [proposal], discovery: null, discovery_rejections: [],
    attempts: [], named_role_evidence: [], supporting_candidates: [proposal], secondary_candidates: [] };
  return { run_key: 'test-run-1', brand_name: 'Example', brand_domain: 'www.example.com', result };
}

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon, authenticated;');
  for (const migration of ['0001_initial_schema.sql', '0002_evidence_source_identity.sql', '0003_resolution_review.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8'));
  }
});
afterAll(async () => { await db.close(); });
beforeEach(async () => { await db.exec('TRUNCATE resolution_candidates, resolution_runs, brand_entity_relationships, brands, legal_entities CASCADE'); });
async function ingest(payload = prepareResolution(input()), key = 'test-run-1') {
  return (await db.query<{ id: string }>('SELECT ingest_resolution_run($1,$2::jsonb) AS id', [key, JSON.stringify(payload)])).rows[0]!.id;
}
async function candidate() { return (await db.query<{ id: string }>('SELECT id FROM resolution_candidates ORDER BY created_at, id')).rows[0]!.id; }
async function approve(id: string, note: string | null = null) {
  return (await db.query<{ id: string }>('SELECT approve_resolution_candidate($1,$2) AS id', [id, note])).rows[0]!.id;
}
async function counts() {
  return (await db.query('SELECT (SELECT count(*)::int FROM brands) brands, (SELECT count(*)::int FROM legal_entities) entities, (SELECT count(*)::int FROM brand_entity_relationships) relationships')).rows[0];
}

describe('local PostgreSQL review transactions (PGlite, no network)', () => {
  it('persists complete raw result and candidate provenance, leaving PROPOSE pending and graph empty', async () => {
    const fixture = input(); await ingest(prepareResolution(fixture));
    expect((await db.query('SELECT raw_result, overall_action FROM resolution_runs')).rows[0]).toEqual({ raw_result: fixture.result, overall_action: 'PROPOSE' });
    expect((await db.query('SELECT review_status, reviewed_at, provenance FROM resolution_candidates')).rows[0]).toEqual({ review_status: 'pending', reviewed_at: null, provenance: fixture.result.proposals[0] });
    expect(await counts()).toEqual({ brands: 0, entities: 0, relationships: 0 });
  });
  it('idempotent ingestion returns the same run and does not reset approval; changed input under the same key fails', async () => {
    const payload = prepareResolution(input()); const id = await ingest(payload); await approve(await candidate());
    expect(await ingest(payload)).toBe(id);
    expect((await db.query('SELECT review_status FROM resolution_candidates')).rows).toEqual([{ review_status: 'approved' }]);
    await expect(ingest({ ...payload, brand_name: 'Different' })).rejects.toThrow('different input');
    expect((await db.query('SELECT id FROM resolution_runs')).rows).toHaveLength(1);
  });
  it.each(['seller', 'site_operator', 'brand_operator'] as const)('approval upserts GB identity and preserves %s with human verification and provenance', async role => {
    const payload = prepareResolution(input()); payload.candidates[0]!.relationship_type = role;
    await ingest(payload); const id = await candidate(); const relationship = await approve(id);
    const row = (await db.query<Record<string, unknown>>('SELECT * FROM brand_entity_relationships')).rows[0]!;
    expect(row).toMatchObject({ id: relationship, relationship_type: role, verification_status: 'human_verified', source_url: source, confidence: '1' });
    expect(row.last_verified_at).not.toBeNull();
    expect(row.provenance).toMatchObject({ resolution_reviews: [{ candidate_id: id, source_url: source, evidence: payload.candidates[0]!.provenance }] });
    expect((await db.query('SELECT jurisdiction,company_number FROM legal_entities')).rows).toEqual([{ jurisdiction: 'GB', company_number: '00123456' }]);
    expect(await approve(id)).toBe(relationship);
    expect((await db.query('SELECT jsonb_array_length(provenance->\'resolution_reviews\') n FROM brand_entity_relationships')).rows[0]).toEqual({ n: 1 });
  });
  it('different runs for one domain reuse the brand, entity and exact-role relationship, appending audit history', async () => {
    const payload = prepareResolution(input()); await ingest(payload); const first = await approve(await candidate());
    const next = await ingest(payload, 'run-2');
    const id = (await db.query<{ id: string }>('SELECT id FROM resolution_candidates WHERE resolution_run_id=$1', [next])).rows[0]!.id;
    expect(await approve(id)).toBe(first);
    expect(await counts()).toEqual({ brands: 1, entities: 1, relationships: 1 });
    expect((await db.query('SELECT jsonb_array_length(provenance->\'resolution_reviews\') n FROM brand_entity_relationships')).rows[0]).toEqual({ n: 2 });
  });
  it('reuses an existing brand by website and respects an explicit brand ID', async () => {
    await db.query('INSERT INTO brands(id,canonical_name,website_url) VALUES ($1,\'Existing brand\',\'https://www.example.com/\')', [fixedId]);
    await ingest(); await approve(await candidate());
    expect((await db.query('SELECT id,canonical_name,resolution_domain FROM brands')).rows).toEqual([{ id: fixedId, canonical_name: 'Existing brand', resolution_domain: 'example.com' }]);
    const payload = prepareResolution(input()); payload.brand_id = fixedId;
    await ingest(payload, 'explicit');
    expect((await db.query('SELECT brand_id FROM resolution_runs WHERE ingestion_key=\'explicit\'')).rows[0]).toEqual({ brand_id: fixedId });
  });
  it('rejecting is idempotent, retains notes, and never touches the graph', async () => {
    await ingest(); const id = await candidate();
    await db.query('SELECT reject_resolution_candidate($1,$2)', [id, 'Unrelated legal role']);
    await db.query('SELECT reject_resolution_candidate($1,$2)', [id, 'retry']);
    expect((await db.query('SELECT review_status,review_notes FROM resolution_candidates')).rows).toEqual([{ review_status: 'rejected', review_notes: 'Unrelated legal role' }]);
    expect(await counts()).toEqual({ brands: 0, entities: 0, relationships: 0 });
    await expect(approve(id)).rejects.toThrow('already rejected');
  });
  it('reject cannot silently revoke a previously approved graph relationship', async () => {
    await ingest(); const id = await candidate(); await approve(id);
    await expect(db.query('SELECT reject_resolution_candidate($1,NULL)', [id])).rejects.toThrow('separate action');
    expect((await db.query('SELECT verification_status FROM brand_entity_relationships')).rows).toEqual([{ verification_status: 'human_verified' }]);
  });
  it('a failure at the final review-state write rolls back brand, entity and relationship writes', async () => {
    await ingest();
    await db.exec("CREATE FUNCTION fail_review_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$; CREATE TRIGGER fail_review_test BEFORE UPDATE ON resolution_candidates FOR EACH ROW EXECUTE FUNCTION fail_review_test();");
    try {
      await expect(approve(await candidate())).rejects.toThrow('injected failure');
      expect(await counts()).toEqual({ brands: 0, entities: 0, relationships: 0 });
      expect((await db.query('SELECT review_status,reviewed_at FROM resolution_candidates')).rows).toEqual([{ review_status: 'pending', reviewed_at: null }]);
      expect((await db.query('SELECT brand_id FROM resolution_runs')).rows).toEqual([{ brand_id: null }]);
    } finally { await db.exec('DROP TRIGGER fail_review_test ON resolution_candidates; DROP FUNCTION fail_review_test()'); }
  });
  it('rollback also restores an existing relationship and canonical entity when an update fails late', async () => {
    await db.exec("INSERT INTO brands(canonical_name,website_url) VALUES ('Existing','https://example.com'); INSERT INTO legal_entities(canonical_name,jurisdiction,company_number) VALUES ('OLD NAME','GB','00123456'); INSERT INTO brand_entity_relationships(brand_id,legal_entity_id,relationship_type,source_url,source_name,confidence,verification_status) SELECT b.id,l.id,'seller','https://example.com/old','Original',0.5,'candidate' FROM brands b CROSS JOIN legal_entities l;");
    await ingest();
    await db.exec("CREATE FUNCTION fail_update_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'late update failure'; END $$; CREATE TRIGGER fail_update_test BEFORE UPDATE ON resolution_candidates FOR EACH ROW EXECUTE FUNCTION fail_update_test();");
    try {
      await expect(approve(await candidate())).rejects.toThrow('late update failure');
      expect((await db.query('SELECT verification_status,source_url,provenance FROM brand_entity_relationships')).rows).toEqual([{ verification_status: 'candidate', source_url: 'https://example.com/old', provenance: {} }]);
      expect((await db.query('SELECT canonical_name FROM legal_entities')).rows).toEqual([{ canonical_name: 'OLD NAME' }]);
      expect((await db.query('SELECT review_status FROM resolution_candidates')).rows).toEqual([{ review_status: 'pending' }]);
    } finally { await db.exec('DROP TRIGGER fail_update_test ON resolution_candidates; DROP FUNCTION fail_update_test()'); }
  });
  it('seller and site-operator relationships are distinct even for the same canonical entity', async () => {
    await ingest(); await approve(await candidate());
    const payload = prepareResolution(input()); payload.candidates[0]!.relationship_type = 'site_operator';
    const run = await ingest(payload, 'operator-run');
    const id = (await db.query<{ id: string }>('SELECT id FROM resolution_candidates WHERE resolution_run_id=$1', [run])).rows[0]!.id;
    await approve(id);
    expect((await db.query('SELECT relationship_type FROM brand_entity_relationships ORDER BY relationship_type')).rows).toEqual([{ relationship_type: 'seller' }, { relationship_type: 'site_operator' }]);
    expect(await counts()).toEqual({ brands: 1, entities: 1, relationships: 2 });
  });
  it('ambiguous pre-existing brand identities require explicit selection rather than guessing', async () => {
    await db.exec("INSERT INTO brands(canonical_name,website_url) VALUES ('One','https://example.com'),('Two','https://www.example.com/');");
    await ingest(); await expect(approve(await candidate())).rejects.toThrow('Ambiguous existing brand');
    expect(await counts()).toEqual({ brands: 2, entities: 0, relationships: 0 });
  });
  it('preserves a prefixed canonical company number without numeric conversion', async () => {
    const fixture = input(); fixture.result.proposals[0]!.company_number = 'SC012345';
    fixture.result.proposals[0]!.companies_house_match!.company_number = 'SC012345';
    await ingest(prepareResolution(fixture)); await approve(await candidate());
    expect((await db.query('SELECT company_number FROM legal_entities')).rows).toEqual([{ company_number: 'SC012345' }]);
  });
  it('bad later candidate rolls back the entire ingestion', async () => {
    const payload = prepareResolution(input()); payload.candidates.push({ ...payload.candidates[0]!, source_url: 'invalid' });
    await expect(ingest(payload)).rejects.toThrow();
    expect((await db.query('SELECT id FROM resolution_runs')).rows).toHaveLength(0);
    expect((await db.query('SELECT id FROM resolution_candidates')).rows).toHaveLength(0);
  });
  it.each(['UNRESOLVED', 'ERROR'] as const)('retains %s without candidates or graph records', async overall_action => {
    const fixture = input(); fixture.result.proposals = []; fixture.overall_action = overall_action; fixture.reason = 'No usable result';
    await ingest(prepareResolution(fixture));
    expect((await db.query('SELECT overall_action FROM resolution_runs')).rows).toEqual([{ overall_action }]);
    expect((await db.query('SELECT id FROM resolution_candidates')).rows).toHaveLength(0);
    expect(await counts()).toEqual({ brands: 0, entities: 0, relationships: 0 });
  });
  it.each(['promoter', 'licensor', 'data_controller', 'service_operator', 'unknown'] as const)('retains %s unchanged but cannot approve it as UK commerce entity', async role => {
    const payload = prepareResolution(input()); payload.candidates[0]!.relationship_type = role;
    await ingest(payload); await expect(approve(await candidate())).rejects.toThrow('outside UK commerce');
    expect(await counts()).toEqual({ brands: 0, entities: 0, relationships: 0 });
    expect((await db.query('SELECT relationship_type FROM resolution_candidates')).rows).toEqual([{ relationship_type: role }]);
  });
  it('REVIEW needs an explicit explanatory note but can be human approved', async () => {
    const payload = prepareResolution(input()); payload.candidates[0]!.recommended_action = 'REVIEW';
    await ingest(payload); const id = await candidate();
    await expect(approve(id)).rejects.toThrow('Review note required');
    await approve(id, 'I checked the cited legal terms and confirmed this mapping.');
    expect((await db.query('SELECT verification_status FROM brand_entity_relationships')).rows).toEqual([{ verification_status: 'human_verified' }]);
  });
  it.each(['registry_verified', 'registry_active', 'source_validated', 'market_context_match', 'brand_context_match'])('fails closed when %s is false', async flag => {
    const payload = prepareResolution(input()); payload.candidates[0]!.verification[flag] = false;
    await ingest(payload); await expect(approve(await candidate(), 'Reviewed')).rejects.toThrow('Verified GB registry');
    expect(await counts()).toEqual({ brands: 0, entities: 0, relationships: 0 });
  });
  it('server role can execute the invoker RPCs using the granted privileges', async () => {
    await db.exec('SET ROLE service_role');
    try {
      await ingest(); await approve(await candidate());
      expect(await counts()).toEqual({ brands: 1, entities: 1, relationships: 1 });
    } finally { await db.exec('RESET ROLE'); }
  });
  it('does not grant browser roles table access or RPC execution, even with permissive defaults', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect((await db.query('SELECT has_table_privilege($1,\'resolution_runs\',\'SELECT\') r, has_table_privilege($1,\'resolution_candidates\',\'INSERT\') c, has_function_privilege($1,\'approve_resolution_candidate(uuid,text)\',\'EXECUTE\') f', [role])).rows[0]).toEqual({ r: false, c: false, f: false });
    }
    expect((await db.query("SELECT has_function_privilege('service_role','approve_resolution_candidate(uuid,text)','EXECUTE') allowed")).rows[0]).toEqual({ allowed: true });
  });
});

describe('mocked Supabase transport and CLI', () => {
  it('persists via one RPC and keeps the full result without inserting a relationship client-side', async () => {
    const requests: { url: string; body: unknown }[] = [];
    const client = createClient('https://example.test', 'test-only', { global: { fetch: async (url, options) => {
      requests.push({ url: String(url), body: JSON.parse(String(options?.body)) });
      return new Response(JSON.stringify(fixedId), { headers: { 'Content-Type': 'application/json' } });
    } } });
    const fixture = input(); expect(await ingestResolutionResult(createResolutionReviewStore(client), fixture)).toBe(fixedId);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('/rpc/ingest_resolution_run');
    expect(requests[0]?.body).toMatchObject({ p_key: fixture.run_key, p_payload: { raw_result: fixture.result } });
  });
  it('approval/rejection each use a single RPC; transport errors do not expose credentials', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ message: 'private-secret' }), { status: 400 }));
    const store = createResolutionReviewStore(createClient('https://example.test', 'test-only', { global: { fetch: request } }));
    await expect(store.approve(fixedId)).rejects.toThrow('approve_resolution_candidate failed');
    expect(request).toHaveBeenCalledOnce();
    request.mockResolvedValueOnce(new Response(JSON.stringify(fixedId), { headers: { 'Content-Type': 'application/json' } }));
    expect(await store.reject(fixedId, 'Not relevant')).toBe(fixedId);
    expect(String(request.mock.calls[1]?.[0])).toContain('/rpc/reject_resolution_candidate');
  });
  it('CLI queue presents the required fields; approve and reject require explicit candidate UUIDs', async () => {
    const row = { id: fixedId, candidate_legal_name: 'ALPHA LIMITED', company_number: '00123456', relationship_type: 'seller' as const,
      source_url: source, recommended_action: 'PROPOSE' as const, reason: 'verified_operating_entity', resolution_runs: { brand_name: 'Example', overall_action: 'PROPOSE' as const, reason: 'verified_operating_entity' } };
    const store: ResolutionReviewStore = { ingest: vi.fn(), queue: vi.fn(async () => [row]), approve: vi.fn(async () => fixedId), reject: vi.fn(async () => fixedId) };
    const log = vi.fn(); await main(['queue'], { store, log });
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ candidate_id: fixedId, brand: 'Example', action: 'PROPOSE', legal_entity: 'ALPHA LIMITED', company_number: '00123456', role: 'seller', source_url: source, reason: 'verified_operating_entity' });
    await expect(main(['approve'], { store, log })).rejects.toThrow();
    expect(store.approve).not.toHaveBeenCalled();
    await main(['approve', '--candidate', fixedId], { store, log }); expect(store.approve).toHaveBeenCalledExactlyOnceWith(fixedId, undefined);
    await main(['reject', '--candidate', fixedId, '--note', 'Unrelated'], { store, log }); expect(store.reject).toHaveBeenCalledExactlyOnceWith(fixedId, 'Unrelated');
  });
  it('queue transport requests only pending rows and paginates under server caps', async () => {
    const urls: URL[] = [];
    const row = { id: fixedId, candidate_legal_name: 'ALPHA LIMITED', company_number: '00123456', relationship_type: 'seller', source_url: source,
      recommended_action: 'PROPOSE', reason: 'verified', resolution_runs: { brand_name: 'Example', overall_action: 'PROPOSE', reason: 'verified' } };
    const store = createResolutionReviewStore(createClient('https://example.test', 'test-only', { global: { fetch: async (value, init) => {
      const url = new URL(String(value)); urls.push(url); expect(init?.method).toBe('GET');
      return new Response(JSON.stringify(urls.length === 1 ? [row] : []), { headers: { 'Content-Type': 'application/json' } });
    } } }));
    expect(await store.queue()).toEqual([row]);
    expect(urls.map(url => url.searchParams.get('offset'))).toEqual(['0', '1']);
    expect(urls.every(url => url.searchParams.get('review_status') === 'eq.pending')).toBe(true);
  });
});
