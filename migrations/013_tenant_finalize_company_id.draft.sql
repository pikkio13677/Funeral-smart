-- FUNERAL SMART — bozza migrazione 013: finalizzazione tenant
-- STAGED / NON ESEGUITA. Dipende dalle migrazioni 005–012 e da un backfill
-- esplicito, verificato su un clone ripristinato da backup.
-- NON aggiungere a migrate.js e NON eseguire su produzione senza approvazione.
--
-- Questa migrazione è il punto di non ritorno logico dello schema: rende obbligatorio
-- il proprietario aziendale per tutti i dati gestionali e sostituisce le unicità
-- globali con unicità per azienda. Non assegna automaticamente alcun record.

-- Le FK 009 sono create NOT VALID per consentire il backfill controllato.
-- Qui vengono validate esplicitamente: se esistono relazioni cross-tenant, la finalizzazione si arresta.
ALTER TABLE funeral_cases VALIDATE CONSTRAINT fk_funeral_cases_company_customer;
ALTER TABLE stock_movements VALIDATE CONSTRAINT fk_stock_movements_company_item;
ALTER TABLE stock_movements VALIDATE CONSTRAINT fk_stock_movements_company_case;
ALTER TABLE tasks VALIDATE CONSTRAINT fk_tasks_company_case;
ALTER TABLE tasks VALIDATE CONSTRAINT fk_tasks_company_staff;
ALTER TABLE invoices VALIDATE CONSTRAINT fk_invoices_company_case;
ALTER TABLE invoices VALIDATE CONSTRAINT fk_invoices_company_customer;
ALTER TABLE payments VALIDATE CONSTRAINT fk_payments_company_invoice;

DO $$
DECLARE
  tenant_table TEXT;
  missing_count BIGINT;
  required_fk_count INTEGER;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'customers', 'funeral_cases', 'staff', 'vehicles', 'inventory_items',
    'stock_movements', 'tasks', 'invoices', 'payments'
  ] LOOP
    EXECUTE format('SELECT COUNT(*) FROM public.%I WHERE company_id IS NULL', tenant_table)
      INTO missing_count;
    IF missing_count > 0 THEN
      RAISE EXCEPTION 'Tenant finalization blocked: % rows in public.% have no company_id',
        missing_count, tenant_table;
    END IF;
  END LOOP;

  SELECT COUNT(*) INTO required_fk_count
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND c.contype = 'f'
    AND c.convalidated
    AND (t.relname, c.conname) IN (
      ('funeral_cases', 'fk_funeral_cases_company_customer'),
      ('stock_movements', 'fk_stock_movements_company_item'),
      ('stock_movements', 'fk_stock_movements_company_case'),
      ('tasks', 'fk_tasks_company_case'),
      ('tasks', 'fk_tasks_company_staff'),
      ('invoices', 'fk_invoices_company_case'),
      ('invoices', 'fk_invoices_company_customer'),
      ('payments', 'fk_payments_company_invoice')
    );
  IF required_fk_count <> 8 THEN
    RAISE EXCEPTION 'Tenant finalization blocked: expected 8 validated composite foreign keys, found %',
      required_fk_count;
  END IF;

  SELECT COUNT(*) INTO required_fk_count
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND c.contype = 'f'
    AND c.convalidated
    AND c.confrelid = 'public.companies'::regclass
    AND (t.relname, c.conname) IN (
      ('customers', 'customers_company_id_fkey'),
      ('funeral_cases', 'funeral_cases_company_id_fkey'),
      ('staff', 'staff_company_id_fkey'),
      ('vehicles', 'vehicles_company_id_fkey'),
      ('inventory_items', 'inventory_items_company_id_fkey'),
      ('stock_movements', 'stock_movements_company_id_fkey'),
      ('tasks', 'tasks_company_id_fkey'),
      ('invoices', 'invoices_company_id_fkey'),
      ('payments', 'payments_company_id_fkey')
    );
  IF required_fk_count <> 9 THEN
    RAISE EXCEPTION 'Tenant finalization blocked: expected 9 validated company foreign keys, found %',
      required_fk_count;
  END IF;
END $$;

-- Prima si creano gli indici sostitutivi: i vecchi vincoli globali restano
-- attivi finché tutti i nuovi indici non sono stati creati correttamente.
CREATE UNIQUE INDEX IF NOT EXISTS uq_funeral_cases_company_case_code
  ON funeral_cases(company_id, case_code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicles_company_plate
  ON vehicles(company_id, plate);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_items_company_sku
  ON inventory_items(company_id, sku);
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_company_invoice_number
  ON invoices(company_id, invoice_number);

DO $$
DECLARE
  missing_index_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO missing_index_count
  FROM (VALUES
    ('uq_funeral_cases_company_case_code', 'funeral_cases', '(company_id, case_code)'),
    ('uq_vehicles_company_plate', 'vehicles', '(company_id, plate)'),
    ('uq_inventory_items_company_sku', 'inventory_items', '(company_id, sku)'),
    ('uq_invoices_company_invoice_number', 'invoices', '(company_id, invoice_number)')
  ) AS required(index_name, table_name, key_columns)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_class idx
    JOIN pg_index i ON i.indexrelid = idx.oid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = required.table_name
      AND idx.relname = required.index_name
      AND i.indisunique
      AND i.indisvalid
      AND pg_get_indexdef(i.indexrelid) LIKE '%' || required.key_columns || '%'
  );
  IF missing_index_count <> 0 THEN
    RAISE EXCEPTION 'Tenant finalization blocked: one or more company-scoped unique indexes are missing or invalid';
  END IF;
END $$;

-- L'unicità per azienda è ora garantita dai nuovi indici.
ALTER TABLE funeral_cases DROP CONSTRAINT IF EXISTS funeral_cases_case_code_key;
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_plate_key;
ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_sku_key;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_invoice_number_key;

-- Solo dopo il backfill verificato si rende obbligatorio il tenant.
ALTER TABLE customers ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE funeral_cases ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE staff ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE vehicles ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE inventory_items ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE stock_movements ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE tasks ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE invoices ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE payments ALTER COLUMN company_id SET NOT NULL;

-- Le tabelle di audit storiche possono conservare eventi pre-tenant con company_id NULL.
