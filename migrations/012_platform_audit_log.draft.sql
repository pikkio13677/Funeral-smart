-- FUNERAL SMART — bozza migrazione 012: audit amministrativo piattaforma
-- STAGED / NON ESEGUITA. Dipende da 005, 010 e 011.
-- NON registrare in migrate.js e NON applicare a DATABASE_URL/Render.
CREATE TABLE IF NOT EXISTS platform_audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  actor_username VARCHAR(60),
  action VARCHAR(120) NOT NULL,
  resource VARCHAR(80) NOT NULL,
  resource_id VARCHAR(80) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_audit_resource_created
  ON platform_audit_log(resource, resource_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_actor_created
  ON platform_audit_log(actor_user_id, created_at DESC, id DESC);
-- Nessuna API UPDATE/DELETE. I privilegi append-only a livello DB restano da definire.
