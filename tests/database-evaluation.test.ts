import { afterEach, describe, expect, it, vi } from 'vitest';
import * as engine from '../src/evaluation/evaluate-product.js';
import { evaluateProductFromDb, loadEvaluationInput } from '../src/evaluation/evaluate-product-from-db.js';
import { seedDemo } from '../src/demo/seed.js';
import { evaluateDemoFromDb } from '../src/demo/live.js';
import { importedDatabase } from './helpers/fake-database.js';

const now = '2026-10-05T12:00:00.000Z';
async function seeded() {
  const db = importedDatabase();
  await seedDemo(db, now);
  db.writes = [];
  const productId = db.tables.products[0]!.id as string;
  const policyId = db.tables.policies[0]!.id as string;
  return { db, productId, policyId, evaluate: () => evaluateProductFromDb(db, productId, policyId, '2026-10-05') };
}
afterEach(() => { vi.restoreAllMocks(); });

describe('database evaluation adapter', () => {
  it('maps database rows and loads the policy rule without dropping evidence fields', async () => {
    const { db, productId, policyId } = await seeded();
    const { input, policy } = await loadEvaluationInput(db, productId, policyId, '2026-10-05');
    expect(input.product).toMatchObject({ id: productId, brand_id: db.tables.brands[0]!.id });
    expect(input.brands).toEqual([{ id: db.tables.brands[0]!.id, canonical_name: 'Charlotte Tilbury' }]);
    expect(input.legal_entities[0]).toMatchObject({ company_number: '08037372' });
    expect(input.relationships[0]).toMatchObject({ relationship_type: 'operated_by', confidence: 1, verification_status: 'human_verified' });
    expect(input.evidence[0]).toMatchObject({ value_numeric: -0.7, product_id: null, value_text: null, source_url: 'https://example.test/report' });
    expect(input.rule).toMatchObject({ policy_id: policyId, threshold_numeric: 10, unknown_handling: 'UNKNOWN' });
    expect(policy.is_active).toBe(true);
    expect(db.writes).toEqual([]);
  });

  it('delegates the comparison entirely to the pure evaluator', async () => {
    const { evaluate } = await seeded();
    const spy = vi.spyOn(engine, 'evaluateProduct');
    spy.mockImplementation(input => ({ criterion: input.rule.criterion, threshold: 10, result: 'UNKNOWN', reason: 'invalid_evidence',
      observed_value: null, evidence_id: null, evidence_source: null, reporting_period: null, legal_entity_id: null,
      product_id: input.product.id, brand_id: input.product.brand_id }));
    expect(await evaluate()).toMatchObject({ result: 'UNKNOWN', reason: 'invalid_evidence' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['legal_entities', 'missing_legal_entity'], ['brand_entity_relationships', 'unresolved_legal_entity'],
    ['evidence', 'missing_evidence'], ['brands', 'missing_brand'],
  ] as const)('returns UNKNOWN for missing %s', async (table, reason) => {
    const { db, evaluate } = await seeded();
    db.tables[table] = [];
    expect(await evaluate()).toMatchObject({ result: 'UNKNOWN', reason });
    expect(db.writes).toEqual([]);
  });

  it.each([{ verification_status: 'candidate' }, { confidence: 0.8 }, { valid_to: '2025-01-01' }])
    ('passes relationship eligibility decisions to the engine %j', async patch => {
      const { db, evaluate } = await seeded();
      Object.assign(db.tables.brand_entity_relationships[0]!, patch);
      expect(await evaluate()).toMatchObject({ result: 'UNKNOWN', reason: 'unresolved_legal_entity' });
    });

  it('preserves ambiguous relationships instead of selecting the first', async () => {
    const { db, evaluate } = await seeded();
    db.tables.brand_entity_relationships.push({ ...db.tables.brand_entity_relationships[0]!, id: 'other-link',
      legal_entity_id: db.tables.legal_entities[1]!.id });
    expect(await evaluate()).toMatchObject({ result: 'UNKNOWN', reason: 'ambiguous_legal_entity' });
  });

  it('loads all evidence and uses the latest verified period via the engine', async () => {
    const { db, evaluate } = await seeded();
    db.tables.evidence.push({ ...db.tables.evidence[0]!, id: 'newest', reporting_period: '2026-27', value_numeric: 20 });
    expect(await evaluate()).toMatchObject({ result: 'FAIL', observed_value: 20, evidence_id: 'newest' });
    db.tables.evidence.at(-1)!.value_numeric = null;
    expect(await evaluate()).toMatchObject({ result: 'UNKNOWN', reason: 'invalid_evidence' });
  });

  it.each(['missing', 'inactive', 'zero-rules', 'multiple-rules', 'unsupported', 'other-threshold'])
    ('fails clearly for %s policy configuration', async situation => {
      const { db, evaluate } = await seeded();
      if (situation === 'missing') db.tables.policies = [];
      if (situation === 'inactive') db.tables.policies[0]!.is_active = false;
      if (situation === 'zero-rules') db.tables.policy_rules = [];
      if (situation === 'multiple-rules') db.tables.policy_rules.push({ ...db.tables.policy_rules[0]!, id: 'extra' });
      if (situation === 'unsupported') db.tables.policy_rules[0]!.operator = '>';
      if (situation === 'other-threshold') db.tables.policy_rules[0]!.threshold_numeric = 11;
      await expect(evaluate()).rejects.toThrow(/policy|Policy|rule/);
      expect(db.writes).toEqual([]);
    });

  it('runs all three demo evaluations read-only with provenance', async () => {
    const { db } = await seeded();
    const results = await evaluateDemoFromDb(db, '2026-10-05');
    expect(results.map(row => [row.brand, row.result, row.observed_value])).toEqual([
      ['Charlotte Tilbury', 'PASS', -0.7], ['Estée Lauder', 'PASS', 10], ['Vichy', 'FAIL', 18.95],
    ]);
    expect(results[2]).toMatchObject({ product: 'Vichy Minéral 89', company_number: '00271555', legal_entity: "L'OREAL (U.K.) LIMITED",
      reporting_period: '2025-26', threshold: 10, evidence_source: { url: 'https://example.test/report' } });
    expect(db.writes).toEqual([]);
  });
});
