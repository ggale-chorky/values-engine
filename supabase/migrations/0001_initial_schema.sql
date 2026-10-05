-- Canonical products, ownership provenance, factual evidence and purchasing policies.
-- This migration intentionally contains no auth integration or RLS policies.
BEGIN;

CREATE TABLE legal_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name text NOT NULL CHECK (btrim(canonical_name) <> ''),
  jurisdiction text NOT NULL CHECK (btrim(jurisdiction) <> ''),
  company_number text CHECK (btrim(company_number) <> ''),
  lei text CHECK (btrim(lei) <> ''),
  website_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX legal_entities_jurisdiction_company_number_unique
  ON legal_entities (jurisdiction, company_number) WHERE company_number IS NOT NULL;
CREATE UNIQUE INDEX legal_entities_lei_unique
  ON legal_entities (lei) WHERE lei IS NOT NULL;

CREATE TABLE brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name text NOT NULL CHECK (btrim(canonical_name) <> ''),
  website_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE brand_entity_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  relationship_type text NOT NULL CHECK (btrim(relationship_type) <> ''),
  source_url text NOT NULL CHECK (btrim(source_url) <> ''),
  source_name text NOT NULL CHECK (btrim(source_name) <> ''),
  confidence numeric NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  verification_status text NOT NULL DEFAULT 'candidate'
    CHECK (verification_status IN ('candidate', 'human_verified', 'auto_verified', 'rejected')),
  valid_from date,
  valid_to date,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE INDEX brand_entity_relationships_brand_idx ON brand_entity_relationships (brand_id);
CREATE INDEX brand_entity_relationships_entity_idx ON brand_entity_relationships (legal_entity_id);

CREATE TABLE legal_entity_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  parent_legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  relationship_type text NOT NULL CHECK (btrim(relationship_type) <> ''),
  source_url text NOT NULL CHECK (btrim(source_url) <> ''),
  source_name text NOT NULL CHECK (btrim(source_name) <> ''),
  confidence numeric NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  verification_status text NOT NULL DEFAULT 'candidate'
    CHECK (verification_status IN ('candidate', 'human_verified', 'auto_verified', 'rejected')),
  valid_from date,
  valid_to date,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (child_legal_entity_id <> parent_legal_entity_id),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE INDEX legal_entity_relationships_child_idx ON legal_entity_relationships (child_legal_entity_id);
CREATE INDEX legal_entity_relationships_parent_idx ON legal_entity_relationships (parent_legal_entity_id);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name text NOT NULL CHECK (btrim(canonical_name) <> ''),
  brand_id uuid REFERENCES brands(id),
  gtin text CHECK (gtin ~ '^([0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$'),
  mpn text,
  variant text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX products_gtin_unique ON products (gtin) WHERE gtin IS NOT NULL;
CREATE INDEX products_brand_idx ON products (brand_id);

CREATE TABLE offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  retailer_name text NOT NULL CHECK (btrim(retailer_name) <> ''),
  retailer_sku text,
  url text NOT NULL CHECK (btrim(url) <> ''),
  price numeric(14, 4) CHECK (price >= 0),
  currency text NOT NULL DEFAULT 'GBP' CHECK (currency ~ '^[A-Z]{3}$'),
  availability text NOT NULL DEFAULT 'unknown'
    CHECK (availability IN ('in_stock', 'out_of_stock', 'preorder', 'backorder', 'unknown')),
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX offers_product_idx ON offers (product_id);

CREATE TABLE evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid REFERENCES products(id),
  brand_id uuid REFERENCES brands(id),
  legal_entity_id uuid REFERENCES legal_entities(id),
  claim_type text NOT NULL CHECK (btrim(claim_type) <> ''),
  value_numeric numeric,
  value_text text,
  value_boolean boolean,
  unit text,
  source_name text NOT NULL CHECK (btrim(source_name) <> ''),
  source_url text NOT NULL CHECK (btrim(source_url) <> ''),
  source_type text NOT NULL CHECK (btrim(source_type) <> ''),
  reporting_period text,
  observed_at timestamptz,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  confidence numeric NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  verification_status text NOT NULL DEFAULT 'candidate'
    CHECK (verification_status IN ('candidate', 'human_verified', 'auto_verified', 'rejected')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_exactly_one_subject CHECK (num_nonnulls(product_id, brand_id, legal_entity_id) = 1),
  CONSTRAINT evidence_exactly_one_value CHECK (num_nonnulls(value_numeric, value_text, value_boolean) = 1)
);
CREATE INDEX evidence_product_claim_idx ON evidence (product_id, claim_type) WHERE product_id IS NOT NULL;
CREATE INDEX evidence_brand_claim_idx ON evidence (brand_id, claim_type) WHERE brand_id IS NOT NULL;
CREATE INDEX evidence_entity_claim_idx ON evidence (legal_entity_id, claim_type) WHERE legal_entity_id IS NOT NULL;

CREATE TABLE policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  name text NOT NULL CHECK (btrim(name) <> ''),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE policy_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES policies(id),
  criterion text NOT NULL CHECK (btrim(criterion) <> ''),
  operator text NOT NULL CHECK (operator IN ('<', '<=', '=', '!=', '>=', '>')),
  threshold_numeric numeric,
  threshold_text text,
  -- REQUIRE makes an unmet rule a failure; PREFER expresses a soft preference.
  action text NOT NULL DEFAULT 'REQUIRE' CHECK (action IN ('REQUIRE', 'PREFER')),
  unknown_handling text NOT NULL DEFAULT 'UNKNOWN' CHECK (unknown_handling IN ('UNKNOWN', 'FAIL')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(threshold_numeric, threshold_text) = 1),
  CHECK (operator IN ('=', '!=') OR threshold_numeric IS NOT NULL)
);
CREATE INDEX policy_rules_policy_idx ON policy_rules (policy_id);

CREATE TABLE evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  policy_id uuid NOT NULL REFERENCES policies(id),
  overall_status text NOT NULL DEFAULT 'UNKNOWN'
    CHECK (overall_status IN ('PASS', 'FAIL', 'UNKNOWN', 'PREFER')),
  results jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(results) = 'object'),
  evaluated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evaluations_product_policy_time_idx ON evaluations (product_id, policy_id, evaluated_at DESC);
CREATE INDEX evaluations_policy_idx ON evaluations (policy_id);

-- Maintain updated_at for mutable canonical records and policies.
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER legal_entities_updated_at BEFORE UPDATE ON legal_entities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER brands_updated_at BEFORE UPDATE ON brands
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER products_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER policies_updated_at BEFORE UPDATE ON policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
