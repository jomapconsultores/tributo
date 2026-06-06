import { createContext, useContext, useEffect, useState } from 'react'
import { accessAPI } from '../services/api'

const AccessContext = createContext({ modules: [], isAdmin: false, loading: true, has: () => false })

export const useAccess = () => useContext(AccessContext)

export function AccessProvider({ children }) {
  const [state, setState] = useState({ modules: [], isAdmin: false, subscription: null, loading: true })

  useEffect(() => {
    accessAPI.me()
      .then((r) => setState({ modules: r.data?.modules || [], isAdmin: !!r.data?.is_admin, subscription: r.data?.subscription || null, loading: false }))
      .catch(() => setState({ modules: [], isAdmin: false, subscription: null, loading: false }))
  }, [])

  const has = (m) => state.isAdmin || state.modules.includes(m)
  return <AccessContext.Provider value={{ ...state, has }}>{children}</AccessContext.Provider>
}

// Ruta de inicio según los módulos disponibles
export function homeFor(has) {
  if (has('gastos')) return '/'
  if (has('ingresos_ice')) return '/calculo-ice'
  if (has('retenciones')) return '/retenciones'
  if (has('declaraciones')) return '/declaracion-ice'
  return '/sin-acceso'
}
