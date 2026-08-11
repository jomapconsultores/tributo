-- 034: Devolución de IVA — constancia de lo REALMENTE presentado al SRI
--
-- Hasta ahora, al marcar una solicitud como presentada solo se guardaba la
-- fecha. Pero lo que hay que poder reportar después es qué aceptó el portal:
-- cuántos comprobantes entraron y por cuánto. Ese dato lo devuelve el SRI en
-- la pantalla de confirmación ("Carga de archivo realizada exitosamente", con
-- el detalle y el Total solicitado), y no tiene por qué coincidir con lo que
-- se marcó acá: el portal muestra su propio listado ya filtrado (bienes de
-- primera necesidad, establecimientos verificados) y descarta lo que no
-- califica. Por eso se guarda aparte de total_iva/monto_solicitado, que son
-- NUESTRO cálculo.

ALTER TABLE devoluciones_iva_solicitudes
  -- Comprobantes que el SRI efectivamente procesó en la solicitud.
  ADD COLUMN IF NOT EXISTS comprobantes_enviados integer,
  -- Total solicitado que confirmó el portal (USD).
  ADD COLUMN IF NOT EXISTS monto_enviado numeric,
  -- Fecha y hora de carga que reporta el SRI (puede diferir de presentada_at,
  -- que es cuando se registró acá).
  ADD COLUMN IF NOT EXISTS fecha_carga_sri timestamptz,
  -- Mensaje/constancia devuelta por el portal, tal cual, para el respaldo.
  ADD COLUMN IF NOT EXISTS sri_mensaje text;

-- El portal del SRI identifica cada comprobante por su SERIE
-- ("Factura - 003-301-000089145"), no por la clave de acceso, así que el
-- snapshot necesita guardarla para poder casar cada fila de la grilla con el
-- comprobante nuestro al momento de cargar los datos allá.
ALTER TABLE devoluciones_iva_items
  ADD COLUMN IF NOT EXISTS factura_numero text;

-- El reporte de devoluciones se consulta por período y por estado.
CREATE INDEX IF NOT EXISTS idx_dev_iva_solicitudes_estado
  ON devoluciones_iva_solicitudes (estado, anio, mes);
