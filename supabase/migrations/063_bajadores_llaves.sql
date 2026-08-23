-- =============================================================================
-- Migración 063: los bajadores solo corren con permiso, y en una sola máquina
-- =============================================================================
-- Los marcadores (bajador de gastos, de ingresos y enviador de devoluciones)
-- son código que vive en el navegador de quien lo tiene: se pueden copiar, y no
-- hay candado dentro del JS que aguante a alguien que sepa editarlo. Lo que sí
-- se puede es que NO SIRVAN SIN PERMISO VIVO: antes de tocar el portal del SRI
-- le preguntan al sistema si esa llave está habilitada y si la máquina es la
-- autorizada. La llave se revoca desde acá y el marcador se apaga.
--
--   llave        el secreto que va incrustado en el marcador al generarlo
--   dispositivo  huella de la PC donde se activó (la primera que lo usa)
--   activa       el interruptor: revocarla apaga el marcador en el acto
--
-- La autorización es de a UNO: alguien con llave activa puede usar los
-- bajadores; el resto, no, aunque tenga acceso al módulo.
CREATE TABLE IF NOT EXISTS bajadores_llaves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  -- 'gastos' | 'emitidos' | 'devolucion' | 'todos'
  cual text NOT NULL DEFAULT 'todos',
  llave text NOT NULL UNIQUE,
  activa boolean NOT NULL DEFAULT true,
  -- Huella de la máquina donde se activó. NULL = todavía no se usó: la primera
  -- máquina que la estrene queda registrada acá.
  dispositivo text,
  dispositivo_nombre text,
  activada_at timestamptz,
  -- Quién la autorizó y desde cuándo. Revocar deja el registro, no borra.
  autorizada_por uuid,
  nota text,
  ultimo_uso_at timestamptz,
  usos integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (user_id, cual)
);

-- La bitácora: cada vez que un marcador pide permiso queda acá, salga bien o
-- mal. Es lo que permite saber quién los usó, desde qué máquina y sobre qué
-- contribuyente, y darse cuenta de un intento con llave copiada.
CREATE TABLE IF NOT EXISTS bajadores_usos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  llave_id uuid REFERENCES bajadores_llaves(id) ON DELETE SET NULL,
  user_id uuid,
  cual text,
  -- 'ok' | 'revocada' | 'otra_maquina' | 'desconocida'
  resultado text NOT NULL,
  dispositivo text,
  dispositivo_nombre text,
  ip text,
  identificacion text,
  periodo text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE bajadores_llaves ENABLE ROW LEVEL SECURITY;
ALTER TABLE bajadores_usos ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_bajadores_llaves_user ON bajadores_llaves (user_id);
CREATE INDEX IF NOT EXISTS idx_bajadores_usos_fecha ON bajadores_usos (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bajadores_usos_llave ON bajadores_usos (llave_id, created_at DESC);
