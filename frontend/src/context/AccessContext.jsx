import { createContext, useContext, useEffect, useState } from 'react'
import { accessAPI } from '../services/api'
import { withCache } from '../services/cache'

const AccessContext = createContext({ modules: [], isAdmin: false, role: 'cliente', loading: true, has: () => false })

export const useAccess = () => useContext(AccessContext)

export function AccessProvider({ children }) {
  const [state, setState] = useState({
    modules: [], isAdmin: false, role: 'cliente', subscription: null, loading: true,
  })

  useEffect(() => {
    // Cacheado 5 min: los módulos y el rol cambian con poca frecuencia.
    withCache('access:me', 5 * 60_000, () => accessAPI.me())
      .then((r) => setState({
        modules: r.data?.modules || [],
        isAdmin: !!r.data?.is_admin,
        role: r.data?.role || 'cliente',
        subscription: r.data?.subscription || null,
        loading: false,
      }))
      .catch(() => setState({ modules: [], isAdmin: false, role: 'cliente', subscription: null, loading: false }))
  }, [])

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
