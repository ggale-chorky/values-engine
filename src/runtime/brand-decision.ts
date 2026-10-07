import { createReadDatabase } from '../db/database.js';
import { evaluateBrandDecision } from '../decision/evaluate-brand-decision.js';
import { configuredClient } from '../scripts/db-cli.js';

/** Lazy server composition: imports/startup do not read secrets or query a database. */
export async function configuredBrandDecision(input: { brand: string; policy: string }) {
  const db = createReadDatabase(await configuredClient());
  return evaluateBrandDecision(input, { db });
}
