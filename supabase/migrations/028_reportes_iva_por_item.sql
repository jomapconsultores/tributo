-- Migración 028: IVA por ítem en el reporte de honorarios
-- false (por defecto) = "+IVA" (el valor es neto y se le suma 15%)
-- true                = "IVA incluido" (el valor ya incluye el 15%)
ALTER TABLE reportes_honorarios
  ADD COLUMN IF NOT EXISTS iva_incluido boolean DEFAULT false;
