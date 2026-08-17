-- =============================================================================
-- Migración 008a: LAS TABLAS QUE NUNCA TUVIERON MIGRACIÓN
-- =============================================================================
-- Ocho tablas que el backend usa todos los días vivían SOLO en la base de
-- producción: se crearon a mano y nadie las escribió acá. El repositorio no
-- podía reconstruir la base —una instalación limpia se levantaba sin
-- credenciales, sin honorarios, sin XML originales y sin pagos aplazados—, y el
-- fallo no se veía hasta que alguien intentaba desplegar de cero.
--
-- Reconstruidas el 2026-08-16 leyendo el esquema real del proyecto `tributos`
-- (columnas, claves, checks, índices y RLS), así que aplicarlas sobre una base
-- que ya las tiene no hace nada: todo va con IF NOT EXISTS.
--
-- Va en 008a, y no al final, por el orden: la migración 028 le agrega una
-- columna a `reportes_honorarios`, así que la tabla tiene que existir antes.
-- Sus dependencias son `clients` (002) y `declaraciones` (008), que ya están.
--
-- Las columnas que agregaron migraciones POSTERIORES no se incluyen acá: cada
-- una las sigue agregando en su turno (028 iva_incluido, 053 mes/anio, 054
-- precio_oficial/descuento). Así la historia se aplica en orden y termina en el
-- mismo esquema que hay hoy en producción.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- --------------------------------------------------------------------------
-- Contribuyentes compartidos entre usuarios: quién le dio acceso a quién.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  granted_to uuid NOT NULL,
  granted_by uuid NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (client_id, granted_to)
);

CREATE INDEX IF NOT EXISTS idx_client_access_client_id ON client_access (client_id);
CREATE INDEX IF NOT EXISTS idx_client_access_granted_to ON client_access (granted_to);

-- --------------------------------------------------------------------------
-- Qué servicios tiene contratado cada contribuyente. `devolucion_iva` es el que
-- habilita el módulo de devoluciones para ese cliente.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_services (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  service text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  notas text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  UNIQUE (client_id, service),
  CONSTRAINT client_services_service_check
    CHECK (service = ANY (ARRAY['declaracion_iva', 'declaracion_ice',
                                'declaracion_renta', 'devolucion_iva']))
);

CREATE INDEX IF NOT EXISTS idx_client_services_client ON client_services (client_id);
CREATE INDEX IF NOT EXISTS idx_client_services_created_by ON client_services (created_by);
CREATE INDEX IF NOT EXISTS idx_client_services_service ON client_services (service);

-- --------------------------------------------------------------------------
-- Credenciales del portal del SRI, cifradas. El texto plano no toca la base:
-- `ciphertext` guarda el cifrado y `key_version` con qué llave se cifró, para
-- poder rotarla sin perder lo anterior.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_credentials (
  id bigserial PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  service text NOT NULL,
  username text,
  ciphertext text NOT NULL,
  key_version smallint NOT NULL DEFAULT 1,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  UNIQUE (client_id, service),
  CONSTRAINT service_credentials_service_check CHECK (service = 'sri_portal')
);

CREATE INDEX IF NOT EXISTS idx_service_credentials_client ON service_credentials (client_id);
CREATE INDEX IF NOT EXISTS idx_service_credentials_created_by ON service_credentials (created_by);
CREATE INDEX IF NOT EXISTS idx_service_credentials_service ON service_credentials (service);
CREATE INDEX IF NOT EXISTS idx_service_credentials_updated_by ON service_credentials (updated_by);

-- --------------------------------------------------------------------------
-- Bitácora de acceso a esas credenciales: quién las miró, cuándo y desde dónde.
-- Sobrevive al borrado de la credencial (ON DELETE SET NULL): el registro de
-- que alguien la vio no se puede borrar borrando la credencial.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credential_access_log (
  id bigserial PRIMARY KEY,
  credential_id bigint REFERENCES service_credentials(id) ON DELETE SET NULL,
  admin_user_id uuid NOT NULL REFERENCES auth.users(id),
  action text NOT NULL,
  ip text,
  user_agent text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb,
  CONSTRAINT credential_access_log_action_check
    CHECK (action = ANY (ARRAY['list', 'view', 'reveal', 'create', 'update', 'delete']))
);

CREATE INDEX IF NOT EXISTS idx_credential_access_log_admin
  ON credential_access_log (admin_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_credential_access_log_credential
  ON credential_access_log (credential_id);

-- --------------------------------------------------------------------------
-- Pagos que el contribuyente aplaza (IVA hasta 3 meses, ICE solo 1) con el mes
-- de origen y el de vencimiento.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pagos_aplazados (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  declaracion_id uuid REFERENCES declaraciones(id) ON DELETE SET NULL,
  tipo text NOT NULL,
  monto numeric NOT NULL,
  meses_aplazados smallint NOT NULL,
  origen_mes smallint NOT NULL,
  origen_anio integer NOT NULL,
  vence_mes smallint NOT NULL,
  vence_anio integer NOT NULL,
  estado text NOT NULL DEFAULT 'pendiente',
  notas text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pagos_aplazados_tipo_check CHECK (tipo = ANY (ARRAY['IVA', 'ICE'])),
  CONSTRAINT pagos_aplazados_estado_check
    CHECK (estado = ANY (ARRAY['pendiente', 'vencido', 'pagado', 'cancelado'])),
  CONSTRAINT pagos_aplazados_monto_check CHECK (monto > 0),
  CONSTRAINT pagos_aplazados_meses_aplazados_check
    CHECK (meses_aplazados >= 1 AND meses_aplazados <= 3),
  CONSTRAINT pagos_aplazados_origen_mes_check CHECK (origen_mes >= 1 AND origen_mes <= 12),
  CONSTRAINT pagos_aplazados_vence_mes_check CHECK (vence_mes >= 1 AND vence_mes <= 12),
  -- El ICE no admite el aplazamiento largo del IVA.
  CONSTRAINT chk_ice_max_1_mes CHECK (NOT (tipo = 'ICE' AND meses_aplazados > 1))
);

CREATE INDEX IF NOT EXISTS idx_pagos_aplazados_client ON pagos_aplazados (client_id);
CREATE INDEX IF NOT EXISTS idx_pagos_aplazados_declaracion ON pagos_aplazados (declaracion_id);
CREATE INDEX IF NOT EXISTS idx_pagos_aplazados_vence
  ON pagos_aplazados (client_id, vence_anio, vence_mes, estado);

-- --------------------------------------------------------------------------
-- Honorarios a cobrar por contribuyente y producto. En su forma ORIGINAL: la
-- 028 le agrega `iva_incluido`, la 053 el período (mes/anio) y la 054 el precio
-- oficial con su descuento.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reportes_honorarios (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid,
  identificacion text NOT NULL,
  producto text NOT NULL,
  marca text DEFAULT '',
  cobrar boolean DEFAULT true,
  valor numeric DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  -- Sin período todavía: una fila por usuario, contribuyente y producto. La 053
  -- reemplaza esta unicidad por una que incluye el mes y el año.
  UNIQUE (user_id, identificacion, producto)
);

CREATE INDEX IF NOT EXISTS idx_reportes_honorarios_user
  ON reportes_honorarios (user_id, identificacion);

-- --------------------------------------------------------------------------
-- Llaves de acceso sin contraseña (WebAuthn/passkey) por usuario.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  email text NOT NULL,
  credential_id text NOT NULL UNIQUE,
  public_key text NOT NULL,
  sign_count bigint DEFAULT 0,
  device_type text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webauthn_email ON webauthn_credentials (email);
CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials (user_id);

-- --------------------------------------------------------------------------
-- El XML tal como vino del SRI. Es el respaldo: lo que se parseó se puede
-- volver a parsear, y ante una discusión manda el original.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS xml_originales (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid,
  client_id uuid,
  modulo text NOT NULL,
  unique_id text DEFAULT '',
  xml_content text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (user_id, client_id, modulo, unique_id)
);

CREATE INDEX IF NOT EXISTS idx_xmlorig_client_modulo ON xml_originales (client_id, modulo);

-- --------------------------------------------------------------------------
-- RLS activo en todas, como el resto del esquema: el backend entra con la
-- service key y el rol anon no debe poder leer nada directo.
-- --------------------------------------------------------------------------
ALTER TABLE client_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagos_aplazados ENABLE ROW LEVEL SECURITY;
ALTER TABLE reportes_honorarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE webauthn_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE xml_originales ENABLE ROW LEVEL SECURITY;
