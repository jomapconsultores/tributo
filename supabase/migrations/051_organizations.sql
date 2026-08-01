-- =============================================================================
-- Migración 051: MULTIEMPRESA — organizaciones (despachos) y membresías
-- =============================================================================
-- Hasta ahora el "inquilino" del sistema era el USUARIO suelto: los
-- contribuyentes colgaban de clients.user_id y los permisos (rol, módulos,
-- submódulos, suscripción) eran globales por usuario. Esta migración introduce
-- la capa que faltaba:
--
--   organizations (EMPRESA / despacho / estudio contable)
--     └── organization_members            (qué usuarios pertenecen y con qué ROL)
--           ├── organization_member_modules     (módulos contratados EN esa empresa)
--           └── organization_member_submodules  (pantallas permitidas EN esa empresa)
--     └── clients (contribuyentes)  ← clients.org_id
--
-- Un usuario puede pertenecer a VARIAS empresas y tener un rol y un juego de
-- permisos DISTINTO en cada una: socio con todo en "MAP Consultores" y
-- trabajador solo con gastos en "Estudio Vera".
--
-- COMPATIBILIDAD: la migración es aditiva y hace backfill. Al terminar, todo lo
-- que existe hoy queda dentro de UNA empresa por defecto con exactamente los
-- mismos roles y módulos que tenía cada usuario, de modo que el comportamiento
-- observable no cambia hasta que se creen empresas nuevas. El backend además
-- tolera que estas tablas todavía no existan (modo heredado).
--
-- Las reglas de visibilidad DENTRO de una empresa siguen siendo las de siempre
-- (admin ve todo; socio todo menos lo creado por un admin; trabajador/cliente
-- solo lo propio y lo compartido por client_access). La empresa actúa como un
-- filtro ADICIONAL por encima de esas reglas, nunca como un reemplazo.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------------
-- 1) EMPRESAS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre text NOT NULL,
  identificacion text,                    -- RUC del despacho (informativo, opcional)
  activa boolean NOT NULL DEFAULT true,   -- false = suspendida: nadie entra a sus datos
  created_by uuid,                        -- usuario que la creó
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Nombre único sin distinguir mayúsculas ni espacios sobrantes: evita
-- "Estudio Vera" y "ESTUDIO VERA " conviviendo como empresas distintas.
CREATE UNIQUE INDEX IF NOT EXISTS organizations_nombre_unico
  ON organizations (lower(btrim(nombre)));

-- ---------------------------------------------------------------------------
-- 2) MEMBRESÍAS — la relación usuario ↔ empresa, con ROL propio en cada una
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organization_members (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'cliente'
    CHECK (role IN ('admin', 'socio', 'trabajador', 'cliente')),
  granted_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT organization_members_unico UNIQUE (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org  ON organization_members(org_id);

-- ---------------------------------------------------------------------------
-- 3) MÓDULOS por membresía — el equivalente de user_modules, pero POR EMPRESA
-- ---------------------------------------------------------------------------
-- Regla: si un usuario NO tiene ninguna fila aquí para una empresa, el backend
-- cae a sus módulos globales (user_modules). Así nada se queda sin acceso
-- mientras se termina de poblar el modelo nuevo.
CREATE TABLE IF NOT EXISTS organization_member_modules (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  modulo text NOT NULL,
  activo boolean NOT NULL DEFAULT true,
  valid_until date,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT organization_member_modules_unico UNIQUE (org_id, user_id, modulo)
);

CREATE INDEX IF NOT EXISTS idx_org_mod_user ON organization_member_modules(org_id, user_id);

-- ---------------------------------------------------------------------------
-- 4) SUBMÓDULOS por membresía — restricción de pantallas POR EMPRESA
-- ---------------------------------------------------------------------------
-- Misma semántica que user_submodules: sin filas para los submódulos de un
-- módulo = TODAS sus pantallas permitidas. Con filas = solo ese subconjunto.
CREATE TABLE IF NOT EXISTS organization_member_submodules (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  submodulo text NOT NULL,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT organization_member_submodules_unico UNIQUE (org_id, user_id, submodulo)
);

CREATE INDEX IF NOT EXISTS idx_org_sub_user ON organization_member_submodules(org_id, user_id);

-- ---------------------------------------------------------------------------
-- 5) Los contribuyentes pasan a pertenecer a una EMPRESA
-- ---------------------------------------------------------------------------
-- Se mantiene clients.user_id (quién lo creó) porque las reglas de visibilidad
-- de socio/trabajador/cliente siguen dependiendo de él. org_id es el filtro
-- nuevo que se aplica por encima.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id);
CREATE INDEX IF NOT EXISTS idx_clients_org_id ON clients(org_id);

-- Suscripción/cobro a nivel de empresa (opcional). Si una empresa no tiene
-- suscripción propia, el backend sigue mirando la del usuario.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_org_unico
  ON subscriptions (org_id) WHERE org_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5 bis) RLS — mismo criterio que el resto del proyecto
-- ---------------------------------------------------------------------------
-- Todas las tablas de este esquema tienen RLS activado y SIN políticas: el
-- backend entra con la service key (que omite RLS) y nadie más llega. Sin este
-- paso, PostgREST expondría las empresas y sus membresías a cualquiera con la
-- anon key, que es pública por diseño — o sea, el mapa completo de quién
-- trabaja para qué despacho.
ALTER TABLE organizations                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members           ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_member_modules    ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_member_submodules ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 6) BACKFILL — todo lo existente entra a una empresa por defecto
-- ---------------------------------------------------------------------------
-- Se crea UNA empresa y se le asignan todos los contribuyentes y todos los
-- usuarios con el rol/módulos/submódulos que ya tenían. Resultado: cero cambios
-- de comportamiento. Renombra 'EMPRESA PRINCIPAL' desde la pantalla de Empresas
-- cuando quieras.
DO $$
DECLARE
  v_org uuid;
  v_creador uuid;
BEGIN
  -- Solo hacer el backfill una vez (si ya hay empresas, no tocar nada).
  IF EXISTS (SELECT 1 FROM organizations) THEN
    RAISE NOTICE 'Ya existen empresas: se omite el backfill.';
    RETURN;
  END IF;

  SELECT user_id INTO v_creador FROM app_admins WHERE role = 'admin' LIMIT 1;

  INSERT INTO organizations (nombre, created_by)
    VALUES ('EMPRESA PRINCIPAL', v_creador)
    RETURNING id INTO v_org;

  -- 6.1 Todos los contribuyentes existentes van a esa empresa.
  UPDATE clients SET org_id = v_org WHERE org_id IS NULL;

  -- 6.2 Todos los usuarios registrados entran como miembros, conservando su rol
  --     ACTIVO actual (app_admins). Sin fila en app_admins = 'cliente'.
  INSERT INTO organization_members (org_id, user_id, role, granted_by)
    SELECT v_org, u.id, COALESCE(NULLIF(a.role, ''), 'cliente'), v_creador
      FROM auth.users u
      LEFT JOIN app_admins a ON a.user_id = u.id
    ON CONFLICT (org_id, user_id) DO NOTHING;

  -- 6.3 Copiar los módulos contratados de cada usuario a su membresía.
  INSERT INTO organization_member_modules (org_id, user_id, modulo, activo, valid_until)
    SELECT v_org, m.user_id, m.modulo, m.activo, m.valid_until
      FROM user_modules m
    ON CONFLICT (org_id, user_id, modulo) DO NOTHING;

  -- 6.4 Copiar las restricciones de pantallas.
  INSERT INTO organization_member_submodules (org_id, user_id, submodulo)
    SELECT v_org, s.user_id, s.submodulo
      FROM user_submodules s
    ON CONFLICT (org_id, user_id, submodulo) DO NOTHING;

  -- 6.5 La suscripción del administrador pasa a ser también la de la empresa.
  UPDATE subscriptions SET org_id = v_org
    WHERE org_id IS NULL AND user_id = v_creador;

  RAISE NOTICE 'Backfill multiempresa completado. Empresa por defecto: %', v_org;
END $$;

-- ---------------------------------------------------------------------------
-- 7) NOTA sobre la unicidad de contribuyentes (NO se aplica automáticamente)
-- ---------------------------------------------------------------------------
-- Hoy la clave única de clients es (user_id, identificacion, periodo_mes,
-- periodo_anio): dos usuarios del MISMO despacho pueden duplicar el mismo
-- contribuyente+período. Con empresas, lo correcto sería que la unicidad fuese
-- por EMPRESA. No se aplica aquí porque, si esos duplicados ya existen en la
-- base, la migración fallaría al crear la restricción.
--
-- Para revisarlos primero:
--
--   SELECT org_id, identificacion, periodo_mes, periodo_anio, count(*)
--     FROM clients
--    GROUP BY 1,2,3,4 HAVING count(*) > 1;
--
-- Y solo cuando esa consulta no devuelva filas, aplicar:
--
--   ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_user_ident_periodo_key;
--   ALTER TABLE clients ADD CONSTRAINT clients_org_ident_periodo_key
--     UNIQUE (org_id, identificacion, periodo_mes, periodo_anio);
