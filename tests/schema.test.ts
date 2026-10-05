import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const productId = '00000000-0000-0000-0000-000000000001';
const brandId = '00000000-0000-0000-0000-000000000002';
const entityId = '00000000-0000-0000-0000-000000000003';
const policyId = '00000000-0000-0000-0000-000000000004';
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  const migration = await readFile(new URL('../supabase/migrations/0001_initial_schema.sql', import.meta.url), 'utf8');
  await db.exec(migration);
}, 30_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec('TRUNCATE legal_entities, brands, products, policies CASCADE');
  await db.query('INSERT INTO brands (id, canonical_name) VALUES ($1, $2)', [brandId, 'Example brand']);
  await db.query('INSERT INTO legal_entities (id, canonical_name, jurisdiction) VALUES ($1, $2, $3)', [entityId, 'Example Ltd', 'GB']);
  await db.query('INSERT INTO products (id, canonical_name, brand_id) VALUES ($1, $2, $3)', [productId, 'Example product', brandId]);
  await db.query('INSERT INTO policies (id, name) VALUES ($1, $2)', [policyId, 'Example policy']);
});

function insertEvidence(subjects: (string | null)[], confidence = 0.8, status = 'candidate') {
  return db.query(`INSERT INTO evidence
    (product_id, brand_id, legal_entity_id, claim_type, value_numeric, source_name, source_url, source_type, confidence, verification_status)
    VALUES ($1, $2, $3, 'uk_median_gender_pay_gap', 8.5, 'Example report', 'https://example.test/report', 'report', $4, $5)`,
  [...subjects, confidence, status]);
}

describe('initial migration', () => {
  it('creates all ten application tables', async () => {
    const { rows } = await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    expect(rows.map(row => row.tablename).sort()).toEqual([
      'brand_entity_relationships', 'brands', 'evaluations', 'evidence', 'legal_entities',
      'legal_entity_relationships', 'offers', 'policies', 'policy_rules', 'products',
    ]);
  });

  it('requires exactly one evidence subject and permits each subject type', async () => {
    for (const subjects of [[productId, null, null], [null, brandId, null], [null, null, entityId]]) {
      await insertEvidence(subjects);
    }
    await expect(insertEvidence([null, null, null])).rejects.toMatchObject({ code: '23514' });
    await expect(insertEvidence([productId, brandId, null])).rejects.toMatchObject({ code: '23514' });
    await expect(insertEvidence([productId, brandId, entityId])).rejects.toMatchObject({ code: '23514' });
  });

  it('bounds confidence and checks verification status', async () => {
    for (const confidence of [0, 1]) await insertEvidence([productId, null, null], confidence);
    for (const confidence of [-0.01, 1.01]) {
      await expect(insertEvidence([productId, null, null], confidence)).rejects.toMatchObject({ code: '23514' });
    }
    for (const status of ['candidate', 'human_verified', 'auto_verified', 'rejected']) {
      await insertEvidence([productId, null, null], 0.5, status);
    }
    await expect(insertEvidence([productId, null, null], 0.5, 'invalid')).rejects.toMatchObject({ code: '23514' });
  });

  it('requires one typed factual value and preserves false boolean values', async () => {
    await insertEvidence([productId, null, null]);
    await expect(db.exec('UPDATE evidence SET value_numeric = NULL')).rejects.toMatchObject({ code: '23514' });
    await expect(db.exec("UPDATE evidence SET value_text = 'ambiguous'")).rejects.toMatchObject({ code: '23514' });
    await db.exec('UPDATE evidence SET value_numeric = NULL, value_boolean = false');
    const { rows } = await db.query<{ value_boolean: boolean }>('SELECT value_boolean FROM evidence');
    expect(rows[0]?.value_boolean).toBe(false);
  });

  it('enforces company identifiers only when supplied', async () => {
    await db.exec(`INSERT INTO legal_entities (canonical_name, jurisdiction, company_number, lei) VALUES
      ('One', 'GB', '00123456', 'EXAMPLE-LEI'), ('Two', 'FR', '00123456', NULL),
      ('Three', 'GB', NULL, NULL), ('Four', 'GB', NULL, NULL)`);
    await expect(db.exec("INSERT INTO legal_entities (canonical_name, jurisdiction, company_number) VALUES ('Duplicate', 'GB', '00123456')"))
      .rejects.toMatchObject({ code: '23505' });
    await expect(db.exec("INSERT INTO legal_entities (canonical_name, jurisdiction, lei) VALUES ('Duplicate', 'FR', 'EXAMPLE-LEI')"))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('enforces unique supplied GTINs while allowing unknown identifiers', async () => {
    await db.exec("INSERT INTO products (canonical_name, gtin) VALUES ('One', '00012345678905'), ('Two', NULL), ('Three', NULL)");
    await expect(db.exec("INSERT INTO products (canonical_name, gtin) VALUES ('Duplicate', '00012345678905')"))
      .rejects.toMatchObject({ code: '23505' });
    await expect(db.exec("INSERT INTO products (canonical_name, gtin) VALUES ('Invalid', 'abc')"))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('rejects self-parenting legal entities', async () => {
    await expect(db.query(`INSERT INTO legal_entity_relationships
      (child_legal_entity_id, parent_legal_entity_id, relationship_type, source_name, source_url, confidence)
      VALUES ($1, $1, 'subsidiary_of', 'Report', 'https://example.test', 1)`, [entityId]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('rejects reversed relationship dates and accepts a valid brand relationship', async () => {
    const sql = `INSERT INTO brand_entity_relationships
      (brand_id, legal_entity_id, relationship_type, source_name, source_url, confidence, valid_from, valid_to)
      VALUES ($1, $2, 'owned_by', 'Report', 'https://example.test', $3, '2026-01-01', $4)`;
    await expect(db.query(sql, [brandId, entityId, 0.8, '2025-01-01'])).rejects.toMatchObject({ code: '23514' });
    await expect(db.query(sql, [brandId, entityId, 1.1, null])).rejects.toMatchObject({ code: '23514' });
    await db.query(sql, [brandId, entityId, 0.8, null]);
  });

  it('allows multiple retailer offers per product and rejects negative prices', async () => {
    const sql = `INSERT INTO offers (product_id, retailer_name, url, price)
      VALUES ($1, $2, 'https://example.test/product', $3)`;
    await db.query(sql, [productId, 'Retailer A', 10]);
    await db.query(sql, [productId, 'Retailer B', null]);
    await expect(db.query(sql, [productId, 'Retailer C', -1])).rejects.toMatchObject({ code: '23514' });
    const { rows } = await db.query<{ currency: string }>('SELECT currency FROM offers');
    expect(rows.map(row => row.currency)).toEqual(['GBP', 'GBP']);
  });

  it('represents the first rule and defaults missing evidence handling to UNKNOWN', async () => {
    const { rows } = await db.query<{ unknown_handling: string; action: string }>(`INSERT INTO policy_rules
      (policy_id, criterion, operator, threshold_numeric)
      VALUES ($1, 'uk_median_gender_pay_gap', '<=', 10) RETURNING unknown_handling, action`, [policyId]);
    expect(rows[0]).toEqual({ unknown_handling: 'UNKNOWN', action: 'REQUIRE' });
    await expect(db.exec("UPDATE policy_rules SET unknown_handling = 'PASS'")).rejects.toMatchObject({ code: '23514' });
    await expect(db.exec('UPDATE policy_rules SET threshold_numeric = NULL')).rejects.toMatchObject({ code: '23514' });
    await expect(db.exec("UPDATE policy_rules SET threshold_text = 'ten'")).rejects.toMatchObject({ code: '23514' });
  });

  it('defaults evaluations to UNKNOWN and supports all requested outcomes', async () => {
    const { rows } = await db.query<{ overall_status: string }>(`INSERT INTO evaluations (product_id, policy_id)
      VALUES ($1, $2) RETURNING overall_status`, [productId, policyId]);
    expect(rows[0]?.overall_status).toBe('UNKNOWN');
    for (const status of ['PASS', 'FAIL', 'UNKNOWN', 'PREFER']) {
      await db.query('UPDATE evaluations SET overall_status = $1', [status]);
    }
    await expect(db.exec("UPDATE evaluations SET overall_status = 'INVALID'")).rejects.toMatchObject({ code: '23514' });
  });

  it('enforces foreign keys and prevents deletion of referenced evidence subjects', async () => {
    await expect(insertEvidence(['00000000-0000-0000-0000-000000000099', null, null]))
      .rejects.toMatchObject({ code: '23503' });
    await insertEvidence([productId, null, null]);
    await expect(db.query('DELETE FROM products WHERE id = $1', [productId])).rejects.toMatchObject({ code: '23503' });
  });

  it('updates modification timestamps automatically', async () => {
    await db.exec("INSERT INTO brands (canonical_name, updated_at) VALUES ('Old name', '2000-01-01')");
    const { rows } = await db.query<{ refreshed: boolean }>(`UPDATE brands SET canonical_name = 'New name'
      WHERE canonical_name = 'Old name' RETURNING updated_at > '2000-01-01'::timestamptz AS refreshed`);
    expect(rows[0]?.refreshed).toBe(true);
  });
});
