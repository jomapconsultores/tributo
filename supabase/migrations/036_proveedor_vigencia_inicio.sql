-- =============================================================================
-- Migración 036: fecha de inicio de vigencia del proveedor calificado
-- =============================================================================
-- Ya existe vigente_hasta (fin). Se agrega el inicio para registrar el rango
-- de vigencia (inicio–fin) extraído del documento / Ministerio de Producción.
ALTER TABLE rebajas_proveedores ADD COLUMN IF NOT EXISTS vigencia_inicio date;
