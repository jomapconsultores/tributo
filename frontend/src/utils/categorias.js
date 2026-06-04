// Mismas categorías de "Gastos Personales" que usa el backend (export_service.py)
// para separar el RESUMEN en Personales vs. Ejercicio.
export const GASTOS_PERSONALES = new Set([
  'ALIMENTACIÓN', 'ALIMENTACION', 'EDUCACIÓN', 'EDUCACION',
  'SALUD', 'VESTIMENTA', 'VIVIENDA', 'VARIOS', 'TURISMO', 'ARTE Y CULTURA',
])

export function esPersonal(categoria) {
  return GASTOS_PERSONALES.has((categoria || '').toUpperCase())
}
