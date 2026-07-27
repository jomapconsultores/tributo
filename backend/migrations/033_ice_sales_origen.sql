-- 033: Ingresos ICE — de dónde salió cada fila (XML o PDF/RIDE)
--
-- El módulo ahora acepta también el RIDE en PDF, para las facturas cuyo XML no
-- se puede bajar (las emitidas por el facturador del SRI). El PDF es menos
-- confiable que el XML: no trae el ICE por línea (se reparte proporcionalmente
-- al precio de cada una, cuadrando contra el subtotal impreso) y el texto puede
-- variar según el emisor. Por eso las filas quedan marcadas: en la pantalla se
-- ven con una insignia "PDF" para revisarlas antes de generar el anexo.
--
-- Las filas que ya existen vienen todas de XML.

ALTER TABLE ice_sales
  ADD COLUMN IF NOT EXISTS origen text NOT NULL DEFAULT 'xml';

ALTER TABLE ice_sales DROP CONSTRAINT IF EXISTS ice_sales_origen_check;
ALTER TABLE ice_sales ADD CONSTRAINT ice_sales_origen_check
  CHECK (origen IN ('xml', 'pdf'));

CREATE INDEX IF NOT EXISTS idx_ice_sales_origen ON ice_sales (origen);
