BEGIN;

-- Nullable identity for brands resolved through this workflow; existing brands remain valid.
ALTER TABLE brands ADD COLUMN resolution_domain text UNIQUE
  CHECK (resolution_domain = lower(resolution_domain) AND resolution_domain ~ '^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$');
ALTER TABLE brand_entity_relationships ADD COLUMN provenance jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(provenance) = 'object');

CREATE TABLE resolution_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ingestion_key text NOT NULL UNIQUE CHECK (btrim(ingestion_key) <> ''),
  input_fingerprint text NOT NULL,
  brand_id uuid REFERENCES brands(id),
  brand_name text NOT NULL CHECK (btrim(brand_name) <> ''),
  brand_domain text NOT NULL CHECK (brand_domain = lower(brand_domain) AND brand_domain ~ '^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$'),
  target_market text NOT NULL CHECK (target_market = 'GB'),
  resolver_version text NOT NULL CHECK (btrim(resolver_version) <> ''),
  git_commit_sha text CHECK (git_commit_sha ~ '^[0-9a-f]{40}$'),
  overall_action text NOT NULL CHECK (overall_action IN ('PROPOSE', 'REVIEW', 'UNRESOLVED', 'ERROR')),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  raw_result jsonb NOT NULL CHECK (jsonb_typeof(raw_result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX resolution_runs_brand_idx ON resolution_runs (brand_id);
CREATE INDEX resolution_runs_domain_time_idx ON resolution_runs (brand_domain, created_at DESC);

CREATE TABLE resolution_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resolution_run_id uuid NOT NULL REFERENCES resolution_runs(id),
  candidate_index integer NOT NULL CHECK (candidate_index >= 0),
  candidate_legal_name text CHECK (btrim(candidate_legal_name) <> ''),
  jurisdiction text NOT NULL CHECK (jurisdiction = 'GB'),
  company_number text CHECK (company_number ~ '^([0-9]{8}|(SC|NI|OC|RC|SO|NC|FC|BR|LP|SL|NL|IP|SP|IC|OE)[0-9]{6})$'),
  relationship_type text NOT NULL CHECK (relationship_type IN
    ('seller', 'site_operator', 'brand_operator', 'promoter', 'licensor', 'data_controller', 'service_operator', 'unknown')),
  source_url text NOT NULL CHECK (source_url ~ '^https?://'),
  retrieval_channel text NOT NULL CHECK (retrieval_channel IN ('direct_http', 'embedded_page_data', 'openai_web_search')),
  recommended_action text NOT NULL CHECK (recommended_action IN ('PROPOSE', 'REVIEW', 'UNRESOLVED', 'ERROR')),
  reason text NOT NULL,
  verification jsonb NOT NULL CHECK (jsonb_typeof(verification) = 'object'),
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
  review_notes text,
  reviewed_at timestamptz,
  approved_relationship_id uuid REFERENCES brand_entity_relationships(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (resolution_run_id, candidate_index),
  CHECK ((review_status = 'pending' AND reviewed_at IS NULL AND approved_relationship_id IS NULL)
    OR (review_status = 'rejected' AND reviewed_at IS NOT NULL AND approved_relationship_id IS NULL)
    OR (review_status = 'approved' AND reviewed_at IS NOT NULL AND approved_relationship_id IS NOT NULL))
);
CREATE INDEX resolution_candidates_pending_idx ON resolution_candidates (created_at, id) WHERE review_status = 'pending';
CREATE INDEX resolution_candidates_company_idx ON resolution_candidates (jurisdiction, company_number);

-- One RPC = one transaction. A reused key with different content fails instead of
-- replacing history or resetting human decisions. PostgreSQL canonicalises JSONB.
CREATE FUNCTION ingest_resolution_run(p_key text, p_payload jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  run_id uuid;
  fingerprint text := encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex');
  previous_fingerprint text;
  item record;
BEGIN
  IF jsonb_typeof(p_payload->'candidates') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid candidates'; END IF;
  INSERT INTO resolution_runs (ingestion_key, input_fingerprint, brand_id, brand_name, brand_domain,
    target_market, resolver_version, git_commit_sha, overall_action, reason, raw_result)
  VALUES (p_key, fingerprint, (p_payload->>'brand_id')::uuid, p_payload->>'brand_name', p_payload->>'brand_domain',
    p_payload->>'target_market', p_payload->>'resolver_version', p_payload->>'git_commit_sha',
    p_payload->>'overall_action', p_payload->>'reason', p_payload->'raw_result')
  ON CONFLICT (ingestion_key) DO NOTHING RETURNING id INTO run_id;
  IF run_id IS NULL THEN
    SELECT id, input_fingerprint INTO run_id, previous_fingerprint FROM resolution_runs WHERE ingestion_key = p_key;
    IF previous_fingerprint IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'Ingestion key already used for different input'; END IF;
    RETURN run_id;
  END IF;
  FOR item IN SELECT value, ordinality FROM jsonb_array_elements(p_payload->'candidates') WITH ORDINALITY LOOP
    INSERT INTO resolution_candidates (resolution_run_id, candidate_index, candidate_legal_name, jurisdiction,
      company_number, relationship_type, source_url, retrieval_channel, recommended_action, reason, verification, provenance)
    VALUES (run_id, item.ordinality - 1, item.value->>'candidate_legal_name', item.value->>'jurisdiction',
      item.value->>'company_number', item.value->>'relationship_type', item.value->>'source_url',
      item.value->>'retrieval_channel', item.value->>'recommended_action', item.value->>'reason',
      item.value->'verification', item.value->'provenance');
  END LOOP;
  RETURN run_id;
END;
$$;

CREATE FUNCTION approve_resolution_candidate(p_candidate uuid, p_note text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  c resolution_candidates%ROWTYPE;
  r resolution_runs%ROWTYPE;
  brand_uuid uuid;
  entity_uuid uuid;
  relationship_uuid uuid;
  matches integer;
  audit jsonb;
BEGIN
  -- Serialise repeat/conflicting decisions on this candidate.
  SELECT * INTO c FROM resolution_candidates WHERE id = p_candidate FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Candidate not found'; END IF;
  IF c.review_status = 'approved' THEN RETURN c.approved_relationship_id; END IF;
  IF c.review_status <> 'pending' THEN RAISE EXCEPTION 'Candidate already rejected'; END IF;
  SELECT * INTO r FROM resolution_runs WHERE id = c.resolution_run_id;
  IF c.relationship_type NOT IN ('seller', 'site_operator', 'brand_operator') THEN
    RAISE EXCEPTION 'Role outside UK commerce entity approval scope';
  END IF;
  IF c.company_number IS NULL OR c.candidate_legal_name IS NULL
    OR c.verification->>'registry_verified' IS DISTINCT FROM 'true'
    OR c.verification->>'registry_active' IS DISTINCT FROM 'true'
    OR c.verification->>'source_validated' IS DISTINCT FROM 'true'
    OR c.verification->>'market_context_match' IS DISTINCT FROM 'true'
    OR c.verification->>'brand_context_match' IS DISTINCT FROM 'true'
    OR c.provenance->'companies_house_match'->>'company_number' IS DISTINCT FROM c.company_number
    OR c.provenance->'companies_house_match'->>'company_name' IS DISTINCT FROM c.candidate_legal_name
    OR c.provenance->'companies_house_match'->>'company_status' IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Verified GB registry identity and attributable brand source required';
  END IF;
  IF (c.recommended_action <> 'PROPOSE' OR c.verification->>'blocking_conflict' = 'true')
    AND coalesce(btrim(p_note), '') = '' THEN RAISE EXCEPTION 'Review note required to approve a review/conflict candidate'; END IF;

  -- All workflow approvals for the same domain use the same lock order. This also
  -- prevents duplicate brands/relationships across different runs of that domain.
  PERFORM pg_advisory_xact_lock(hashtextextended(r.brand_domain, 0));
  SELECT * INTO r FROM resolution_runs WHERE id = c.resolution_run_id FOR UPDATE;
  brand_uuid := r.brand_id;
  IF brand_uuid IS NULL THEN
    SELECT count(*), (array_agg(id ORDER BY id))[1] INTO matches, brand_uuid FROM brands
    WHERE resolution_domain = r.brand_domain OR
      lower(split_part(regexp_replace(website_url, '^https?://(www\.)?', '', 'i'), '/', 1)) = r.brand_domain;
    IF matches > 1 THEN RAISE EXCEPTION 'Ambiguous existing brand; supply brand_id during ingestion'; END IF;
  END IF;
  IF brand_uuid IS NULL THEN
    INSERT INTO brands (canonical_name, website_url, resolution_domain)
      VALUES (r.brand_name, 'https://' || r.brand_domain, r.brand_domain) RETURNING id INTO brand_uuid;
  ELSE
    PERFORM 1 FROM brands WHERE id = brand_uuid FOR UPDATE;
    IF EXISTS (SELECT 1 FROM brands WHERE id = brand_uuid AND resolution_domain IS NOT NULL AND resolution_domain <> r.brand_domain) THEN
      RAISE EXCEPTION 'Brand domain mismatch';
    END IF;
    UPDATE brands SET resolution_domain = r.brand_domain WHERE id = brand_uuid;
  END IF;
  UPDATE resolution_runs SET brand_id = brand_uuid WHERE id = r.id;
  INSERT INTO legal_entities (canonical_name, jurisdiction, company_number)
    VALUES (c.candidate_legal_name, 'GB', c.company_number)
    ON CONFLICT (jurisdiction, company_number) DO UPDATE SET canonical_name = EXCLUDED.canonical_name
    RETURNING id INTO entity_uuid;
  SELECT count(*), (array_agg(id ORDER BY id))[1] INTO matches, relationship_uuid
    FROM brand_entity_relationships WHERE brand_id = brand_uuid AND legal_entity_id = entity_uuid
      AND relationship_type = c.relationship_type;
  IF matches > 1 THEN RAISE EXCEPTION 'Ambiguous existing relationships; reconcile before approval'; END IF;
  audit := jsonb_build_object('candidate_id', c.id, 'run_id', r.id, 'source_url', c.source_url,
    'review_notes', p_note, 'approved_at', now(), 'evidence', c.provenance);
  IF relationship_uuid IS NULL THEN
    INSERT INTO brand_entity_relationships (brand_id, legal_entity_id, relationship_type, source_url, source_name,
      confidence, verification_status, last_verified_at, provenance)
    VALUES (brand_uuid, entity_uuid, c.relationship_type, c.source_url, 'Human resolution review',
      1, 'human_verified', now(), jsonb_build_object('resolution_reviews', jsonb_build_array(audit)))
    RETURNING id INTO relationship_uuid;
  ELSE
    -- Lock the relationship too; append provenance rather than overwriting history.
    UPDATE brand_entity_relationships SET source_url = c.source_url, source_name = 'Human resolution review',
      confidence = 1, verification_status = 'human_verified', last_verified_at = now(),
      provenance = provenance || jsonb_build_object('resolution_reviews', coalesce(provenance->'resolution_reviews', '[]'::jsonb) || jsonb_build_array(audit))
    WHERE id = relationship_uuid;
  END IF;
  UPDATE resolution_candidates SET review_status = 'approved', review_notes = p_note,
    reviewed_at = now(), approved_relationship_id = relationship_uuid WHERE id = c.id;
  RETURN relationship_uuid;
END;
$$;

CREATE FUNCTION reject_resolution_candidate(p_candidate uuid, p_note text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE c resolution_candidates%ROWTYPE;
BEGIN
  SELECT * INTO c FROM resolution_candidates WHERE id = p_candidate FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Candidate not found'; END IF;
  IF c.review_status = 'rejected' THEN RETURN c.id; END IF;
  IF c.review_status <> 'pending' THEN RAISE EXCEPTION 'Approved candidate cannot be rejected; graph revocation is a separate action'; END IF;
  UPDATE resolution_candidates SET review_status = 'rejected', review_notes = p_note, reviewed_at = now() WHERE id = c.id;
  RETURN c.id;
END;
$$;

-- No RLS policies or browser grants. Explicitly undo possible Supabase default grants.
REVOKE ALL ON resolution_runs, resolution_candidates FROM PUBLIC;
REVOKE ALL ON FUNCTION ingest_resolution_run(text, jsonb), approve_resolution_candidate(uuid, text), reject_resolution_candidate(uuid, text) FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON resolution_runs, resolution_candidates FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION ingest_resolution_run(text, jsonb), approve_resolution_candidate(uuid, text), reject_resolution_candidate(uuid, text) FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON resolution_runs, resolution_candidates TO service_role;
    GRANT SELECT, INSERT, UPDATE ON brands, legal_entities, brand_entity_relationships TO service_role;
    GRANT EXECUTE ON FUNCTION ingest_resolution_run(text, jsonb), approve_resolution_candidate(uuid, text), reject_resolution_candidate(uuid, text) TO service_role;
  END IF;
END;
$$;
NOTIFY pgrst, 'reload schema';
COMMIT;
