-- =============================================================================
-- Migración 008: DECLARACIONES (IVA / ICE) guardadas por cliente / período
-- =============================================================================
CREATE TABLE IF NOT EXISTS declaraciones (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  user_id uuid,
  tipo text NOT NULL,            -- IVA | ICE
  anio integer,
  mes integer,
  datos jsonb,                   -- snapshot de filas codigo->valor + resumen
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_declaraciones_client_id ON declaraciones(client_id);
