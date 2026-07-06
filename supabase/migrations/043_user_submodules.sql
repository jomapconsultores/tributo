-- =============================================================================
-- Migración 043: Permisos por SUBMÓDULO (pantallas sueltas dentro de un módulo).
-- =============================================================================
-- Regla (retrocompatible): tener el MÓDULO contratado = ver TODAS sus pantallas,
-- salvo que el administrador restrinja. La restricción se expresa guardando aquí
-- el SUBCONJUNTO de submódulos PERMITIDOS de ese módulo. Si un usuario no tiene
-- ninguna fila para los submódulos de un módulo, se consideran TODOS permitidos.
--
-- Solo el administrador otorga/restringe (PUT /api/admin/users/{uid}/submodules).
-- El catálogo de submódulos vive en el código (access.py::SUBMODULOS); aquí solo
-- se guarda qué submódulos quedan habilitados por usuario cuando hay restricción.

CREATE TABLE IF NOT EXISTS user_submodules (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  submodulo text NOT NULL,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT user_submodules_user_sub_unique UNIQUE (user_id, submodulo)
);

CREATE INDEX IF NOT EXISTS idx_user_submodules_user_id ON user_submodules(user_id);
