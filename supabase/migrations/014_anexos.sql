-- =============================================================================
-- Migración 014: Anexos PVP/ICE guardados por cliente / período
-- =============================================================================
CREATE TABLE IF NOT EXISTS anexos (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  user_id uuid,
  tipo text,             -- ICE | PVP
  datos jsonb,           -- { tipo, header, rows }
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_anexos_client_id ON anexos(client_id);
