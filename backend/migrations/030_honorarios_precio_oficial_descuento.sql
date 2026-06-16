-- 030: Precio oficial + descuento por honorario (para que el descuento pase a Odoo)
-- `valor` sigue siendo el NETO a cobrar (base sin IVA). Se agregan:
--   precio_oficial = precio de lista (price_unit en Odoo)
--   descuento      = % de descuento sobre el oficial (discount en Odoo)
-- Relación: valor = precio_oficial * (1 - descuento/100).

ALTER TABLE reportes_honorarios ADD COLUMN IF NOT EXISTS precio_oficial numeric;
ALTER TABLE reportes_honorarios ADD COLUMN IF NOT EXISTS descuento numeric DEFAULT 0;
