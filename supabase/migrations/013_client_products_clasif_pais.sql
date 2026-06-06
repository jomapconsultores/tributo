-- =============================================================================
-- Migración 013: clasificación y país en el catálogo (para el código ICE)
-- =============================================================================
ALTER TABLE client_products ADD COLUMN IF NOT EXISTS cod_clasificacion text DEFAULT '';
ALTER TABLE client_products ADD COLUMN IF NOT EXISTS cod_pais text DEFAULT '593';
