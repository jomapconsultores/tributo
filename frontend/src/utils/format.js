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
