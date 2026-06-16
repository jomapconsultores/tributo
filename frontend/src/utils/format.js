// Formato de números para Ecuador: separador de MILES con punto y
// separador de DECIMALES con coma. Ej: 1234.5 -> "$1.234,50".
// Se usa en todo el sistema (importar `fmtMoney`/`fmtNum`/`fmtPct`).

function _miles(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

export function fmtMoney(v) {
  const n = parseFloat(v) || 0
  const [ent, dec] = Math.abs(n).toFixed(2).split('.')
  return (n < 0 ? '-$' : '$') + _miles(ent) + ',' + dec
}

export function fmtNum(v, decimales = 2) {
  const n = parseFloat(v) || 0
  const [ent, dec] = Math.abs(n).toFixed(decimales).split('.')
  return (n < 0 ? '-' : '') + _miles(ent) + (decimales > 0 ? ',' + dec : '')
}

export function fmtPct(v, decimales = 2) {
  return fmtNum(v, decimales) + '%'
}

// Mensaje (texto) de los comprobantes excluidos por tener fecha de OTRO mes
// (no pertenecen al período en proceso del cliente). Devuelve '' si no hubo.
// `d` es la respuesta del backend (process-xml / process-txt).
export function msgFueraPeriodo(d) {
  const n = d?.fuera_de_periodo || 0
  if (!n) return ''
  const arr = d.fuera_periodo || []
  const lista = arr.slice(0, 6)
    .map((r) => `  • ${r.factura || r.archivo || '—'} — ${r.fecha || ''}`).join('\n')
  const mas = arr.length > 6 ? `\n  …y ${arr.length - 6} más` : ''
  const per = d.periodo ? ` ${d.periodo}` : ' en proceso'
  return `\n\n📅 ${n} comprobante(s) NO se tomaron en cuenta porque están con otra fecha ` +
         `(no pertenecen al período${per}):\n${lista}${mas}`
}
