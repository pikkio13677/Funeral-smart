-- FUNERAL SMART — bozza migrazione 008: integrità referenziale tenant-aware
-- DIPENDE da 005, 006 e 007. Non registrare in migrate.js.
-- Applicare solo su PostgreSQL temporaneo o clone ripristinato, dopo il backfill verificato.
-- company_id resta nullable in questa fase per consentire il backfill graduale.
-- Le FK composte impediscono che una riga di un'azienda punti a record di un'altra.

-- Chiavi candidate: PostgreSQL richiede una chiave univoca che includa l'azienda.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_company_id_id
  ON customers(company_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_funeral_cases_company_id_id
  ON funeral_cases(company_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_company_id_id
  ON staff(company_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_items_company_id_id
  ON inventory_items(company_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_company_id_id
  ON invoices(company_id, id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_funeral_cases_tenant_customer' AND conrelid='public.funeral_cases'::regclass) THEN
    ALTER TABLE funeral_cases ADD CONSTRAINT fk_funeral_cases_tenant_customer
      FOREIGN KEY (company_id, customer_id)
      REFERENCES customers(company_id, id)
      MATCH SIMPLE ON UPDATE RESTRICT ON DELETE SET NULL (customer_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_stock_movements_tenant_item' AND conrelid='public.stock_movements'::regclass) THEN
    ALTER TABLE stock_movements ADD CONSTRAINT fk_stock_movements_tenant_item
      FOREIGN KEY (company_id, item_id)
      REFERENCES inventory_items(company_id, id)
      MATCH SIMPLE ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_stock_movements_tenant_case' AND conrelid='public.stock_movements'::regclass) THEN
    ALTER TABLE stock_movements ADD CONSTRAINT fk_stock_movements_tenant_case
      FOREIGN KEY (company_id, case_id)
      REFERENCES funeral_cases(company_id, id)
      MATCH SIMPLE ON UPDATE RESTRICT ON DELETE SET NULL (case_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_tasks_tenant_case' AND conrelid='public.tasks'::regclass) THEN
    ALTER TABLE tasks ADD CONSTRAINT fk_tasks_tenant_case
      FOREIGN KEY (company_id, case_id)
      REFERENCES funeral_cases(company_id, id)
      MATCH SIMPLE ON UPDATE RESTRICT ON DELETE SET NULL (case_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_tasks_tenant_staff' AND conrelid='public.tasks'::regclass) THEN
    ALTER TABLE tasks ADD CONSTRAINT fk_tasks_tenant_staff
      FOREIGN KEY (company_id, assigned_to)
      REFERENCES staff(company_id, id)
      MATCH SIMPLE ON UPDATE RESTRICT ON DELETE SET NULL (assigned_to);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_invoices_tenant_case' AND conrelid='public.invoices'::regclass) THEN
    ALTER TABLE invoices ADD CONSTRAINT fk_invoices_tenant_case
      FOREIGN KEY (company_id, case_id)
      REFERENCES funeral_cases(company_id, id)
      MATCH SIMPLE ON UPDATE RESTRICT ON DELETE SET NULL (case_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_invoices_tenant_customer' AND conrelid='public.invoices'::regclass) THEN
    ALTER TABLE invoices ADD CONSTRAINT fk_invoices_tenant_customer
      FOREIGN KEY (company_id, customer_id)
      REFERENCES customers(company_id, id)
      MATCH SIMPLE ON UPDATE RESTRICT ON DELETE SET NULL (customer_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_payments_tenant_invoice' AND conrelid='public.payments'::regclass) THEN
    ALTER TABLE payments ADD CONSTRAINT fk_payments_tenant_invoice
      FOREIGN KEY (company_id, invoice_id)
      REFERENCES invoices(company_id, id)
      MATCH SIMPLE ON UPDATE RESTRICT ON DELETE CASCADE;
  END IF;
END $$;

-- Indici di supporto per join, cancellazioni e controlli referenziali.
CREATE INDEX IF NOT EXISTS idx_funeral_cases_company_customer
  ON funeral_cases(company_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_movements_company_item
  ON stock_movements(company_id, item_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_company_case
  ON stock_movements(company_id, case_id) WHERE case_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_company_case
  ON tasks(company_id, case_id) WHERE case_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_company_staff
  ON tasks(company_id, assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_company_case
  ON invoices(company_id, case_id) WHERE case_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_company_customer
  ON invoices(company_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_company_invoice
  ON payments(company_id, invoice_id);

-- Prima di rendere company_id NOT NULL occorre completare il backfill e verificare
-- che nessuna riga gestionale rimanga senza azienda. Questo file non lo fa.
