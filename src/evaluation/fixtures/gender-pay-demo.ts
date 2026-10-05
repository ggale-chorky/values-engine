import type { ProductEvaluationInput } from '../evaluate-product.js';
import type { PolicyRule } from '../types.js';

export const demoRule: PolicyRule = {
  criterion: 'uk_median_gender_pay_gap', operator: '<=', threshold_numeric: 10,
  action: 'REQUIRE', unknown_handling: 'UNKNOWN',
};

// User-supplied examples. IDs, product records and verified links are synthetic
// test data, not assertions of verified real-world product ownership.
export function createDemoFixtures(): { name: string; input: ProductEvaluationInput }[] {
  return [
    { name: 'Charlotte Tilbury', entity: 'CHARLOTTE TILBURY BEAUTY LIMITED', company: '08037372', value: -0.7 },
    { name: 'Estée Lauder', entity: 'ESTEE LAUDER COSMETICS LIMITED', company: '00659213', value: 10 },
    { name: "L'Oréal", entity: "L'OREAL (U.K.) LIMITED", company: '00271555', value: 18.95 },
  ].map((row, index) => {
    const brandId = `demo-brand-${index + 1}`;
    const entityId = `demo-entity-${index + 1}`;
    return {
      name: row.name,
      input: {
        product: { id: `demo-product-${index + 1}`, brand_id: brandId },
        brands: [{ id: brandId, canonical_name: row.name }],
        legal_entities: [{ id: entityId, canonical_name: row.entity, company_number: row.company }],
        relationships: [{ id: `demo-relationship-${index + 1}`, brand_id: brandId, legal_entity_id: entityId,
          relationship_type: 'owned_by', confidence: 1, verification_status: 'human_verified',
          valid_from: null, valid_to: null }],
        evidence: [{ id: `demo-evidence-${index + 1}`, legal_entity_id: entityId,
          claim_type: 'uk_median_gender_pay_gap', value_numeric: row.value, unit: 'percent',
          source_name: 'Local deterministic demo fixture', source_url: `https://example.test/gpg/${index + 1}`,
          reporting_period: '2025-26', confidence: 1, verification_status: 'auto_verified' }],
        rule: { ...demoRule },
        as_of: '2026-10-05',
      },
    };
  });
}
