-- =============================================================================
-- Migración 035: vigencia y documentos en el catálogo de proveedores calificados
-- =============================================================================
-- Permite adjuntar documento(s) (Excel/foto/PDF) que respaldan la calificación de
-- un proveedor y registrar hasta cuándo es válida (vigente/vencido).
ALTER TABLE rebajas_proveedores ADD COLUMN IF NOT EXISTS vigente_hasta date;
ALTER TABLE rebajas_proveedores ADD COLUMN IF NOT EXISTS documentos jsonb DEFAULT '[]'::jsonb;
