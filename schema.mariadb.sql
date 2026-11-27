-- FUNERAL SMART - schema iniziale MariaDB 10.11
-- File di preparazione: NON viene eseguito automaticamente.
-- Applicare solo a un database MariaDB vuoto e di staging dopo backup e verifica.
-- Le tabelle tenant/multi-azienda restano escluse: ENABLE_MULTI_TENANT non va attivato.

CREATE TABLE IF NOT EXISTS schema_migrations (
  id VARCHAR(120) NOT NULL PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_types (
  id CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  code VARCHAR(80) NOT NULL UNIQUE,
  label VARCHAR(120) NOT NULL,
  description TEXT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 100
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS providers (
  id CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  business_name VARCHAR(180) NOT NULL,
  vat_number VARCHAR(20) NOT NULL UNIQUE,
  city VARCHAR(100) NOT NULL,
  province VARCHAR(80) NULL,
  address TEXT NULL,
  email VARCHAR(254) NULL,
  phone VARCHAR(40) NULL,
  website TEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  verification_date DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_providers_status CHECK (status IN ('pending','verified','suspended','rejected')),
  CONSTRAINT chk_providers_verified_date CHECK (status <> 'verified' OR verification_date IS NOT NULL),
  KEY idx_providers_city_status (city, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS provider_services (
  provider_id CHAR(36) NOT NULL,
  service_type_id CHAR(36) NOT NULL,
  PRIMARY KEY (provider_id, service_type_id),
  CONSTRAINT fk_provider_services_provider FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
  CONSTRAINT fk_provider_services_service FOREIGN KEY (service_type_id) REFERENCES service_types(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS price_lists (
  id CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  provider_id CHAR(36) NOT NULL,
  service_type_id CHAR(36) NOT NULL,
  title VARCHAR(180) NOT NULL,
  total_euro DECIMAL(10,2) NULL,
  vat_included BOOLEAN NULL,
  included_items JSON NOT NULL DEFAULT ('[]'),
  excluded_items JSON NOT NULL DEFAULT ('[]'),
  third_party_costs_note TEXT NULL,
  valid_from DATE NULL,
  valid_until DATE NULL,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_price_lists_total CHECK (total_euro IS NULL OR total_euro >= 0),
  CONSTRAINT chk_price_lists_dates CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from),
  CONSTRAINT fk_price_lists_provider FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
  CONSTRAINT fk_price_lists_service FOREIGN KEY (service_type_id) REFERENCES service_types(id),
  KEY idx_price_lists_provider_published (provider_id, published)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS provider_applications (
  id CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  business_name VARCHAR(180) NOT NULL,
  vat_number VARCHAR(20) NOT NULL UNIQUE,
  city VARCHAR(100) NOT NULL,
  province VARCHAR(80) NOT NULL DEFAULT '',
  email VARCHAR(254) NOT NULL,
  phone VARCHAR(40) NOT NULL DEFAULT '',
  website TEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_provider_applications_status CHECK (status IN ('pending','approved','rejected'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inquiries (
  id CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  city VARCHAR(100) NOT NULL,
  service_type VARCHAR(80) NOT NULL,
  destination_country VARCHAR(100) NULL,
  budget_euro INT NULL,
  notes VARCHAR(1500) NULL,
  contact_email VARCHAR(254) NULL,
  contact_phone VARCHAR(40) NULL,
  privacy_consent BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(20) NOT NULL DEFAULT 'received',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_inquiries_status CHECK (status IN ('received','reviewed','assigned','closed','deleted')),
  CONSTRAINT chk_inquiries_budget CHECK (budget_euro IS NULL OR budget_euro > 0),
  CONSTRAINT chk_inquiries_contact CHECK (contact_email IS NOT NULL OR contact_phone IS NOT NULL),
  KEY idx_inquiries_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS customers (
  id CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  phone VARCHAR(40) NULL,
  email VARCHAR(254) NULL,
  address TEXT NULL,
  notes VARCHAR(1500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS funeral_cases (
  id CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  case_code VARCHAR(40) NOT NULL UNIQUE,
  customer_id CHAR(36) NULL,
  deceased_first_name VARCHAR(100) NOT NULL,
  deceased_last_name VARCHAR(100) NOT NULL,
  date_of_death DATE NULL,
  service_type VARCHAR(80) NOT NULL,
  service_date DATETIME(3) NULL,
  location VARCHAR(180) NULL,
  destination VARCHAR(180) NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'open',
  estimated_total DECIMAL(10,2) NOT NULL DEFAULT 0,
  notes VARCHAR(2000) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_funeral_cases_status CHECK (status IN ('open','planned','in_progress','completed','cancelled')),
  CONSTRAINT chk_funeral_cases_total CHECK (estimated_total >= 0),
  CONSTRAINT fk_funeral_cases_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  KEY idx_funeral_cases_status_date (status, service_date),
  KEY idx_funeral_cases_customer (customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS staff (
  id CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  role VARCHAR(100) NOT NULL,
  phone VARCHAR(40) NULL,
  email VARCHAR(254) NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_staff_name (last_name, first_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS vehicles (
  id CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  plate VARCHAR(20) NOT NULL UNIQUE,
  make_model VARCHAR(120) NOT NULL,
  vehicle_type VARCHAR(80) NOT NULL DEFAULT 'Funebre',
  status VARCHAR(24) NOT NULL DEFAULT 'available',
  next_maintenance DATE NULL,
  notes VARCHAR(1000) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_vehicles_status CHECK (status IN ('available','assigned','maintenance','inactive'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inventory_items (
  id CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  sku VARCHAR(60) NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  category VARCHAR(100) NOT NULL,
  quantity DECIMAL(12,2) NOT NULL DEFAULT 0,
  min_quantity DECIMAL(12,2) NOT NULL DEFAULT 0,
  unit VARCHAR(30) NOT NULL DEFAULT 'pz',
  unit_cost DECIMAL(10,2) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_inventory_quantity CHECK (quantity >= 0),
  CONSTRAINT chk_inventory_min_quantity CHECK (min_quantity >= 0),
  CONSTRAINT chk_inventory_unit_cost CHECK (unit_cost >= 0),
  KEY idx_inventory_category_name (category, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_movements (
  id CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  item_id CHAR(36) NOT NULL,
  movement_type VARCHAR(12) NOT NULL,
  quantity DECIMAL(12,2) NOT NULL,
  reason VARCHAR(300) NULL,
  case_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_stock_movement_type CHECK (movement_type IN ('in','out')),
  CONSTRAINT chk_stock_movement_quantity CHECK (quantity > 0),
  CONSTRAINT fk_stock_movements_item FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  CONSTRAINT fk_stock_movements_case FOREIGN KEY (case_id) REFERENCES funeral_cases(id) ON DELETE SET NULL,
  KEY idx_stock_movements_item_date (item_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tasks (
  id CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  title VARCHAR(180) NOT NULL,
  description VARCHAR(1500) NULL,
  due_date DATETIME(3) NULL,
  priority VARCHAR(12) NOT NULL DEFAULT 'normal',
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  case_id CHAR(36) NULL,
  assigned_to CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_tasks_priority CHECK (priority IN ('low','normal','high','urgent')),
  CONSTRAINT chk_tasks_status CHECK (status IN ('open','in_progress','done','cancelled')),
  CONSTRAINT fk_tasks_case FOREIGN KEY (case_id) REFERENCES funeral_cases(id) ON DELETE SET NULL,
  CONSTRAINT fk_tasks_staff FOREIGN KEY (assigned_to) REFERENCES staff(id) ON DELETE SET NULL,
  KEY idx_tasks_status_due (status, due_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS invoices (
  id CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  invoice_number VARCHAR(60) NOT NULL UNIQUE,
  case_id CHAR(36) NULL,
  customer_id CHAR(36) NULL,
  issue_date DATE NOT NULL DEFAULT (CURRENT_DATE),
  due_date DATE NULL,
  amount DECIMAL(10,2) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  notes VARCHAR(1000) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_invoices_status CHECK (status IN ('draft','issued','partial','paid','overdue','cancelled')),
  CONSTRAINT chk_invoices_amount CHECK (amount >= 0),
  CONSTRAINT fk_invoices_case FOREIGN KEY (case_id) REFERENCES funeral_cases(id) ON DELETE SET NULL,
  CONSTRAINT fk_invoices_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  KEY idx_invoices_status_due (status, due_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payments (
  id CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  invoice_id CHAR(36) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  payment_date DATE NOT NULL DEFAULT (CURRENT_DATE),
  method VARCHAR(40) NOT NULL,
  reference VARCHAR(120) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_payments_amount CHECK (amount > 0),
  CONSTRAINT fk_payments_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  KEY idx_payments_invoice (invoice_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_users (
  id CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  username VARCHAR(60) NOT NULL UNIQUE,
  display_name VARCHAR(160) NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(24) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  last_login_at DATETIME(3) NULL,
  totp_secret_enc TEXT NULL,
  totp_pending_secret_enc TEXT NULL,
  totp_enabled_at DATETIME(3) NULL,
  recovery_codes_hashes JSON NULL,
  CONSTRAINT chk_app_users_role CHECK (role IN ('admin','manager','operator','warehouse','accounting'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_sessions (
  id CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_app_sessions_user FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE,
  KEY idx_app_sessions_user (user_id),
  KEY idx_app_sessions_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NULL,
  username VARCHAR(60) NULL,
  action VARCHAR(120) NOT NULL,
  resource VARCHAR(80) NULL,
  resource_id VARCHAR(80) NULL,
  ip_address VARCHAR(45) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_audit_log_user FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE SET NULL,
  KEY idx_audit_log_created (created_at),
  KEY idx_audit_log_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_mfa_challenges (
  id CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME(3) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_app_mfa_challenges_user FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE,
  KEY idx_app_mfa_challenges_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO service_types (code, label, description, sort_order) VALUES
 ('burial','Sepoltura','Servizi funebri con sepoltura',10),
 ('cremation','Cremazione','Servizi funebri con cremazione',20),
 ('international-repatriation','Rimpatrio internazionale','Trasporto internazionale e pratiche correlate',30),
 ('cremation-burial','Cremazione + sepoltura','Cremazione con successiva sepoltura delle ceneri',35),
 ('assistance','Assistenza e orientamento','Supporto informativo per le famiglie',40)
ON DUPLICATE KEY UPDATE code = VALUES(code);
