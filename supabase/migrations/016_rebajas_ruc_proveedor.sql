-- =============================================================================
-- Migración 016: RUC del proveedor en rebajas/exenciones
-- =============================================================================
ALTER TABLE rebajas_ingredientes ADD COLUMN IF NOT EXISTS ruc_proveedor text DEFAULT '';
