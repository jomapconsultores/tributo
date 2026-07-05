-- =============================================================================
-- Migración 042: Roles múltiples por usuario (el mismo usuario puede tener
-- varios roles y cambiar entre ellos con un selector).
-- =============================================================================
-- app_admins sigue siendo el ROL ACTIVO del usuario (lo que lee rol_de() y de
-- ahí toda la lógica de permisos/visibilidad). Esta tabla nueva guarda el
-- CONJUNTO de roles que el administrador le OTORGÓ y entre los que puede
-- cambiar. Cambiar de rol = re-apuntar app_admins a uno de estos (validado).
--
-- Solo el administrador otorga roles (endpoint PUT /api/admin/users/{uid}/roles,
-- protegido por require_super_admin). El cambio de rol activo es self-service
-- pero SOLO entre los roles ya otorgados aquí.

CREATE TABLE IF NOT EXISTS user_roles (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'socio', 'cliente')),
  granted_by uuid,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT user_roles_user_role_unique UNIQUE (user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);

-- Backfill: cada admin/socio existente tiene su rol actual como "otorgado", para
-- que _admin_user_ids() (que ahora también mira user_roles) siga reconociéndolos
-- como admin de raíz y nada cambie de comportamiento hasta que se otorgue un 2º rol.
INSERT INTO user_roles (user_id, role)
  SELECT user_id, role FROM app_admins
  ON CONFLICT (user_id, role) DO NOTHING;
