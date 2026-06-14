import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { clientsAPI } from '../services/api'
import { withCache, bust } from '../services/cache'

const ClientContext = createContext(null)

const CLIENTS_TTL = 90_000 // 90 s — tiempo de vida del caché de clientes

export function ClientProvider({ children }) {
  const [clients, setClients] = useState([])
  const [selectedClientId, setSelectedClientId] = useState(
    () => localStorage.getItem('selectedClientId') || null
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [focusIdent, setFocusIdent] = useState(null)

  // force=true invalida el caché y fuerza un re-fetch (tras mutaciones).
  // force=false (defecto) reutiliza la respuesta cacheada si está vigente.
  const refreshClients = useCallback(async (force = false) => {
    if (force) bust('clients:list')
    setLoading(true)
    setError('')
    try {
      const res = await withCache('clients:list', CLIENTS_TTL, () => clientsAPI.list())
      setClients(res.data || [])
      return res.data || []
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshClients()
  }, [refreshClients])

  const selectClient = useCallback((id) => {
    setSelectedClientId(id)
    if (id) localStorage.setItem('selectedClientId', id)
    else localStorage.removeItem('selectedClientId')
  }, [])

  const createClient = useCallback(async (data, opts = {}) => {
    const res = await clientsAPI.create(data)
    await refreshClients(true)
    if (res.data?.id && opts.select !== false) selectClient(res.data.id)
    return res.data
  }, [refreshClients, selectClient])

  const updateClient = useCallback(async (id, data) => {
    await clientsAPI.update(id, data)
    await refreshClients(true)
  }, [refreshClients])

  const deleteClient = useCallback(async (id) => {
    await clientsAPI.delete(id)
    if (id === selectedClientId) selectClient(null)
    await refreshClients(true)
  }, [refreshClients, selectClient, selectedClientId])

  const selectedClient = clients.find((c) => c.id === selectedClientId) || null

  return (
    <ClientContext.Provider
      value={{
        clients,
        selectedClientId,
        selectedClient,
        loading,
        error,
        refreshClients,
        selectClient,
        createClient,
        updateClient,
        deleteClient,
        focusIdent,
        setFocusIdent,
      }}
    >
      {children}
    </ClientContext.Provider>
  )
}

export function useClients() {
  const ctx = useContext(ClientContext)
  if (!ctx) throw new Error('useClients debe usarse dentro de ClientProvider')
  return ctx
}
