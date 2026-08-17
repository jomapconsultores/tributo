-- =============================================================================
-- Migración 019a: DOS COLUMNAS QUE NUNCA TUVIERON MIGRACIÓN
-- =============================================================================
-- Del mismo agujero que 008a, pero en tablas que sí estaban escritas: dos
-- columnas se agregaron a mano en producción y nadie las trajo al repositorio.
--
--   · `app_admins.role` — es EL rol activo del usuario, lo que lee `rol_de()`.
--     La 019 crea la tabla sin ella, y después la 042 la consulta, la 044 le
--     pone su CHECK y la 051 filtra por ella: sobre una base limpia, las tres
--     fallaban.
--   · `clients.iva_incluido` — la 026 agrega una columna con ese nombre, pero a
--     `subscriptions`. La de `clients` es otra y no estaba en ningún lado.
--
-- Va en 019a porque tiene que existir antes de la 026 y de la 042.
-- Reconstruidas el 2026-08-16 desde el esquema real del proyecto `tributos`.

-- El rol nace 'admin' porque una fila en app_admins ERA, antes de que hubiera
-- roles, exactamente eso: un administrador.
ALTER TABLE app_admins
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'admin';

-- El CHECK con los tres roles lo pone la 044; acá no se adelanta.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS iva_incluido boolean DEFAULT false;
