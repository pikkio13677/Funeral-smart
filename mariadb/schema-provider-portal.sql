-- FUNERAL SMART — schema MariaDB per marketplace e Area Imprese
-- STAGING ONLY. DDL preparato per revisione; NON eseguire automaticamente.
-- Prerequisiti: MariaDB 10.11+, database vuoto dedicato, charset utf8mb4.
-- Tutti gli identificativi UUID sono CHAR(36) ASCII con collation binaria.
-- Timestamp applicativi memorizzati in UTC (DATETIME(3)).
-- Non contiene dati demo, credenziali, utenti amministratori o invii email.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE IF NOT EXISTS app_users (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  username VARCHAR(60) NOT NULL,
  display_name VARCHAR(160) NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(24) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  email VARCHAR(254) NULL,
  email_verified_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  last_login_at DATETIME(3) NULL,
  verified_email VARCHAR(254) GENERATED ALWAYS AS (
    CASE WHEN email_verified_at IS NOT NULL THEN email ELSE NULL END
  ) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_app_users_username (username),
  UNIQUE KEY uq_app_users_verified_email (verified_email),
  CONSTRAINT ck_app_users_role CHECK (role IN ('admin','manager','operator','warehouse','accounting')),
  CONSTRAINT ck_app_users_email_normalized CHECK (email IS NULL OR email = LOWER(TRIM(email))),
  CONSTRAINT ck_app_users_email_verification CHECK (email_verified_at IS NULL OR email IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_sessions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  last_seen_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY uq_app_sessions_token_hash (token_hash),
  KEY idx_app_sessions_user (user_id),
  KEY idx_app_sessions_expiry (expires_at),
  CONSTRAINT fk_app_sessions_user FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  username VARCHAR(60) NULL,
  action VARCHAR(120) NOT NULL,
  resource VARCHAR(80) NULL,
  resource_id VARCHAR(80) NULL,
  ip_address VARCHAR(45) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  KEY idx_audit_log_created (created_at),
  KEY idx_audit_log_user (user_id, created_at),
  CONSTRAINT fk_audit_log_user FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_types (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  code VARCHAR(80) NOT NULL,
  label VARCHAR(120) NOT NULL,
  description TEXT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 100,
  PRIMARY KEY (id),
  UNIQUE KEY uq_service_types_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS providers (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_name VARCHAR(180) NOT NULL,
  vat_number VARCHAR(20) NOT NULL,
  city VARCHAR(100) NOT NULL,
  province VARCHAR(80) NULL,
  address TEXT NULL,
  email VARCHAR(254) NULL,
  phone VARCHAR(40) NULL,
  website TEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  verification_date DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY uq_providers_vat_number (vat_number),
  KEY idx_providers_city_status (city, status),
  CONSTRAINT ck_providers_status CHECK (status IN ('pending','verified','suspended','rejected')),
  CONSTRAINT ck_providers_verified_date CHECK (status <> 'verified' OR verification_date IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS provider_services (
  provider_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  service_type_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (provider_id, service_type_id),
  CONSTRAINT fk_provider_services_provider FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
  CONSTRAINT fk_provider_services_type FOREIGN KEY (service_type_id) REFERENCES service_types(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS price_lists (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  service_type_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(180) NOT NULL,
  total_euro DECIMAL(10,2) NULL,
  vat_included TINYINT(1) NULL,
  included_items JSON NOT NULL,
  excluded_items JSON NOT NULL,
  third_party_costs_note TEXT NULL,
  valid_from DATE NULL,
  valid_until DATE NULL,
  published TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  KEY idx_price_lists_provider_published (provider_id, published),
  CONSTRAINT fk_price_lists_provider FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
  CONSTRAINT fk_price_lists_service FOREIGN KEY (service_type_id) REFERENCES service_types(id) ON DELETE RESTRICT,
  CONSTRAINT ck_price_lists_total CHECK (total_euro IS NULL OR total_euro >= 0),
  CONSTRAINT ck_price_lists_dates CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS provider_applications (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_name VARCHAR(180) NOT NULL,
  vat_number VARCHAR(20) NOT NULL,
  city VARCHAR(100) NOT NULL,
  province VARCHAR(80) NOT NULL DEFAULT '',
  email VARCHAR(254) NOT NULL,
  phone VARCHAR(40) NOT NULL DEFAULT '',
  website TEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY uq_provider_applications_vat (vat_number),
  CONSTRAINT ck_provider_applications_status CHECK (status IN ('pending','approved','rejected'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inquiries (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  city VARCHAR(100) NOT NULL,
  service_type VARCHAR(80) NOT NULL,
  destination_country VARCHAR(100) NULL,
  budget_euro INT NULL,
  notes VARCHAR(1500) NULL,
  contact_email VARCHAR(254) NULL,
  contact_phone VARCHAR(40) NULL,
  privacy_consent TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'received',
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  KEY idx_inquiries_created_at (created_at),
  CONSTRAINT ck_inquiries_status CHECK (status IN ('received','reviewed','assigned','closed','deleted')),
  CONSTRAINT ck_inquiries_budget CHECK (budget_euro IS NULL OR budget_euro > 0),
  CONSTRAINT ck_inquiries_contact CHECK (contact_email IS NOT NULL OR contact_phone IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inquiry_provider_assignments (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  inquiry_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  assigned_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  assigned_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  revoked_at DATETIME(3) NULL,
  revoked_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  revocation_reason VARCHAR(500) NULL,
  active_inquiry_id CHAR(36) GENERATED ALWAYS AS (
    CASE WHEN status = 'active' THEN inquiry_id ELSE NULL END
  ) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_assignment_one_active_per_inquiry (active_inquiry_id),
  UNIQUE KEY uq_assignment_id_provider (id, provider_id),
  KEY idx_assignment_history (inquiry_id, assigned_at, id),
  KEY idx_assignment_provider (provider_id, status, assigned_at),
  CONSTRAINT fk_assignment_inquiry FOREIGN KEY (inquiry_id) REFERENCES inquiries(id) ON DELETE RESTRICT,
  CONSTRAINT fk_assignment_provider FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_assignment_assigned_by FOREIGN KEY (assigned_by_user_id) REFERENCES app_users(id) ON DELETE SET NULL,
  CONSTRAINT fk_assignment_revoked_by FOREIGN KEY (revoked_by_user_id) REFERENCES app_users(id) ON DELETE SET NULL,
  CONSTRAINT ck_assignment_status CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoked_by_user_id IS NULL AND revocation_reason IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS provider_user_access (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  role VARCHAR(24) NOT NULL DEFAULT 'provider_operator',
  status VARCHAR(20) NOT NULL DEFAULT 'invited',
  invited_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY uq_provider_user_access_provider_user (provider_id, user_id),
  KEY idx_provider_user_access_user_status (user_id, status),
  KEY idx_provider_user_access_provider_status (provider_id, status),
  CONSTRAINT fk_provider_access_provider FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_provider_access_user FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE,
  CONSTRAINT fk_provider_access_inviter FOREIGN KEY (invited_by_user_id) REFERENCES app_users(id) ON DELETE SET NULL,
  CONSTRAINT ck_provider_access_role CHECK (role IN ('provider_admin','provider_operator')),
  CONSTRAINT ck_provider_access_status CHECK (status IN ('invited','active','suspended','revoked'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS provider_user_invitations (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  email VARCHAR(254) NOT NULL,
  role VARCHAR(24) NOT NULL DEFAULT 'provider_operator',
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  invited_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  accepted_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  expires_at DATETIME(3) NOT NULL,
  accepted_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  pending_provider_id CHAR(36) GENERATED ALWAYS AS (
    CASE WHEN status = 'pending' THEN provider_id ELSE NULL END
  ) STORED,
  pending_email VARCHAR(254) GENERATED ALWAYS AS (
    CASE WHEN status = 'pending' THEN email ELSE NULL END
  ) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_provider_invitation_token_hash (token_hash),
  UNIQUE KEY uq_provider_invitation_pending_email (pending_provider_id, pending_email),
  KEY idx_provider_invitations_provider_status (provider_id, status, created_at),
  KEY idx_provider_invitations_expiry (status, expires_at),
  CONSTRAINT fk_provider_invitation_provider FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_provider_invitation_inviter FOREIGN KEY (invited_by_user_id) REFERENCES app_users(id) ON DELETE SET NULL,
  CONSTRAINT fk_provider_invitation_accepted_by FOREIGN KEY (accepted_by_user_id) REFERENCES app_users(id) ON DELETE SET NULL,
  CONSTRAINT ck_provider_invitation_role CHECK (role IN ('provider_admin','provider_operator')),
  CONSTRAINT ck_provider_invitation_status CHECK (status IN ('pending','accepted','revoked','expired')),
  CONSTRAINT ck_provider_invitation_email CHECK (email = LOWER(TRIM(email))),
  CONSTRAINT ck_provider_invitation_expiry CHECK (expires_at > created_at),
  CONSTRAINT ck_provider_invitation_timestamps CHECK (
    (status = 'accepted' AND accepted_at IS NOT NULL AND revoked_at IS NULL AND accepted_by_user_id IS NOT NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND accepted_at IS NULL AND accepted_by_user_id IS NULL)
    OR (status IN ('pending','expired') AND accepted_at IS NULL AND revoked_at IS NULL AND accepted_by_user_id IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS provider_inquiry_responses (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  assignment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(20) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  responded_by_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  responded_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  UNIQUE KEY uq_provider_response_assignment (assignment_id),
  KEY idx_provider_responses_provider (provider_id, responded_at),
  CONSTRAINT fk_provider_response_assignment_provider FOREIGN KEY (assignment_id, provider_id)
    REFERENCES inquiry_provider_assignments(id, provider_id) ON DELETE RESTRICT,
  CONSTRAINT fk_provider_response_user FOREIGN KEY (responded_by_user_id) REFERENCES app_users(id) ON DELETE SET NULL,
  CONSTRAINT ck_provider_response_status CHECK (status IN ('accepted','rejected')),
  CONSTRAINT ck_provider_response_reason CHECK (CHAR_LENGTH(TRIM(reason)) >= 10)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS provider_portal_audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  assignment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  action VARCHAR(100) NOT NULL,
  reason VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (id),
  KEY idx_provider_portal_audit_provider_created (provider_id, created_at, id),
  KEY idx_provider_portal_audit_user_created (provider_id, user_id, created_at),
  CONSTRAINT fk_provider_audit_provider FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_provider_audit_user FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE SET NULL,
  CONSTRAINT fk_provider_audit_assignment_provider FOREIGN KEY (assignment_id, provider_id)
    REFERENCES inquiry_provider_assignments(id, provider_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed tipi servizio: eseguibile più volte senza duplicare i codici.
INSERT INTO service_types (id, code, label, description, sort_order) VALUES
  (UUID(), 'burial', 'Sepoltura', 'Servizi funebri con sepoltura', 10),
  (UUID(), 'cremation', 'Cremazione', 'Servizi funebri con cremazione', 20),
  (UUID(), 'international-repatriation', 'Rimpatrio internazionale', 'Trasporto internazionale e pratiche correlate', 30),
  (UUID(), 'assistance', 'Assistenza e orientamento', 'Supporto informativo per le famiglie', 40)
ON DUPLICATE KEY UPDATE
  label = VALUES(label),
  description = VALUES(description),
  sort_order = VALUES(sort_order);

-- IMPORTANTI NOTE DI INTEGRAZIONE:
-- 1. app_users.role è il ruolo piattaforma; provider_user_access.role è il ruolo portale.
-- 2. L'accesso iniziale provider_admin deve essere creato da un flusso admin piattaforma autenticato.
-- 3. Non esiste auto-link per email: accettazione richiede app_users.email_verified_at.
-- 4. Gli inviti pending scaduti vanno marcati expired prima di crearne uno nuovo.
-- 5. Un solo incarico attivo per richiesta è garantito dall'indice su active_inquiry_id.
-- 6. Verificare che il server applicativo imposti la sessione DB UTC e che UUID() sia usato solo per gli ID.
-- 7. Questo file non abilita ENABLE_PROVIDER_PORTAL e non modifica migrate.js.
