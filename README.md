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
are needed to run the scaffold, tests or importer dry-run. Future live imports use
`SUPABASE_URL` and `SUPABASE_SECRET_KEY`; secret keys must remain server-side.
`COMPANIES_HOUSE_API_KEY` remains a placeholder for future registry integration.

## Database

`supabase/migrations/0001_initial_schema.sql` creates ten PostgreSQL tables in one
transaction. Migration 0001 has been applied to production and must not be edited.
Schema changes go in new migrations. Production evidence has now been imported;
local evaluation does not apply migrations or connect to Supabase. No authentication
foreign key or RLS policies are included.

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
evaluations also default to `UNKNOWN`. The local evaluator described below supports
the first required rule; database constraints alone do not calculate a decision.

## Schema decisions

- UUID keys use PostgreSQL's built-in `gen_random_uuid()`; timestamps use
  `timestamptz`. Simple triggers maintain `updated_at`.
- Company numbers, LEIs and GTINs are text to preserve leading zeros. Migration
  0002 replaces the partial company-number index with a normal UNIQUE constraint
  on `(jurisdiction, company_number)` for PostgREST upserts; multiple NULL company
  numbers remain allowed. LEI and GTIN indexes remain partial. Ingestion must normalise
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

## UK Gender Pay Gap import

```sh
npm run import:gpg -- --year=2025 --dry-run
```

The year defaults to `2025`, representing reporting period `2025-26`. The importer
downloads the [official CSV](https://gender-pay-gap.service.gov.uk/viewing/download-data/2025),
validates headers and CSV structure, and keeps identifiers as strings. It trims and
uppercases company numbers without removing zeros or prefixes. Legal entities use
jurisdiction `GB` and `CurrentName`, falling back to `EmployerName`.

Dry-run downloads and performs all transformations but returns before loading the
Supabase writer or dotenv. It needs no secrets and makes no database requests.
Output includes total rows, rows with company numbers, valid evidence rows,
skipped rows by reason, unique upsert counts and three sample records. Sample
`legal_entity_id` values are NULL because database UUIDs cannot be resolved in a
dry-run; the accompanying `legal_entity_lookup` gives the exact company key used
to resolve them during an eventual live import.

Rows without company numbers are excluded. Missing names also exclude the entity.
Rows with a company number and name still produce an entity if the median figure
or employer ID is invalid, but produce no evidence. `skipped_rows` counts rows
that cannot produce evidence, including those that still produce an entity.
Zero and negative median values are preserved. Blank, non-finite or malformed
numbers never become zero.

Evidence uses `uk_median_gender_pay_gap`, `percent`, source name `UK Gender Pay Gap
Service`, source type `government`, the employer ID and source URL, reporting
period, retrieval timestamp, confidence `1` and `auto_verified`. These attributes
record the organisation's reported figure from the official dataset; they do not
assert independent verification of the employer's calculation or any moral judgement.
Metadata includes only EmployerName, EmployerId, EmployerSize, DateSubmitted and
CompanyLinkToGPGInfo. Submission dates remain source text without an invented timezone.

Migration 0002 adds `evidence.source_record_id` and a UNIQUE constraint on
`(source_name, source_record_id, claim_type, reporting_period)`. Source record ID
and reporting period must both be supplied for this uniqueness guarantee; legacy
claims with NULL identity fields remain valid. The migration also requests a
PostgREST schema-cache reload.

For an authorised live import, migration 0002 must already be deployed and
the two Supabase environment variables configured. Omitting `--dry-run` enables
writes. Entities are deduplicated and upserted in batches of 200, then evidence is
upserted using returned entity UUIDs. Repeated company keys or employer records
use the last eligible CSV row; an employer ID linked to conflicting company
numbers aborts before writes. Separate employer IDs may report against the same
company and remain separate evidence records.

The import is not one database transaction: a failed later batch can leave earlier
batches committed. Reruns update the same identities and can resume safely.
It does not delete older evidence when a later CSV row is removed or becomes
invalid. Corrections, conflicting company names and stale evidence need a future
reconciliation policy. The CSV is loaded in memory (roughly a few MB for 2025).

Unit tests cover transformations, parsing, dry-run isolation and migration 0002's
upsert constraints, including stable UUIDs on repeated imports.

## Local deterministic evaluation

```sh
npm run demo:evaluate
```

This command runs synthetic product/brand relationships and the three user-supplied
gender-pay values. It loads no environment files, makes no network requests and
requires no secrets. Fixture IDs and ownership verification are local test data,
not claims that real product ownership has been independently verified.

`evaluateRule` compares one structured claim using `uk_median_gender_pay_gap`,
`<=` and a finite numeric threshold. It requires a resolved, verified entity
context. It returns structured fields only: result, machine-readable reason,
criterion, threshold, observed value, evidence ID, source name/URL, reporting
period and legal entity ID. Unsupported rules and invalid evidence return UNKNOWN.

`evaluateProduct` accepts a product, brand/entity records, relationships, evidence,
one rule and an explicit `as_of` date (`YYYY-MM-DD`). It selects a brand relationship
only if human/auto verified, confidence is at least 0.9 and at most 1, and the date
falls within its validity interval. NULL bounds are open-ended; both date bounds
are inclusive. Malformed dates are ineligible. More than one eligible relationship
returns `ambiguous_legal_entity`, even if both rows name the same entity.

Evidence must match the selected entity and criterion and be human/auto verified.
The latest reporting period among verified claims is selected using validated
`YYYY-YY` periods. Equal latest periods return `ambiguous_evidence`; invalid period
labels return UNKNOWN because they cannot be ranked. An invalid latest numeric
value returns UNKNOWN rather than falling back to an older value. Numeric strings,
NULL, NaN and infinity are rejected. Unit must be `percent`, evidence must have
one numeric value and only the legal entity subject, and provenance fields must
be present. Evidence confidence must be in [0, 1]; only relationships have the 0.9
cutoff in this MVP.

The caller must supply the complete relevant snapshot, not a truncated page of
relationships or evidence. The pure rule function trusts the caller's resolved
entity context; `evaluateProduct` performs eligibility checks. No parent-company
traversal, multi-rule aggregation, soft preferences, unknown-to-FAIL override,
evidence age cutoff or historical evidence-availability filtering is implemented.
The date controls relationship validity; evidence uses the latest supplied verified
reporting period. All otherwise eligible relationship types are considered under
the MVP criteria. The fixtures use `owned_by`.

Expected demo output:

```text
Charlotte Tilbury -> PASS (-0.7 <= 10)
Estée Lauder -> PASS (10 <= 10)
L'Oréal -> FAIL (18.95 > 10)
```
