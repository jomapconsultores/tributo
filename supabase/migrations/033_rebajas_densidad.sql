-- =============================================================================
-- Migración 033: densidad por componente (para equivalencia en litros)
-- =============================================================================
-- Permite convertir cantidades en masa (g/kg) a litros: litros = masa / densidad.
-- Densidad en g/ml (= kg/L). Por defecto 1 (agua / líquidos acuosos).
ALTER TABLE rebajas_ingredientes ADD COLUMN IF NOT EXISTS densidad numeric DEFAULT 1;
