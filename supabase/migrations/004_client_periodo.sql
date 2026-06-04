-- =============================================================================
-- Migración 004: Período (Mes + Año) obligatorio por cliente
-- =============================================================================
-- Cada registro de cliente corresponde a un contribuyente EN UN PERÍODO concreto
-- (mes + año). El mismo RUC/Cédula se "duplica" por cada mes y por cada año,
-- porque las declaraciones son mensuales y el período enlaza con el siguiente paso.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS periodo_mes int;     -- 1..12
ALTER TABLE clients ADD COLUMN IF NOT EXISTS periodo_anio int;    -- ej. 2025

-- La identificación deja de ser única por sí sola: ahora es única por período
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_identificacion_key;
ALTER TABLE clients ADD CONSTRAINT clients_identificacion_periodo_key
  UNIQUE (identificacion, periodo_mes, periodo_anio);

CREATE INDEX IF NOT EXISTS idx_clients_periodo ON clients(periodo_anio, periodo_mes);
