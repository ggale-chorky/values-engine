import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEMO_CATALOG } from '../demo/catalog.js';
import { CompaniesHouseClient, CompaniesHouseError } from '../resolution/companies-house.js';
import { resolveBrandLegalEntity } from '../resolution/resolve-brand-legal-entity.js';

export async function main() {
  const { config } = await import('dotenv');
  config({ quiet: true });
  if (!process.env.COMPANIES_HOUSE_API_KEY?.trim()) throw new CompaniesHouseError('missing_api_key');
  const companiesHouse = new CompaniesHouseClient();
  for (const item of DEMO_CATALOG) {
    try {
      const proposals = await resolveBrandLegalEntity({ brand_name: item.brand, source_url: item.source_url }, { companiesHouse });
      for (const proposal of proposals) {
        console.log(JSON.stringify(proposal, null, 2));
      }
    } catch {
      // One inaccessible source must not stop the remaining brands; no raw errors.
      console.log(`${item.brand}\n→ recommendation: UNRESOLVED\n→ signals: resolver_error`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Resolver requires COMPANIES_HOUSE_API_KEY in the environment. No credentials are logged.'); process.exitCode = 1; });
}
