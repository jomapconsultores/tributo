-- =============================================================================
-- Migración 027: Bitácora de movimientos (auditoría de actividad para el admin)
--
-- Registra QUÉ hizo cada usuario, con QUÉ contribuyente y en QUÉ proceso
-- (subir facturas, guardar declaraciones, crear clientes, etc.) para que el
-- administrador pueda revisarlo en el módulo "Movimientos".
-- =============================================================================
CREATE TABLE IF NOT EXISTS activity_log (
  id              bigserial PRIMARY KEY,
  actor_user_id   uuid NOT NULL,            -- quién realizó la acción
  actor_email     text,                     -- email del actor (denormalizado para mostrar)
  action          text NOT NULL,            -- upload | create | save | delete
  module          text,                     -- gastos | ingresos_iva | ingresos_ice | retenciones | declaraciones | anexos | clientes
  entity          text NOT NULL,            -- etiqueta legible del proceso ("Facturas de gastos", "Declaración IVA", ...)
  client_id       uuid,                     -- contribuyente afectado (si aplica)
  identificacion  text,                     -- RUC/cédula del contribuyente
  contribuyente   text,                     -- nombre del contribuyente
  cantidad        integer,                  -- nº de elementos afectados (ej. 12 facturas)
  metadata        jsonb,                    -- detalle adicional
  occurred_at     timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_log_occurred ON activity_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_actor    ON activity_log(actor_user_id);

-- Marcador de "última vez que el admin revisó los movimientos" (para el contador de nuevos)
CREATE TABLE IF NOT EXISTS activity_seen (
  admin_user_id  uuid PRIMARY KEY,
  last_seen_at   timestamptz DEFAULT now()
);
