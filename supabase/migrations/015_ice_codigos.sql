-- =============================================================================
-- Migración 015: catálogo de Códigos ICE del SRI en la base (búsqueda/actualización)
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE IF NOT EXISTS ice_codigos (
  id bigserial PRIMARY KEY,
  impuesto text,
  impuesto_nombre text,
  clasif_cod text,
  clasificacion text,
  marca text,
  descripcion text
);
CREATE INDEX IF NOT EXISTS idx_ice_codigos_imp ON ice_codigos(impuesto);
CREATE INDEX IF NOT EXISTS idx_ice_codigos_desc ON ice_codigos USING gin (descripcion gin_trgm_ops);
