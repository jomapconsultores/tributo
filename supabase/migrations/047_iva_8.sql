-- =============================================================================
-- Migración 047: Casilla propia para la tarifa IVA 8% (base_8 / iva_8)
-- =============================================================================
-- Antes, las facturas gravadas al 8% (tarifa especial: feriados/turismo) se
-- plegaban dentro de base_15/iva_15. Eso rompía la identidad base_15 × 15% =
-- iva_15 en el resumen y la declaración (una factura al 8% mete un IVA que no es
-- el 15% dentro de la base 15%). Ahora el 8% tiene su propia casilla; su IVA se
-- sigue contando en el crédito/total (ver services/declaracion.py), pero la base
-- 15% queda homogénea y la sumatoria vertical/horizontal cuadra.
--
-- Columnas aditivas y NO nulas con default 0: no rompen inserts existentes.

ALTER TABLE invoices  ADD COLUMN IF NOT EXISTS base_8 numeric NOT NULL DEFAULT 0;
ALTER TABLE invoices  ADD COLUMN IF NOT EXISTS iva_8  numeric NOT NULL DEFAULT 0;
ALTER TABLE sales_iva ADD COLUMN IF NOT EXISTS base_8 numeric NOT NULL DEFAULT 0;
ALTER TABLE sales_iva ADD COLUMN IF NOT EXISTS iva_8  numeric NOT NULL DEFAULT 0;

-- Backfill de datos existentes: mover las facturas que estaban gravadas SOLO al
-- 8% (su IVA es ~8% de la base, muy separado del 15%) desde base_15/iva_15 a
-- base_8/iva_8. Umbral 0.115 = punto medio entre 8% y 15%; los comprobantes 15%
-- (ratio ~0.15) no se tocan. Los comprobantes MIXTOS 15%+8% en una sola factura
-- (raros) no se re-dividen aquí; se corrigen al volver a subir el XML.
UPDATE invoices
   SET base_8 = base_15, iva_8 = iva_15, base_15 = 0, iva_15 = 0
 WHERE base_15 > 0 AND iva_15 > 0 AND (iva_15 / base_15) < 0.115;

UPDATE sales_iva
   SET base_8 = base_15, iva_8 = iva_15, base_15 = 0, iva_15 = 0
 WHERE base_15 > 0 AND iva_15 > 0 AND (iva_15 / base_15) < 0.115;
