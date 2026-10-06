import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEMO_CATALOG } from '../demo/catalog.js';
import { CompaniesHouseClient, CompaniesHouseError } from '../resolution/companies-house.js';
import { resolveWithDiscovery } from '../resolution/resolve-with-discovery.js';

export async function main() {
  const { config } = await import('dotenv');
  config({ quiet: true });
  if (!process.env.COMPANIES_HOUSE_API_KEY?.trim()) throw new CompaniesHouseError('missing_api_key');
  const companiesHouse = new CompaniesHouseClient();
  for (const item of DEMO_CATALOG) {
    try {
      const result = await resolveWithDiscovery({ brand_name: item.brand, source_url: item.source_url,
        domain: new URL(item.source_url).hostname.replace(/^www\./, '') }, { companiesHouse });
      console.log(item.brand);
      for (const attempt of result.attempts) console.log(`→ ${attempt.channel}: ${attempt.outcome}`);
      for (const proposal of result.proposals) {
        console.log(`→ ${proposal.retrieval_channel}: ${proposal.company_number ?? 'no verified identifier'}\n→ Companies House: ${proposal.companies_house_match?.company_name ?? 'unverified'}\n→ role: ${proposal.inferred_role}\n→ ${proposal.recommended_action}`);
        console.log(JSON.stringify(proposal, null, 2));
      }
      console.log(JSON.stringify({ discovery: result.discovery, discovery_rejections: result.discovery_rejections }, null, 2));
    } catch {
      // One inaccessible source must not stop the remaining brands; no raw errors.
      console.log(`${item.brand}\n→ recommendation: UNRESOLVED\n→ signals: resolver_error`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Resolver requires COMPANIES_HOUSE_API_KEY in the environment. No credentials are logged.'); process.exitCode = 1; });
}
