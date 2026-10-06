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

## Database demo adapter and seed

The following commands require a configured database. They were not run during
implementation; tests use fakes and the existing local PGlite tests only.

```sh
npm run demo:seed -- --dry-run
npm run demo:seed
npm run demo:live
```

Unlike the CSV importer's dry-run, **demo seed dry-run reads the configured
database**. It performs zero writes. Backend scripts read `SUPABASE_URL` and
`SUPABASE_SECRET_KEY` from the environment or local `.env`. Missing configuration
fails with a clear message. The server client disables session persistence,
automatic token refresh and URL session detection. Never import it into browser
code; the module also rejects browser execution. Credentials and raw SDK errors
are not printed.

`evaluate-product-from-db.ts` loads the policy, its rules, product, brand, all brand
relationships, referenced legal entities and matching gender-pay evidence. Database
rows are validated and mapped into the existing pure evaluator, which still owns
relationship eligibility, latest-period selection, UNKNOWN handling and numeric
comparison. The adapter accepts exactly one rule on an active policy:
`uk_median_gender_pay_gap <= 10`, `REQUIRE`, `UNKNOWN`, with no text threshold.
Other rule sets, inactive policies and missing products/policies fail clearly.
Missing entity records, relationships or evidence flow to the engine as UNKNOWN.
Invalid latest evidence is not replaced by an older passing result.

Reads are ordered by ID and paginated until empty, advancing by the actual page
length to tolerate smaller server row limits. Read errors fail rather than becoming
missing evidence. `demo:live` has only a read interface and prints JSON provenance
for Charlotte Tilbury Magic Cream, Estée Lauder Advanced Night Repair and Vichy
Minéral 89. It does not persist evaluations or assume the expected results.

The seeder looks up the three existing GB legal entities by company numbers
`08037372`, `00659213` and `00271555`. It never creates/updates legal entities or
evidence. Every lookup and conflict check happens before the first write. A missing
entity blocks the entire seed; dry-run reports missing entities and planned actions
with `ready: false` and a non-zero exit status. Evidence previews are calculated by
the pure engine under the *proposed* relationship, not asserted as already seeded.

Objects are matched by exact brand/product names and the demo policy name.
Relationships must be unambiguous and match the expected entity and `operated_by`
type. Existing matching rows retain their UUIDs; missing rows get new UUIDs. An
existing policy rule must already match the supported rule. Duplicates, conflicting
product brands, user-specific policies with the same name and conflicting links
abort before writes. Reused links are updated to confidence 1, human_verified,
open-ended validity and the current `last_verified_at`; the demo policy is activated.
No GTINs, MPNs, offers, prices or product URLs are created.

These first-party source URLs were checked read-only on 2026-10-05 and are stored
with descriptive source names for the requested `operated_by` links:

- [Charlotte Tilbury UK Terms & Conditions](https://www.charlottetilbury.com/uk/help/terms-and-conditions)
- [Estée Lauder UK Loyalty Terms & Conditions](https://www.esteelauder.co.uk/terms-conditions-loyalty)
- [Vichy UK Terms of Use](https://www.vichy.co.uk/terms-of-use)

All URLs were resolved, so the existing NOT NULL relationship source URL constraint
can be retained. No schema changes or migration 0003 are needed; migrations 0001
and 0002 are unchanged.

Run only one seeder at a time: lookup-before-write does not protect against
concurrent inserts without additional database uniqueness/locking. Multi-request
seeding is not atomic; sequential retries recover from a partially completed run
without duplicating matched records. Paginated reads are not a transactional
snapshot, so avoid concurrent edits when an exactly repeatable evaluation is needed.
No actual production values, credentials, access permissions or connectivity were
verified in this milestone.

## Resolver V1: read-only candidate proposals

`npm run resolve:demo` is a live, read-only command for the three first-party URLs
in `src/demo/catalog.ts`. It needs `COMPANIES_HOUSE_API_KEY` in the environment
(the CLI can load local `.env`). It was **not run during implementation**. Unit
tests use representative local HTML snippets and mocked API responses, never
real credentials, websites or Companies House requests.

The demo pipeline is: supplied legal-page URL → ordinary HTTP(S) fetch → visible
DOM and embedded JSON extraction → Companies House verification. If retrieval is
blocked/incomplete or supplies no usable shopping evidence, domain-restricted
OpenAI web discovery supplies candidate snippets for the same deterministic verifier.
There is no browser automation, Supabase access, relationship creation or automatic
verification-state change.
The caller supplies the first-party URL; V1 does not independently establish
that the domain belongs to the named brand. A proposal is not proof of ownership.

`CompaniesHouseClient` uses the [official API authentication scheme](https://developer.company-information.service.gov.uk/authentication):
HTTP Basic with the environment key as username and an empty password. It supports
direct company profiles and company search, validates responses with Zod and
checks that a returned profile number matches the requested number. The resolver
only uses direct lookups; search never substitutes a guess when no number is found.
401, 404, 429, network errors, timeouts and invalid responses have explicit error
codes. Requests time out after 10 seconds, responses are capped at 1 MB, authenticated
redirects are refused, and there are no automatic retries. 429 retry guidance is
reported when supplied as seconds. API keys, headers and raw error bodies are
never logged.

First-party page fetching identifies itself as `ValuesEngine-DevelopmentResolver/1.0`,
has a 15-second total timeout, a 2 MB response limit and at most five redirects.
Only HTML and plain text are accepted. Requests allow public HTTP(S) on default
ports, check DNS results and pin the selected public address for connection.
Private/reserved destinations, cross-site redirects and HTTPS downgrades are
refused. Same-host and www/non-www redirects are permitted. Requests carry no
credentials or cookies. UTF-8 text and identity encoding are supported; compressed
responses that ignore the identity request are reported as unavailable. HTTP
blocking, recognised challenge pages and login walls produce `source_unavailable`;
there is no CAPTCHA, login or bot-protection bypass. Challenge detection is
conservative and cannot recognise every possible interstitial.

Visible HTML parsing uses `htmlparser2`, decodes character entities and ignores scripts,
styles, templates, comments, navigation/menus and explicitly hidden nodes. Extraction uses numbers
beside labels such as `company number`, `company no.`, `registered number` and
`registered in England and Wales under number`. VAT/charity labels and unrelated
numeric strings are excluded. Numbers stay strings and reuse importer trimming/
uppercasing. Supported forms are eight digits or a recognised two-letter prefix
with six digits, including SC, NI, OC and RC. No numbers are padded or guessed.
Other registry formats remain unsupported in V1.

Each occurrence retains its complete semantic text block, exact supporting
sentence, scoped heading context, DOM path/order and inferred role. Paragraphs,
headings, list items and table cells stay separate. Names are associated within
the same sentence; a uniquely named company and identifier can also bind an explicit
postfix role across registration/address text in the same block. Names are never
borrowed from an adjacent block/cell. Footer and
promotion/privacy/licensing sections are secondary evidence. Legal-name extraction
is conservative, expecting title-case or uppercase
names ending in Limited/Ltd/PLC/LLP. All-lowercase or unusual names can require
manual review. Name agreement normalises accents, punctuation, whitespace, `Ltd`
and `&`; it does not use fuzzy matching or compare against the brand name.

Name and role are extracted together. Roles are `site_operator`, `seller`,
`brand_operator`, `promoter`, `licensor`, `data_controller` and `unknown`. An
explicit statement such as "seller is" or "site is operated by" identifies a
role. Registration wording inside a scoped Terms of Sale section can identify
the seller; an About Us heading or registration number alone is insufficient.
Negated/former-role wording is not treated as a current shopping relationship.

Evidence is grouped by company number, normalised extracted name, role and page
context. Primary shopping-role evidence drives a proposal when present. Unrelated
roles and secondary/footer occurrences remain visible but cannot introduce a
name conflict against that evidence. Similarly authoritative shopping-role
statements attaching different names to the same number still require REVIEW,
as do different numbers identifying competing operating entities. Unknown or
unrelated roles alone cannot produce a shopping proposal.

The CLI prints complete JSON diagnostics: official profile match, inferred role,
all grouped occurrences, supporting blocks and conflicting evidence with an
`impacts_recommendation` flag. No first-party retrieval or blocking behaviour has
changed. The Charlotte fixture includes both a Terms of Sale/About Us company
registration and unrelated Islestarr promotional/footer text. The Estée name/number
regression uses representative loyalty-only wording and expects REVIEW, because a
programme promoter alone does not establish the shopping role. A separate generic
synthetic fixture tests explicit seller/site-operator wording producing PROPOSE.
No new live evidence is asserted by these fixtures.

Retrieval diagnostics report requested/final URLs (without credentials, query or
fragment), HTTP status, content type, bytes read from the final response, extracted
visible-text length, HTML title (at most 200 characters), and whether a labelled
company-number pattern was found. They contain no response body or headers.
Outcomes are `success`, `blocked`, `empty_or_shell`, `retrieved_content_incomplete`, `unsupported_content`,
`network_error` or `http_error`. An unread body has zero bytes read and null text
diagnostics. Fewer than 100 extracted visible characters without a company number
is a conservative `empty_or_shell` heuristic, not proof that JavaScript is required.
HTML of at least 250 KB with fewer than 5,000 visible characters, a text/byte ratio
below 1%, and no visible company number is `retrieved_content_incomplete`. The
`content_heuristic` field labels this rule; it is not a calibrated completeness test.
Embedded evidence can still recover a usable candidate from such a response.

Each proposal has a machine-readable `reason`: retrieval failures use
`source_blocked` / `source_unavailable`; successfully fetched pages without evidence
use `insufficient_visible_text` / `no_company_evidence`. A verified company whose
role is insufficient uses `relationship_role_inadequate` and requires REVIEW.
Other reasons distinguish verification failure, conflicting evidence, incomplete
verification, inactive companies, unavailable legal names and verified operating
entities. Parenthetical company registration details may precede postfix roles
such as “is the promoter”; they still belong to the same company-number sentence.

Confidence is a deterministic **uncalibrated heuristic**, with each contribution
included in `signals`:

| Signal | Weight |
|---|---:|
| Extracted number matches official profile | +0.80 |
| All considered names agree | +0.15 |
| A considered name conflicts | −0.40 |
| Company active / not active | +0.05 / −0.15 |
| Multiple primary operating entities | −0.25 |
| Shopping role unresolved or only secondary evidence | −0.25 |
| Incomplete verification | −0.25 |

Scores are clamped to [0, 1]: HIGH ≥0.90, MEDIUM ≥0.60, otherwise LOW. `PROPOSE`
requires name agreement, active status, a primary shopping role and complete,
unambiguous verification. Unrelated companies elsewhere on a page do not by
themselves lower confidence in the operating entity. Missing or conflicting names,
unresolved roles and inactive companies require `REVIEW`. No labelled number,
unavailable source, or failed profile lookup produces `UNRESOLVED`. A 404 does not
confirm the number. No proposal is marked `human_verified` or saved.

At most ten unique candidates are looked up per page. Larger sets and partial API
failures prevent PROPOSE. Repeated numbers are looked up once but retain all
occurrences. A 401/429/missing key stops further API calls for that page. The CLI
reports failures per brand and continues through the remaining configured URLs.
No schema change is needed; migrations 0001 and 0002 remain unchanged.


### Resolver V2 discovery and provenance

`resolveWithDiscovery` orchestrates the demo; `resolveBrandLegalEntity` remains the
standalone deterministic HTTP/embedded resolver. It inspects JSON-LD, JSON script
payloads and `__NEXT_DATA__` without executing JavaScript. String values (including
HTML strings) use the same extractor. Explicit legal-name/company-number fields
within one JSON object can identify a candidate but do not establish its role.
Unrelated JSON values are never concatenated. JSON paths and extraction channels
(`visible_dom`, `structured_data`, `embedded_page_state`, or `discovery_text`) stay
on each occurrence. Malformed/oversized/deep JSON is skipped and incomplete embedded
inspection cannot produce an embedded PROPOSE. Executable application-state
assignments and streaming JavaScript payloads are deliberately unsupported.

The official `openai` SDK reads `OPENAI_API_KEY` only when discovery is needed.
Set it locally to enable the fallback; the example file contains only a blank
placeholder. Missing keys/API failures retain the direct result and a structured
attempt status. The service makes one Responses request using `gpt-5.5`,
`web_search`, `filters.allowed_domains`, and `include: ["web_search_call.action.sources"]`,
with a 45-second timeout, no retries, no SDK logging, `store: false` and an output
limit. The supplied domain (including its subdomains) is the only search scope;
there is no broader-domain retry. See the [official OpenAI web-search guide](https://developers.openai.com/api/docs/guides/tools-web-search).

Structured output is validated with Zod. The full API web-search source list is
retained, along with rejected-candidate reasons. Candidates must have an HTTP(S)
first-party URL, a matching source-domain field and a matching URL in that source
list. The model's separate name/number/role fields are diagnostic suggestions;
only deterministic extraction from its attributed evidence text enters Companies
House verification. No legal-name-only fuzzy lookup is implemented: name-only
claims require REVIEW. API/source-list/schema failures fail closed.

Each proposal and occurrence records `direct_http`, `embedded_page_data`, or
`openai_web_search`. PROPOSE requires an extracted company number, official active
Companies House profile, matching legal name, shopping role and no relevant
conflicts/incomplete verification. Search claims without verification remain
REVIEW; invalid/unattributed sources do not become candidates. Search text can be
stale or inaccurate, and Companies House confirms company identity rather than
ownership of a brand. Even PROPOSE is only a reviewable proposal, never a graph
fact. The demo prints channel attempts, recommendations and complete provenance.
All discovery tests mock both OpenAI and Companies House; do not run `resolve:demo`
unless live external calls are intended.
