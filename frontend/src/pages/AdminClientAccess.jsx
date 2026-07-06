import { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { adminAPI } from '../services/api'
import { filtrarClientesPorTexto } from '../utils/clientSearch'
import './AdminClientAccess.css'

// Módulos contratables (incluye los nuevos). El orden es el de presentación.
const MODULOS = [
  { key: 'gastos',           label: 'Gastos',              color: 'blue' },
  { key: 'retenciones',      label: 'Retenciones',         color: 'orange' },
  { key: 'ingresos_ice',     label: 'Ingresos ICE',        color: 'purple' },
  { key: 'declaraciones',    label: 'Declaraciones',       color: 'green' },
  { key: 'agente_retencion', label: 'Agente de retención', color: 'teal' },
]
const MOD_LABEL = Object.fromEntries(MODULOS.map((m) => [m.key, m.label]))

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
  const [subBusy, setSubBusy]         = useState(false)
  const [bulkBusy, setBulkBusy]       = useState(false)
  const [modulos, setModulos]         = useState(new Set())      // módulos activos del usuario
  const [submods, setSubmods]         = useState(new Set())      // pantallas PERMITIDAS del usuario
  const [catalogo, setCatalogo]       = useState({})            // { modulo: [{key,label}] }

  // Carga usuarios (sin admins) + catálogo de submódulos
  useEffect(() => {
    adminAPI.listUsers()
      .then((r) => setUsers((r.data || []).filter((u) => u.role !== 'admin')))
      .finally(() => setLoadingUsers(false))
    adminAPI.submodulosCatalogo().then((r) => setCatalogo(r.data?.catalogo || {})).catch(() => {})
  }, [])

  // Derivar módulos/submódulos del usuario seleccionado. Depende de 'users'
  // porque los toggles mutan ese array — pero solo actualiza estado local (sin red).
  useEffect(() => {
    if (!selectedUid) { setModulos(new Set()); setSubmods(new Set()); return }
    const u = users.find((x) => x.user_id === selectedUid)
    if (u) {
      setModulos(new Set(Object.entries(u.modules || {}).filter(([, v]) => v.activo).map(([k]) => k)))
      setSubmods(new Set(u.submodules || []))
    }
  }, [selectedUid, users])

  // Cargar contribuyentes SOLO al cambiar de usuario (no en cada toggle de
  // módulo/submódulo — antes 'users' estaba en las deps y causaba refetch+flicker).
  useEffect(() => {
    if (!selectedUid) { setGrupos([]); return }
    setLoadingAccess(true)
    adminAPI.clientAccess(selectedUid)
      .then((r) => setGrupos(r.data?.data || []))
      .finally(() => setLoadingAccess(false))
  }, [selectedUid])

  // ── 1) Módulos ──────────────────────────────────────────────────────────
  const toggleModulo = async (key) => {
    if (modBusy) return
    setModBusy(true)
    const next = new Set(modulos)
    next.has(key) ? next.delete(key) : next.add(key)
    try {
      await adminAPI.setModules(selectedUid, [...next], null)
      setModulos(next)
      setUsers((prev) => prev.map((u) => u.user_id !== selectedUid ? u
        : { ...u, modules: Object.fromEntries(MODULOS.map((m) => [m.key, { activo: next.has(m.key) }])) }))
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
    finally { setModBusy(false) }
  }

  // ── 2) Submódulos (pantallas) ───────────────────────────────────────────
  // submods = conjunto PERMITIDO completo. Guardar envía todo el conjunto; el
  // backend reconcilia por módulo (todos marcados = sin restricción).
  const guardarSubmods = async (next) => {
    // Guarda CRÍTICA: un módulo ACTIVO no puede quedar con 0 pantallas. Si se
    // guardara vacío, el backend lo interpreta como "sin restricción = TODAS"
    // (lo opuesto a lo que quiere el admin). Para no dar ninguna pantalla de un
    // módulo, hay que desactivar el módulo en la sección 1.
    for (const m of MODULOS) {
      if (!modulos.has(m.key)) continue
      const keys = (catalogo[m.key] || []).map((s) => s.key)
      if (keys.length && !keys.some((k) => next.has(k))) {
        alert(`El módulo "${m.label}" no puede quedar sin ninguna pantalla marcada.\n\nSi no quieres que vea nada de ese módulo, desactívalo en la sección 1 (Módulos). Debe quedar al menos una pantalla marcada.`)
        return
      }
    }
    setSubBusy(true)
    try { await adminAPI.setSubmodules(selectedUid, [...next]); setSubmods(next)
      setUsers((prev) => prev.map((u) => u.user_id === selectedUid ? { ...u, submodules: [...next] } : u))
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
    finally { setSubBusy(false) }
  }
  const toggleSubmod = (subKey) => {
    if (subBusy) return
    const next = new Set(submods)
    next.has(subKey) ? next.delete(subKey) : next.add(subKey)
    guardarSubmods(next)
  }
  const marcarTodasDelModulo = (modKey) => {
    if (subBusy) return
    const next = new Set(submods)
    ;(catalogo[modKey] || []).forEach((s) => next.add(s.key))
    guardarSubmods(next)
  }

  // ── 3) Contribuyentes (clientes) ────────────────────────────────────────
  const toggleCliente = async (g) => {
    const key = g.identificacion
    setBusy((b) => ({ ...b, [key]: true }))
    try {
      await adminAPI.setClientAccess({ identificacion: g.identificacion, granted_to: selectedUid, grant: !g.con_acceso })
      setGrupos((prev) => prev.map((x) => x.identificacion === g.identificacion ? { ...x, con_acceso: !g.con_acceso, parcial: false } : x))
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
    finally { setBusy((b) => ({ ...b, [key]: false })) }
  }

  const filtered = useMemo(() => filtrarClientesPorTexto(grupos, search), [grupos, search])

  const marcarClientes = async (grant) => {
    // Al dar: los que no tienen acceso. Al quitar: los que tienen acceso total O parcial.
    const objetivo = grant
      ? filtered.filter((g) => !g.con_acceso)
      : filtered.filter((g) => g.con_acceso || g.parcial)
    if (objetivo.length === 0) return
    if (grant && objetivo.length > 8 && !window.confirm(`¿Dar acceso a ${objetivo.length} contribuyente(s) filtrado(s)?`)) return
    if (!grant && !window.confirm(`¿Quitar el acceso a ${objetivo.length} contribuyente(s) filtrado(s)?`)) return
    setBulkBusy(true)
    try {
      await adminAPI.setClientAccessBulk(selectedUid, objetivo.map((g) => g.identificacion), grant)
      const ids = new Set(objetivo.map((g) => g.identificacion))
      setGrupos((prev) => prev.map((x) => ids.has(x.identificacion) ? { ...x, con_acceso: grant, parcial: false } : x))
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
    finally { setBulkBusy(false) }
  }

  const conAcceso = grupos.filter((g) => g.con_acceso).length
  const hayAlgunAcceso = grupos.some((g) => g.con_acceso || g.parcial)
  const selectedUser = users.find((u) => u.user_id === selectedUid)
  // Módulos activos que tienen pantallas configurables (catálogo)
  const modsConSub = MODULOS.filter((m) => modulos.has(m.key) && (catalogo[m.key] || []).length > 0)

  return (
    <div className="aca-wrap">
      <div className="aca-header">
        <h1 className="aca-title">🔐 Permisos del usuario</h1>
        <p className="aca-sub">Autoriza en orden: <strong>1) Módulos</strong> → <strong>2) Pantallas</strong> → <strong>3) Contribuyentes</strong>.</p>
      </div>

      {/* Selector de usuario */}
      <div className="aca-user-row">
        <label className="aca-label">Usuario</label>
        {loadingUsers ? <span className="aca-loading-txt">Cargando…</span> : (
          <select className="aca-select" value={selectedUid} onChange={(e) => { setSelectedUid(e.target.value); setSearch('') }}>
            <option value="">— Selecciona un usuario —</option>
            {users.map((u) => <option key={u.user_id} value={u.user_id}>{u.email} · {u.role}</option>)}
          </select>
        )}
      </div>

      {!selectedUid && (
        <div className="aca-empty"><span className="aca-empty-ico">👤</span><p>Selecciona un usuario para gestionar sus permisos.</p></div>
      )}

      {selectedUid && (
        <>
          {/* ── 1) MÓDULOS ── */}
          <div className="aca-section">
            <div className="aca-section-title"><span className="aca-step">1</span> Módulos {modBusy && <span className="aca-count-inline">guardando…</span>}</div>
            <p className="aca-hint">Marca a qué módulos del sistema tiene acceso este usuario.</p>
            <div className="aca-mods-grid">
              {MODULOS.map((m) => {
                const activo = modulos.has(m.key)
                return (
                  <label key={m.key} className={`aca-mod-item ${activo ? 'on' : ''} mod-${m.color} ${modBusy ? 'busy' : ''}`}>
                    <input type="checkbox" checked={activo} disabled={modBusy} onChange={() => toggleModulo(m.key)} />
                    <span className="aca-mod-label">{m.label}</span>
                  </label>
                )
              })}
            </div>
          </div>

          {/* ── 2) PANTALLAS (submódulos) ── */}
          <div className="aca-section">
            <div className="aca-section-title"><span className="aca-step">2</span> Pantallas dentro de cada módulo {subBusy && <span className="aca-count-inline">guardando…</span>}</div>
            {modsConSub.length === 0 ? (
              <p className="aca-hint">Activa un módulo arriba para elegir sus pantallas. (Con todas marcadas, ve el módulo completo.)</p>
            ) : (
              <>
                <p className="aca-hint">Desmarca las pantallas que NO debe ver. Con todas marcadas ve el módulo completo. Para no darle ninguna pantalla de un módulo, desactiva el módulo arriba.</p>
                {modsConSub.map((m) => {
                  const subs = catalogo[m.key] || []
                  const total = subs.length
                  const marcadas = subs.filter((s) => submods.has(s.key)).length
                  return (
                    <div key={m.key} className="aca-subgroup">
                      <div className="aca-subgroup-head">
                        <strong>{m.label}</strong>
                        <span className="aca-subgroup-actions">
                          <span className="aca-subcount">{marcadas}/{total}</span>
                          <button type="button" className="aca-mini" disabled={subBusy || marcadas === total} onClick={() => marcarTodasDelModulo(m.key)}>Todas</button>
                        </span>
                      </div>
                      <div className="aca-subgrid">
                        {subs.map((s) => (
                          <label key={s.key} className={`aca-sub-item ${submods.has(s.key) ? 'on' : ''} ${subBusy ? 'busy' : ''}`}>
                            <input type="checkbox" checked={submods.has(s.key)} disabled={subBusy} onChange={() => toggleSubmod(s.key)} />
                            <span>{s.label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </>
            )}
          </div>

          {/* ── 3) CONTRIBUYENTES ── */}
          <div className="aca-section">
            <div className="aca-section-title">
              <span className="aca-step">3</span> Contribuyentes (clientes)
              {!loadingAccess && <span className="aca-count-inline">{conAcceso} / {grupos.length} con acceso</span>}
            </div>
            <p className="aca-hint">Marca los contribuyentes que este usuario podrá ver y trabajar (declaraciones, cálculos, etc.).</p>
            {loadingAccess ? <div className="aca-loading">Cargando contribuyentes…</div> : (
              <>
                <div className="aca-cli-toolbar">
                  <input className="aca-search" placeholder="🔍 Buscar por nombre o RUC…" value={search} onChange={(e) => setSearch(e.target.value)} />
                  <button type="button" className="aca-mini strong" disabled={bulkBusy || filtered.length === 0} onClick={() => marcarClientes(true)}>✓ Marcar todos{search ? ' (filtrados)' : ''}</button>
                  <button type="button" className="aca-mini" disabled={bulkBusy || !hayAlgunAcceso} onClick={() => marcarClientes(false)}>Ninguno{search ? ' (filtrados)' : ''}</button>
                </div>
                {bulkBusy && <div className="aca-loading">Aplicando…</div>}
                {filtered.length === 0 && grupos.length > 0 && <div className="aca-no-results">Sin coincidencias para "{search}"</div>}
                {grupos.length === 0 && <div className="aca-no-results">No hay contribuyentes registrados todavía.</div>}
                <div className="aca-table">
                  {filtered.map((g) => {
                    const cargando = busy[g.identificacion]
                    return (
                      <label key={g.identificacion} className={`aca-row ${g.con_acceso ? 'on' : ''} ${cargando ? 'busy' : ''}`}>
                        <input type="checkbox" checked={g.con_acceso} disabled={cargando} onChange={() => toggleCliente(g)} />
                        <span className="aca-row-nombre">{g.nombre}</span>
                        <span className="aca-row-ruc">{g.identificacion}</span>
                        {g.parcial && <span className="aca-parcial">parcial</span>}
                        <span className={`aca-status ${g.con_acceso ? 'on' : 'off'}`}>{cargando ? '…' : g.con_acceso ? 'Con acceso' : 'Sin acceso'}</span>
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
