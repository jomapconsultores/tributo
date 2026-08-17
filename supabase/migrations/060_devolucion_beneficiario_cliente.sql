-- 060: Devolución de IVA — de qué tipo de beneficiario es cada contribuyente
--
-- Adultos mayores y personas con discapacidad son dos trámites distintos, con
-- dos entradas distintas en el portal del SRI y dos pantallas acá. Pero el
-- sistema no tenía cómo distinguirlos: las dos listaban a todos los que tienen
-- el servicio `devolucion_iva`, así que en "Adultos mayores" aparecían también
-- los de discapacidad y al revés.
--
-- No se puede deducir del contribuyente: no hay fecha de nacimiento, y el grado
-- de discapacidad lo tiene el MSP, no nosotros. Lo que sí sabemos es lo que el
-- usuario decidió al armar la solicitud, y eso es exactamente este dato: se
-- graba al guardar la primera y desde ahí el contribuyente aparece solo en la
-- pantalla que le corresponde.
--
-- Nulo = todavía no se sabe. Esos aparecen en las DOS pantallas, que es lo
-- correcto: sin una solicitud previa no hay forma de saber cuál le toca, y
-- esconderlo de ambas lo dejaría inalcanzable.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS devolucion_beneficiario text;

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_devolucion_beneficiario_check;
ALTER TABLE clients ADD CONSTRAINT clients_devolucion_beneficiario_check
  CHECK (devolucion_beneficiario IS NULL
         OR devolucion_beneficiario IN ('tercera_edad', 'discapacidad'));

-- Lo que ya se decidió en solicitudes anteriores no se pierde: se rescata de
-- la última solicitud de cada contribuyente.
UPDATE clients c
   SET devolucion_beneficiario = s.tipo_beneficiario
  FROM (
    SELECT DISTINCT ON (client_id) client_id, tipo_beneficiario
      FROM devoluciones_iva_solicitudes
     WHERE tipo_beneficiario IS NOT NULL
     ORDER BY client_id, created_at DESC
  ) s
 WHERE s.client_id = c.id
   AND c.devolucion_beneficiario IS NULL;
