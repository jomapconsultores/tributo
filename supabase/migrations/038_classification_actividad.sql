-- =============================================================================
-- Migración 038: actividad económica (SRI) en el clasificador de gastos
-- =============================================================================
ALTER TABLE classification_map ADD COLUMN IF NOT EXISTS actividad text;
