-- =============================================================================
-- Migración 064: marcar a mano el trabajo hecho de un período
-- =============================================================================
-- El reporte ya sabía si un servicio estaba hecho, pero solo por lo que quedó
-- registrado en el sistema: una declaración guardada, un anexo generado. Todo lo
-- que se hace fuera —o antes de usar el sistema— quedaba como faltante para
-- siempre, y no había forma de decir "esto ya está".
--
-- Acá se guarda esa decisión: por contribuyente, concepto y período. Manda sobre
-- lo deducido, en los dos sentidos (marcar hecho algo que el sistema no vio, y
-- desmarcar algo que quedó registrado por error).
CREATE TABLE IF NOT EXISTS reportes_trabajo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  identificacion text NOT NULL,
  -- El mismo concepto que usa reportes_honorarios (IVA, ICE, Anexo…).
  producto text NOT NULL,
  mes integer NOT NULL,
  anio integer NOT NULL,
  realizado boolean NOT NULL DEFAULT true,
  nota text,
  marcado_por uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (user_id, identificacion, producto, mes, anio)
);

ALTER TABLE reportes_trabajo ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_reportes_trabajo_periodo
  ON reportes_trabajo (user_id, anio, mes);
