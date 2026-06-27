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

// 2021 — cerveza industrial: tarifa específica por escala de producción del
// productor (Res. NAC-DGERCGC20-00000078). Desde 2022 hay tarifa única.
export const RANGOS_IND_2021 = [
  { key: 'R1', label: 'Pequeña escala (≤ 730.000 hl)', tarifa: 8.41 },
  { key: 'R2', label: 'Mediana escala (≤ 1.400.000 hl)', tarifa: 10.48 },
  { key: 'R3', label: 'Gran escala (> 1.400.000 hl)', tarifa: 13.08 },
]
export const RANGO_IND_2021_DEFAULT = 'R1'
export function tarifaRangoInd2021(rangoKey) {
  const r = RANGOS_IND_2021.find((x) => x.key === rangoKey)
  return r ? r.tarifa : RANGOS_IND_2021[0].tarifa
}
// ¿Aplica el selector de rango? (solo cerveza industrial 2021)
export function aplicaRangoInd2021(categoria, anio) {
  return (categoria || '').toUpperCase() === 'INDUSTRIAL' && String(anio) === '2021'
}

// Tarifa específica ($/litro de alcohol puro) según código de impuesto y año.
// Para cerveza industrial 2021 usa la tarifa del rango (rangoInd) si se indica.
// Devuelve null si el código no tiene tarifa específica definida.
export function tarifaEspecifica(codImpuesto, anio, rangoInd) {
  const cat = IMPUESTO_CAT[String(codImpuesto || '').trim()]
  if (!cat) return null
  if (cat === 'INDUSTRIAL' && String(anio) === '2021' && rangoInd) {
    return tarifaRangoInd2021(rangoInd)
  }
  const tar = TARIFAS[String(anio)] || TARIFAS['2026']
  const v = tar[cat]
  return v == null ? null : v
}

// Umbral ad-valorem ($/litro) del año. El ICE ad-valorem (75% sobre el excedente)
// solo aplica a bebidas alcohólicas (cód. 3031); en cervezas no hay ad-valorem.
export function umbralAdValorem(anio) {
  const tar = TARIFAS[String(anio)] || TARIFAS['2026']
  return tar.umbral == null ? null : tar.umbral
}

// En 2021 la cerveza industrial tuvo tarifas específicas por rango de volumen de
// producción. El sistema usa el Rango 1 (8.41) como referencia.
export function esIndustrial2021(codImpuesto, anio) {
  return IMPUESTO_CAT[String(codImpuesto || '').trim()] === 'INDUSTRIAL' && String(anio) === '2021'
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
  // 2021 cerveza industrial: tarifa por escala de producción (rango); resto: tabla anual
  const tarifa = (cat === 'INDUSTRIAL' && String(anio) === '2021' && r.rango_ind)
    ? tarifaRangoInd2021(r.rango_ind)
    : (tar[cat] || 0)
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
  // Ad-valorem (75% sobre el excedente del umbral): bebidas alcohólicas y cerveza
  // industrial. La cerveza artesanal solo paga ICE específico.
  const aplicaAdv = (cat === 'ALCOHOLICA' || cat === 'INDUSTRIAL') && precioLitro > umbral
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
