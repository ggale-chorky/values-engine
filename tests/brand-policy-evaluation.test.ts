import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { createReadDatabase } from '../src/db/database.js';
import { evaluateBrandFromDb, BRAND_EVALUATION_SCOPE } from '../src/evaluation/evaluate-brand-from-db.js';
import { main } from '../src/scripts/evaluate-brand.js';
import { FakeDatabase } from './helpers/fake-database.js';

const date = '2026-10-07';
function fixture() {
  const db = new FakeDatabase();
  db.tables.brands.push({ id: 'brand', canonical_name: 'Example' });
  db.tables.legal_entities.push({ id: 'entity', canonical_name: 'ALPHA LIMITED', company_number: '00123456', jurisdiction: 'GB' });
  db.tables.brand_entity_relationships.push({ id: 'link', brand_id: 'brand', legal_entity_id: 'entity', relationship_type: 'seller',
    verification_status: 'human_verified', confidence: 1, valid_from: null, valid_to: null });
  db.tables.evidence.push({ id: 'evidence', legal_entity_id: 'entity', product_id: null, brand_id: null,
    claim_type: 'uk_median_gender_pay_gap', value_numeric: 10, value_text: null, value_boolean: null, unit: 'percent',
    reporting_period: '2025-26', source_name: 'UK Gender Pay Gap Service', source_url: 'https://example.test/evidence',
    confidence: 1, verification_status: 'auto_verified' });
  return db;
}
const evaluate = (db: FakeDatabase) => evaluateBrandFromDb(db, 'Example', date);

describe('brand policy adapter with mocked database', () => {
  it.each([[-0.7, 'PASS'], [10, 'PASS'], [18.95, 'FAIL']] as const)('evaluates %s as %s with the existing demo rule', async (value, status) => {
    const db = fixture(); db.tables.evidence[0]!.value_numeric = value;
    expect(await evaluate(db)).toMatchObject({ brand: 'Example', legal_entity: 'ALPHA LIMITED', company_number: '00123456',
      relationship_type: 'seller', relationship_verification_status: 'human_verified', criterion: 'uk_median_gender_pay_gap', threshold: 10,
      observed_value: value, reporting_period: '2025-26', evidence_source: { name: 'UK Gender Pay Gap Service', url: 'https://example.test/evidence' },
      final_status: status, reason: status === 'PASS' ? 'threshold_met' : 'threshold_exceeded', scope: BRAND_EVALUATION_SCOPE });
    expect(db.writes).toEqual([]);
  });
  it('missing evidence returns UNKNOWN', async () => {
    const db = fixture(); db.tables.evidence = [];
    expect(await evaluate(db)).toMatchObject({ final_status: 'UNKNOWN', reason: 'missing_evidence', observed_value: null });
  });
  it('missing human-verified commerce relationship returns UNKNOWN without reading evidence', async () => {
    const db = fixture(); db.tables.brand_entity_relationships = [];
    expect(await evaluate(db)).toMatchObject({ final_status: 'UNKNOWN', reason: 'no_verified_commerce_entity' });
    expect(db.reads.some(item => item.table === 'evidence')).toBe(false);
  });
  it('multiple eligible entities return UNKNOWN before reading evidence', async () => {
    const db = fixture(); db.tables.legal_entities.push({ ...db.tables.legal_entities[0], id: 'other' });
    db.tables.brand_entity_relationships.push({ ...db.tables.brand_entity_relationships[0], id: 'other-link', legal_entity_id: 'other' });
    expect(await evaluate(db)).toMatchObject({ final_status: 'UNKNOWN', reason: 'ambiguous_legal_entity' });
    expect(db.reads.some(item => item.table === 'evidence')).toBe(false);
  });
  it.each(['seller', 'site_operator', 'operated_by'])('accepts human-verified %s without reinterpreting it', async relationship_type => {
    const db = fixture(); db.tables.brand_entity_relationships[0]!.relationship_type = relationship_type;
    expect(await evaluate(db)).toMatchObject({ final_status: 'PASS', relationship_type });
  });
  it.each(['promoter', 'licensor', 'data_controller', 'brand_operator', 'owned_by', 'service_operator', 'unknown'])('excludes %s', async role => {
    const db = fixture(); db.tables.brand_entity_relationships[0]!.relationship_type = role;
    expect(await evaluate(db)).toMatchObject({ final_status: 'UNKNOWN', reason: 'no_verified_commerce_entity' });
  });
  it.each(['candidate', 'auto_verified', 'rejected'])('excludes %s relationships even for seller roles', async status => {
    const db = fixture(); db.tables.brand_entity_relationships[0]!.verification_status = status;
    expect(await evaluate(db)).toMatchObject({ final_status: 'UNKNOWN', reason: 'no_verified_commerce_entity' });
  });
  it('counts distinct entities and preserves all eligible roles for a single entity', async () => {
    const db = fixture(); db.tables.brand_entity_relationships.push({ ...db.tables.brand_entity_relationships[0], id: 'site-link', relationship_type: 'site_operator' });
    expect(await evaluate(db)).toMatchObject({ final_status: 'PASS', relationship_type: ['seller', 'site_operator'], relationship_ids: ['link', 'site-link'] });
  });
  it('excludes foreign entities', async () => {
    const db = fixture(); db.tables.legal_entities[0]!.jurisdiction = 'US';
    expect(await evaluate(db)).toMatchObject({ final_status: 'UNKNOWN', reason: 'no_verified_commerce_entity' });
  });
  it.each([{ confidence: 0.8 }, { valid_from: '2027-01-01' }, { valid_to: '2020-01-01' }])('retains confidence/date eligibility checks: %j', async override => {
    const db = fixture(); Object.assign(db.tables.brand_entity_relationships[0]!, override);
    expect(await evaluate(db)).toMatchObject({ final_status: 'UNKNOWN', reason: 'no_verified_commerce_entity' });
  });
  it('selects the latest verified reporting period, ignoring newer unverified evidence', async () => {
    const db = fixture(); db.tables.evidence.push({ ...db.tables.evidence[0], id: 'old', reporting_period: '2024-25', value_numeric: 99 },
      { ...db.tables.evidence[0], id: 'unverified', reporting_period: '2026-27', value_numeric: 99, verification_status: 'candidate' });
    expect(await evaluate(db)).toMatchObject({ final_status: 'PASS', evidence_id: 'evidence', reporting_period: '2025-26' });
  });
  it.each([null, '10', 'invalid'])('does not coerce invalid latest values or fall back to older evidence: %s', async value => {
    const db = fixture(); db.tables.evidence.push({ ...db.tables.evidence[0], id: 'old', reporting_period: '2024-25' });
    db.tables.evidence[0]!.value_numeric = value;
    expect(await evaluate(db)).toMatchObject({ final_status: 'UNKNOWN', reason: 'missing_evidence' });
  });
  it('preserves ambiguous latest evidence as UNKNOWN rather than choosing a favourable record', async () => {
    const db = fixture(); db.tables.evidence.push({ ...db.tables.evidence[0], id: 'duplicate' });
    expect(await evaluate(db)).toMatchObject({ final_status: 'UNKNOWN', reason: 'ambiguous_evidence' });
  });
  it('only unverified evidence means missing evidence', async () => {
    const db = fixture(); db.tables.evidence[0]!.verification_status = 'candidate';
    expect(await evaluate(db)).toMatchObject({ final_status: 'UNKNOWN', reason: 'missing_evidence' });
  });
  it('does not guess among duplicate brand names', async () => {
    const db = fixture(); db.tables.brands.push({ id: 'duplicate', canonical_name: 'Example' });
    expect(await evaluate(db)).toMatchObject({ final_status: 'UNKNOWN', reason: 'ambiguous_brand' });
  });
  it('returns UNKNOWN for a missing brand', async () => {
    const db = fixture(); db.tables.brands = [];
    expect(await evaluate(db)).toMatchObject({ final_status: 'UNKNOWN', reason: 'brand_not_found' });
  });
});

describe('read-only CLI end-to-end mocked transport', () => {
  it('uses GET only and emits JSON with scope and evaluation, without changing evidence or creating evaluations', async () => {
    const db = fixture(); const initial = structuredClone(db.tables); const requests: URL[] = [];
    const client = createClient('https://example.test', 'test-only', { global: { fetch: async (value, init) => {
      expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined();
      const url = new URL(String(value)); requests.push(url);
      const table = url.pathname.split('/').at(-1)! as keyof typeof db.tables;
      expect(['brands', 'brand_entity_relationships', 'legal_entities', 'evidence']).toContain(table);
      const filters = Object.fromEntries([...url.searchParams].filter(([, val]) => val.startsWith('eq.')).map(([key, val]) => [key, val.slice(3)]));
      const rows = Number(url.searchParams.get('offset')) === 0 ? await db.read(table, filters) : [];
      return new Response(JSON.stringify(rows), { headers: { 'Content-Type': 'application/json' } });
    } } });
    const log = vi.fn();
    await main(['--brand', 'Example'], { read: async () => createReadDatabase(client), now: () => new Date(date), log });
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ final_status: 'PASS', scope: BRAND_EVALUATION_SCOPE });
    expect(requests.find(url => url.pathname.endsWith('brand_entity_relationships'))?.searchParams.get('verification_status')).toBe('eq.human_verified');
    expect(db.writes).toEqual([]); expect(db.tables).toEqual(initial);
  });
  it('validates CLI arguments before connecting', async () => {
    const read = vi.fn();
    await expect(main([], { read })).rejects.toThrow('Usage');
    await expect(main(['--brand', ' '], { read })).rejects.toThrow('Usage');
    expect(read).not.toHaveBeenCalled();
  });
});
