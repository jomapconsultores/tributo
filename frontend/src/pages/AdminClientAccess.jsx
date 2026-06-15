import { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { adminAPI } from '../services/api'
import './AdminClientAccess.css'

const MODULOS = [
  { key: 'gastos',        label: 'Gastos',          color: 'blue' },
  { key: 'retenciones',   label: 'Retenciones',     color: 'orange' },
  { key: 'ingresos_ice',  label: 'Ingresos ICE',    color: 'purple' },
  { key: 'declaraciones', label: 'Declaraciones',   color: 'green' },
]

export default function AdminClientAccess() {
  const [searchParams] = useSearchParams()
  const [users, setUsers]             = useState([])
  const [selectedUid, setSelectedUid] = useState(searchParams.get('uid') || '')
  const [grupos, setGrupos]           = useState([])
  const [loadingUsers, setLoadingUsers]   = useState(true)
  const [loadingAccess, setLoadingAccess] = useState(false)
  const [search, setSearch]           = useState('')
  const [busy, setBusy]               = useState({})
  const [modBusy, setModBusy]         = useState(false)
  const [modulos, setModulos]         = useState(new Set()) // módulos activos del usuario seleccionado

  // Carga usuarios (con sus módulos incluidos en la respuesta)
  useEffect(() => {
    adminAPI.listUsers()
      .then((r) => {
        const list = (r.data || []).filter((u) => u.role !== 'admin')
        setUsers(list)
      })
      .finally(() => setLoadingUsers(false))
  }, [])

  // Al cambiar usuario: cargar módulos actuales y contribuyentes
  useEffect(() => {
    if (!selectedUid) { setGrupos([]); setModulos(new Set()); return }

    // Módulos del usuario desde la lista ya cargada
    const u = users.find((x) => x.user_id === selectedUid)
    if (u) {
      const activos = new Set(
        Object.entries(u.modules || {}).filter(([, v]) => v.activo).map(([k]) => k)
      )
      setModulos(activos)
    }

    // Acceso a clientes
    setLoadingAccess(true)
    adminAPI.clientAccess(selectedUid)
      .then((r) => setGrupos(r.data?.data || []))
      .finally(() => setLoadingAccess(false))
  }, [selectedUid, users])

  // Toggle módulo
  const toggleModulo = async (key) => {
    if (modBusy) return
    setModBusy(true)
    try {
      const next = new Set(modulos)
      next.has(key) ? next.delete(key) : next.add(key)
      await adminAPI.setModules(selectedUid, [...next], null)
      setModulos(next)
      // Actualizar en la lista local para reflejar el cambio
      setUsers((prev) => prev.map((u) => {
        if (u.user_id !== selectedUid) return u
        const mods = { ...u.modules }
        MODULOS.forEach((m) => { mods[m.key] = { activo: next.has(m.key) } })
        return { ...u, modules: mods }
      }))
    } catch (e) {
      alert('Error: ' + (e.response?.data?.detail || e.message))
    } finally {
      setModBusy(false)
    }
  }

  // Toggle acceso a cliente
  const toggle = async (g) => {
    const key = g.identificacion
    setBusy((b) => ({ ...b, [key]: true }))
    try {
      await adminAPI.setClientAccess({
        identificacion: g.identificacion,
        granted_to: selectedUid,
        grant: !g.con_acceso,
      })
      setGrupos((prev) => prev.map((x) =>
        x.identificacion === g.identificacion
          ? { ...x, con_acceso: !g.con_acceso, parcial: false }
          : x
      ))
    } catch (e) {
      alert('Error: ' + (e.response?.data?.detail || e.message))
    } finally {
      setBusy((b) => ({ ...b, [key]: false }))
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return grupos
    return grupos.filter((g) =>
      [g.nombre, g.identificacion].some((f) => (f || '').toLowerCase().includes(q))
    )
  }, [grupos, search])

  const conAcceso   = grupos.filter((g) => g.con_acceso).length
  const selectedUser = users.find((u) => u.user_id === selectedUid)

  return (
    <div className="aca-wrap">
      <div className="aca-header">
        <h1 className="aca-title">Acceso a Clientes y Módulos</h1>
        <p className="aca-sub">Asigna módulos y contribuyentes visibles para cada usuario.</p>
      </div>

      {/* Selector de usuario */}
      <div className="aca-user-row">
        <label className="aca-label">Usuario</label>
        {loadingUsers ? (
          <span className="aca-loading-txt">Cargando…</span>
        ) : (
          <select
            className="aca-select"
            value={selectedUid}
            onChange={(e) => { setSelectedUid(e.target.value); setSearch('') }}
          >
            <option value="">— Selecciona un usuario —</option>
            {users.map((u) => (
              <option key={u.user_id} value={u.user_id}>
                {u.email} ({u.role})
              </option>
            ))}
          </select>
        )}
      </div>

      {!selectedUid && (
        <div className="aca-empty">
          <span className="aca-empty-ico">👤</span>
          <p>Selecciona un usuario para gestionar su acceso.</p>
        </div>
      )}

      {selectedUid && (
        <>
          {/* ── Checklist de módulos ── */}
          <div className="aca-section">
            <div className="aca-section-title">Módulos contratados</div>
            <div className="aca-mods-grid">
              {MODULOS.map((m) => {
                const activo = modulos.has(m.key)
                return (
                  <label
                    key={m.key}
                    className={`aca-mod-item ${activo ? 'on' : ''} mod-${m.color} ${modBusy ? 'busy' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={activo}
                      disabled={modBusy}
                      onChange={() => toggleModulo(m.key)}
                    />
                    <span className="aca-mod-label">{m.label}</span>
                  </label>
                )
              })}
            </div>
          </div>

          {/* ── Lista de contribuyentes ── */}
          <div className="aca-section">
            <div className="aca-section-title">
              Contribuyentes
              {!loadingAccess && (
                <span className="aca-count-inline">
                  {conAcceso} / {grupos.length} con acceso
                </span>
              )}
            </div>

            {loadingAccess ? (
              <div className="aca-loading">Cargando contribuyentes…</div>
            ) : (
              <>
                <input
                  className="aca-search"
                  placeholder="🔍 Buscar por nombre o RUC…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />

                {filtered.length === 0 && grupos.length > 0 && (
                  <div className="aca-no-results">Sin coincidencias para "{search}"</div>
                )}

                <div className="aca-table">
                  {filtered.map((g) => {
                    const cargando = busy[g.identificacion]
                    return (
                      <label
                        key={g.identificacion}
                        className={`aca-row ${g.con_acceso ? 'on' : ''} ${cargando ? 'busy' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={g.con_acceso}
                          disabled={cargando}
                          onChange={() => toggle(g)}
                        />
                        <span className="aca-row-nombre">{g.nombre}</span>
                        <span className="aca-row-ruc">{g.identificacion}</span>
                        {g.parcial && <span className="aca-parcial">parcial</span>}
                        <span className={`aca-status ${g.con_acceso ? 'on' : 'off'}`}>
                          {cargando ? '…' : g.con_acceso ? 'Con acceso' : 'Sin acceso'}
                        </span>
                      </label>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
