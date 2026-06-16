-- 029: Honorarios por período (mes/año)
-- Permite el histórico mensual (desplegable de meses anteriores) y el arrastre
-- automático de los valores al mes siguiente. Antes había un único valor por
-- (user, RUC, producto); ahora hay uno por período.

ALTER TABLE reportes_honorarios ADD COLUMN IF NOT EXISTS mes integer;
ALTER TABLE reportes_honorarios ADD COLUMN IF NOT EXISTS anio integer;

-- Las filas que ya existían pasan a ser las del período ACTUAL (hora Ecuador),
-- así el mes en curso arranca con lo que ya estaba cargado.
UPDATE reportes_honorarios
SET mes = EXTRACT(MONTH FROM (now() AT TIME ZONE 'America/Guayaquil'))::int,
    anio = EXTRACT(YEAR  FROM (now() AT TIME ZONE 'America/Guayaquil'))::int
WHERE mes IS NULL OR anio IS NULL;

ALTER TABLE reportes_honorarios ALTER COLUMN mes  SET NOT NULL;
ALTER TABLE reportes_honorarios ALTER COLUMN anio SET NOT NULL;

-- La unicidad ahora incluye el período.
ALTER TABLE reportes_honorarios
  DROP CONSTRAINT IF EXISTS reportes_honorarios_user_id_identificacion_producto_key;
ALTER TABLE reportes_honorarios
  ADD CONSTRAINT reportes_honorarios_user_ident_prod_periodo_key
  UNIQUE (user_id, identificacion, producto, mes, anio);

CREATE INDEX IF NOT EXISTS idx_reportes_honorarios_periodo
  ON reportes_honorarios (user_id, anio, mes);
