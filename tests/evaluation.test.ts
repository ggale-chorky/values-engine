import { describe, expect, it } from 'vitest';
import { evaluateProduct } from '../src/evaluation/evaluate-product.js';
import { evaluateRule } from '../src/evaluation/evaluate-rule.js';
import { createDemoFixtures } from '../src/evaluation/fixtures/gender-pay-demo.js';
import type { BrandEntityRelationship, Evidence } from '../src/evaluation/types.js';

function fixture() { return createDemoFixtures()[0]!.input; }

describe('pure rule evaluation', () => {
  it.each([[-0.7, 'PASS'], [0, 'PASS'], [10, 'PASS'], [18.95, 'FAIL']] as const)
    ('compares %s to the threshold', (value, expected) => {
      const input = fixture();
      const result = evaluateRule(input.rule, { ...input.evidence[0]!, value_numeric: value },
        { legal_entity_id: input.legal_entities[0]!.id, relationship_verified: true });
      expect(result.result).toBe(expected);
    });

  it('preserves structured explanation without generated prose', () => {
    const input = fixture();
    expect(evaluateRule(input.rule, input.evidence[0]!, { legal_entity_id: 'demo-entity-1', relationship_verified: true }))
      .toEqual({ criterion: 'uk_median_gender_pay_gap', result: 'PASS', reason: 'threshold_met', threshold: 10,
        observed_value: -0.7, evidence_id: 'demo-evidence-1',
        evidence_source: { name: 'Local deterministic demo fixture', url: 'https://example.test/gpg/1' },
        reporting_period: '2025-26', legal_entity_id: 'demo-entity-1' });
  });

  it('requires a resolved verified entity context', () => {
    const input = fixture();
    for (const context of [null, { legal_entity_id: 'demo-entity-1', relationship_verified: false }]) {
      expect(evaluateRule(input.rule, input.evidence[0]!, context))
        .toMatchObject({ result: 'UNKNOWN', reason: 'unresolved_legal_entity', observed_value: null });
    }
  });

  it.each([null, undefined, '', '10', NaN, Infinity, -Infinity])('rejects invalid numeric evidence %s', value => {
    const input = fixture();
    expect(evaluateRule(input.rule, { ...input.evidence[0]!, value_numeric: value },
      { legal_entity_id: 'demo-entity-1', relationship_verified: true }))
      .toMatchObject({ result: 'UNKNOWN', reason: 'invalid_evidence', observed_value: null, evidence_id: 'demo-evidence-1' });
  });

  it.each([
    { unit: 'fraction' }, { source_name: '' }, { source_url: '' }, { confidence: NaN },
    { confidence: 1.1 }, { reporting_period: '2025-27' }, { product_id: 'some-product' },
    { value_text: 'conflicting value' }, { value_boolean: false },
  ] satisfies Partial<Evidence>[])('rejects malformed evidence fields %j', patch => {
    const input = fixture();
    expect(evaluateRule(input.rule, { ...input.evidence[0]!, ...patch },
      { legal_entity_id: 'demo-entity-1', relationship_verified: true })).toMatchObject({ result: 'UNKNOWN', reason: 'invalid_evidence' });
  });

  it('treats absent, wrong-criterion and wrong-entity evidence as missing', () => {
    const input = fixture();
    for (const evidence of [null, { ...input.evidence[0]!, claim_type: 'other' }, { ...input.evidence[0]!, legal_entity_id: 'other' }]) {
      expect(evaluateRule(input.rule, evidence, { legal_entity_id: 'demo-entity-1', relationship_verified: true }))
        .toMatchObject({ result: 'UNKNOWN', reason: 'missing_evidence', evidence_id: null });
    }
  });

  it('rejects unverified evidence even when called without product traversal', () => {
    const input = fixture();
    expect(evaluateRule(input.rule, { ...input.evidence[0]!, verification_status: 'candidate' },
      { legal_entity_id: 'demo-entity-1', relationship_verified: true }))
      .toMatchObject({ result: 'UNKNOWN', reason: 'unverified_evidence' });
  });

  it.each([null, NaN, Infinity])('returns UNKNOWN for invalid threshold %s', threshold => {
    const input = fixture();
    expect(evaluateProduct({ ...input, rule: { ...input.rule, threshold_numeric: threshold } }))
      .toMatchObject({ result: 'UNKNOWN', reason: 'invalid_rule' });
  });

  it.each([{ criterion: 'other' }, { operator: '>' }, { action: 'PREFER' }, { unknown_handling: 'FAIL' }])
    ('does not silently apply unsupported rule semantics %j', patch => {
      const input = fixture();
      expect(evaluateProduct({ ...input, rule: { ...input.rule, ...patch } }))
        .toMatchObject({ result: 'UNKNOWN', reason: 'unsupported_rule' });
    });
});

describe('product traversal and evidence selection', () => {
  it('evaluates the three supplied examples', () => {
    expect(createDemoFixtures().map(({ name, input }) => ({ name, result: evaluateProduct(input).result }))).toEqual([
      { name: 'Charlotte Tilbury', result: 'PASS' }, { name: 'Estée Lauder', result: 'PASS' }, { name: "L'Oréal", result: 'FAIL' },
    ]);
  });

  it('returns UNKNOWN for missing relationships or evidence', () => {
    const input = fixture();
    expect(evaluateProduct({ ...input, relationships: [] })).toMatchObject({ result: 'UNKNOWN', reason: 'unresolved_legal_entity' });
    expect(evaluateProduct({ ...input, evidence: [] })).toMatchObject({ result: 'UNKNOWN', reason: 'missing_evidence' });
  });

  it('returns UNKNOWN for missing brand or referenced legal entity', () => {
    const input = fixture();
    expect(evaluateProduct({ ...input, brands: [] })).toMatchObject({ result: 'UNKNOWN', reason: 'missing_brand' });
    expect(evaluateProduct({ ...input, product: { ...input.product, brand_id: null } })).toMatchObject({ result: 'UNKNOWN', reason: 'missing_brand' });
    expect(evaluateProduct({ ...input, legal_entities: [] })).toMatchObject({ result: 'UNKNOWN', reason: 'missing_legal_entity' });
  });

  it.each([
    { verification_status: 'candidate' }, { verification_status: 'rejected' }, { confidence: 0.899 },
    { confidence: NaN }, { confidence: 1.1 }, { valid_from: '2026-10-06' }, { valid_to: '2026-10-04' },
    { valid_from: '2026-02-30' }, { valid_to: 'not-a-date' }, { valid_from: '2026-10-06', valid_to: '2026-10-04' },
    { brand_id: 'another-brand' },
  ] satisfies Partial<BrandEntityRelationship>[])('excludes unusable relationships %j', patch => {
    const input = fixture();
    expect(evaluateProduct({ ...input, relationships: [{ ...input.relationships[0]!, ...patch }] }))
      .toMatchObject({ result: 'UNKNOWN', reason: 'unresolved_legal_entity' });
  });

  it.each(['human_verified', 'auto_verified'])('accepts %s at confidence and inclusive validity boundaries', status => {
    const input = fixture();
    expect(evaluateProduct({ ...input, relationships: [{ ...input.relationships[0]!, verification_status: status,
      confidence: 0.9, valid_from: input.as_of, valid_to: input.as_of }] }).result).toBe('PASS');
  });

  it.each(['another-entity', 'demo-entity-1'])('refuses multiple eligible relationships, including duplicate targets', target => {
    const input = fixture();
    expect(evaluateProduct({ ...input, relationships: [...input.relationships,
      { ...input.relationships[0]!, id: 'second-link', legal_entity_id: target }] }))
      .toMatchObject({ result: 'UNKNOWN', reason: 'ambiguous_legal_entity', legal_entity_id: null });
  });

  it('does not count ineligible links as ambiguous', () => {
    const input = fixture();
    expect(evaluateProduct({ ...input, relationships: [...input.relationships,
      { ...input.relationships[0]!, id: 'candidate', verification_status: 'candidate' }] }).result).toBe('PASS');
  });

  it('selects the latest verified period regardless of input order', () => {
    const input = fixture();
    const older = { ...input.evidence[0]!, id: 'older', reporting_period: '2024-25', value_numeric: -10 };
    const latest = { ...input.evidence[0]!, id: 'latest', value_numeric: 18.95 };
    for (const evidence of [[older, latest], [latest, older]]) {
      expect(evaluateProduct({ ...input, evidence }))
        .toMatchObject({ result: 'FAIL', observed_value: 18.95, reporting_period: '2025-26', evidence_id: 'latest' });
    }
  });

  it('ignores newer unverified evidence and irrelevant claims', () => {
    const input = fixture();
    const candidate = { ...input.evidence[0]!, id: 'candidate', reporting_period: '2026-27', verification_status: 'candidate' };
    expect(evaluateProduct({ ...input, evidence: [candidate, ...input.evidence,
      { ...input.evidence[0]!, legal_entity_id: 'unrelated' }, { ...input.evidence[0]!, claim_type: 'unrelated' }] }))
      .toMatchObject({ result: 'PASS', evidence_id: 'demo-evidence-1', reporting_period: '2025-26' });
    expect(evaluateProduct({ ...input, evidence: [candidate] })).toMatchObject({ result: 'UNKNOWN', reason: 'unverified_evidence' });
  });

  it('does not fall back to an older PASS when latest evidence is invalid', () => {
    const input = fixture();
    expect(evaluateProduct({ ...input, evidence: [...input.evidence,
      { ...input.evidence[0]!, id: 'latest-invalid', reporting_period: '2026-27', value_numeric: null }] }))
      .toMatchObject({ result: 'UNKNOWN', reason: 'invalid_evidence', evidence_id: 'latest-invalid' });
  });

  it('does not guess when periods cannot be ranked or latest claims tie', () => {
    const input = fixture();
    expect(evaluateProduct({ ...input, evidence: [...input.evidence,
      { ...input.evidence[0]!, id: 'malformed', reporting_period: null }] }))
      .toMatchObject({ result: 'UNKNOWN', reason: 'invalid_evidence' });
    expect(evaluateProduct({ ...input, evidence: [...input.evidence,
      { ...input.evidence[0]!, id: 'duplicate', value_numeric: 18.95 }] }))
      .toMatchObject({ result: 'UNKNOWN', reason: 'ambiguous_evidence' });
  });

  it('is deterministic and leaves inputs unchanged', () => {
    const input = fixture();
    const before = structuredClone(input);
    expect(evaluateProduct(input)).toEqual(evaluateProduct(input));
    expect(input).toEqual(before);
    expect(evaluateProduct({ ...input, as_of: '2026-02-30' }))
      .toMatchObject({ result: 'UNKNOWN', reason: 'invalid_evaluation_date' });
  });
});
