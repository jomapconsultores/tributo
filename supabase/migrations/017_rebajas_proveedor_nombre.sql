-- =============================================================================
-- Migración 017: nombre de empresa/persona del proveedor en rebajas/exenciones
-- =============================================================================
ALTER TABLE rebajas_ingredientes ADD COLUMN IF NOT EXISTS proveedor_nombre text DEFAULT '';
