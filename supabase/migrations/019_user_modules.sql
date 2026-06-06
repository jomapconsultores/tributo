-- =============================================================================
-- Migración 019: módulos contratados por usuario (Fase 2 multi-tenant)
-- =============================================================================
CREATE TABLE IF NOT EXISTS user_modules (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  modulo text NOT NULL,
  activo boolean DEFAULT true,
  valid_until date,
  created_at timestamptz DEFAULT now(),
  UNIQUE (user_id, modulo)
);
CREATE INDEX IF NOT EXISTS idx_user_modules_user ON user_modules(user_id);

CREATE TABLE IF NOT EXISTS app_admins (
  user_id uuid PRIMARY KEY,
  created_at timestamptz DEFAULT now()
);
