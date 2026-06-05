// Ensambla el código completo de producto ICE para el anexo SRI, con el orden
// requerido: codImpuesto-057-codProd(6)-presentacion(3)-capacidad(6)-unidad-593-grado(6)
const onlyDigits = (v) => String(v || '').replace(/\D/g, '')
const pad = (v, n) => onlyDigits(v).padStart(n, '0')

export function buildCodProdICE({ codSri, presentacion, capacidad, unidad, grado, codImpuesto }) {
  const s = String(codSri || '').trim()
  if (!s) return ''
  if (s.includes('-')) return s // ya es un código completo
  const cimp = (codImpuesto || '3031')
  const und = onlyDigits(unidad) || '66'
  return `${cimp}-057-${pad(s, 6)}-${pad(presentacion || '13', 3)}-${pad(capacidad || '750', 6)}-${und}-593-${pad(grado || '15', 6)}`
}
