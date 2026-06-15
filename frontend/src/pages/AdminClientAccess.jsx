import { useState, useEffect, useMemo } from 'react'
import { adminAPI } from '../services/api'
import './AdminClientAccess.css'

export default function AdminClientAccess() {
  const [users, setUsers] = useState([])
  const [selectedUid, setSelectedUid] = useState('')
  const [grupos, setGrupos] = useState([])
  const [loadingUsers, setLoadingUsers] = useState(true)
  const [loadingAccess, setLoadingAccess] = useState(false)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState({}) // { key: true/false }

  useEffect(() => {
    adminAPI.listUsers()
      .then((r) => {
        // Mostrar solo usuarios que no son el super-admin (clientes y socios)
        const list = (r.data || []).filter((u) => u.role !== 'admin')
        setUsers(list)
      })
      .finally(() => setLoadingUsers(false))
  }, [])

  useEffect(() => {
    if (!selectedUid) { setGrupos([]); return }
    setLoadingAccess(true)
    adminAPI.clientAccess(selectedUid)
      .then((r) => setGrupos(r.data?.data || []))
      .finally(() => setLoadingAccess(false))
  }, [selectedUid])

  const toggle = async (g) => {
    const key = `${g.owner_user_id}:${g.identificacion}`
    setBusy((b) => ({ ...b, [key]: true }))
    try {
      await adminAPI.setClientAccess({
        identificacion: g.identificacion,
        owner_user_id: g.owner_user_id,
        granted_to: selectedUid,
        grant: !g.con_acceso,
      })
      setGrupos((prev) => prev.map((x) =>
        x.identificacion === g.identificacion && x.owner_user_id === g.owner_user_id
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

  const conAcceso = grupos.filter((g) => g.con_acceso).length
  const selectedUser = users.find((u) => u.user_id === selectedUid)

  return (
    <div className="aca-wrap">
      <div className="aca-header">
        <div>
          <h1 className="aca-title">Acceso a Clientes</h1>
          <p className="aca-sub">Asigna qué contribuyentes puede ver cada usuario.</p>
        </div>
      </div>

      {/* Selector de usuario */}
      <div className="aca-user-row">
        <label className="aca-label">Usuario</label>
        {loadingUsers ? (
          <span className="aca-loading-txt">Cargando usuarios…</span>
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
          <p>Selecciona un usuario para gestionar su acceso a clientes.</p>
        </div>
      )}

      {selectedUid && loadingAccess && (
        <div className="aca-loading">Cargando contribuyentes…</div>
      )}

      {selectedUid && !loadingAccess && (
        <>
          {/* Barra de búsqueda y resumen */}
          <div className="aca-toolbar">
            <input
              className="aca-search"
              placeholder="🔍 Buscar por nombre o RUC…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span className="aca-count">
              {conAcceso} de {grupos.length} contribuyente{grupos.length !== 1 ? 's' : ''} con acceso
            </span>
          </div>

          {filtered.length === 0 && (
            <div className="aca-no-results">Sin coincidencias para "{search}"</div>
          )}

          <div className="aca-list">
            {filtered.map((g) => {
              const key = `${g.owner_user_id}:${g.identificacion}`
              const cargando = busy[key]
              return (
                <label
                  key={key}
                  className={`aca-item ${g.con_acceso ? 'on' : ''} ${cargando ? 'busy' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={g.con_acceso}
                    disabled={cargando}
                    onChange={() => toggle(g)}
                  />
                  <div className="aca-item-info">
                    <span className="aca-item-nombre">{g.nombre}</span>
                    <span className="aca-item-ruc">{g.identificacion}</span>
                  </div>
                  <div className="aca-item-right">
                    {g.parcial && <span className="aca-parcial">parcial</span>}
                    {cargando
                      ? <span className="aca-spinner">…</span>
                      : <span className={`aca-status ${g.con_acceso ? 'on' : 'off'}`}>
                          {g.con_acceso ? 'Con acceso' : 'Sin acceso'}
                        </span>
                    }
                  </div>
                </label>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
