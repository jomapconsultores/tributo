import { createContext, useContext, useCallback } from 'react'
import { accessAPI } from '../services/api'
import { clearAll as clearApiCache } from '../services/cache'
import useCachedResource from '../hooks/useCachedResource'

const DEFAULTS = { modules: [], isAdmin: false, role: 'cliente', roles: ['cliente'], subscription: null }

const AccessContext = createContext({ ...DEFAULTS, loading: true, has: () => false })

export const useAccess = () => useContext(AccessContext)

const transformMe = (r) => ({
  modules: r.data?.modules || [],
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
    <AccessContext.Provider value={{ ...state, has, isSuperAdmin, switchRole }}>
      {children}
    </AccessContext.Provider>
  )
}

// Ruta de inicio según los módulos disponibles
export function homeFor(has) {
  if (has('gastos')) return '/'
  if (has('ingresos_ice')) return '/calculo-ice'
  if (has('retenciones')) return '/retenciones'
  if (has('declaraciones')) return '/declaracion-ice'
  return '/sin-acceso'
}
