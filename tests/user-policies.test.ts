import { createPolicyCreator } from '../src/policies/creation.js';
import { describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { createReadDatabase } from '../src/db/database.js';
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
  it('returns both identifiers from one creation call', async () => {
    const creator = { create: vi.fn().mockResolvedValue({ policy_id: policyId, rule_id: 'rule-id' }) };
    expect(await createPolicy(creator, ' Personal ', '5')).toMatchObject({ policy_id: policyId, rule_id: 'rule-id', active: true, threshold: 5 });
    expect(creator.create).toHaveBeenCalledExactlyOnceWith('Personal', 5);
  });
  it.each(['', ' ', 'abc', '10%', '10abc', 'NaN', 'Infinity', '-Infinity', '1e999', '0x10', '1,5'])('rejects malformed threshold %j before writing', async threshold => {
    const db = { create: vi.fn() };
    await expect(createPolicy(db, 'Name', threshold)).rejects.toThrow('finite');
    expect(db.create).not.toHaveBeenCalled();
  });
  it.each(['-0.7', '0', '10', '18.95', '1e2'])('accepts finite decimal %s without changing its semantics', value => {
    expect(validatePolicyInput('Name', value).threshold).toBe(Number(value));
  });
  it('requires a name before calling the RPC', async () => {
    const creator = { create: vi.fn() };
    await expect(createPolicy(creator, ' ', '10')).rejects.toThrow('name');
    expect(creator.create).not.toHaveBeenCalled();
  });
  it('does not repair or retry RPC failure', async () => {
    const creator = { create: vi.fn().mockRejectedValue(new Error('private transport details')) };
    await expect(createPolicy(creator, 'Name', '10')).rejects.toThrow('No repair or retry');
    expect(creator.create).toHaveBeenCalledTimes(1);
  });
  it('validates CLI input before connecting', async () => {
    const write = vi.fn();
    await expect(policyCli(['create', '--name', 'Name', '--max-gender-pay-gap', 'bad'], { write })).rejects.toThrow('finite');
    expect(write).not.toHaveBeenCalled();
  });
  it('creates through the CLI', async () => {
    const db = { create: vi.fn().mockResolvedValue({ policy_id: policyId, rule_id: 'rule-id' }) }; const log = vi.fn();
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
  it.each([false, true])('creation uses one RPC POST and no follow-up table writes (failure=%s)', async failure => {
    const requests: { path: string; method: string }[] = [];
    const ruleId = '22222222-2222-4222-8222-222222222222';
    const client = createClient('https://example.test', 'test-only', { global: { fetch: async (input, init) => {
      requests.push({ path: new URL(String(input)).pathname, method: init!.method! });
      expect(JSON.parse(String(init?.body))).toEqual({ p_name: 'Policy', p_threshold: 3 });
      return new Response(JSON.stringify(failure ? { message: 'private error' } : [{ policy_id: policyId, rule_id: ruleId }]),
        { status: failure ? 400 : 200, headers: { 'Content-Type': 'application/json' } });
    } } });
    const result = createPolicy(createPolicyCreator(client), 'Policy', '3');
    if (failure) await expect(result).rejects.toThrow('Policy creation RPC failed');
    else expect(await result).toMatchObject({ policy_id: policyId, rule_id: ruleId });
    expect(requests).toEqual([{ path: '/rest/v1/rpc/create_gender_pay_policy', method: 'POST' }]);
  });
});
