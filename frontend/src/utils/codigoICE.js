// Ensambla el código completo de producto ICE para el anexo SRI, con el orden
// requerido: codImpuesto-057-codProd(6)-presentacion(3)-capacidad(6)-unidad-593-grado(6)
const onlyDigits = (v) => String(v || '').replace(/\D/g, '')
const pad = (v, n) => onlyDigits(v).padStart(n, '0')

// Orden: impuesto - clasificación - marca - presentación - capacidad - unidad - país - grado
export function buildCodProdICE({ codSri, clasificacion, presentacion, capacidad, unidad, pais, grado, codImpuesto }) {
  const s = String(codSri || '').trim()
  if (!s) return ''
  if (s.includes('-')) return s // ya es un código completo
  const cimp = (codImpuesto || '3031')
  const cl = pad(clasificacion || '57', 3)
  const und = onlyDigits(unidad) || '66'
  const ps = pad(pais || '593', 3)
  return `${cimp}-${cl}-${pad(s, 6)}-${pad(presentacion || '13', 3)}-${pad(capacidad || '750', 6)}-${und}-${ps}-${pad(grado || '15', 6)}`
}
