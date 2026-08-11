// Feriados nacionales de Ecuador (Ley Orgánica de Feriados) y cálculo de días hábiles.
//
// El SRI traslada la fecha máxima de declaración al siguiente día hábil cuando el
// día que toca por el 9no dígito cae en sábado, domingo o día de descanso
// obligatorio. Aquí se construye ese calendario de días NO hábiles.
//
// Feriados nacionales:
//   1 de enero            Año Nuevo                  (inamovible)
//   lunes y martes        Carnaval                   (inamovible, se mueve con la Pascua)
//   Viernes Santo         (Pascua - 2)               (inamovible)
//   1 de mayo             Día del Trabajo            (trasladable)
//   24 de mayo            Batalla de Pichincha       (trasladable)
//   10 de agosto          Primer Grito de Independencia (trasladable)
//   9 de octubre          Independencia de Guayaquil (trasladable)
//   2 de noviembre        Día de los Difuntos        (trasladable)
//   3 de noviembre        Independencia de Cuenca    (trasladable)
//   25 de diciembre       Navidad                    (inamovible)
//
// Regla de traslado del descanso obligatorio:
//   martes            -> lunes inmediato anterior
//   miércoles o jueves-> viernes inmediato posterior
//   sábado            -> viernes inmediato anterior
//   domingo           -> lunes inmediato posterior
//   lunes o viernes   -> se mantiene
// OJO: cuando un feriado se traslada, el día ORIGINAL vuelve a ser laborable; el
// descanso (y por tanto la prórroga del plazo del SRI) cae en el día trasladado.

// --- helpers de fecha (siempre a medianoche local, sin husos horarios) --------

const soloFecha = (f) => new Date(f.getFullYear(), f.getMonth(), f.getDate())
const masDias = (f, n) => new Date(f.getFullYear(), f.getMonth(), f.getDate() + n)
const p2 = (n) => String(n).padStart(2, '0')

// Clave 'YYYY-MM-DD' de una Date (en hora local).
export const claveFecha = (f) => `${f.getFullYear()}-${p2(f.getMonth() + 1)}-${p2(f.getDate())}`

// --- Pascua ------------------------------------------------------------------

// Domingo de Pascua (calendario gregoriano) — algoritmo de Meeus/Jones/Butcher.
export function domingoPascua(anio) {
  const a = anio % 19
  const b = Math.floor(anio / 100)
  const c = anio % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const mes = Math.floor((h + l - 7 * m + 114) / 31)   // 3 = marzo, 4 = abril
  const dia = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(anio, mes - 1, dia)
}

// --- traslado ----------------------------------------------------------------

// Día de descanso obligatorio que corresponde a un feriado trasladable.
// getDay(): 0 domingo … 6 sábado.
function trasladarDescanso(f) {
  switch (f.getDay()) {
    case 2: return masDias(f, -1)  // martes    -> lunes anterior
    case 3: return masDias(f, 2)   // miércoles -> viernes posterior
    case 4: return masDias(f, 1)   // jueves    -> viernes posterior
    case 6: return masDias(f, -1)  // sábado    -> viernes anterior
    case 0: return masDias(f, 1)   // domingo   -> lunes posterior
    default: return f              // lunes / viernes: no se traslada
  }
}

// --- feriados decretados (no previsibles por regla) --------------------------
//
// Días no laborables declarados por Decreto Ejecutivo (puentes, censos, etc.).
// Se agregan a mano por año, en formato 'YYYY-MM-DD'.
export const FERIADOS_DECRETADOS = {
  '2026-04-30': 'Día no laborable (Decreto Ejecutivo)',
}

// --- calendario por año -------------------------------------------------------

const _cache = new Map()   // anio -> Map<'YYYY-MM-DD', nombre>

/**
 * Días de descanso obligatorio (ya trasladados) del año, como
 * Map<'YYYY-MM-DD', nombre del feriado>. El resultado se memoriza por año.
 */
export function feriadosDeAnio(anio) {
  const cacheado = _cache.get(anio)
  if (cacheado) return cacheado

  const pascua = domingoPascua(anio)
  const mapa = new Map()
  const poner = (fecha, nombre) => {
    let k = claveFecha(fecha)
    // 2 y 3 de noviembre pueden caer en el mismo día tras el traslado; la ley
    // mantiene los dos descansos, así que se corren a días consecutivos.
    // (Nunca alcanzan el rango de días 10–28 que usa el SRI.)
    let f = fecha
    while (mapa.has(k)) { f = masDias(f, 1); k = claveFecha(f) }
    mapa.set(k, nombre)
  }

  // Inamovibles
  poner(new Date(anio, 0, 1), 'Año Nuevo')
  poner(masDias(pascua, -48), 'Carnaval (lunes)')
  poner(masDias(pascua, -47), 'Carnaval (martes)')
  poner(masDias(pascua, -2), 'Viernes Santo')
  poner(new Date(anio, 11, 25), 'Navidad')

  // Trasladables
  poner(trasladarDescanso(new Date(anio, 4, 1)), 'Día del Trabajo')
  poner(trasladarDescanso(new Date(anio, 4, 24)), 'Batalla de Pichincha')
  poner(trasladarDescanso(new Date(anio, 7, 10)), 'Primer Grito de Independencia')
  poner(trasladarDescanso(new Date(anio, 9, 9)), 'Independencia de Guayaquil')
  poner(trasladarDescanso(new Date(anio, 10, 2)), 'Día de los Difuntos')
  poner(trasladarDescanso(new Date(anio, 10, 3)), 'Independencia de Cuenca')

  // Decretados
  for (const [k, nombre] of Object.entries(FERIADOS_DECRETADOS)) {
    if (k.startsWith(`${anio}-`) && !mapa.has(k)) mapa.set(k, nombre)
  }

  _cache.set(anio, mapa)
  return mapa
}

// --- consultas ----------------------------------------------------------------

/** Nombre del feriado si esa fecha es de descanso obligatorio; null si no lo es. */
export function esFeriado(fecha) {
  return feriadosDeAnio(fecha.getFullYear()).get(claveFecha(fecha)) ?? null
}

/** true si la fecha cae en fin de semana. */
export const esFinDeSemana = (fecha) => fecha.getDay() === 0 || fecha.getDay() === 6

/** true si la fecha NO es hábil: fin de semana o feriado. */
export const esDiaNoHabil = (fecha) => esFinDeSemana(fecha) || esFeriado(fecha) !== null

/** Motivo por el que una fecha no es hábil ('sábado', 'domingo' o el feriado). null si es hábil. */
export function motivoNoHabil(fecha) {
  if (fecha.getDay() === 6) return 'sábado'
  if (fecha.getDay() === 0) return 'domingo'
  return esFeriado(fecha)
}

/**
 * Primer día hábil en o después de `fecha`: salta fines de semana y feriados
 * (incluidos los encadenados, p. ej. viernes feriado + sábado + domingo).
 * Devuelve una Date nueva; no muta la original.
 */
export function siguienteDiaHabil(fecha) {
  let d = soloFecha(fecha)
  // Cota de seguridad: ninguna cadena real de días no hábiles pasa de ~10 días.
  for (let i = 0; i < 15 && esDiaNoHabil(d); i++) d = masDias(d, 1)
  return d
}

/**
 * Traslado aplicado a una fecha límite: { fecha, original, dias, motivo }.
 * `motivo` es el nombre del feriado o el día de fin de semana que causó el
 * corrimiento (el del día original); `dias` es 0 si no hubo traslado.
 */
export function trasladoDiaHabil(fecha) {
  const original = soloFecha(fecha)
  const habil = siguienteDiaHabil(original)
  const dias = Math.round((habil - original) / 86400000)
  return { fecha: habil, original, dias, motivo: dias === 0 ? null : motivoNoHabil(original) }
}
