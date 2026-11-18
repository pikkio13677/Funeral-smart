-- FUNERAL SMART — bozza migrazione 009: integrità referenziale tra aziende
-- Dipende dalle bozze 005, 006 e 007.
-- NON ESEGUIRE IN PRODUZIONE. Applicare solo a un clone ripristinato e dopo
-- aver verificato il backfill. Le FK NOT VALID proteggono subito le nuove
-- scritture ma consentono di bonificare e validare in una fase successiva.
--
-- I target (company_id, id) devono essere univoci per poter essere referenziati
-- da FK composte. Gli indici non parziali sono intenzionali: company_id è ancora
-- nullable durante la fase di transizione.

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

-- Indici lato figlio per controlli FK e join tenant-aware.
CREATE INDEX IF NOT EXISTS idx_funeral_cases_company_customer
  ON funeral_cases(company_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_company_item
  ON stock_movements(company_id, item_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_company_case
  ON stock_movements(company_id, case_id);
CREATE INDEX IF NOT EXISTS idx_tasks_company_case
  ON tasks(company_id, case_id);
CREATE INDEX IF NOT EXISTS idx_tasks_company_staff
  ON tasks(company_id, assigned_to);
CREATE INDEX IF NOT EXISTS idx_invoices_company_case
  ON invoices(company_id, case_id);
CREATE INDEX IF NOT EXISTS idx_invoices_company_customer
  ON invoices(company_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_company_invoice
  ON payments(company_id, invoice_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_funeral_cases_company_customer' AND conrelid = 'public.funeral_cases'::regclass) THEN
    ALTER TABLE funeral_cases ADD CONSTRAINT fk_funeral_cases_company_customer
      FOREIGN KEY (company_id, customer_id) REFERENCES customers(company_id, id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_stock_movements_company_item' AND conrelid = 'public.stock_movements'::regclass) THEN
    ALTER TABLE stock_movements ADD CONSTRAINT fk_stock_movements_company_item
      FOREIGN KEY (company_id, item_id) REFERENCES inventory_items(company_id, id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_stock_movements_company_case' AND conrelid = 'public.stock_movements'::regclass) THEN
    ALTER TABLE stock_movements ADD CONSTRAINT fk_stock_movements_company_case
      FOREIGN KEY (company_id, case_id) REFERENCES funeral_cases(company_id, id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tasks_company_case' AND conrelid = 'public.tasks'::regclass) THEN
    ALTER TABLE tasks ADD CONSTRAINT fk_tasks_company_case
      FOREIGN KEY (company_id, case_id) REFERENCES funeral_cases(company_id, id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tasks_company_staff' AND conrelid = 'public.tasks'::regclass) THEN
    ALTER TABLE tasks ADD CONSTRAINT fk_tasks_company_staff
      FOREIGN KEY (company_id, assigned_to) REFERENCES staff(company_id, id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_company_case' AND conrelid = 'public.invoices'::regclass) THEN
    ALTER TABLE invoices ADD CONSTRAINT fk_invoices_company_case
      FOREIGN KEY (company_id, case_id) REFERENCES funeral_cases(company_id, id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_company_customer' AND conrelid = 'public.invoices'::regclass) THEN
    ALTER TABLE invoices ADD CONSTRAINT fk_invoices_company_customer
      FOREIGN KEY (company_id, customer_id) REFERENCES customers(company_id, id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payments_company_invoice' AND conrelid = 'public.payments'::regclass) THEN
    ALTER TABLE payments ADD CONSTRAINT fk_payments_company_invoice
      FOREIGN KEY (company_id, invoice_id) REFERENCES invoices(company_id, id) NOT VALID;
  END IF;
END $$;

-- Dopo il backfill, i conteggi e la verifica di ogni relazione cross-tenant:
-- ALTER TABLE funeral_cases VALIDATE CONSTRAINT fk_funeral_cases_company_customer;
-- ALTER TABLE stock_movements VALIDATE CONSTRAINT fk_stock_movements_company_item;
-- ALTER TABLE stock_movements VALIDATE CONSTRAINT fk_stock_movements_company_case;
-- ALTER TABLE tasks VALIDATE CONSTRAINT fk_tasks_company_case;
-- ALTER TABLE tasks VALIDATE CONSTRAINT fk_tasks_company_staff;
-- ALTER TABLE invoices VALIDATE CONSTRAINT fk_invoices_company_case;
-- ALTER TABLE invoices VALIDATE CONSTRAINT fk_invoices_company_customer;
-- ALTER TABLE payments VALIDATE CONSTRAINT fk_payments_company_invoice;
--
-- Solo dopo la validazione, rendere NOT NULL le colonne company_id e pianificare
-- la rimozione delle vecchie FK singole che hanno semantiche ON DELETE meno
-- restrittive. Non validare o rendere NOT NULL automaticamente in questo file.
