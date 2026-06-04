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

export function periodoLargo(client) {
  if (!client?.periodo_mes || !client?.periodo_anio) return ''
  return `${nombreMes(client.periodo_mes)} ${client.periodo_anio}`
}

export function periodoCorto(client) {
  if (!client?.periodo_mes || !client?.periodo_anio) return ''
  return `${MESES_CORTO[client.periodo_mes - 1]} ${client.periodo_anio}`
}
