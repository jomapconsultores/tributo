-- =============================================================================
-- Migración 021: mensajes del formulario de contacto (landing pública)
-- =============================================================================
CREATE TABLE IF NOT EXISTS contactos (
  id bigserial PRIMARY KEY,
  nombre text,
  email text,
  telefono text,
  mensaje text,
  atendido boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contactos_created ON contactos(created_at DESC);
