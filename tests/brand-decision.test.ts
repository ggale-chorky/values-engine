import { afterEach, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { createReadDatabase } from '../src/db/database.js';
import { evaluateBrandDecision } from '../src/decision/evaluate-brand-decision.js';
import * as brandEvaluator from '../src/evaluation/evaluate-brand-from-db.js';
import { main } from '../src/scripts/decision-brand.js';
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
const decide = (db: FakeDatabase) => evaluateBrandDecision({ brand: 'Example', policy: 'Personal' }, { db, asOf: '2026-10-07' });
afterEach(() => vi.restoreAllMocks());
it.each([[-0.7, 'PASS', 'threshold_met'], [5, 'PASS', 'threshold_met'], [6, 'FAIL', 'threshold_exceeded']] as const)('returns %s as %s using persisted threshold', async (value, decision, reason) => {
  const db = fixture(); db.tables.evidence[0]!.value_numeric = value;
  const result = await decide(db);
  expect(result).toEqual({ decision, reason, policy: { id: policyId, name: 'Personal' },
    rule: { criterion: 'uk_median_gender_pay_gap', operator: '<=', threshold: 5 }, subject: { brand: 'Example' },
    entity: { legal_name: 'EXAMPLE LIMITED', company_number: '00123456', relationship_type: 'seller', verification_status: 'human_verified' },
    evidence: { observed_value: value, unit: 'percent', reporting_period: '2025-26', source_name: 'UK Gender Pay Gap Service', source_url: 'https://example.test/evidence', evidence_id: 'evidence' },
    scope: brandEvaluator.BRAND_EVALUATION_SCOPE,
    explanation: `Your policy allows a median UK gender pay gap of up to 5%. EXAMPLE LIMITED reports ${value}% for 2025-26, so this ${decision === 'PASS' ? 'passes' : 'exceeds'} your rule.` });
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  expect(db.writes).toEqual([]);
});
it('missing evidence uses null fields without inventing facts', async () => {
  const db = fixture(); db.tables.evidence = [];
  expect(await decide(db)).toMatchObject({ decision: 'UNKNOWN', reason: 'missing_evidence',
    evidence: { observed_value: null, unit: null, reporting_period: null, source_name: null, source_url: null, evidence_id: null },
    explanation: 'No valid verified median UK gender-pay-gap evidence is available for the selected commerce entity.' });
});
it('no verified commerce entity returns a precise explanation and null entity fields', async () => {
  const db = fixture(); db.tables.brand_entity_relationships = [];
  expect(await decide(db)).toMatchObject({ decision: 'UNKNOWN', reason: 'no_verified_commerce_entity',
    entity: { legal_name: null, company_number: null, relationship_type: null, verification_status: null },
    explanation: 'No eligible human-verified UK commerce entity is available for this brand.' });
});
it('ambiguous entities remain UNKNOWN without selecting one', async () => {
  const db = fixture(); db.tables.legal_entities.push({ ...db.tables.legal_entities[0], id: 'other' });
  db.tables.brand_entity_relationships.push({ ...db.tables.brand_entity_relationships[0], id: 'other-link', legal_entity_id: 'other' });
  expect(await decide(db)).toMatchObject({ decision: 'UNKNOWN', reason: 'ambiguous_legal_entity', entity: { legal_name: null },
    explanation: 'Multiple eligible human-verified UK commerce entities are associated with this brand; no entity was selected.' });
});
it('unsupported rules retain structured fields and UNKNOWN', async () => {
  const db = fixture(); db.tables.policy_rules[0]!.operator = '>';
  expect(await decide(db)).toMatchObject({ decision: 'UNKNOWN', reason: 'unsupported_rule', rule: { operator: '>', threshold: 5 },
    explanation: 'The selected policy contains an unsupported criterion, operator, action or unknown-handling setting.' });
});
it('incomplete rules use null criterion/operator/threshold instead of defaulting to the demo rule', async () => {
  const db = fixture(); db.tables.policy_rules = [];
  expect(await decide(db)).toMatchObject({ decision: 'UNKNOWN', reason: 'invalid_rule', rule: { criterion: null, operator: null, threshold: null } });
});
it('invalid evidence does not invent a percent unit', async () => {
  const db = fixture(); db.tables.evidence[0]!.unit = 'invalid';
  expect(await decide(db)).toMatchObject({ decision: 'UNKNOWN', reason: 'missing_evidence', evidence: { unit: null, evidence_id: 'evidence' } });
});
it.each(['brand_not_found', 'ambiguous_brand', 'ambiguous_evidence', 'inactive_policy'] as const)('preserves %s with a deterministic explanation', async reason => {
  const db = fixture();
  if (reason === 'brand_not_found') db.tables.brands = [];
  if (reason === 'ambiguous_brand') db.tables.brands.push({ ...db.tables.brands[0], id: 'duplicate' });
  if (reason === 'ambiguous_evidence') db.tables.evidence.push({ ...db.tables.evidence[0], id: 'duplicate' });
  if (reason === 'inactive_policy') db.tables.policies[0]!.is_active = false;
  const result = await decide(db);
  expect(result).toMatchObject({ decision: 'UNKNOWN', reason });
  expect(result.explanation.length).toBeGreaterThan(20);
});
it('uses the existing evaluation result, without a second threshold comparison', async () => {
  const db = fixture();
  const original = await brandEvaluator.evaluateBrandFromDb(db, 'Example', '2026-10-07');
  // Deliberately inconsistent numeric data proves this presentation adapter does not recalculate a decision.
  const spy = vi.spyOn(brandEvaluator, 'evaluateBrandFromDb').mockResolvedValue({ ...original, policy_id: policyId,
    policy_name: 'Personal', threshold: 5, observed_value: 99, final_status: 'PASS', reason: 'threshold_met' });
  expect(await decide(db)).toMatchObject({ decision: 'PASS', reason: 'threshold_met', evidence: { observed_value: 99 } });
  expect(spy).toHaveBeenCalledExactlyOnceWith(db, 'Example', '2026-10-07', expect.objectContaining({ id: policyId, rule: expect.objectContaining({ threshold_numeric: 5 }) }));
});
it('requires an explicit policy and preserves safe lookup errors', async () => {
  const db = fixture();
  await expect(evaluateBrandDecision({ brand: 'Example', policy: '' }, { db })).rejects.toThrow('required');
  expect(db.reads).toEqual([]);
  await expect(evaluateBrandDecision({ brand: 'Example', policy: 'Absent' }, { db })).rejects.toThrow('not found');
  db.tables.policies.push({ ...db.tables.policies[0], id: 'duplicate' });
  await expect(decide(db)).rejects.toThrow('Ambiguous');
});
it('CLI validates before connecting', async () => {
  const read = vi.fn();
  await expect(main(['--brand', 'Example'], { read })).rejects.toThrow('Usage');
  expect(read).not.toHaveBeenCalled();
});
it('service and CLI issue only GET requests, preserve all data and print just one JSON decision', async () => {
  const db = fixture(); const before = structuredClone(db.tables); const methods: string[] = [];
  const client = createClient('https://example.test', 'test-only', { global: { fetch: async (input, init) => {
    methods.push(init!.method!); expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined();
    const url = new URL(String(input)); const table = url.pathname.split('/').at(-1)! as keyof typeof db.tables;
    const filters = Object.fromEntries([...url.searchParams].filter(([, v]) => v.startsWith('eq.')).map(([k, v]) => [k, v.slice(3)]));
    const rows = Number(url.searchParams.get('offset')) === 0 ? await db.read(table, filters) : [];
    return new Response(JSON.stringify(rows), { headers: { 'Content-Type': 'application/json' } });
  } } });
  const read = async () => createReadDatabase(client); const log = vi.fn();
  const expected = await evaluateBrandDecision({ brand: 'Example', policy: policyId }, { db: await read(), asOf: '2026-10-07' });
  await main(['--brand', 'Example', '--policy', policyId], { read, now: () => new Date('2026-10-07'), log });
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0]![0])).toEqual(expected);
  expect(methods.length).toBeGreaterThan(0); expect(db.tables).toEqual(before); expect(db.writes).toEqual([]);
});
