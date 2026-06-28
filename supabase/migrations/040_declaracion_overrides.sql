-- =============================================================================
-- Migración 040: overrides persistentes por período (crédito mes anterior + factor)
-- Para que el crédito tributario del mes anterior (605/606) y el factor de
-- proporcionalidad se guarden y se RECUPEREN automáticamente por período, sin
-- depender de guardar toda la declaración.
-- =============================================================================
CREATE TABLE IF NOT EXISTS declaracion_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tipo text NOT NULL DEFAULT 'IVA',
  mes int NOT NULL,
  anio int NOT NULL,
  credito_adq numeric,
  credito_ret numeric,
  factor_prop numeric,
  updated_at timestamptz DEFAULT now(),
  UNIQUE (client_id, tipo, mes, anio)
);
