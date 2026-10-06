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
with six digits, including SC, NI, OC and RC. Explicitly labelled UK/England &
Wales numeric registrations of 1–8 digits are left-padded to eight digits for
Companies House lookup. Unlabelled numbers or short numbers without explicit UK
registration context are not padded. Each occurrence preserves `raw_identifier`
and `canonical_identifier`; prefixed identifiers keep their existing rules.

Each occurrence retains its complete semantic text block, exact supporting
sentence, scoped heading context, DOM path/order and inferred role. Paragraphs,
headings, list items and table cells stay separate. Names are associated within
the same sentence; a uniquely named company and identifier can also bind an explicit
postfix role across registration/address text in the same block. Names are never
borrowed from an adjacent block/cell during initial extraction. V2.3 separately
links complementary evidence only under the same-document guards below. Footer and
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

Scores are clamped to [0, 1]: HIGH ≥0.90, MEDIUM ≥0.60, otherwise LOW. `PROPOSE`
requires name agreement, active status, a primary shopping role and complete,
unambiguous verification. Unrelated companies elsewhere on a page do not by
themselves lower confidence in the operating entity. Missing or conflicting names,
unresolved roles and inactive companies require `REVIEW`. No labelled number,
unavailable source, or failed profile lookup produces `UNRESOLVED`. A 404 does not
confirm the number. No proposal is marked `human_verified` or saved.

Each verification pass attempts at most ten candidate lookups, prioritising
relevant target-market evidence. Unchecked candidates remain in diagnostics with
unverified state; unrelated failures and limits do not veto verified candidates.
Registry results are cached across direct/discovery passes within one resolution.
Repeated numbers retain all occurrences. A 401/429/missing key stops further API calls for that page. The CLI
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
on each occurrence. Malformed/oversized/deep JSON is skipped and recorded as an
inspection diagnostic; it does not veto a fully parsed, independently verified
candidate from another payload. Executable application-state
assignments and streaming JavaScript payloads are deliberately unsupported.

The official `openai` SDK reads `OPENAI_API_KEY` only when discovery is needed.
Set it locally to enable the fallback; the example file contains only a blank
placeholder. Missing keys/API failures retain the direct result and a structured
attempt status. The service uses Responses with `gpt-5.5`,
`web_search`, `filters.allowed_domains`, and `include: ["web_search_call.action.sources"]`,
with a 45-second timeout per attempt, no SDK logging, `store: false` and an output
limit. The service retries at most once after 500 ms for 429, 5xx and recognised
network failures; SDK retries remain disabled. It never retries 400/401/403.
Failures retain safe HTTP status, allowlisted API type/code, retryability and
attempt count, without raw messages, headers or request payloads. The supplied domain (including its subdomains) is the only search scope;
there is no broader-domain retry. See the [official OpenAI web-search guide](https://developers.openai.com/api/docs/guides/tools-web-search).

Structured output is validated with Zod. The full API web-search source list is
retained, along with rejected-candidate reasons. Candidates must have an HTTP(S)
first-party URL and a matching URL in that source list. Parsed URL hostnames are
authoritative: comparison lowercases, removes a trailing dot and strips leading
`www.`. Only the allowed domain or genuine subdomains pass; deceptive suffixes
and lookalikes do not. The model-produced `source_domain` is retained for
diagnostics only, including when it is absent or disagrees. The model's separate name/number/role fields are diagnostic suggestions;
only deterministic extraction from its attributed evidence text enters Companies
House verification. No legal-name-only fuzzy lookup is implemented: name-only
claims require REVIEW unless a deterministic identifier can be linked through
the same-document fusion guards below. API/source-list/schema failures fail closed.

Each proposal and occurrence records `direct_http`, `embedded_page_data`, or
`openai_web_search`. PROPOSE requires an extracted company number, official active
Companies House profile, matching legal name, shopping role and no relevant
candidate-specific conflicts or missing verification. Search claims without verification remain
REVIEW; invalid/unattributed sources do not become candidates. Search text can be
stale or inaccurate, and Companies House confirms company identity rather than
ownership of a brand. Even PROPOSE is only a reviewable proposal, never a graph
fact. The demo prints channel attempts, recommendations and complete provenance.
All discovery tests mock both OpenAI and Companies House; do not run `resolve:demo`
unless live external calls are intended.


### Resolver V2.1 role and context safeguards

Explicit supply/sell-products-to-you wording identifies a seller; an explicit
parenthetical definition of “Licensor” identifies a licensor even if it also
uses “we/us”. Recognised transactional wording remains tied to its named company
and identifier, with negation and competing subjects excluded. Embedded JSON
section titles/headings/names are preserved on candidate blocks, including
subscription and app terms. Those metadata headings do not create a seller role.

Verified licensors, promoters and data controllers remain reviewable evidence but
cannot satisfy a shopping relationship on their own or compete with a separate
verified seller. Explicit differing `Brand:` labels or quoted `Terms for "Brand"`
scopes are flagged `context_mismatch`; the resolver does not guess brand context
from a legal-company-name mismatch (for example, Vichy versus L'Oreal).
Discovery failure retains existing direct/embedded proposals and diagnostics.
The Vichy and Charlotte fixtures are representative local regressions, not fresh
live retrievals; the Islestarr identifier in the embedded fixture is synthetic.


### Resolver V2.2 candidate verification and overall decision

The resolver defaults to `target_market: GB`. Evidence on explicitly foreign-market
paths/domains or with recognised foreign registration/customer/legal context is
retained as secondary diagnostic evidence (`market_context_mismatch`) and excluded
from UK candidate selection. Explicit different-brand privacy/brand scopes are
similarly excluded as `context_mismatch`. These checks are conservative heuristics,
not a complete jurisdiction classifier; unspecified market context uses the GB
default. No inference is made from the mismatch between a brand and a legal name.

Each candidate exposes `verification`: source validation, deterministic identifier,
registry verification and active status, legal-name agreement, role relevance,
market/brand context match and blocking conflict. PROPOSE is derived from those
fields, never the numeric confidence score. Unusable/no-identifier evidence,
foreign-market records and unrelated promoters/licensors do not impose a batch
veto. Same-identifier relevant name conflicts still block that candidate.

Direct DOM, page-state and discovery snippets share the same extractor and are
merged by canonical company identifier before verification. Stronger discovered
UK seller/site-operator evidence can supersede a direct loyalty/promoter record;
both occurrences remain visible. A successful direct resolution still avoids an
unnecessary discovery call. With no adequate direct candidate, discovery can add
stronger evidence without losing the direct evidence or repeating cached lookups.

`resolveWithDiscovery` returns `overall`, `selected_candidate`,
`supporting_candidates` and `secondary_candidates`, alongside all proposals,
direct results and discovery diagnostics. Selection prefers a fully verified
relevant candidate, then a verified identity with inadequate role, then an
unverified identity for REVIEW. Without a credible identity it is UNRESOLVED.
Two different verified, relevant entities competing for GB return REVIEW with
`ambiguous_legal_entity` and no selected entity. No LLM ranking breaks that tie.
All recommendations remain proposals, with no graph writes or approvals.


### Resolver V2.3 same-document evidence fusion

All three text paths (DOM, embedded JSON strings and discovery snippets) now retain
named role evidence even without a registration number in that fragment. They
share `classifyRole`, including explicit ordering-with-the-company/products-sold
wording and supply-products-to-you wording. Previously identifier-gated extraction
could discard a seller fragment when the registration lived in another JSON
string or discovery snippet. Literal snippet ellipses are treated as gap markers
inside the classifier; the supporting text itself is not rewritten.

Before registry verification, `fuseDocumentEvidence` can link a named role fragment
to identifier evidence only when both are primary, attributable first-party
evidence with the same complete canonical document URL, equivalent normalised
legal name, matching brand scope and matching GB market scope. URL comparison
preserves paths and queries (removing only fragments and using existing hostname
canonicalisation). Sharing a domain is insufficient. Names use the existing
case/accent/punctuation/apostrophe/whitespace/Ltd normalisation, never fuzzy matching.
The role must be explicit deterministic shopping-role evidence, not a model field
or heading alone. Conflicting identifiers for a name, or conflicting relevant
names for an identifier within that document, prevent fusion.

Both occurrences remain separate. A role-only occurrence retains null raw/canonical
identifier fields; its fusion metadata references the matched identifier and
canonical URL. The candidate and its signals expose
`same_document_evidence_fusion`. No sentence or company number is manufactured
by joining quotes. Original snippets, JSON paths, sections and retrieval channels
remain available. Secondary promoter/licensor/controller evidence remains visible.
The fused candidate must still pass every V2.2 verification flag, including an
independent active Companies House identity/name match and absence of blocking
conflicts. Same-document identity linking is not registry verification or approval.

The representative Estée terms fixtures exercise seller and registration snippets
from one document (`659213` → `00659213`), alongside secondary loyalty evidence.
The Charlotte embedded fixture exercises the exact supplied ellipsis/“we or us”
supply wording with a separate registration fragment. These are local regression
fixtures, not fresh live captures. No relationships or graph records are written.


### Beauty UK v1: frozen baseline and regression dataset

The frozen input is `benchmarks/beauty-uk-v1.csv`: exactly the requested 20 brands,
with only `brand_name,domain,target_market` (`GB`). The harness rejects extra
columns/fields, URLs in the domain field, invalid markets and duplicate brands.
No company identifiers, legal names, legal-page URLs or parent mappings are supplied.
`benchmarks/resolver-v23-freeze.json` pins the dataset and existing resolver source
hashes at checkpoint `043dcac7e7bc6db4db345faa98c2c76b10c02f74`. Tests verify those historical
source blobs and the unchanged dataset; current V2.4 source hashes are recorded separately
in each new run. The original manifest and saved baseline run are not overwritten.

Beauty UK v1 is now a regression dataset, not a future blind benchmark. Its saved
V2.3 distribution is **5 PROPOSE / 7 REVIEW / 5 UNRESOLVED / 3 ERROR**. A future
authorised V2.4 run is a labelled regression comparison, not a new blind performance
estimate. A fresh unseen Beauty UK v2 holdout is needed for the next unbiased measurement.

The existing orchestration requires a source URL. The thin adapter in
`src/benchmark/domain-entry.ts` derives only `https://<normalised-domain>/` and invokes
the current resolver. It may obtain evidence from that homepage or fall back
to the existing domain-restricted discovery flow. It contains no brand-specific
fallbacks or known legal-page links. The historical V2.3 implementation remains
recoverable from its checkpoint; V2.4 changes are described below.

Validate without network access, environment loading or output writes:

```sh
npm run benchmark:resolver -- --input benchmarks/beauty-uk-v1.csv --dry-run
npm run benchmark:resolver -- --input benchmarks/beauty-uk-v1.csv --limit 3 --dry-run
```

A future authorised live run omits `--dry-run` and needs the existing OpenAI and
Companies House environment keys. `--input` defaults to the frozen CSV; `--limit`
must be a positive integer and selects the first N rows after validating the entire
file. `--output` chooses a new run directory; otherwise a unique directory under
`benchmarks/runs/` is used. Existing directories are refused. Generated runs are
Git-ignored. Execution is sequential; a brand failure does not stop later brands.

Each run writes:

- `results.jsonl`: input fields, benchmark action/error, operational error codes and
  the complete resolver result, including verification, registry matches, snippets,
  raw/canonical identifiers, exclusions, secondary candidates and fusion metadata.
- `results.csv`: brand/domain/market, action, selected entity/number/role/source,
  retrieval channel, reason, fusion flag and error.
- `audit.csv`: the same result columns plus blank `audit_outcome`,
  `audited_legal_entity`, `audited_company_number`, `audited_role`, `audit_notes`.
  Human `audit_outcome` values are CORRECT, INCORRECT or UNCLEAR; none are filled in.
- `summary.json`: completed/planned totals; PROPOSE/REVIEW/UNRESOLVED/ERROR counts;
  propose/review/unresolved/error rates; input filename/hash; Git SHA/dirty state;
  timestamp; GB target; current resolver version/source hashes; evaluation kind
  (`regression_comparison` for the frozen Beauty UK v1 content); and model/configuration
  identity read safely from the current discovery implementation. Each completed brand is flushed
  to disk; the summary marks whether the planned run finished.

ERROR means a thrown execution failure, or an unresolved/review result affected by
provider/configuration/response failures. Ordinary blocked pages followed by a
successful empty discovery remain UNRESOLVED. An independently successful PROPOSE
is retained even if secondary evidence encountered a provider failure; those errors
remain diagnostic. The resolver's original overall decision is always preserved in
JSONL, even when the benchmark labels the run ERROR. Rates use all completed brands,
including errors, as the denominator. No proposal precision is calculated before audit.
Raw exceptions, credential/header fields and configured secret values are not
written. The harness retains audit evidence rather than request/transport payloads.

Known frozen limitation: some Charlotte live embedded-page transactional occurrences
were still classified `unknown` despite an equivalent regression fixture resolving
as seller. This remains a historical limitation of the frozen V2.3 baseline;
no claim is made that the corresponding live case has been fixed without rerunning it. The harness and tests make no Supabase writes.


### Resolver V2.4

UK-first resolution still defaults unspecified `target_market` to `GB`.
Generic “we are” identity wording no longer establishes site operation. Site-operator
claims require an explicit website/site/webshop/store object or an explicit site-operator
role. Mobile-message, programme, competition, recruitment, app, tool and feature
operation does not establish a shopping relationship. `service_operator` is diagnostic
and cannot pass the shopping-role gate. Explicit “goods supplied from the Website
are supplied by” identifies a seller. Existing exact-name matching and same-document
fusion rules remain in force; registry/page-name disagreement requires REVIEW.

Domain-restricted discovery prioritises authoritative legal URLs. Each attributable
candidate URL is retrieved sequentially with the existing bounded, public-address-only
HTTP client. Duplicate URLs are fetched once per discovery pass. The full visible and
embedded document is extracted deterministically without executing scripts. Ordinary
successful documents supersede model snippets, including documents with no company
evidence. Blocked/unavailable or insufficient documents may use attributable search
text as fallback; an embedded identifier recovered from a sparse shell still uses
that document. Off-domain redirects are rejected. No access-control bypass is added.

Occurrence provenance records `evidence_origin` as `discovered_url_direct` or
`search_evidence_fallback`, plus the discovered URL and existing retrieval/extraction
channels. `discovered_sources` records retrieval outcome and safe diagnostics; raw
search candidates and the complete API source list remain available for audit.
Model-provided name/number/role fields never substitute for deterministic extraction
and Companies House verification.

Heuristic source priority favours explicit UK and main-site legal/transactional pages.
Careers/applicant, promotional/loyalty and recognised foreign-market sources are
excluded from shopping selection and fusion, but retained as secondary evidence.
Privacy-controller evidence cannot override a verified seller/site operator. Ranking
orders retrieval and supporting citations; it never breaks a conflict between two
verified relevant operating entities. The market/section vocabularies are conservative
heuristics, not a complete taxonomy of international sites.

A successful search with malformed JSON, missing fields or a schema mismatch receives
one structured-output repair request using the same domain-restricted configuration.
Safe `validation_errors` retain category, attempt and schema field paths, not response
payloads or raw errors. A failed repair remains `discovery_invalid_response`, mapped
to benchmark ERROR unless an independent PROPOSE already exists. There is at most
one transient provider retry across the operation, so repair plus retry is bounded
to three API requests. No ownership truth or graph relationships are written.

The implementation is locally tested with mocked transports. Stop before the live
Beauty UK v1 regression comparison; its V2.4 distribution is not yet measured.
