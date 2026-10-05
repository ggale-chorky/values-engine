import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCsv, prepareImport, reportingPeriod } from '../importers/gender-pay-gap.js';
import type { ImportPlan } from '../importers/gender-pay-gap.js';

export function parseArgs(args: string[]) {
  let year = 2025;
  let dryRun = false;
  let yearSeen = false;
  for (const arg of args) {
    if (arg === '--dry-run') dryRun = true;
    else if (/^--year=\d{4}$/.test(arg) && !yearSeen) {
      year = Number(arg.slice(7));
      yearSeen = true;
    } else throw new Error('Usage: npm run import:gpg -- --year=2025 [--dry-run]');
  }
  reportingPeriod(year);
  return { year, dryRun };
}

export async function runImport(args: string[], dependencies: {
  fetch?: typeof fetch;
  write?: (plan: ImportPlan) => Promise<void>;
  log?: (message: string) => void;
  now?: () => Date;
} = {}) {
  const { year, dryRun } = parseArgs(args);
  const source = `https://gender-pay-gap.service.gov.uk/viewing/download-data/${year}`;
  const response = await (dependencies.fetch ?? fetch)(source, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Official CSV download failed (HTTP ${response.status}).`);
  const retrievedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const plan = prepareImport(parseCsv(await response.text()), year, retrievedAt);
  const samples = plan.evidence.slice(0, 3).map(item => ({
    legal_entity: plan.entities.find(entity => entity.company_number === item.company_number),
    // The real UUID is resolved from the upsert response only in a live run.
    evidence: { ...item.record, legal_entity_id: null },
    legal_entity_lookup: { jurisdiction: 'GB', company_number: item.company_number },
  }));
  const log = dependencies.log ?? console.log;
  log(JSON.stringify({ mode: dryRun ? 'dry-run' : 'live', source, reporting_period: reportingPeriod(year),
    retrieved_at: retrievedAt, ...plan.statistics, samples }, null, 2));
  if (dryRun) return plan;
  const write = dependencies.write ?? (await import('../importers/gender-pay-gap-store.js')).writeImport;
  await write(plan);
  log('Import completed.');
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runImport(process.argv.slice(2)).catch(() => {
    // Avoid printing raw errors, environment values, request URLs or headers.
    console.error('Gender-pay-gap import failed. Check arguments, CSV availability/format and, for live runs, configuration and migration 0002. Prior live batches may have completed; reruns are idempotent.');
    process.exitCode = 1;
  });
}
