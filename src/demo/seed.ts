import { randomUUID } from 'node:crypto';
import type { ReadDatabase, Row, SeedTable, WriteDatabase } from '../db/database.js';
import { assertSupportedRule, DataError, entityRow, evidenceRow, oneOrNone, parseRows, ruleRow } from '../db/rows.js';
import { evaluateProduct } from '../evaluation/evaluate-product.js';
import { DEMO_CATALOG, DEMO_POLICY_NAME, DEMO_RULE } from './catalog.js';

interface Operation { table: SeedTable; id: string; action: 'create' | 'reuse'; changes: Row }

/** Full read-only preflight; no database writer is available to this function. */
export async function planDemoSeed(db: ReadDatabase, now: string) {
  if (!Number.isFinite(Date.parse(now))) throw new DataError('Invalid seed timestamp.');
  const operations: Operation[] = [];
  function plan(table: SeedTable, existing: Row | null, desired: Row) {
    const id = existing ? existing.id : randomUUID();
    if (typeof id !== 'string') throw new DataError(`Missing ID for ${table}.`);
    const changes = Object.fromEntries(Object.entries(desired).filter(([key, value]) => !existing || existing[key] !== value));
    const operation: Operation = { table, id, action: existing ? 'reuse' : 'create', changes };
    operations.push(operation);
    return { id, action: operation.action, would_update: existing !== null && Object.keys(changes).length > 0 };
  }
  const items = [];
  for (const item of DEMO_CATALOG) {
    const entity = oneOrNone(await db.read('legal_entities', { jurisdiction: 'GB', company_number: item.company_number }),
      `legal entity ${item.company_number}`);
    const parsedEntity = entity ? parseRows(entityRow, [entity], 'legal entity')[0]! : null;
    const existingBrand = oneOrNone(await db.read('brands', { canonical_name: item.brand }), `brand ${item.brand}`);
    const brand = plan('brands', existingBrand, { canonical_name: item.brand });
    const links = existingBrand ? await db.read('brand_entity_relationships', { brand_id: brand.id }) : [];
    const existingLink = oneOrNone(links, `relationships for ${item.brand}`);
    if (existingLink && (existingLink.legal_entity_id !== parsedEntity?.id || existingLink.relationship_type !== 'operated_by')) {
      throw new DataError(`Conflicting relationship for ${item.brand}; resolve it before seeding.`);
    }
    const relationship = parsedEntity ? plan('brand_entity_relationships', existingLink, {
      brand_id: brand.id, legal_entity_id: parsedEntity.id, relationship_type: 'operated_by',
      confidence: 1, verification_status: 'human_verified', source_name: item.source_name, source_url: item.source_url,
      valid_from: null, valid_to: null, last_verified_at: now,
    }) : { id: null, action: 'blocked', would_update: false };
    // Match by exact name first and reject another brand, rather than duplicating it.
    const existingProduct = oneOrNone(await db.read('products', { canonical_name: item.product }), `product ${item.product}`);
    if (existingProduct && existingProduct.brand_id !== brand.id) throw new DataError(`Conflicting product brand for ${item.product}.`);
    const product = plan('products', existingProduct, { canonical_name: item.product, brand_id: brand.id });
    let latestEvidence = null;
    if (parsedEntity) {
      const evidence = parseRows(evidenceRow, await db.read('evidence', {
        legal_entity_id: parsedEntity.id, claim_type: DEMO_RULE.criterion,
      }), 'evidence');
      // Reuse the pure engine to summarise latest evidence under the proposed link.
      // This preview does not claim that the relationship has already been saved.
      latestEvidence = evaluateProduct({
        product: { id: product.id, brand_id: brand.id }, brands: [{ id: brand.id, canonical_name: item.brand }],
        legal_entities: [parsedEntity], relationships: [{ id: relationship.id!, brand_id: brand.id,
          legal_entity_id: parsedEntity.id, relationship_type: 'operated_by', confidence: 1,
          verification_status: 'human_verified', valid_from: null, valid_to: null }],
        evidence, rule: DEMO_RULE, as_of: now.slice(0, 10),
      });
    }
    items.push({ brand_name: item.brand, product_name: item.product, company_number: item.company_number,
      legal_entity_found: parsedEntity !== null, legal_entity: parsedEntity,
      latest_evidence_under_proposed_relationship: latestEvidence, brand, relationship, product });
  }
  const existingPolicy = oneOrNone(await db.read('policies', { name: DEMO_POLICY_NAME }), 'demo policy');
  if (existingPolicy && existingPolicy.user_id !== null) throw new DataError('Demo policy name belongs to a user-specific policy.');
  const policy = plan('policies', existingPolicy, { name: DEMO_POLICY_NAME, user_id: null, is_active: true });
  const existingRule = existingPolicy ? oneOrNone(await db.read('policy_rules', { policy_id: policy.id }), 'demo policy rules') : null;
  if (existingRule) assertSupportedRule(parseRows(ruleRow, [existingRule], 'policy rule')[0]!);
  const rule = plan('policy_rules', existingRule, { policy_id: policy.id, ...DEMO_RULE });
  return { ready: items.every(item => item.legal_entity_found), items, policy, rule, operations };
}

export async function seedDemo(db: WriteDatabase, now: string) {
  const plan = await planDemoSeed(db, now);
  if (!plan.ready) {
    const missing = plan.items.filter(item => !item.legal_entity_found).map(item => item.company_number).join(', ');
    throw new DataError(`Required imported legal entities are missing: ${missing}. No writes performed.`);
  }
  // Run a single seeder at a time: lookup-before-write is not a database lock.
  for (const operation of plan.operations) {
    if (operation.action === 'create') await db.insert(operation.table, { id: operation.id, ...operation.changes });
    else if (Object.keys(operation.changes).length) await db.update(operation.table, operation.id, operation.changes);
  }
  return plan;
}
