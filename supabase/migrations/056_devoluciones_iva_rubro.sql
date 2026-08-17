-- 056: Devolución de IVA — rubro de gasto por comprobante y período semestral
-- (venía de backend/migrations/032, que nunca se aplicaba: la carpeta que se
--  despliega es esta. Ver el encabezado de 008a.)
--
-- 1) RUBRO: cada comprobante que entra a la solicitud se direcciona al tipo de
--    gasto que corresponde (vivienda, salud, alimentación, vestimenta,
--    educación, turismo, servicios básicos, otros). Va en el ítem (snapshot),
--    no en la factura: la solicitud presentada no debe cambiar si después se
--    reclasifica al proveedor.
--
-- 2) DETALLE POR MES: el tope de la devolución es MENSUAL (5 RBU de base para
--    adultos mayores, 2 RBU proporcionales para discapacidad). Un contribuyente
--    SEMESTRAL declara los seis meses juntos, así que su solicitud lleva seis
--    topes, uno por mes, y no uno solo. `detalle_meses` guarda ese desglose
--    ({mes, base, iva, tope, solicitar, excedente}) y `tope_mensual` pasa a ser
--    el tope del PERÍODO (la suma de los topes de sus meses; para un período
--    mensual sigue siendo el tope del mes, así que nada cambia para ellos).
--
-- 3) ENVÍO: fecha en que la solicitud se envió/presentó al SRI.

ALTER TABLE devoluciones_iva_items
  ADD COLUMN IF NOT EXISTS rubro text;

ALTER TABLE devoluciones_iva_solicitudes
  ADD COLUMN IF NOT EXISTS detalle_meses jsonb,
  ADD COLUMN IF NOT EXISTS presentada_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_dev_iva_items_rubro
  ON devoluciones_iva_items (rubro);
