BEGIN;

-- PostgREST on_conflict names columns but cannot supply the predicate required
-- to infer 0001's partial index. A normal UNIQUE constraint permits that upsert
-- while still allowing multiple rows with NULL company numbers.
DROP INDEX legal_entities_jurisdiction_company_number_unique;
ALTER TABLE legal_entities
  ADD CONSTRAINT legal_entities_jurisdiction_company_number_unique
  UNIQUE (jurisdiction, company_number);

ALTER TABLE evidence
  ADD COLUMN source_record_id text CHECK (btrim(source_record_id) <> ''),
  ADD CONSTRAINT evidence_source_identity_unique
  UNIQUE (source_name, source_record_id, claim_type, reporting_period);

-- Legacy claims without a source record ID or reporting period remain valid.
-- Importers must populate both to receive the idempotency guarantee.
NOTIFY pgrst, 'reload schema';

COMMIT;
