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

// Comprobantes DESCARTADOS por identidad ajena: ventas cuyo EMISOR no es el
// contribuyente que declara, y compras cuyo COMPRADOR no es este contribuyente.
// NO se guardan (igual que las de otro período): solo se informan para que quede
// claro qué se dejó fuera. La equivalencia RUC↔cédula del mismo dueño ya la
// resuelve el backend, así que estas son de OTRA persona/RUC.
export function msgIdentAjena(d) {
  const fmt = (arr, campo) => arr.slice(0, 6)
    .map((r) => `  • ${r.factura || r.archivo || '—'} — ${campo} ${r[campo === 'emisor' ? 'ruc_emisor' : 'ruc_comprador'] || '—'}`)
    .join('\n') + (arr.length > 6 ? `\n  …y ${arr.length - 6} más` : '')
  const parts = []
  const emi = d?.emisor_ajeno || []
  const comp = d?.comprador_ajeno || []
  if (emi.length) {
    parts.push(`\n\n🚫 ${emi.length} venta(s) NO se tomaron en cuenta porque el EMISOR (RUC) ` +
               `no es el contribuyente que declara (la emitió otro RUC):\n${fmt(emi, 'emisor')}`)
  }
  if (comp.length) {
    parts.push(`\n\n🚫 ${comp.length} compra(s) NO se tomaron en cuenta porque el COMPRADOR ` +
               `no es este contribuyente (está a nombre de otra persona):\n${fmt(comp, 'comprador')}`)
  }
  return parts.join('')
}
