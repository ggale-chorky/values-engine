import type { ReadDatabase } from '../db/database.js';
import { DataError, requiredOne } from '../db/rows.js';
import { evaluateProductFromDb } from '../evaluation/evaluate-product-from-db.js';
import { DEMO_CATALOG, DEMO_POLICY_NAME } from './catalog.js';

export async function evaluateDemoFromDb(db: ReadDatabase, asOf: string) {
  const policy = requiredOne(await db.read('policies', { name: DEMO_POLICY_NAME, user_id: null }), 'demo policy');
  if (typeof policy.id !== 'string') throw new DataError('Invalid demo policy ID.');
  const results = [];
  for (const item of DEMO_CATALOG) {
    const brand = requiredOne(await db.read('brands', { canonical_name: item.brand }), `brand ${item.brand}`);
    if (typeof brand.id !== 'string') throw new DataError('Invalid demo brand ID.');
    const product = requiredOne(await db.read('products', { canonical_name: item.product, brand_id: brand.id }), `product ${item.product}`);
    if (typeof product.id !== 'string') throw new DataError('Invalid demo product ID.');
    const result = await evaluateProductFromDb(db, product.id, policy.id, asOf);
    results.push({ product: item.product, product_id: product.id, brand: result.brand?.canonical_name ?? null,
      legal_entity: result.legal_entity?.canonical_name ?? null, legal_entity_id: result.legal_entity_id,
      company_number: result.legal_entity?.company_number ?? null, observed_value: result.observed_value,
      threshold: result.threshold, reporting_period: result.reporting_period, result: result.result, reason: result.reason,
      evidence_id: result.evidence_id, evidence_source: result.evidence_source });
  }
  return results;
}
