CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS service_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(80) UNIQUE NOT NULL,
  label VARCHAR(120) NOT NULL,
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name VARCHAR(180) NOT NULL,
  vat_number VARCHAR(20) UNIQUE NOT NULL,
  city VARCHAR(100) NOT NULL,
  province VARCHAR(80),
  address TEXT,
  email VARCHAR(254),
  phone VARCHAR(40),
  website TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','suspended','rejected')),
  verification_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status <> 'verified' OR verification_date IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS provider_services (
  provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  service_type_id UUID NOT NULL REFERENCES service_types(id),
  PRIMARY KEY (provider_id, service_type_id)
);

CREATE TABLE IF NOT EXISTS price_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  service_type_id UUID NOT NULL REFERENCES service_types(id),
  title VARCHAR(180) NOT NULL,
  total_euro NUMERIC(10,2),
  vat_included BOOLEAN,
  included_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  excluded_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  third_party_costs_note TEXT,
  valid_from DATE,
  valid_until DATE,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (total_euro IS NULL OR total_euro >= 0),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from)
);

CREATE TABLE IF NOT EXISTS provider_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name VARCHAR(180) NOT NULL,
  vat_number VARCHAR(20) UNIQUE NOT NULL,
  city VARCHAR(100) NOT NULL,
  province VARCHAR(80) NOT NULL DEFAULT '',
  email VARCHAR(254) NOT NULL,
  phone VARCHAR(40) NOT NULL DEFAULT '',
  website TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city VARCHAR(100) NOT NULL,
  service_type VARCHAR(80) NOT NULL,
  destination_country VARCHAR(100),
  budget_euro INTEGER,
  notes VARCHAR(1500),
  contact_email VARCHAR(254),
  contact_phone VARCHAR(40),
  privacy_consent BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(20) NOT NULL DEFAULT 'received' CHECK (status IN ('received','reviewed','assigned','closed','deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (budget_euro IS NULL OR budget_euro > 0),
  CHECK (contact_email IS NOT NULL OR contact_phone IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_providers_city_status ON providers (city, status);
CREATE INDEX IF NOT EXISTS idx_price_lists_provider_published ON price_lists (provider_id, published);
CREATE INDEX IF NOT EXISTS idx_inquiries_created_at ON inquiries (created_at DESC);

INSERT INTO service_types (code, label, description, sort_order) VALUES
 ('burial','Sepoltura','Servizi funebri con sepoltura',10),
 ('cremation','Cremazione','Servizi funebri con cremazione',20),
 ('international-repatriation','Rimpatrio internazionale','Trasporto internazionale e pratiche correlate',30),
 ('assistance','Assistenza e orientamento','Supporto informativo per le famiglie',40)
ON CONFLICT (code) DO NOTHING;
