import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { clientsAPI } from '../services/api'

const ClientContext = createContext(null)

export function ClientProvider({ children }) {
  const [clients, setClients] = useState([])
  const [selectedClientId, setSelectedClientId] = useState(
    () => localStorage.getItem('selectedClientId') || null
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refreshClients = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await clientsAPI.list()
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

  const createClient = useCallback(async (data) => {
    const res = await clientsAPI.create(data)
    await refreshClients()
    if (res.data?.id) selectClient(res.data.id)
    return res.data
  }, [refreshClients, selectClient])

  const updateClient = useCallback(async (id, data) => {
    await clientsAPI.update(id, data)
    await refreshClients()
  }, [refreshClients])

  const deleteClient = useCallback(async (id) => {
    await clientsAPI.delete(id)
    if (id === selectedClientId) selectClient(null)
    await refreshClients()
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
