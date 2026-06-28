-- =============================================================================
-- Migración 037: actividad económica del proveedor (desde el SRI)
-- =============================================================================
ALTER TABLE rebajas_proveedores ADD COLUMN IF NOT EXISTS actividad text;
