import { annotateFailure } from './mcp-diagnostics.js';
import type { RuntimeDiagnostic } from './mcp-diagnostics.js';
import { createReadDatabase } from '../db/database.js';
import { evaluateBrandDecision } from '../decision/evaluate-brand-decision.js';
import { configuredClient } from '../scripts/db-cli.js';

/** Lazy server composition: imports/startup do not read secrets or query a database. */
export async function configuredBrandDecision(input: { brand: string; policy: string }) {
  let details: RuntimeDiagnostic = { stage: 'runtime_init' };
  try {
    const db = createReadDatabase(await configuredClient(presence => { details = { ...presence }; }));
    details.stage = 'decision_service';
    return await evaluateBrandDecision(input, { db: {
      read(table, filters) {
        // Observe existing reads only. No additional queries or decision logic.
        details.stage = table === 'policies' || table === 'policy_rules' ? 'policy_lookup' : 'brand_evaluation';
        return db.read(table, filters);
      },
    } });
  } catch (error) {
    annotateFailure(error, details);
    throw error;
  }
}
