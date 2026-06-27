-- =============================================================================
-- Migración 030: rango de producción (cerveza industrial 2021) en Cálculo ICE
-- =============================================================================
-- En 2021 la cerveza industrial tuvo tarifas específicas por escala de producción
-- (Res. NAC-DGERCGC20-00000078): R1 pequeña ≤730.000 hl (8.41), R2 mediana
-- ≤1.400.000 hl (10.48), R3 gran escala >1.400.000 hl (13.08). Se guarda el rango
-- elegido por fila para recalcular con la tarifa correcta. NULL = Rango 1 (default).
ALTER TABLE ice_calc ADD COLUMN IF NOT EXISTS rango_ind text;
