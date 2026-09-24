-- ------------------------------------------------------------
-- Desarrollado por Marco Antonio Posligua San Martín
-- ------------------------------------------------------------
-- Migración 068: el cliente reporta su pago y el administrador lo activa.
--
-- Hasta ahora el cobro era ciego por los dos lados: el cliente pagaba por
-- transferencia y tenía que avisar por WhatsApp (o no avisaba), y el
-- administrador se enteraba cuando le escribían. La pantalla «El acceso está en
-- pausa» terminaba en «avisa a quien administra el sistema», sin ningún lugar
-- donde dejar el comprobante.
--
-- Acá queda: el cliente sube la foto o el PDF de su transferencia con los datos
-- del pago, la fila nace 'pendiente' y al administrador le llega un correo y
-- una insignia. El administrador revisa el comprobante y con UN botón aprueba:
-- se registra el pago en `pagos`, la suscripción pasa a 'activo' y se corre la
-- fecha del próximo pago. Si algo no cuadra, lo rechaza con un motivo y el
-- cliente lo ve (y recibe el correo) sin tener que llamar a preguntar.
--
-- El archivo NO se guarda aquí: vive en el bucket privado `comprobantes-pago`
-- de Storage y esta tabla solo guarda su ruta. Se sirve con URL firmada de una
-- hora, y solo al dueño del comprobante o al administrador.
CREATE TABLE IF NOT EXISTS pagos_reportados (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Quién reporta el pago (siempre hay una persona detrás, aunque cobre la empresa)
  user_id uuid NOT NULL,
  user_email text,
  -- Empresa activa al momento de reportar. Si esa empresa tiene suscripción
  -- propia, el pago se le abona a ELLA y no a la persona: es la empresa la que
  -- contrató. NULL = modo heredado (la suscripción es del usuario).
  org_id uuid,

  monto numeric NOT NULL DEFAULT 0,      -- lo que el cliente dice haber pagado
  meses integer NOT NULL DEFAULT 1,      -- 1, 3, 6 o 12 (pago anticipado)
  fecha_pago date,                       -- fecha de la transferencia/depósito
  metodo text,                           -- transferencia | deposito | efectivo | otro
  banco text,                            -- banco de origen/destino
  referencia text,                       -- nº de comprobante o de transacción
  nota text,                             -- lo que el cliente quiera aclarar

  comprobante_path text,                 -- ruta en el bucket (NULL = reportó sin archivo)
  comprobante_nombre text,               -- nombre original, para mostrarlo

  estado text NOT NULL DEFAULT 'pendiente',  -- pendiente | aprobado | rechazado
  revisado_por uuid,                     -- administrador que aprobó o rechazó
  revisado_at timestamptz,
  nota_admin text,                       -- motivo del rechazo o comentario
  -- Pago que se creó al aprobar (tabla `pagos`). Deja la trazabilidad de qué
  -- cobro salió de qué comprobante, que es justo lo que después se pregunta.
  pago_id bigint,
  monto_aprobado numeric,                -- lo que el administrador registró (puede diferir)

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pagos_reportados_user   ON pagos_reportados (user_id);
CREATE INDEX IF NOT EXISTS idx_pagos_reportados_org    ON pagos_reportados (org_id);
-- El panel del administrador entra siempre por «los pendientes, del más nuevo
-- al más viejo»: ese es el índice que se usa en cada carga.
CREATE INDEX IF NOT EXISTS idx_pagos_reportados_estado ON pagos_reportados (estado, created_at DESC);

ALTER TABLE pagos_reportados ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE pagos_reportados IS
  'Comprobantes de pago que envía el cliente para que el administrador active su acceso.';
