import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { DataError } from '../db/rows.js';
import { COMPANY_NUMBER_PATTERN } from '../resolution/companies-house.js';
import type { ResolverResult } from '../resolution/resolve-with-discovery.js';

const nonempty = z.string().trim().min(1);
const uuid = z.uuid();
const action = z.enum(['PROPOSE', 'REVIEW', 'UNRESOLVED', 'ERROR']);
const role = z.enum(['seller', 'site_operator', 'brand_operator', 'promoter', 'licensor', 'data_controller', 'service_operator', 'unknown']);
const object = z.record(z.string(), z.unknown());
const candidateSchema = z.object({
  candidate_legal_name: nonempty.nullable(), jurisdiction: z.literal('GB'),
  company_number: z.string().regex(COMPANY_NUMBER_PATTERN).nullable(),
  relationship_type: role, source_url: z.url({ protocol: /^https?$/ }),
  retrieval_channel: z.enum(['direct_http', 'embedded_page_data', 'openai_web_search']),
  recommended_action: action, reason: nonempty, verification: object, provenance: object,
});
const payloadSchema = z.object({
  brand_id: uuid.nullable(), brand_name: nonempty,
  brand_domain: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/),
  target_market: z.literal('GB'), resolver_version: z.literal('V2.4.1'),
  git_commit_sha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  overall_action: action, reason: nonempty, raw_result: object, candidates: z.array(candidateSchema),
});
export type ResolutionPayload = z.infer<typeof payloadSchema>;
export interface IngestResolutionInput {
  /** Stable caller-provided event/run identity; do not use brand/domain alone across new runs. */
  run_key: string;
  brand_id?: string;
  brand_name: string;
  brand_domain: string;
  git_commit_sha?: string;
  result: ResolverResult;
  /** Allows a benchmark's operational ERROR to coexist with the complete resolver output. */
  overall_action?: z.infer<typeof action>;
  reason?: string;
}

/** Pure adapter around an existing result. Never invokes the frozen resolver or registry. */
export function prepareResolution(input: IngestResolutionInput): ResolutionPayload {
  nonempty.parse(input.run_key);
  const candidates = input.result.proposals.filter(p => p.company_number !== null || p.candidate_legal_entity_name !== null)
    .map(p => ({ candidate_legal_name: p.candidate_legal_entity_name, jurisdiction: 'GB', company_number: p.company_number,
      relationship_type: p.inferred_role, source_url: p.source_url, retrieval_channel: p.retrieval_channel,
      recommended_action: p.recommended_action, reason: p.reason, verification: p.verification,
      // Preserve all candidate-level evidence, including source snippets, registry match,
      // excluded/conflicting evidence, raw identifiers and fusion provenance.
      provenance: p }));
  return payloadSchema.parse({ brand_id: input.brand_id ?? null, brand_name: input.brand_name,
    brand_domain: input.brand_domain.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, ''),
    target_market: 'GB', resolver_version: 'V2.4.1', git_commit_sha: input.git_commit_sha ?? null,
    overall_action: input.overall_action ?? input.result.overall.recommended_action,
    reason: input.reason ?? input.result.overall.reason, raw_result: input.result, candidates });
}

const queueSchema = z.object({ id: uuid, candidate_legal_name: z.string().nullable(), company_number: z.string().nullable(),
  relationship_type: role, source_url: z.string(), recommended_action: action, reason: z.string(),
  resolution_runs: z.object({ brand_name: z.string(), overall_action: action, reason: z.string() }) });
export type PendingCandidate = z.infer<typeof queueSchema>;
export interface ResolutionReviewStore {
  ingest(key: string, payload: ResolutionPayload): Promise<string>;
  queue(): Promise<PendingCandidate[]>;
  approve(candidate: string, note?: string): Promise<string>;
  reject(candidate: string, note?: string): Promise<string>;
}

/** Trusted server transport. Mutation is always a single transactional RPC. */
export function createResolutionReviewStore(client: SupabaseClient): ResolutionReviewStore {
  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await client.rpc(name, args);
    if (error) {
      const safeMessages = new Set(['Candidate not found', 'Candidate already rejected',
        'Approved candidate cannot be rejected; graph revocation is a separate action',
        'Role outside UK commerce entity approval scope',
        'Verified GB registry identity and attributable brand source required',
        'Review note required to approve a review/conflict candidate',
        'Ambiguous existing brand; supply brand_id during ingestion', 'Brand domain mismatch',
        'Ambiguous existing relationships; reconcile before approval', 'Ingestion key already used for different input']);
      throw new DataError(safeMessages.has(error.message) ? error.message : `Resolution review ${name} failed; retry with the same run key/candidate ID.`);
    }
    return uuid.parse(data);
  }
  return {
    ingest: (key, payload) => rpc('ingest_resolution_run', { p_key: nonempty.parse(key), p_payload: payloadSchema.parse(payload) }),
    approve: (candidate, note) => rpc('approve_resolution_candidate', { p_candidate: uuid.parse(candidate), p_note: note ?? null }),
    reject: (candidate, note) => rpc('reject_resolution_candidate', { p_candidate: uuid.parse(candidate), p_note: note ?? null }),
    async queue() {
      const rows: PendingCandidate[] = [];
      for (;;) {
        const { data, error } = await client.from('resolution_candidates')
          .select('id,candidate_legal_name,company_number,relationship_type,source_url,recommended_action,reason,resolution_runs!inner(brand_name,overall_action,reason)')
          .eq('review_status', 'pending').order('created_at').order('id').range(rows.length, rows.length + 499);
        if (error) throw new Error('Resolution review queue read failed.');
        const page = z.array(queueSchema).parse(data);
        if (!page.length) return rows;
        rows.push(...page);
      }
    },
  };
}
export async function ingestResolutionResult(store: ResolutionReviewStore, input: IngestResolutionInput): Promise<string> {
  return store.ingest(input.run_key, prepareResolution(input));
}
