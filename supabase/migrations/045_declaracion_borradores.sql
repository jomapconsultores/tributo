-- =============================================================================
-- Migración 045: borrador automático de la declaración (por período + tipo)
-- Guarda en el servidor —a medida que el usuario trabaja— el estado de los
-- campos editables de la declaración (ventas manuales, crédito 605/606, factor,
-- rebajas/exención ICE, casillas y meses a aplazar) como un JSON, para
-- recuperarlo al reabrir desde cualquier dispositivo, SIN marcarla como oficial
-- (eso lo sigue haciendo el botón "Guardar declaración"). No marca Reportes ni
-- crea pagos aplazados.
-- =============================================================================
CREATE TABLE IF NOT EXISTS declaracion_borradores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id uuid,
  tipo text NOT NULL DEFAULT 'IVA',
  datos jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now(),
  UNIQUE (client_id, tipo)
);
