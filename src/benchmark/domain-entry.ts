import { z } from 'zod';
import { normaliseDiscoveryDomain } from '../resolution/discover-first-party-evidence.js';
import { resolveWithDiscovery } from '../resolution/resolve-with-discovery.js';

export const benchmarkInputSchema = z.object({
  brand_name: z.string().trim().min(1).max(200),
  domain: z.string().refine(value => normaliseDiscoveryDomain(value) !== null, 'invalid domain'),
  target_market: z.literal('GB'),
}).strict();
export type BenchmarkInput = z.infer<typeof benchmarkInputSchema>;

/** No known legal URL: start at the supplied domain homepage and use frozen V2.3. */
export async function resolveDomain(input: BenchmarkInput, dependencies: Parameters<typeof resolveWithDiscovery>[1]) {
  const fields = benchmarkInputSchema.parse(input);
  const domain = normaliseDiscoveryDomain(fields.domain)!;
  return resolveWithDiscovery({ ...fields, domain, source_url: `https://${domain}/` }, dependencies);
}
