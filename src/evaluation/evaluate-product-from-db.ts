import type { ReadDatabase } from '../db/database.js';
import { assertSupportedRule, brandRow, DataError, entityRow, evidenceRow, parseRows, policyRow, productRow,
  relationshipRow, requiredOne, ruleRow } from '../db/rows.js';
import { evaluateProduct } from './evaluate-product.js';
import type { ProductEvaluationInput } from './evaluate-product.js';

export async function loadEvaluationInput(db: ReadDatabase, productId: string, policyId: string, asOf: string) {
  const policy = parseRows(policyRow, [requiredOne(await db.read('policies', { id: policyId }), 'policy')], 'policy')[0]!;
  if (!policy.is_active) throw new DataError('Policy must be active.');
  const rules = parseRows(ruleRow, await db.read('policy_rules', { policy_id: policyId }), 'policy rules');
  if (rules.length !== 1) throw new DataError('Policy must contain exactly one rule.');
  const rule = rules[0]!;
  assertSupportedRule(rule);
  const product = parseRows(productRow, [requiredOne(await db.read('products', { id: productId }), 'product')], 'product')[0]!;
  const brands = product.brand_id ? parseRows(brandRow, await db.read('brands', { id: product.brand_id }), 'brands') : [];
  const relationships = product.brand_id
    ? parseRows(relationshipRow, await db.read('brand_entity_relationships', { brand_id: product.brand_id }), 'relationships') : [];
  const entities = [];
  const evidence = [];
  // Load all links/claims, including candidates: only the pure engine decides eligibility.
  for (const id of new Set(relationships.map(link => link.legal_entity_id))) {
    entities.push(...parseRows(entityRow, await db.read('legal_entities', { id }), 'legal entities'));
    evidence.push(...parseRows(evidenceRow, await db.read('evidence', { legal_entity_id: id, claim_type: rule.criterion }), 'evidence'));
  }
  const input: ProductEvaluationInput = { product, brands, legal_entities: entities, relationships, evidence, rule, as_of: asOf };
  return { input, policy, product };
}

export async function evaluateProductFromDb(db: ReadDatabase, productId: string, policyId: string, asOf: string) {
  const { input, policy, product } = await loadEvaluationInput(db, productId, policyId, asOf);
  const evaluation = evaluateProduct(input);
  return { ...evaluation, policy_id: policy.id, policy: policy.name, product,
    brand: input.brands.find(brand => brand.id === input.product.brand_id) ?? null,
    legal_entity: input.legal_entities.find(entity => entity.id === evaluation.legal_entity_id) ?? null };
}
