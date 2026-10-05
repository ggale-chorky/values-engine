import type { SupabaseClient } from '@supabase/supabase-js';

export type Table = 'products' | 'brands' | 'brand_entity_relationships' | 'legal_entities' | 'evidence' | 'policies' | 'policy_rules';
export type SeedTable = 'products' | 'brands' | 'brand_entity_relationships' | 'policies' | 'policy_rules';
export type Row = Record<string, unknown>;
export type Filters = Record<string, string | number | boolean | null>;
export interface ReadDatabase { read(table: Table, filters: Filters): Promise<Row[]> }
export interface WriteDatabase extends ReadDatabase {
  insert(table: SeedTable, row: Row): Promise<void>;
  update(table: SeedTable, id: string, row: Row): Promise<void>;
}

export class DatabaseError extends Error {}

/** Read-only capability: pagination never silently drops ambiguous links/claims. */
export function createReadDatabase(client: SupabaseClient): ReadDatabase {
  return {
    async read(table, filters) {
      const rows: Row[] = [];
      // Advance by actual response length, tolerating a server page cap below 200.
      for (;;) {
        let query = client.from(table).select('*').order('id').range(rows.length, rows.length + 199);
        for (const [column, value] of Object.entries(filters)) query = value === null ? query.is(column, null) : query.eq(column, value);
        let result;
        try { result = await query; } catch { throw new DatabaseError(`Read failed for ${table}.`); }
        if (result.error || !Array.isArray(result.data)) throw new DatabaseError(`Read failed for ${table}.`);
        const page = result.data as Row[];
        if (page.length === 0) return rows;
        if (page.some(row => typeof row.id !== 'string') || page.some(row => rows.some(previous => previous.id === row.id))) {
          throw new DatabaseError(`Invalid or unstable pagination for ${table}.`);
        }
        rows.push(...page);
      }
    },
  };
}

export function createWriteDatabase(client: SupabaseClient): WriteDatabase {
  return {
    ...createReadDatabase(client),
    async insert(table, row) {
      try {
        const { data, error } = await client.from(table).insert(row).select('id');
        if (error || data?.length !== 1) throw new Error();
      } catch { throw new DatabaseError(`Insert failed for ${table}; earlier writes may have completed.`); }
    },
    async update(table, id, row) {
      try {
        const { data, error } = await client.from(table).update(row).eq('id', id).select('id');
        if (error || data?.length !== 1) throw new Error();
      } catch { throw new DatabaseError(`Update failed for ${table}; earlier writes may have completed.`); }
    },
  };
}
