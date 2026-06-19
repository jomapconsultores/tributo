-- =============================================================================
-- Migración 029: Reservas de Capacitación y acompañamiento
--
-- El cliente solicita una hora de capacitación ($50 + IVA/hora). La solicitud
-- queda en estado 'pendiente' hasta que el socio o administrador la autoriza
-- (o la rechaza) y agenda la fecha/hora definitiva.
-- =============================================================================
CREATE TABLE IF NOT EXISTS capacitaciones (
  id                bigserial PRIMARY KEY,
  solicitante_id    uuid NOT NULL,                       -- cliente que solicita
  solicitante_email text,                                -- email (denormalizado para mostrar)
  tema              text,                                -- tema / motivo de la sesión
  modalidad         text DEFAULT 'online',               -- online | presencial
  fecha_sugerida    date,                                -- fecha que pide el cliente
  hora_sugerida     text,                                -- hora sugerida (texto libre)
  horas             numeric DEFAULT 1,                   -- nº de horas estimadas
  mensaje           text,                                -- detalle adicional del cliente
  estado            text NOT NULL DEFAULT 'pendiente',   -- pendiente | autorizada | rechazada | realizada
  precio_hora       numeric DEFAULT 50,                  -- neto por hora (sin IVA)
  fecha_agendada    timestamptz,                         -- fecha/hora confirmada por el socio/admin
  autorizada_por    uuid,                                -- socio/admin que autorizó o rechazó
  nota_admin        text,                                -- nota del socio/admin
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_capacitaciones_solicitante ON capacitaciones(solicitante_id);
CREATE INDEX IF NOT EXISTS idx_capacitaciones_estado      ON capacitaciones(estado);
CREATE INDEX IF NOT EXISTS idx_capacitaciones_creada      ON capacitaciones(created_at DESC);
