-- =============================================================================
-- Migración 062: la grilla del portal del SRI vive en la base, no en el navegador
-- =============================================================================
-- El trámite de devolución se arma con el listado que el propio SRI muestra, y
-- ese listado no está en Gastos: existe solo dentro de la solicitud. Pero la
-- solicitud guarda lo MARCADO, así que la copia cruda de la grilla —para poder
-- desmarcar una fila y volver a marcarla, o para ver qué trajo el portal aunque
-- todavía no se haya guardado nada— vivía en el localStorage del navegador
-- (`devIvaPortal:` / `devIvaFuera:`).
--
-- Eso ataba el trabajo a UNA máquina y a UN navegador: el contador que traía la
-- grilla en la oficina no la veía desde la laptop, limpiar los datos del
-- navegador borraba el mes entero, y nada de eso quedaba respaldado. Acá pasa a
-- la base, junto al resto del trámite.
--
--   filas      la grilla tal cual la mostró el portal (serie, fecha, proveedor, iva)
--   excluidos  los comprobantes que el usuario sacó de ESTA devolución (siguen
--              en Gastos: el SRI lista lo suyo y lo demás no va en la solicitud)
--
-- Uno por contribuyente y período: traer el listado de nuevo REEMPLAZA el
-- anterior; no se acumulan dos grillas del mismo mes.
CREATE TABLE IF NOT EXISTS devoluciones_iva_portal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  mes integer NOT NULL,
  anio integer NOT NULL,
  -- De quién dijo ser el listado en el portal (queda como respaldo de que la
  -- grilla entró en la ficha correcta).
  identificacion text,
  filas jsonb NOT NULL DEFAULT '[]'::jsonb,
  excluidos jsonb NOT NULL DEFAULT '[]'::jsonb,
  traido_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (client_id, mes, anio)
);

-- Igual que el resto de tablas: RLS activo (el backend entra con service key;
-- el rol anon no debe poder leer nada directo).
ALTER TABLE devoluciones_iva_portal ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_dev_iva_portal_cliente
  ON devoluciones_iva_portal (client_id, anio, mes);
