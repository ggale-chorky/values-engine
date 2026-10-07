import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  for (const file of ['0001_initial_schema.sql', '0004_atomic_policy_creation.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
  }
}, 30_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('TRUNCATE policies CASCADE'); });

async function expectEmpty() {
  expect((await db.query('SELECT * FROM policies')).rows).toEqual([]);
  expect((await db.query('SELECT * FROM policy_rules')).rows).toEqual([]);
}
it('atomically creates one active policy and exactly one fixed rule, returning both IDs', async () => {
  const { rows } = await db.query<{ policy_id: string; rule_id: string }>('SELECT * FROM create_gender_pay_policy($1, $2)', [' Personal ', '-0.7']);
  expect(rows).toHaveLength(1);
  expect((await db.query('SELECT id, name, is_active FROM policies')).rows).toEqual([{ id: rows[0]!.policy_id, name: 'Personal', is_active: true }]);
  expect((await db.query('SELECT id, policy_id, criterion, operator, threshold_numeric, threshold_text, action, unknown_handling FROM policy_rules')).rows)
    .toEqual([{ id: rows[0]!.rule_id, policy_id: rows[0]!.policy_id, criterion: 'uk_median_gender_pay_gap', operator: '<=', threshold_numeric: '-0.7', threshold_text: null, action: 'REQUIRE', unknown_handling: 'UNKNOWN' }]);
});
it.each([null, '', ' ', '\t\n'])('rejects empty database policy name %j', async name => {
  await expect(db.query('SELECT * FROM create_gender_pay_policy($1, 10)', [name])).rejects.toThrow();
  await expectEmpty();
});
it.each([null, 'NaN', 'Infinity', '-Infinity'])('rejects invalid database threshold %j', async value => {
  await expect(db.query('SELECT * FROM create_gender_pay_policy($1, $2)', ['Policy', value])).rejects.toThrow();
  await expectEmpty();
});
it.each(['policy_rules', 'policies'])('rolls back both rows when %s fails after initial insertion', async table => {
  // Rule insert failure and final activation failure exercise both rollback boundaries.
  await db.exec(`CREATE FUNCTION fail_policy_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected failure'; END; $$;
    CREATE TRIGGER fail_policy_test BEFORE ${table === 'policies' ? 'UPDATE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_policy_test();`);
  try {
    await expect(db.query("SELECT * FROM create_gender_pay_policy('Policy', 10)")).rejects.toThrow('Injected failure');
    await expectEmpty();
  } finally {
    await db.exec(`DROP TRIGGER fail_policy_test ON ${table}; DROP FUNCTION fail_policy_test();`);
  }
});
it('does not grant PUBLIC execution of the creation function', async () => {
  const { rows } = await db.query<{ allowed: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM pg_proc p, LATERAL aclexplode(p.proacl) a
    WHERE p.proname = 'create_gender_pay_policy' AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) AS allowed`);
  expect(rows[0]!.allowed).toBe(false);
});
