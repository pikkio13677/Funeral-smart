-- FUNERAL SMART — bozza migrazione 005: fondamenta multi-azienda
-- STAGED / NON ESEGUITA: NON inserirla in migrate.js e NON applicarla a DATABASE_URL.
-- Prima dell'esecuzione: backup PostgreSQL verificato, restore su copia e approvazione del piano di backfill.
-- Questa bozza è volutamente additiva: crea tabelle e colonne nullable, senza assegnare dati esistenti.

CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name VARCHAR(180) NOT NULL,
  vat_number VARCHAR(20),
  address TEXT,
  city VARCHAR(100),
  province VARCHAR(80),
  email VARCHAR(254),
  phone VARCHAR(40),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'closed')),
  plan_code VARCHAR(40) NOT NULL DEFAULT 'trial',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- La partita IVA può essere assente durante la configurazione iniziale.
-- L'unicità normalizzata sarà aggiunta dopo aver definito la gestione di sedi e gruppi societari.
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);

CREATE TABLE IF NOT EXISTS company_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role VARCHAR(24) NOT NULL
    CHECK (role IN ('admin', 'manager', 'operator', 'warehouse', 'accounting')),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'invited', 'suspended', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_company_memberships_user_status
  ON company_memberships(user_id, status);
CREATE INDEX IF NOT EXISTS idx_company_memberships_company_status
  ON company_memberships(company_id, status);

-- Fase di transizione: nullable finché non è stato eseguito e verificato il backfill.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE funeral_cases ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_customers_company ON customers(company_id);
CREATE INDEX IF NOT EXISTS idx_funeral_cases_company ON funeral_cases(company_id);
CREATE INDEX IF NOT EXISTS idx_staff_company ON staff(company_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_company ON vehicles(company_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_company ON inventory_items(company_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_company ON stock_movements(company_id);
CREATE INDEX IF NOT EXISTS idx_tasks_company ON tasks(company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_payments_company ON payments(company_id);

-- Codici pratica, numeri fattura e SKU sono univoci all'interno dell'azienda,
-- non a livello globale. La targa resta globalmente univoca perché identifica
-- un veicolo fisico e non deve essere duplicata tra imprese.
ALTER TABLE funeral_cases DROP CONSTRAINT IF EXISTS funeral_cases_case_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_funeral_cases_company_case_code
  ON funeral_cases(company_id, case_code)
  WHERE company_id IS NOT NULL;

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_invoice_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_company_invoice_number
  ON invoices(company_id, invoice_number)
  WHERE company_id IS NOT NULL;

ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_sku_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_items_company_sku
  ON inventory_items(company_id, sku)
  WHERE company_id IS NOT NULL AND sku IS NOT NULL;



-- PASSI ANCORA NECESSARI PRIMA DI RENDERE company_id NOT NULL:
-- 1. Creare/identificare l'azienda proprietaria dei dati già presenti.
-- 2. Associare i record esistenti a tale azienda in transazione con conteggi prima/dopo.
-- 3. Verificare tutte le relazioni (customer/case/item/invoice/payment/task/staff) nello stesso tenant.
-- 4. Aggiornare tutte le query e rotte affinché filtrino il tenant ricavato dalla membership server-side.
-- 5. Aggiungere vincoli compositi per impedire riferimenti incrociati tra aziende.
-- 6. Solo allora rendere company_id NOT NULL e valutare Row Level Security.
-- 7. Aggiungere questo file a migrate.js solo dopo restore-test, test automatici e revisione.
