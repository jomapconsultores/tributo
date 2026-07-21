-- =============================================================================
-- Migración 049: Periodicidad de declaración de IVA — MENSUAL o SEMESTRAL
-- =============================================================================
-- Hasta ahora TODO contribuyente declaraba de forma mensual (un `clients` row por
-- mes). La normativa ecuatoriana permite declarar el IVA (Form. 104) de forma
-- SEMESTRAL a quienes venden exclusivamente con tarifa 0% o cuyas ventas están
-- sujetas a retención total. Para esos contribuyentes, un `clients` row representa
-- un SEMESTRE completo (6 meses de facturas) y se declara una sola vez:
--   · 1er semestre (ENE–JUN)  → se declara en JULIO
--   · 2do semestre (JUL–DIC)  → se declara en ENERO del año siguiente
--
-- Representación:
--   · periodicidad      = 'mensual' | 'semestral'  (atributo de IDENTIDAD del
--                         contribuyente: se propaga a todos sus períodos).
--   · periodo_semestre  = 1 | 2 | NULL             (solo para semestrales).
--   · periodo_mes       se sigue usando como ANCLA cronológica del período: para
--                         semestrales se fija al ÚLTIMO mes del semestre (6 ó 12),
--                         de modo que el orden por (periodo_anio, periodo_mes), la
--                         unicidad y el arrastre de crédito del período anterior
--                         (semestre previo) siguen funcionando sin cambios.
-- =============================================================================

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS periodicidad text NOT NULL DEFAULT 'mensual',
  ADD COLUMN IF NOT EXISTS periodo_semestre int;   -- 1 | 2 | NULL (solo semestral)

-- Solo se aceptan los dos valores previstos.
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_periodicidad_check;
ALTER TABLE clients ADD CONSTRAINT clients_periodicidad_check
  CHECK (periodicidad IN ('mensual', 'semestral'));

-- Coherencia: si es semestral debe indicar el semestre (1 ó 2); si es mensual, no.
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_semestre_check;
ALTER TABLE clients ADD CONSTRAINT clients_semestre_check
  CHECK (
    (periodicidad = 'semestral' AND periodo_semestre IN (1, 2))
    OR (periodicidad = 'mensual' AND periodo_semestre IS NULL)
  );

CREATE INDEX IF NOT EXISTS idx_clients_periodicidad ON clients(periodicidad);
