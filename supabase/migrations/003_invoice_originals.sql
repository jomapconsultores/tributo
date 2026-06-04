-- =============================================================================
-- Migración 003: Valores originales y bandera Yanbal en facturas
-- =============================================================================
-- Se persisten la base e importe ANTES de aplicar descuentos, para poder
-- recalcular correctamente el descuento manual y la regla automática de Yanbal.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS base_15_original numeric DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS total_original numeric DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS es_yanbal boolean DEFAULT false;
