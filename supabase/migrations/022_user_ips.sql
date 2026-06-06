-- =============================================================================
-- Migración 022: IPs por usuario (máximo permitido por cuenta)
-- =============================================================================
CREATE TABLE IF NOT EXISTS user_ips (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  ip text NOT NULL,
  last_seen timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  UNIQUE (user_id, ip)
);
CREATE INDEX IF NOT EXISTS idx_user_ips_user ON user_ips(user_id);
