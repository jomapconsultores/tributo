-- =============================================================================
-- Migración 034: catálogo reutilizable de proveedores (RUC → calificado)
-- =============================================================================
-- Guarda cada RUC verificado una vez (por contribuyente) con su nombre y si está
-- calificado (MIPYME/artesano) en el Ministerio de Producción, para reutilizarlo
-- y autocompletar sin volver a consultar. Verificación por lote actualiza calificado.
CREATE TABLE IF NOT EXISTS rebajas_proveedores (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid,
  identificacion text NOT NULL,
  ruc text NOT NULL,
  nombre text DEFAULT '',
  calificado boolean DEFAULT false,
  categoria text DEFAULT '',
  vigencia text DEFAULT '',
  verificado_at timestamptz,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT rebajas_proveedores_unique UNIQUE (user_id, identificacion, ruc)
);

CREATE INDEX IF NOT EXISTS idx_rebajas_prov_ident ON rebajas_proveedores(identificacion);
