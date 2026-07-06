-- =============================================================================
-- Migración 044: nuevo rol "trabajador" (empleado de la firma al que el admin
-- asigna módulos/pantallas y contribuyentes específicos).
-- =============================================================================
-- El trabajador NO es admin ni socio (no ve todo): en cuanto a visibilidad de
-- datos se comporta igual que 'cliente' (solo ve los contribuyentes que el
-- administrador le comparte vía client_access) + los módulos/submódulos que le
-- otorguen. Se agrega como rol valido tanto en app_admins (rol ACTIVO) como en
-- user_roles (conjunto otorgado).

ALTER TABLE app_admins DROP CONSTRAINT IF EXISTS app_admins_role_chk;
ALTER TABLE app_admins ADD CONSTRAINT app_admins_role_chk
  CHECK (role = ANY (ARRAY['admin'::text, 'socio'::text, 'trabajador'::text]));

ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_check
  CHECK (role = ANY (ARRAY['admin'::text, 'socio'::text, 'trabajador'::text, 'cliente'::text]));
