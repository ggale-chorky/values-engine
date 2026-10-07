import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { DatabaseError } from '../db/database.js';

const rowSchema = z.object({
  id: z.uuid(), relationship_type: z.string().min(1), source_url: z.string(),
  verification_status: z.literal('human_verified'), last_verified_at: z.string().nullable(),
  brands: z.object({ canonical_name: z.string() }),
  legal_entities: z.object({ canonical_name: z.string(), company_number: z.string().nullable(), jurisdiction: z.string().min(1) }),
});
export interface VerifiedRelationship {
  relationship_id: string;
  brand: string;
  legal_entity: string;
  company_number: string | null;
  jurisdiction: string;
  relationship_type: string;
  source_url: string;
  verification_status: 'human_verified';
  last_verified_at: string | null;
}

/** Read-only GET queries; no RPC, insert, update or approval capability. */
export async function listVerifiedRelationships(client: SupabaseClient): Promise<VerifiedRelationship[]> {
  const rows: VerifiedRelationship[] = [];
  const seen = new Set<string>();
  for (;;) {
    let page: z.infer<typeof rowSchema>[];
    try {
      const { data, error } = await client.from('brand_entity_relationships')
        .select('id,relationship_type,source_url,verification_status,last_verified_at,brands!inner(canonical_name),legal_entities!inner(canonical_name,company_number,jurisdiction)')
        .eq('verification_status', 'human_verified').order('id').range(rows.length, rows.length + 199);
      if (error) throw error;
      page = z.array(rowSchema).parse(data);
    } catch { throw new DatabaseError('Could not read human-verified relationships.'); }
    if (!page.length) {
      // Sort across all pages; keep ID pagination unchanged. Use locale-independent
      // brand-name ordering with relationship ID as a deterministic tie-breaker.
      const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
      return rows.sort((a, b) => compare(a.brand, b.brand) || compare(a.relationship_id, b.relationship_id));
    }
    for (const row of page) {
      if (seen.has(row.id)) throw new DatabaseError('Unstable pagination while reading human-verified relationships.');
      seen.add(row.id);
      rows.push({ relationship_id: row.id, brand: row.brands.canonical_name, legal_entity: row.legal_entities.canonical_name,
        company_number: row.legal_entities.company_number, jurisdiction: row.legal_entities.jurisdiction, relationship_type: row.relationship_type, source_url: row.source_url,
        verification_status: row.verification_status, last_verified_at: row.last_verified_at });
    }
  }
}
