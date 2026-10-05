import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(await readFile(new URL('../supabase/migrations/0001_initial_schema.sql', import.meta.url), 'utf8'));
  // Reproduce the predicate-free ON CONFLICT used by PostgREST before the fix.
  await expect(db.exec(`INSERT INTO legal_entities (canonical_name, jurisdiction, company_number)
    VALUES ('Old Ltd', 'GB', '00000001') ON CONFLICT (jurisdiction, company_number)
    DO UPDATE SET canonical_name = EXCLUDED.canonical_name`)).rejects.toMatchObject({ code: '42P10' });
  await db.exec(`INSERT INTO legal_entities (canonical_name, jurisdiction, company_number) VALUES ('Old Ltd', 'GB', '00000001');
    INSERT INTO evidence (legal_entity_id, claim_type, value_numeric, source_name, source_url, source_type, confidence)
    SELECT id, 'legacy_claim', 1, 'Legacy source', 'https://example.test', 'report', 1 FROM legal_entities;`);
  await db.exec(await readFile(new URL('../supabase/migrations/0002_evidence_source_identity.sql', import.meta.url), 'utf8'));
  const legacy = await db.query<{ source_record_id: string | null }>('SELECT source_record_id FROM evidence');
  expect(legacy.rows).toEqual([{ source_record_id: null }]);
}, 30_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('TRUNCATE legal_entities CASCADE'); });

async function entity(name = 'Example Ltd') {
  const result = await db.query<{ id: string }>(`INSERT INTO legal_entities (canonical_name, jurisdiction, company_number)
    VALUES ($1, 'GB', '00123456') ON CONFLICT (jurisdiction, company_number)
    DO UPDATE SET canonical_name = EXCLUDED.canonical_name RETURNING id`, [name]);
  return result.rows[0]!.id;
}

async function claim(id: string, recordId: string | null = '123', period: string | null = '2025-26', value = 5,
  source = 'UK Gender Pay Gap Service', type = 'uk_median_gender_pay_gap') {
  return db.query<{ id: string }>(`INSERT INTO evidence (legal_entity_id, claim_type, value_numeric, source_name,
    source_url, source_type, confidence, source_record_id, reporting_period)
    VALUES ($1, $2, $3, $4, 'https://example.test', 'government', 1, $5, $6)
    ON CONFLICT (source_name, source_record_id, claim_type, reporting_period)
    DO UPDATE SET value_numeric = EXCLUDED.value_numeric RETURNING id`, [id, type, value, source, recordId, period]);
}

it('upserts company identity with a stable UUID and allows multiple NULL numbers', async () => {
  const id = await entity();
  expect(await entity('Renamed Ltd')).toBe(id);
  await db.exec(`INSERT INTO legal_entities (canonical_name, jurisdiction, company_number)
    VALUES ('Unknown one', 'GB', NULL), ('Unknown two', 'GB', NULL), ('French entity', 'FR', '00123456')`);
  const result = await db.query<{ canonical_name: string }>('SELECT canonical_name FROM legal_entities WHERE id = $1', [id]);
  expect(result.rows[0]?.canonical_name).toBe('Renamed Ltd');
});

it('reimports evidence without duplicates and updates the reported value', async () => {
  const id = await entity();
  const first = await claim(id);
  const again = await claim(id, '123', '2025-26', -2.5);
  expect(again.rows[0]?.id).toBe(first.rows[0]?.id);
  const result = await db.query<{ value_numeric: string }>('SELECT value_numeric FROM evidence');
  expect(result.rows).toEqual([{ value_numeric: '-2.5' }]);
});

it('distinguishes source, employer, claim and reporting period', async () => {
  const id = await entity();
  await claim(id);
  await claim(id, '456');
  await claim(id, '123', '2024-25');
  await claim(id, '123', '2025-26', 5, 'Other source');
  await claim(id, '123', '2025-26', 5, 'UK Gender Pay Gap Service', 'other_claim');
  const result = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM evidence');
  expect(result.rows[0]?.count).toBe(5);
});

it('preserves claims without source identity and rejects empty source record IDs', async () => {
  const id = await entity();
  await claim(id, null, null);
  await claim(id, null, null);
  const result = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM evidence');
  expect(result.rows[0]?.count).toBe(2);
  await expect(claim(id, ' ')).rejects.toMatchObject({ code: '23514' });
});
