import { createContext, useContext, useCallback } from 'react'
import { accessAPI } from '../services/api'
import { clearAll as clearApiCache } from '../services/cache'
import useCachedResource from '../hooks/useCachedResource'

const DEFAULTS = { modules: [], submodules: null, isAdmin: false, role: 'cliente', roles: ['cliente'], subscription: null }

const AccessContext = createContext({ ...DEFAULTS, loading: true, has: () => false, hasSub: () => true })

export const useAccess = () => useContext(AccessContext)

const transformMe = (r) => ({
  modules: r.data?.modules || [],
  // null = desconocido (backend viejo o cargando) → el frontend no oculta nada
  // (el backend igual valida). Array = pantallas permitidas.
  submodules: r.data?.submodules || null,
  isAdmin: !!r.data?.is_admin,
  role: r.data?.role || 'cliente',
  roles: r.data?.roles?.length ? r.data.roles : [r.data?.role || 'cliente'],
  subscription: r.data?.subscription || null,
})

export function AccessProvider({ children }) {
  // Cacheado 5 min: los módulos y el rol cambian con poca frecuencia.
  const fetchMe = useCallback(() => accessAPI.me(), [])
  const { data, loading } = useCachedResource('access:me', 5 * 60_000, fetchMe, transformMe)

  const state = { ...DEFAULTS, ...data, loading }
  const isSuperAdmin = state.role === 'admin'
  const has = (m) => isSuperAdmin || state.modules.includes(m)
  // hasSub: ¿el usuario puede ver esta pantalla (submódulo)? Fail-open si aún no
  // se conocen los submódulos (null): el backend sigue siendo la autoridad.
  const hasSub = (key) => isSuperAdmin || !state.submodules || state.submodules.includes(key)

  // Cambiar el rol activo. Como el rol determina la VISIBILIDAD de datos en toda
  // la app (clientes, módulos, permisos), tras el cambio se limpia TODO el caché
  // y se recarga la app desde cero para no arrastrar datos del rol anterior.
  const switchRole = useCallback(async (role) => {
    if (role === state.role) return
    await accessAPI.switchRole(role)
    clearApiCache()
    window.location.assign('/')
  }, [state.role])

  return (
    <AccessContext.Provider value={{ ...state, has, hasSub, isSuperAdmin, switchRole }}>
      {children}
    </AccessContext.Provider>
  )
}

// Ruta de inicio según los módulos Y submódulos disponibles. Se pasa hasSub para
// que el destino de redirección sea una pantalla REALMENTE accesible (evita
// bucles cuando el submódulo de la pantalla por defecto está restringido).
export function homeFor(has, hasSub = () => true) {
  if (has('gastos') && hasSub('gastos_facturas')) return '/'
  if (has('gastos') && hasSub('gastos_clasificar')) return '/clasificador'
  if (has('ingresos_ice') && hasSub('ice_calculo')) return '/calculo-ice'
  if (has('ingresos_ice') && hasSub('ice_xml')) return '/ice'
  if (has('ingresos_ice') && hasSub('ice_catalogo')) return '/catalogo-productos'
  if (has('retenciones')) return '/retenciones'
  if (has('declaraciones') && hasSub('decl_ice')) return '/declaracion-ice'
  if (has('declaraciones') && hasSub('decl_iva')) return '/declaracion-iva'
  if (has('agente_retencion') && hasSub('agret_retenciones')) return '/retenciones-efectuadas'
  return '/sin-acceso'
}
