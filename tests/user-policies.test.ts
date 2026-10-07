import { describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { createReadDatabase, createWriteDatabase } from '../src/db/database.js';
import { createPolicy, listPolicies, selectPolicy, validatePolicyInput } from '../src/policies/service.js';
import { evaluateBrandFromDb } from '../src/evaluation/evaluate-brand-from-db.js';
import { main as evaluateCli } from '../src/scripts/evaluate-brand.js';
import { main as policyCli } from '../src/scripts/policies.js';
import { FakeDatabase } from './helpers/fake-database.js';

const policyId = '11111111-1111-4111-8111-111111111111';
function fixture() {
  const db = new FakeDatabase();
  db.tables.policies.push({ id: policyId, name: 'Personal', is_active: true, user_id: null, created_at: '2026-10-07T00:00:00Z' });
  db.tables.policy_rules.push({ id: 'rule', policy_id: policyId, criterion: 'uk_median_gender_pay_gap', operator: '<=', threshold_numeric: 5,
    threshold_text: null, action: 'REQUIRE', unknown_handling: 'UNKNOWN' });
  db.tables.brands.push({ id: 'brand', canonical_name: 'Example' });
  db.tables.legal_entities.push({ id: 'entity', canonical_name: 'EXAMPLE LIMITED', company_number: '00123456', jurisdiction: 'GB' });
  db.tables.brand_entity_relationships.push({ id: 'link', brand_id: 'brand', legal_entity_id: 'entity', relationship_type: 'seller',
    verification_status: 'human_verified', confidence: 1, valid_from: null, valid_to: null });
  db.tables.evidence.push({ id: 'evidence', legal_entity_id: 'entity', product_id: null, brand_id: null,
    claim_type: 'uk_median_gender_pay_gap', value_numeric: 5, value_text: null, value_boolean: null, unit: 'percent',
    reporting_period: '2025-26', source_name: 'UK Gender Pay Gap Service', source_url: 'https://example.test/evidence',
    confidence: 1, verification_status: 'auto_verified' });
  return db;
}
async function evaluate(db: FakeDatabase) { return evaluateBrandFromDb(db, 'Example', '2026-10-07', await selectPolicy(db, policyId)); }

describe('user policy creation', () => {
  it('creates one active policy with exactly one structured rule, never appending duplicate rules', async () => {
    const db = new FakeDatabase();
    const first = await createPolicy(db, ' Personal ', '5');
    const second = await createPolicy(db, 'Personal', '6');
    expect(first).toMatchObject({ policy_name: 'Personal', active: true, threshold: 5 });
    expect(first.policy_id).not.toBe(second.policy_id);
    for (const policy of db.tables.policies) {
      expect(policy.is_active).toBe(true);
      expect(db.tables.policy_rules.filter(rule => rule.policy_id === policy.id)).toHaveLength(1);
    }
    expect(db.tables.policy_rules[0]).toMatchObject({ criterion: 'uk_median_gender_pay_gap', operator: '<=', threshold_numeric: 5,
      threshold_text: null, action: 'REQUIRE', unknown_handling: 'UNKNOWN' });
    expect(db.writes.map(write => write.table)).toEqual(['policies', 'policy_rules', 'policies', 'policies', 'policy_rules', 'policies']);
  });
  it.each(['', ' ', 'abc', '10%', '10abc', 'NaN', 'Infinity', '-Infinity', '1e999', '0x10', '1,5'])('rejects malformed threshold %j before writing', async threshold => {
    const db = new FakeDatabase();
    await expect(createPolicy(db, 'Name', threshold)).rejects.toThrow('finite');
    expect(db.writes).toEqual([]);
  });
  it.each(['-0.7', '0', '10', '18.95', '1e2'])('accepts finite decimal %s without changing its semantics', value => {
    expect(validatePolicyInput('Name', value).threshold).toBe(Number(value));
  });
  it('requires a name', async () => {
    const db = new FakeDatabase();
    await expect(createPolicy(db, ' ', '10')).rejects.toThrow('name');
    expect(db.writes).toEqual([]);
  });
  it('keeps a policy inactive when rule insertion fails and does not retry', async () => {
    const db = new FakeDatabase(); db.failAfter = 1;
    await expect(createPolicy(db, 'Name', '10')).rejects.toThrow('policy_id=');
    expect(db.tables.policies[0]!.is_active).toBe(false);
    expect(db.tables.policy_rules).toEqual([]);
    expect(db.writes).toHaveLength(1);
  });
  it('validates CLI input before connecting', async () => {
    const write = vi.fn();
    await expect(policyCli(['create', '--name', 'Name', '--max-gender-pay-gap', 'bad'], { write })).rejects.toThrow('finite');
    expect(write).not.toHaveBeenCalled();
  });
  it('creates through the CLI', async () => {
    const db = new FakeDatabase(); const log = vi.fn();
    await policyCli(['create', '--name', 'Name', '--max-gender-pay-gap', '7'], { write: async () => db, log });
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ active: true, threshold: 7 });
  });
});

describe('persisted policy selection and listing', () => {
  it.each([policyId, 'Personal'])('selects exactly by %s', async selector => {
    const db = fixture();
    expect(await selectPolicy(db, selector)).toMatchObject({ id: policyId, name: 'Personal', problem: null, rule: { threshold_numeric: 5 } });
    expect(db.reads[0]!.filters).toEqual(selector === policyId ? { id: policyId } : { name: 'Personal' });
    expect(db.writes).toEqual([]);
  });
  it('does not use fuzzy names or guess between duplicate names', async () => {
    const db = fixture();
    await expect(selectPolicy(db, 'person')).rejects.toThrow('not found');
    db.tables.policies.push({ ...db.tables.policies[0], id: 'duplicate' });
    await expect(selectPolicy(db, 'Personal')).rejects.toThrow('Ambiguous');
    expect((await selectPolicy(db, policyId)).id).toBe(policyId);
  });
  it('lists predictably, including policies missing rules, without writes', async () => {
    const db = fixture(); db.tables.policies.unshift({ id: 'z', name: 'Z', is_active: false }, { id: 'a', name: 'A', is_active: false });
    const rows = await listPolicies(db);
    expect(rows.map(row => row.policy_name)).toEqual(['A', 'Personal', 'Z']);
    expect(rows[1]).toEqual({ policy_id: policyId, policy_name: 'Personal', active: true, criterion: 'uk_median_gender_pay_gap', operator: '<=',
      threshold: 5, unknown_handling: 'UNKNOWN', created_at: '2026-10-07T00:00:00Z' });
    expect(rows[0]!.threshold).toBeNull(); expect(db.writes).toEqual([]);
  });
});

describe('persisted policy brand evaluation', () => {
  it.each([[4, 'PASS'], [5, 'PASS'], [6, 'FAIL']] as const)('compares %s to DB threshold 5: %s', async (value, status) => {
    const db = fixture(); db.tables.evidence[0]!.value_numeric = value;
    expect(await evaluate(db)).toMatchObject({ policy_id: policyId, policy_name: 'Personal', operator: '<=', threshold: 5,
      observed_value: value, final_status: status, legal_entity: 'EXAMPLE LIMITED', reporting_period: '2025-26' });
    expect(db.writes).toEqual([]);
  });
  it('missing evidence remains UNKNOWN', async () => {
    const db = fixture(); db.tables.evidence = [];
    expect(await evaluate(db)).toMatchObject({ final_status: 'UNKNOWN', reason: 'missing_evidence' });
  });
  it('no trusted commerce entity remains UNKNOWN', async () => {
    const db = fixture(); db.tables.brand_entity_relationships = [];
    expect(await evaluate(db)).toMatchObject({ final_status: 'UNKNOWN', reason: 'no_verified_commerce_entity' });
  });
  it('multiple entities remain UNKNOWN', async () => {
    const db = fixture(); db.tables.legal_entities.push({ ...db.tables.legal_entities[0], id: 'other' });
    db.tables.brand_entity_relationships.push({ ...db.tables.brand_entity_relationships[0], id: 'other-link', legal_entity_id: 'other' });
    expect(await evaluate(db)).toMatchObject({ final_status: 'UNKNOWN', reason: 'ambiguous_legal_entity' });
  });
  it.each([{ criterion: 'other' }, { operator: '<' }, { action: 'PREFER' }, { unknown_handling: 'FAIL' }])('does not reinterpret unsupported rule %j', async override => {
    const db = fixture(); Object.assign(db.tables.policy_rules[0]!, override);
    expect(await evaluate(db)).toMatchObject({ final_status: 'UNKNOWN', reason: 'unsupported_rule' });
  });
  it.each([{ threshold_numeric: null }, { threshold_numeric: '5' }, { threshold_numeric: Infinity }, { threshold_text: '5' }, { action: undefined }])('rejects invalid rule %j', async override => {
    const db = fixture(); Object.assign(db.tables.policy_rules[0]!, override);
    expect(await evaluate(db)).toMatchObject({ final_status: 'UNKNOWN', reason: 'invalid_rule' });
  });
  it.each([0, 2])('rejects %s rules rather than selecting or inventing one', async count => {
    const db = fixture(); db.tables.policy_rules = count ? [...db.tables.policy_rules, { ...db.tables.policy_rules[0], id: 'second' }] : [];
    expect(await evaluate(db)).toMatchObject({ final_status: 'UNKNOWN', reason: 'invalid_rule' });
  });
  it('inactive policies cannot pass', async () => {
    const db = fixture(); db.tables.policies[0]!.is_active = false;
    expect(await evaluate(db)).toMatchObject({ final_status: 'UNKNOWN', reason: 'inactive_policy' });
  });
  it('list and selected-policy CLI only issue GETs through the real adapter', async () => {
    const db = fixture(); const before = structuredClone(db.tables); const methods: string[] = [];
    const client = createClient('https://example.test', 'test-only', { global: { fetch: async (input, init) => {
      methods.push(init!.method!); expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined();
      const url = new URL(String(input)); const table = url.pathname.split('/').at(-1)! as keyof typeof db.tables;
      const filters = Object.fromEntries([...url.searchParams].filter(([, value]) => value.startsWith('eq.')).map(([key, value]) => [key, value.slice(3)]));
      const rows = Number(url.searchParams.get('offset')) === 0 ? await db.read(table, filters) : [];
      return new Response(JSON.stringify(rows), { headers: { 'Content-Type': 'application/json' } });
    } } });
    const read = async () => createReadDatabase(client); const log = vi.fn();
    await policyCli(['list'], { read, log });
    await evaluateCli(['--brand', 'Example', '--policy', 'Personal'], { read, log, now: () => new Date('2026-10-07') });
    expect(JSON.parse(log.mock.calls[1]![0])).toMatchObject({ policy_id: policyId, threshold: 5, final_status: 'PASS' });
    expect(methods.length).toBeGreaterThan(0); expect(db.tables).toEqual(before); expect(db.writes).toEqual([]);
  });
  it('creation transport writes only policies and policy_rules', async () => {
    const requests: { table: string; method: string }[] = [];
    const client = createClient('https://example.test', 'test-only', { global: { fetch: async (input, init) => {
      const table = new URL(String(input)).pathname.split('/').at(-1)!;
      requests.push({ table, method: init!.method! });
      return new Response(JSON.stringify([{ id: 'created' }]), { headers: { 'Content-Type': 'application/json' } });
    } } });
    await createPolicy(createWriteDatabase(client), 'Policy', '3');
    expect(requests).toEqual([{ table: 'policies', method: 'POST' }, { table: 'policy_rules', method: 'POST' }, { table: 'policies', method: 'PATCH' }]);
  });
});
