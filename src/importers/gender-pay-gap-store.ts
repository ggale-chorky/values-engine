import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { ImportPlan } from './gender-pay-gap.js';

const entityResponse = z.array(z.object({ id: z.uuid(), company_number: z.string() }));

export async function writeImport(plan: ImportPlan): Promise<void> {
  // This module is loaded only for a non-dry run. Never log configuration or
  // upstream errors, which could contain request details or credentials.
  const { config } = await import('dotenv');
  config({ quiet: true });
  const url = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) throw new Error('Live import requires SUPABASE_URL and SUPABASE_SECRET_KEY.');
  const client = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const ids = new Map<string, string>();
  // Bound returning rows below the standard PostgREST response limit.
  const batchSize = 200;
  for (let offset = 0; offset < plan.entities.length; offset += batchSize) {
    const batch = plan.entities.slice(offset, offset + batchSize);
    const { data, error } = await client.from('legal_entities')
      .upsert(batch, { onConflict: 'jurisdiction,company_number' })
      .select('id,company_number');
    if (error) throw new Error('Legal entity upsert failed; prior batches may have completed.');
    const parsed = entityResponse.safeParse(data);
    if (!parsed.success || parsed.data.length !== batch.length) throw new Error('Incomplete legal entity upsert response.');
    for (const row of parsed.data) ids.set(row.company_number, row.id);
  }
  const records = plan.evidence.map(item => {
    const id = ids.get(item.company_number);
    if (!id) throw new Error('Missing legal entity ID; evidence import stopped.');
    return { ...item.record, legal_entity_id: id };
  });
  for (let offset = 0; offset < records.length; offset += batchSize) {
    const { error } = await client.from('evidence').upsert(records.slice(offset, offset + batchSize), {
      onConflict: 'source_name,source_record_id,claim_type,reporting_period',
    });
    if (error) throw new Error('Evidence upsert failed; prior batches may have completed.');
  }
}
