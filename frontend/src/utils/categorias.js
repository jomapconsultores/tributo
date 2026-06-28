// Mismas categorías de "Gastos Personales" que usa el backend (export_service.py)
// para separar el RESUMEN en Personales vs. Ejercicio.
export const GASTOS_PERSONALES = new Set([
  'ALIMENTACIÓN', 'EDUCACIÓN',
  'SALUD', 'VESTIMENTA', 'VIVIENDA', 'VARIOS', 'TURISMO', 'ARTE Y CULTURA',
])

// Normaliza para comparar sin importar tildes (ALIMENTACION == ALIMENTACIÓN).
const _norm = (s) => (s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const _PERSONAL_NORM = new Set([...GASTOS_PERSONALES].map(_norm))

export function esPersonal(categoria) {
  return _PERSONAL_NORM.has(_norm(categoria))
}
