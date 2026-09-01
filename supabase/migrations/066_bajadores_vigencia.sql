-- =============================================================================
-- Migración 066: la autorización de los bajadores caduca
-- =============================================================================
-- Hasta ahora la llave duraba hasta que alguien se acordaba de revocarla. En la
-- práctica eso significa que no caducaba nunca: quien dejó el despacho seguía
-- con el marcador vivo hasta que alguien la daba de baja a mano.
--
-- A partir de acá la autorización se da POR UN PLAZO, de tres meses como
-- máximo. Vencido, el marcador se apaga solo —sin que nadie tenga que hacer
-- nada— y el administrador decide si lo renueva. Renovar es un acto explícito:
-- vuelve a contar desde el día en que se renueva, así que nunca hay más de tres
-- meses por delante.
--
--   vence_at       el día y hora en que la llave deja de servir
--   renovada_at    cuándo se renovó por última vez
--   renovaciones   cuántas veces se renovó (para ver de un vistazo si es de las
--                  que se renuevan sin pensar)
--
-- NULL en vence_at = no caduca. Se reserva para la llave del dueño de la
-- herramienta, que el sistema se crea sola. Las que otorga el administrador
-- llevan siempre fecha.
ALTER TABLE bajadores_llaves
  ADD COLUMN IF NOT EXISTS vence_at     timestamptz,
  ADD COLUMN IF NOT EXISTS renovada_at  timestamptz,
  ADD COLUMN IF NOT EXISTS renovaciones integer NOT NULL DEFAULT 0;

-- Las llaves que ya estaban dadas no se cortan de golpe: arrancan con el plazo
-- completo desde hoy, y de ahí en más siguen la regla nueva. La del dueño
-- (la que se autorizó a sí misma) queda sin vencimiento.
UPDATE bajadores_llaves
   SET vence_at = now() + interval '3 months'
 WHERE vence_at IS NULL
   AND (autorizada_por IS NULL OR autorizada_por <> user_id);

-- Para la pantalla de administración, que ordena por lo que está por vencer.
CREATE INDEX IF NOT EXISTS idx_bajadores_llaves_vence
    ON bajadores_llaves (vence_at)
 WHERE vence_at IS NOT NULL;

COMMENT ON COLUMN bajadores_llaves.vence_at IS
  'Cuándo deja de servir la llave. NULL = no caduca (solo el dueño de la herramienta).';
COMMENT ON COLUMN bajadores_llaves.renovada_at IS
  'Última vez que el administrador la renovó.';
COMMENT ON COLUMN bajadores_llaves.renovaciones IS
  'Cuántas veces se renovó desde que se otorgó.';
