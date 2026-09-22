-- =============================================================================
-- Migración 067: quién le factura a cada contribuyente
-- =============================================================================
-- Los honorarios salen de dos lugares: lo de CMAJ se factura en Odoo y lo de
-- Marco Antonio en Contabilidad MAP. La elección vivía solo en el navegador
-- (localStorage de la pantalla Emitir): cambiaba de una computadora a otra y
-- se perdía al limpiarlo, así que había que volver a elegirla cada vez.
--
-- Acá queda guardada, por contribuyente (RUC/cédula) y por quien factura
-- (user_id, igual que reportes_honorarios).
CREATE TABLE IF NOT EXISTS facturacion_emisor (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  identificacion text NOT NULL,
  -- 'cmaj' = Odoo (CMAJ Asociados) · 'map' = Contabilidad MAP (Marco Antonio)
  emisor text NOT NULL CHECK (emisor IN ('cmaj', 'map')),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (user_id, identificacion)
);

ALTER TABLE facturacion_emisor ENABLE ROW LEVEL SECURITY;
