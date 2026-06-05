-- =============================================================================
-- Migración 011: código SRI individual y codImpuesto en el catálogo
-- =============================================================================
-- cod_prod_sri = código individual del producto (6 dígitos). El código completo
-- (cod_prod_ice) se ensambla con presentación/capacidad/unidad/grado.
ALTER TABLE client_products ADD COLUMN IF NOT EXISTS cod_prod_sri text DEFAULT '';
ALTER TABLE client_products ADD COLUMN IF NOT EXISTS cod_impuesto text DEFAULT '3031';
