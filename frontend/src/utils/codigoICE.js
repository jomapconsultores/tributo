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

export const sinCeros = (v) => String(parseInt(onlyDigits(v) || '0', 10))

// Arma el código completo desde sus 8 partes
export const armarCodigo = (p) =>
  `${onlyDigits(p.impuesto) || '3031'}-${pad(p.clasificacion || '57', 3)}-${pad(p.marca, 6)}-${pad(p.presentacion || '13', 3)}-${pad(p.capacidad || '750', 6)}-${onlyDigits(p.unidad) || '66'}-${pad(p.pais || '593', 3)}-${pad(p.grado || '15', 6)}`

// Descompone un código completo en sus 8 partes; si no tiene el formato, defaults
export const descomponerCodigo = (cod) => {
  const seg = String(cod || '').trim().split('-')
  if (seg.length === 8) {
    return { impuesto: seg[0], clasificacion: seg[1], marca: seg[2], presentacion: seg[3], capacidad: seg[4], unidad: seg[5], pais: seg[6], grado: seg[7] }
  }
  return { impuesto: onlyDigits(cod) || '3031', clasificacion: '057', marca: '', presentacion: '013', capacidad: '000750', unidad: '66', pais: '593', grado: '000015' }
}
