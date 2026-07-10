import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react'
import { clientsAPI } from '../services/api'
import { periodoADeclarar } from '../utils/declaracionSRI'
import useCachedResource from '../hooks/useCachedResource'

const ClientContext = createContext(null)

const CLIENTS_TTL = 90_000 // 90 s — tiempo de vida del caché de clientes

// Clave única de localStorage para el cliente seleccionado (compartida con App.jsx)
export const SELECTED_CLIENT_KEY = 'selectedClientId'

const fetchClients = () => clientsAPI.list()
const transformClients = (res) => res.data || []

export function ClientProvider({ children }) {
  const [selectedClientId, setSelectedClientId] = useState(
    () => localStorage.getItem(SELECTED_CLIENT_KEY) || null
  )
  const [focusIdent, setFocusIdent] = useState(null)
  const [svcMap, setSvcMap] = useState(null) // null = cargando; {} = sin servicios
  const [servicesError, setServicesError] = useState('') // mensaje de error real al cargar servicesMap (distinto de "sin servicios")
  // Resultado de la apertura automática del período mes vencido (para avisar al
  // usuario). null = nada que avisar; { creados, periodo:{mes,anio} } si abrió.
  const [aperturaVencido, setAperturaVencido] = useState(null)

  // force=true invalida el caché y fuerza un re-fetch (tras mutaciones).
  // force=false (defecto, reload() sin args) reutiliza la respuesta cacheada
  // si está vigente.
  const { data: clientsData, loading, error, reload: refreshClients } =
    useCachedResource('clients:list', CLIENTS_TTL, fetchClients, transformClients)
  const clients = clientsData || []

  useEffect(() => {
    clientsAPI.servicesMap()
      .then((r) => {
        const m = {}
        for (const [svc, idents] of Object.entries(r.data || {})) m[svc] = new Set(idents)
        setSvcMap(m)
        setServicesError('')
      })
      .catch((e) => {
        // Error real de red/backend: no lo confundimos con "sin servicios contratados".
        setServicesError(e.response?.data?.detail || e.message)
        setSvcMap({})
      })
  }, [])

  // Declaración mes vencido: al entrar (cambio de mes), abrir automáticamente el
  // período a declarar (el mes anterior) para los contribuyentes trabajados el
  // ciclo previo. El backend es idempotente; el gate por período en localStorage
  // evita repetir la llamada en cada carga. Solo se marca hecho si tuvo éxito.
  useEffect(() => {
    const per = periodoADeclarar()
    const gateKey = `abrirPeriodoVencido:${per.anio}-${String(per.mes).padStart(2, '0')}`
    if (localStorage.getItem(gateKey)) return
    clientsAPI.abrirPeriodoVencido()
      .then((r) => {
        localStorage.setItem(gateKey, '1')
        const creados = r.data?.creados || 0
        if (creados > 0) {
          refreshClients(true)
          setAperturaVencido({ creados, periodo: r.data?.periodo || per })
        }
      })
      .catch(() => { /* silencioso: no bloquea la app; reintenta en la próxima carga */ })
  }, [refreshClients])

  const identsForSvc = useCallback((service) => {
    if (svcMap === null) return null // todavía cargando
    const svcs = service.split(',').map((s) => s.trim()).filter(Boolean)
    const out = new Set()
    for (const s of svcs) for (const id of (svcMap[s] || new Set())) out.add(id)
    return out
  }, [svcMap])

  const selectClient = useCallback((id) => {
    setSelectedClientId(id)
    if (id) localStorage.setItem(SELECTED_CLIENT_KEY, id)
    else localStorage.removeItem(SELECTED_CLIENT_KEY)
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

  const selectedClient = useMemo(
    () => clients.find((c) => c.id === selectedClientId) || null,
    [clients, selectedClientId]
  )

  const value = useMemo(() => ({
    clients,
    selectedClientId,
    selectedClient,
    loading,
    error,
    servicesError,
    refreshClients,
    selectClient,
    createClient,
    updateClient,
    deleteClient,
    focusIdent,
    setFocusIdent,
    identsForSvc,
    aperturaVencido,
    dismissAperturaVencido: () => setAperturaVencido(null),
  }), [
    clients,
    selectedClientId,
    selectedClient,
    loading,
    error,
    servicesError,
    refreshClients,
    selectClient,
    createClient,
    updateClient,
    deleteClient,
    focusIdent,
    setFocusIdent,
    identsForSvc,
    aperturaVencido,
  ])

  return (
    <ClientContext.Provider value={value}>
      {children}
    </ClientContext.Provider>
  )
}

export function useClients() {
  const ctx = useContext(ClientContext)
  if (!ctx) throw new Error('useClients debe usarse dentro de ClientProvider')
  return ctx
}
