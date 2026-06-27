// Espejo de backend/services/ice_calc_data.py
export const TARIFAS = {
  '2021': { ALCOHOLICA: 7.18, ARTESANAL: 1.49, INDUSTRIAL: 8.41, umbral: 4.29 },
  '2022': { ALCOHOLICA: 10.00, ARTESANAL: 1.50, INDUSTRIAL: 13.08, umbral: 4.37 },
  '2023': { ALCOHOLICA: 10.00, ARTESANAL: 1.50, INDUSTRIAL: 13.08, umbral: 4.53 },
  '2024': { ALCOHOLICA: 10.15, ARTESANAL: 1.52, INDUSTRIAL: 13.28, umbral: 4.60 },
  '2025': { ALCOHOLICA: 10.30, ARTESANAL: 1.54, INDUSTRIAL: 13.48, umbral: 4.67 },
  '2026': { ALCOHOLICA: 10.41, ARTESANAL: 1.56, INDUSTRIAL: 13.62, umbral: 4.72 },
}

export const CATEGORIAS = [
  { key: 'ALCOHOLICA', label: 'Bebidas alcohólicas' },
  { key: 'ARTESANAL', label: 'Cervezas artesanales' },
  { key: 'INDUSTRIAL', label: 'Cervezas industriales' },
]
export const CAT_LABEL = Object.fromEntries(CATEGORIAS.map((c) => [c.key, c.label]))

// Código de impuesto SRI ↔ categoría de tarifa específica
export const IMPUESTO_CAT = {
  '3031': 'ALCOHOLICA',  // ICE Bebidas alcohólicas
  '3041': 'INDUSTRIAL',  // ICE Cerveza industrial
  '3043': 'ARTESANAL',   // ICE Cerveza artesanal
}
export const IMPUESTO_LABEL = {
  '3031': 'ICE Bebidas alcohólicas',
  '3041': 'ICE Cerveza industrial',
  '3043': 'ICE Cerveza artesanal',
}
export const CAT_IMPUESTO = { ALCOHOLICA: '3031', INDUSTRIAL: '3041', ARTESANAL: '3043' }

// Tarifa específica ($/litro de alcohol puro) según código de impuesto y año.
// Devuelve null si el código no tiene tarifa específica definida.
export function tarifaEspecifica(codImpuesto, anio) {
  const cat = IMPUESTO_CAT[String(codImpuesto || '').trim()]
  if (!cat) return null
  const tar = TARIFAS[String(anio)] || TARIFAS['2026']
  const v = tar[cat]
  return v == null ? null : v
}

export function ivaRate(anio, mes) {
  const a = parseInt(anio, 10) || 2026
  const m = parseInt(mes, 10) || 1
  if (a <= 2023) return 0.12
  if (a === 2024) return m <= 3 ? 0.12 : 0.15
  return 0.15
}

const f = (v) => parseFloat(v) || 0

export function calcRow(r, anio, mes) {
  const tar = TARIFAS[String(anio)] || TARIFAS['2026']
  const cat = (r.categoria || 'ALCOHOLICA').toUpperCase()
  const tarifa = tar[cat] || 0
  const umbral = tar.umbral || 0
  const iva = ivaRate(anio, mes)

  const porCajas = r.por_cajas !== false
  const cajas = f(r.cajas)
  const bpc = f(r.botellas_por_caja)
  const unidades = f(r.unidades)
  const grado = f(r.grado)
  const cap = f(r.capacidad)
  const precio = f(r.precio)

  const totalBot = porCajas ? cajas * bpc : unidades
  const precioBot = porCajas ? (bpc > 0 ? precio / bpc : 0) : precio
  const litrosPb = (grado / 100) * (cap / 1000)
  const precioLitro = cap > 0 ? (precioBot * 1000) / cap : 0

  const iceEsp = tarifa * litrosPb * totalBot
  let iceAdv = 0
  const aplicaAdv = cat === 'ALCOHOLICA' && precioLitro > umbral
  if (aplicaAdv) iceAdv = (precioLitro - umbral) * 0.75 * (cap / 1000) * totalBot
  const totalIce = iceEsp + iceAdv
  const subtotal = precioBot * totalBot
  const baseIva = subtotal + totalIce
  const ivaVal = baseIva * iva
  const pvp = baseIva + ivaVal

  // ICE calculado por botella individual (base del cálculo) → caja → total
  const iceEspBot = tarifa * litrosPb
  const iceAdvBot = aplicaAdv ? (precioLitro - umbral) * 0.75 * (cap / 1000) : 0
  const icePorBotella = iceEspBot + iceAdvBot

  return {
    cat, totalBot, precioBot, precioLitro, aplicaAdv,
    iceEsp, iceAdv, totalIce, subtotal, baseIva, iva: ivaVal, pvp,
    iceEspBot, iceAdvBot, icePorBotella,
    icePorCaja: icePorBotella * bpc,
    ivaTasa: iva,
  }
}
