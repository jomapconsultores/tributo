-- ------------------------------------------------------------
-- Desarrollado por Marco Antonio Posligua San Martín
-- ------------------------------------------------------------
-- Migración 067: aviso previo del VENCIMIENTO DE LA DECLARACIÓN
--
-- Al contribuyente (y a quien lleva su contabilidad) se le avisa DOS DÍAS ANTES
-- de la fecha máxima de declaración, para que nadie se entere del plazo el día
-- en que se vence y le toque pagar multa e intereses.
--
-- La fecha máxima no es la misma para todos: la da el NOVENO DÍGITO del RUC
-- (día 10, 12, 14 … 28) y se corre al siguiente día hábil si cae en fin de
-- semana o feriado. Por eso el cron corre TODOS los días: cada contribuyente
-- vence el día que le toca, no todos el mismo.
--
-- Un cron puede correr dos veces —por reintento, por un despliegue a medias o
-- porque alguien lo dispara a mano desde Actions—. Esta columna guarda PARA QUÉ
-- vencimiento ya se avisó, de modo que el segundo pase del día no vuelva a
-- escribir. Cuando llega el período siguiente la fecha deja de coincidir y el
-- aviso vuelve a salir solo.
--
-- Va en `clients` y no en una tabla aparte porque el plazo es de un
-- contribuyente EN UN PERÍODO, que es justamente lo que una fila de `clients`
-- representa.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS aviso_declaracion date;

COMMENT ON COLUMN clients.aviso_declaracion IS
  'Fecha máxima de declaración para la que ya se envió el aviso previo (dos días antes). Evita avisar dos veces por el mismo vencimiento.';
