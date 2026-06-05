-- =============================================================================
-- Migración 009: período (mes/año) por fila en Cálculo ICE
-- =============================================================================
-- Permite calcular cada producto con su propio mes/año (tarifas e IVA por fecha)
-- sin depender únicamente del período del cliente.
ALTER TABLE ice_calc ADD COLUMN IF NOT EXISTS anio integer;
ALTER TABLE ice_calc ADD COLUMN IF NOT EXISTS mes integer;
