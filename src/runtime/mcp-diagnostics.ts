import { DataError } from '../db/rows.js';
import { DatabaseError } from '../db/database.js';

export type FailureStage = 'runtime_init' | 'policy_lookup' | 'brand_evaluation' | 'decision_service' | 'mcp_handler' | 'response_serialization';
export interface RuntimeDiagnostic {
  stage: FailureStage;
  supabase_url_present?: boolean;
  supabase_secret_key_present?: boolean;
}
const context = new WeakMap<object, RuntimeDiagnostic>();
export function annotateFailure(error: unknown, details: RuntimeDiagnostic) {
  if (typeof error === 'object' && error !== null && !context.has(error)) context.set(error, details);
}
const safeMessages = new Set([
  'Database configuration requires valid SUPABASE_URL and SUPABASE_SECRET_KEY.',
  'Policy not found.', 'Ambiguous policy name; select by UUID.', 'Policy name or UUID is required.',
  'Brand and policy are required.', 'Unexpected evaluation reason.', 'Unexpected UNKNOWN decision reason.',
]);
const tables = ['policies', 'policy_rules', 'brands', 'brand_entity_relationships', 'legal_entities', 'evidence'];
for (const table of tables) {
  safeMessages.add(`Read failed for ${table}.`);
  safeMessages.add(`Invalid or unstable pagination for ${table}.`);
}
for (const label of ['policies', 'brands', 'relationships', 'legal entities', 'evidence']) safeMessages.add(`Invalid database rows for ${label}.`);

/** Only fixed class labels, allowlisted messages and boolean configuration presence leave this boundary. */
export function reportMcpFailure(error: unknown, fallback: FailureStage = 'mcp_handler') {
  if (process.env.VALUES_ENGINE_MCP_DEBUG !== '1') return;
  const details = typeof error === 'object' && error !== null ? context.get(error) : undefined;
  const name = error instanceof DataError ? 'DataError' : error instanceof DatabaseError ? 'DatabaseError'
    : error instanceof TypeError ? 'TypeError' : error instanceof Error ? 'Error' : 'NonError';
  const message = (error instanceof DataError || error instanceof DatabaseError) && safeMessages.has(error.message)
    ? error.message : 'Unexpected failure; details redacted.';
  try { console.error(JSON.stringify({ diagnostic: 'values_engine_mcp_failure', ...details, stage: details?.stage ?? fallback, error_class: name, message })); }
  catch { /* Diagnostics must not change tool outcomes. */ }
}
