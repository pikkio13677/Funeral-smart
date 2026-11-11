-- FUNERAL SMART: migrazione gestionale v1 (additiva e ripetibile)
-- Eseguire sul DATABASE_URL dopo lo schema base. Non cancella dati esistenti.

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  phone VARCHAR(40),
  email VARCHAR(254),
  address TEXT,
  notes VARCHAR(1500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS funeral_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_code VARCHAR(40) UNIQUE NOT NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  deceased_first_name VARCHAR(100) NOT NULL,
  deceased_last_name VARCHAR(100) NOT NULL,
  date_of_death DATE,
  service_type VARCHAR(80) NOT NULL,
  service_date TIMESTAMPTZ,
  location VARCHAR(180),
  destination VARCHAR(180),
  status VARCHAR(24) NOT NULL DEFAULT 'open' CHECK (status IN ('open','planned','in_progress','completed','cancelled')),
  estimated_total NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (estimated_total >= 0),
  notes VARCHAR(2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  role VARCHAR(100) NOT NULL,
  phone VARCHAR(40),
  email VARCHAR(254),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plate VARCHAR(20) UNIQUE NOT NULL,
  make_model VARCHAR(120) NOT NULL,
  vehicle_type VARCHAR(80) NOT NULL DEFAULT 'Funebre',
  status VARCHAR(24) NOT NULL DEFAULT 'available' CHECK (status IN ('available','assigned','maintenance','inactive')),
  next_maintenance DATE,
  notes VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku VARCHAR(60) UNIQUE,
  name VARCHAR(160) NOT NULL,
  category VARCHAR(100) NOT NULL,
  quantity NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  min_quantity NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (min_quantity >= 0),
  unit VARCHAR(30) NOT NULL DEFAULT 'pz',
  unit_cost NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES inventory_items(id),
  movement_type VARCHAR(12) NOT NULL CHECK (movement_type IN ('in','out')),
  quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
  reason VARCHAR(300),
  case_id UUID REFERENCES funeral_cases(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(180) NOT NULL,
  description VARCHAR(1500),
  due_date TIMESTAMPTZ,
  priority VARCHAR(12) NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  case_id UUID REFERENCES funeral_cases(id) ON DELETE SET NULL,
  assigned_to UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number VARCHAR(60) UNIQUE NOT NULL,
  case_id UUID REFERENCES funeral_cases(id) ON DELETE SET NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE,
  amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','partial','paid','overdue','cancelled')),
  notes VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  method VARCHAR(40) NOT NULL,
  reference VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_funeral_cases_status_date ON funeral_cases(status, service_date);
CREATE INDEX IF NOT EXISTS idx_funeral_cases_customer ON funeral_cases(customer_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due_date);
CREATE INDEX IF NOT EXISTS idx_stock_movements_item_date ON stock_movements(item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_status_due ON invoices(status, due_date);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
