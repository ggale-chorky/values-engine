import { describe, expect, it } from 'vitest';
import { planDemoSeed, seedDemo } from '../src/demo/seed.js';
import { importedDatabase } from './helpers/fake-database.js';

const now = '2026-10-05T12:00:00.000Z';
describe('demo seed planning and execution', () => {
  it('dry-run reports all existing entities, evidence and planned objects with zero writes', async () => {
    const db = importedDatabase();
    const before = structuredClone(db.tables);
    const plan = await planDemoSeed(db, now);
    expect(plan.ready).toBe(true);
    expect(plan.items.map(item => item.company_number)).toEqual(['08037372', '00659213', '00271555']);
    expect(plan.items.map(item => item.latest_evidence_under_proposed_relationship?.observed_value)).toEqual([-0.7, 10, 18.95]);
    for (const item of plan.items) {
      expect(item.legal_entity_found).toBe(true);
      expect([item.brand.action, item.relationship.action, item.product.action]).toEqual(['create', 'create', 'create']);
    }
    expect([plan.policy.action, plan.rule.action]).toEqual(['create', 'create']);
    expect(db.tables).toEqual(before);
    expect(db.writes).toEqual([]);
  });

  it('reruns reuse IDs for every object and only refresh verification timestamp', async () => {
    const db = importedDatabase();
    const originalEntities = structuredClone(db.tables.legal_entities);
    const originalEvidence = structuredClone(db.tables.evidence);
    await seedDemo(db, now);
    const ids = Object.fromEntries(Object.entries(db.tables).map(([table, rows]) => [table, rows.map(row => row.id)]));
    db.writes = [];
    const preview = await planDemoSeed(db, now);
    expect(preview.operations.every(operation => operation.action === 'reuse')).toBe(true);
    expect(db.writes).toEqual([]);
    await seedDemo(db, '2026-10-06T12:00:00.000Z');
    expect(Object.fromEntries(Object.entries(db.tables).map(([table, rows]) => [table, rows.map(row => row.id)]))).toEqual(ids);
    expect(db.writes).toHaveLength(3);
    expect(db.writes.every(write => write.kind === 'update' && write.table === 'brand_entity_relationships')).toBe(true);
    expect(db.tables.legal_entities).toEqual(originalEntities);
    expect(db.tables.evidence).toEqual(originalEvidence);
    expect(db.tables.products.every(row => row.gtin === undefined && row.mpn === undefined && row.url === undefined)).toBe(true);
    expect(db.tables.brand_entity_relationships.every(row => row.relationship_type === 'operated_by'
      && row.confidence === 1 && row.verification_status === 'human_verified' && typeof row.source_url === 'string')).toBe(true);
  });

  it.each([0, 1, 2])('refuses the entire write plan if required entity %s is missing', async index => {
    const db = importedDatabase();
    db.tables.legal_entities.splice(index, 1);
    const plan = await planDemoSeed(db, now);
    expect(plan.ready).toBe(false);
    expect(plan.items[index]?.relationship.action).toBe('blocked');
    await expect(seedDemo(db, now)).rejects.toThrow('Required imported legal entities are missing');
    expect(db.writes).toEqual([]);
  });

  it('can resume after partial seed interruption without duplicates', async () => {
    const db = importedDatabase();
    db.failAfter = 5;
    await expect(seedDemo(db, now)).rejects.toThrow('Simulated interruption');
    db.failAfter = null;
    await seedDemo(db, now);
    expect(db.tables.brands).toHaveLength(3);
    expect(db.tables.brand_entity_relationships).toHaveLength(3);
    expect(db.tables.products).toHaveLength(3);
    expect(db.tables.policies).toHaveLength(1);
    expect(db.tables.policy_rules).toHaveLength(1);
  });

  it.each(['brands', 'products', 'brand_entity_relationships', 'policies', 'policy_rules'] as const)
    ('refuses duplicate %s before making any writes', async table => {
      const db = importedDatabase();
      await seedDemo(db, now);
      db.writes = [];
      db.tables[table].push({ ...db.tables[table][0]!, id: 'duplicate' });
      await expect(seedDemo(db, now)).rejects.toThrow('Ambiguous');
      expect(db.writes).toEqual([]);
    });

  it('does not overwrite conflicting policy logic', async () => {
    const db = importedDatabase();
    await seedDemo(db, now);
    db.writes = [];
    db.tables.policy_rules[0]!.threshold_numeric = 20;
    await expect(seedDemo(db, now)).rejects.toThrow('Expected exactly one numeric');
    expect(db.writes).toEqual([]);
  });
});
