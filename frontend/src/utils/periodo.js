export const MESES = [
  'ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO',
  'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE',
]

export const MESES_CORTO = [
  'ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN',
  'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC',
]

export function nombreMes(mes) {
  return MESES[(parseInt(mes, 10) || 0) - 1] || ''
}

// --- Semestral (IVA Form. 104 semestral) -----------------------------------
// 1er semestre = ENE–JUN (ancla mes 6); 2do = JUL–DIC (ancla mes 12).

export function esSemestral(client) {
  return (client?.periodicidad || 'mensual') === 'semestral'
}

// Semestre (1|2) del cliente: usa periodo_semestre, o lo deduce del mes ancla.
export function semestreDe(client) {
  if (client?.periodo_semestre) return parseInt(client.periodo_semestre, 10)
  return (parseInt(client?.periodo_mes, 10) || 1) <= 6 ? 1 : 2
}

// Etiqueta larga del semestre: '1ER SEMESTRE 2026 (ENE–JUN)'.
export function semestreLargo(client) {
  if (!client?.periodo_anio) return ''
  const s = semestreDe(client)
  const rango = s === 1 ? 'ENE–JUN' : 'JUL–DIC'
  return `${s === 1 ? '1ER' : '2DO'} SEMESTRE ${client.periodo_anio} (${rango})`
}

export function semestreCorto(client) {
  if (!client?.periodo_anio) return ''
  const s = semestreDe(client)
  return `${s === 1 ? '1ER' : '2DO'} SEM ${client.periodo_anio}`
}

export function periodoLargo(client) {
  if (esSemestral(client)) return semestreLargo(client)
  if (!client?.periodo_mes || !client?.periodo_anio) return ''
  return `${nombreMes(client.periodo_mes)} ${client.periodo_anio}`
}

export function periodoCorto(client) {
  if (esSemestral(client)) return semestreCorto(client)
  if (!client?.periodo_mes || !client?.periodo_anio) return ''
  return `${MESES_CORTO[client.periodo_mes - 1]} ${client.periodo_anio}`
}
