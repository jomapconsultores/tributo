-- =============================================================================
-- Migración 061: el anexo PVP/ICE queda atribuido a su contribuyente Y a su mes
-- =============================================================================
-- Los anexos ya colgaban del contribuyente (client_id), pero el período vivía
-- solo dentro del JSON. Con columnas propias se pueden listar "los anexos de
-- meses anteriores" de un RUC, ordenarlos por período y recuperar uno viejo
-- para copiarlo, con cambios, al mes que se está trabajando.
ALTER TABLE anexos ADD COLUMN IF NOT EXISTS periodo_anio integer;
ALTER TABLE anexos ADD COLUMN IF NOT EXISTS periodo_mes  integer;
ALTER TABLE anexos ADD COLUMN IF NOT EXISTS updated_at   timestamptz DEFAULT now();

-- Relleno de lo ya guardado: primero, el período del contribuyente del que cuelga…
UPDATE anexos a
   SET periodo_anio = c.periodo_anio,
       periodo_mes  = c.periodo_mes
  FROM clients c
 WHERE c.id = a.client_id
   AND a.periodo_anio IS NULL;

-- …y para los anexos sueltos (sin contribuyente), lo que diga su cabecera.
UPDATE anexos
   SET periodo_anio = NULLIF(regexp_replace(COALESCE(datos->'header'->>'Anio', ''), '\D', '', 'g'), '')::int,
       periodo_mes  = NULLIF(regexp_replace(COALESCE(datos->'header'->>'Mes',  ''), '\D', '', 'g'), '')::int
 WHERE periodo_anio IS NULL;

UPDATE anexos SET updated_at = created_at WHERE updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_anexos_client_tipo_periodo
  ON anexos(client_id, tipo, periodo_anio, periodo_mes);
