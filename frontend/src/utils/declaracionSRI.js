// Calendario tributario SRI (Ecuador)
// La fecha máxima de declaración mensual (IVA - Form. 104, Retenciones - Form. 103,
// ICE - Form. 113) depende del NOVENO dígito del RUC/identificación.
//
//   9no dígito -> día máximo
//     1 -> 10      6 -> 20
//     2 -> 12      7 -> 22
//     3 -> 14      8 -> 24
//     4 -> 16      9 -> 26
//     5 -> 18      0 -> 28
//
// Nota: si el día cae en fin de semana o feriado, el SRI lo traslada al
// siguiente día hábil. Aquí se devuelve la fecha base según el dígito.

const DIA_POR_DIGITO = {
  1: 10, 2: 12, 3: 14, 4: 16, 5: 18,
  6: 20, 7: 22, 8: 24, 9: 26, 0: 28,
}

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]

// Noveno dígito del RUC (índice 8). Devuelve null si el RUC no es válido.
export function novenoDigito(ruc) {
  if (!ruc) return null
  const s = String(ruc).trim()
  if (s.length < 9 || !/^\d+$/.test(s)) return null
  return parseInt(s[8], 10)
}

// Día máximo (10-28) de declaración mensual según el 9no dígito. null si inválido.
export function diaDeclaracion(ruc) {
  const d = novenoDigito(ruc)
  if (d === null) return null
  return DIA_POR_DIGITO[d] ?? null
}

// Próxima fecha concreta de declaración a partir de `hoy` (Date). null si inválido.
export function proximaFechaDeclaracion(ruc, hoy = new Date()) {
  const dia = diaDeclaracion(ruc)
  if (dia === null) return null
  let anio = hoy.getFullYear()
  let mes = hoy.getMonth() // 0-11
  if (hoy.getDate() > dia) {
    mes += 1
    if (mes > 11) { mes = 0; anio += 1 }
  }
  return new Date(anio, mes, dia)
}

// Resumen listo para mostrar. { valido, digito, dia, proximaFecha, proximaFechaTexto }
export function infoDeclaracion(ruc, hoy = new Date()) {
  const digito = novenoDigito(ruc)
  const dia = digito === null ? null : (DIA_POR_DIGITO[digito] ?? null)
  if (dia === null) {
    return { valido: false, digito, dia: null, proximaFecha: null, proximaFechaTexto: null }
  }
  const f = proximaFechaDeclaracion(ruc, hoy)
  return {
    valido: true,
    digito,
    dia,
    proximaFecha: f,
    proximaFechaTexto: `${f.getDate()} de ${MESES[f.getMonth()]} de ${f.getFullYear()}`,
  }
}
