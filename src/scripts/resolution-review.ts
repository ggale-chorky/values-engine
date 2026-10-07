import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createResolutionReviewStore } from '../review/resolution-review.js';
import type { ResolutionReviewStore } from '../review/resolution-review.js';
import { configuredClient, isMain, reportCliError } from './db-cli.js';

/** Parsing happens before reading env or constructing a server client. Import is inert. */
export async function main(args: string[], dependencies: { store?: ResolutionReviewStore; log?: (text: string) => void } = {}) {
  const [command, ...rest] = args;
  if (!['queue', 'approve', 'reject'].includes(command ?? '')) throw new Error('Expected queue, approve or reject.');
  const { values } = parseArgs({ args: rest, strict: true, options: { candidate: { type: 'string' }, note: { type: 'string' } } });
  if (command === 'queue' && (values.candidate !== undefined || values.note !== undefined)) throw new Error('Queue does not accept candidate/note flags.');
  const candidate = command === 'queue' ? null : z.uuid().parse(values.candidate);
  const store = dependencies.store ?? createResolutionReviewStore(await configuredClient());
  const log = dependencies.log ?? console.log;
  if (command === 'queue') {
    for (const row of await store.queue()) log(JSON.stringify({ candidate_id: row.id, brand: row.resolution_runs.brand_name,
      action: row.recommended_action, run_action: row.resolution_runs.overall_action, legal_entity: row.candidate_legal_name,
      company_number: row.company_number, role: row.relationship_type, source_url: row.source_url,
      reason: row.reason, run_reason: row.resolution_runs.reason }));
  } else {
    const id = await (command === 'approve' ? store.approve(candidate!, values.note) : store.reject(candidate!, values.note));
    log(JSON.stringify({ candidate_id: candidate, review_status: command === 'approve' ? 'approved' : 'rejected',
      ...(command === 'approve' ? { relationship_id: id } : {}) }));
  }
}
if (isMain(import.meta.url)) main(process.argv.slice(2)).catch(reportCliError);
