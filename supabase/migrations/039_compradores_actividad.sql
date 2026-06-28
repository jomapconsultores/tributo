-- =============================================================================
-- Migración 039: actividad económica (SRI) en compradores
-- =============================================================================
ALTER TABLE compradores ADD COLUMN IF NOT EXISTS actividad text;
