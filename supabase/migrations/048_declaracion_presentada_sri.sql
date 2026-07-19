-- =============================================================================
-- Migración 048: estado "presentada / subida al SRI" de una declaración
-- Guardar la declaración (botón "Guardar declaración") ya no basta para dejar de
-- estar PENDIENTE: existe además un paso explícito de confirmar que se SUBIÓ al
-- portal del SRI. Mientras no se marque presentada, el contribuyente sigue
-- apareciendo en "Clientes pendientes". Al marcarla, deja de figurar pendiente.
-- =============================================================================
ALTER TABLE declaraciones
  ADD COLUMN IF NOT EXISTS presentada_sri boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS presentada_sri_at timestamptz;

-- Acelera el filtro de "pendientes" (declaraciones aún no subidas al SRI).
CREATE INDEX IF NOT EXISTS idx_declaraciones_presentada_sri
  ON declaraciones(client_id, tipo) WHERE presentada_sri;
