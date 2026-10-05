# Values Engine

Backend foundation for a UK-first purchasing-policy engine. Canonical products are
separate from retailer offers. Factual evidence retains its source, confidence and
verification status; the schema contains no ethical score.

## Local development

Use Node.js 26 and npm (initial environment: Node 26.0.0, npm 11.12.1).

```sh
npm install
npm run dev
npm run typecheck
npm test
npm run build
```

The ESM entry point loads dotenv and prints a startup message. It does not create
a Supabase client or make network requests. The build writes JavaScript to `dist/`.
TypeScript strict checks cover both source and tests.

`.env.example` documents the three future configuration variables with empty
placeholders. `.env` and other local environment files are ignored by Git. No keys
are needed to run the scaffold or tests. Service role keys must remain server-side.

## Database

`supabase/migrations/0001_initial_schema.sql` creates ten PostgreSQL tables in one
transaction. It has not been applied to a live database. No Supabase connection,
authentication foreign key, RLS policy or deployment setup is included.

- `legal_entities` and `brands` hold canonical identities.
- `brand_entity_relationships` links brands to legal entities;
  `legal_entity_relationships` links children to parents. Both preserve source,
  confidence, verification status and optional validity dates.
- `products` holds physical products; `offers` holds retailer listings with
  optional prices, currency (default GBP), availability and retrieval time.
- `evidence` stores one typed factual value for exactly one product, brand or
  legal entity, with provenance and JSON object metadata.
- `policies` and `policy_rules` describe purchasing criteria.
- `evaluations` stores outcomes and a JSON object for detailed results.

The first rule is representable as `criterion = 'uk_median_gender_pay_gap'`,
`operator = '<='`, `threshold_numeric = 10`, `action = 'REQUIRE'`, and
`unknown_handling = 'UNKNOWN'`. Numeric gender pay gap evidence should use percentage
points (for example, `8.5` with `unit = 'percent'`). `PREFER` is available for soft
preferences. Unknown handling accepts `UNKNOWN` or `FAIL` and defaults to `UNKNOWN`;
evaluations also default to `UNKNOWN`. Evaluation logic is not implemented yet, so
these constraints alone do not calculate or validate a policy decision.

## Schema decisions

- UUID keys use PostgreSQL's built-in `gen_random_uuid()`; timestamps use
  `timestamptz`. Simple triggers maintain `updated_at`.
- Company numbers, LEIs and GTINs are text to preserve leading zeros. Partial
  unique indexes apply only to supplied identifiers. Ingestion must normalise
  jurisdiction codes and identifiers consistently; GTIN lengths are checked, but
  check digits and equivalent zero-padded forms are not normalised by SQL.
- Product brands may be unknown. Missing identifiers and offer prices use NULL.
  A missing claim is represented by no evidence row, rather than an empty value.
- Relationship types, claim types, source types and reporting periods remain
  non-enumerated text. Reporting periods can express source-specific fiscal years.
  Repeated claims and relationships can preserve different sources and history.
- Foreign keys use default NO ACTION deletion behaviour to protect linked records.
  Direct self-parenting is rejected; longer ownership cycles are not checked here.
- Evidence metadata and evaluation results must be JSON objects. Rule thresholds
  require exactly one numeric or text value; ordering operators require numbers.
- This schema is not ready for untrusted client access: access controls and RLS
  must be designed before exposing it. No RLS policies are created in this phase.

## Tests

Vitest applies the actual migration to an in-memory PGlite PostgreSQL database and
checks constraints, identifier uniqueness, relationships, offers, the first rule,
UNKNOWN defaults, foreign keys and timestamp updates. PGlite is a test-only
dependency; tests require no credentials or database service. They do not verify
Supabase-specific deployment or access-control configuration.
