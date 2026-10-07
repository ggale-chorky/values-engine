import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

export interface PolicyCreator {
  create(name: string, threshold: number): Promise<{ policy_id: string; rule_id: string }>;
}

/** Only exposes the fixed policy-creation RPC; no table mutations or retries. */
export function createPolicyCreator(client: SupabaseClient): PolicyCreator {
  return {
    async create(name, threshold) {
      const { data, error } = await client.rpc('create_gender_pay_policy', { p_name: name, p_threshold: threshold });
      if (error) throw new Error('Policy RPC failed.');
      const rows = z.array(z.object({ policy_id: z.uuid(), rule_id: z.uuid() })).length(1).parse(data);
      return rows[0]!;
    },
  };
}
