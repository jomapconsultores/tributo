import { createContext, useContext, useCallback } from 'react'
import { accessAPI } from '../services/api'
import useCachedResource from '../hooks/useCachedResource'

const DEFAULTS = { modules: [], isAdmin: false, role: 'cliente', subscription: null }

const AccessContext = createContext({ ...DEFAULTS, loading: true, has: () => false })

export const useAccess = () => useContext(AccessContext)

const transformMe = (r) => ({
  modules: r.data?.modules || [],
  isAdmin: !!r.data?.is_admin,
  role: r.data?.role || 'cliente',
  subscription: r.data?.subscription || null,
})

export function AccessProvider({ children }) {
  // Cacheado 5 min: los módulos y el rol cambian con poca frecuencia.
  const fetchMe = useCallback(() => accessAPI.me(), [])
  const { data, loading } = useCachedResource('access:me', 5 * 60_000, fetchMe, transformMe)

  const state = { ...DEFAULTS, ...data, loading }
  const isSuperAdmin = state.role === 'admin'
  const has = (m) => isSuperAdmin || state.modules.includes(m)
  return (
    <AccessContext.Provider value={{ ...state, has, isSuperAdmin }}>
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
