import { useEffect, useMemo, useState } from 'react'
import { credentialsAPI, clientsAPI } from '../services/api'
import { useAccess } from '../context/AccessContext'
import { infoDeclaracion } from '../utils/declaracionSRI'
import { filterBySearch } from '../utils/search'
import BadgeVencimiento from '../components/BadgeVencimiento'
import './AdminCredentials.css'

const SERVICIOS = [{ key: 'sri_portal', label: 'Portal SRI' }]
const REVEAL_TTL_SECONDS = 30

// Servicios contratables que el admin marca por cliente (declaraciones SRI)
const CLIENT_SERVICES = [
  { key: 'declaracion_iva',   label: 'IVA',  title: 'Declaración IVA' },
  { key: 'declaracion_ice',   label: 'ICE',  title: 'Declaración ICE' },
  { key: 'declaracion_renta', label: 'Renta', title: 'Declaración Renta' },
  { key: 'devolucion_iva',    label: 'Dev.', title: 'Devolución IVA (Tercera Edad, etc.)' },
]

function dedupContribuyentes(clients) {
  const seen = new Set()
  const out = []
  for (const c of clients) {
    if (seen.has(c.identificacion)) continue
    seen.add(c.identificacion)
    out.push({ id: c.id, identificacion: c.identificacion, nombre: c.nombre })
  }
  out.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
  return out
}

export default function AdminCredentials() {
  // El admin (super) ve TODO (claves, revelar, editar). Socio/trabajador acceden
  // a la vista LIMITADA: solo marcar qué declaraciones hace cada contribuyente.
  const { isSuperAdmin } = useAccess()
  const [creds, setCreds] = useState([])
  const [contribs, setContribs] = useState([])
  // Servicios contratados por RUC (compartidos por todo el contribuyente). Maneja
  // las casillas IVA/ICE/Renta/Dev. para TODAS las filas (con o sin credencial).
  const [servicesByRuc, setServicesByRuc] = useState({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [reveal, setReveal] = useState(null) // { id, ruc, nombre, password, ttl }
  const [editor, setEditor] = useState(null) // { mode: 'create'|'edit', credential?: {...} }
  const [busy, setBusy] = useState(false)
  // Filtro persistente por servicio (IVA, ICE, Renta, Dev.). Vacío = todos.
  const [svcFilter, setSvcFilter] = useState(() => {
    try { return JSON.parse(localStorage.getItem('admCredSvcFilter')) || [] } catch { return [] }
  })
  useEffect(() => {
    try { localStorage.setItem('admCredSvcFilter', JSON.stringify(svcFilter)) } catch { /* ignore */ }
  }, [svcFilter])
  const toggleSvcFilter = (key) =>
    setSvcFilter((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key])

  // Filtro por día máximo de declaración (según 9no dígito del RUC) y orden por
  // la próxima fecha de declaración (la más cercana primero)
  const [diaFilter, setDiaFilter] = useState(() => localStorage.getItem('admCredDiaFilter') || '')
  useEffect(() => { try { localStorage.setItem('admCredDiaFilter', diaFilter) } catch { /* ignore */ } }, [diaFilter])
  const [ordenFecha, setOrdenFecha] = useState(() => localStorage.getItem('admCredOrdenFecha') === '1')
  useEffect(() => { try { localStorage.setItem('admCredOrdenFecha', ordenFecha ? '1' : '0') } catch { /* ignore */ } }, [ordenFecha])
  const DIAS_DECL = [10, 12, 14, 16, 18, 20, 22, 24, 26, 28]

  const load = async () => {
    setLoading(true)
    try {
      if (isSuperAdmin) {
        const [credsRes, contribsRes] = await Promise.all([
          credentialsAPI.list(),
          clientsAPI.list(),
        ])
        setCreds(credsRes.data?.data || [])
        setServicesByRuc(credsRes.data?.services_by_ruc || {})
        setContribs(dedupContribuyentes(contribsRes.data || []))
      } else {
        // Socio/trabajador: sin credenciales. Solo contribuyentes visibles + el
        // mapa de servicios (declaraciones marcadas) para poder marcarlas.
        const [contribsRes, svcRes] = await Promise.all([
          clientsAPI.list(),
          clientsAPI.servicesMap(),
        ])
        const byRuc = {}
        for (const [svc, idents] of Object.entries(svcRes.data || {})) {
          for (const id of (idents || [])) {
            if (!byRuc[id]) byRuc[id] = []
            if (!byRuc[id].includes(svc)) byRuc[id].push(svc)
          }
        }
        setCreds([])
        setServicesByRuc(byRuc)
        setContribs(dedupContribuyentes(contribsRes.data || []))
      }
    } catch (e) {
      alert('Error cargando: ' + (e.response?.data?.detail || e.message))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [isSuperAdmin])

  // Una fila por contribuyente (RUC): si ya tiene credencial se muestra tal cual;
  // si NO la tiene (p.ej. cliente recién creado), aparece igual con opción de
  // "＋ Clave" para agregarla. Así un cliente nuevo se refleja automáticamente.
  const allRows = useMemo(() => {
    const credByRuc = {}
    for (const c of creds) { if (c.ruc && !credByRuc[c.ruc]) credByRuc[c.ruc] = c }
    return contribs.map((ct) => {
      const cred = credByRuc[ct.identificacion]
      const services = servicesByRuc[ct.identificacion] || []
      if (cred) return { ...cred, client_services: services }
      return {
        id: `noc-${ct.id}`, client_id: ct.id, ruc: ct.identificacion,
        nombre: ct.nombre, username: null, notes: null, client_services: services,
        needs_reentry: false, updated_at: null, _sinClave: true,
      }
    })
  }, [creds, contribs, servicesByRuc])

  const filtered = useMemo(() => {
    let list = filterBySearch(allRows, search, (c) => [c.nombre, c.ruc, c.username, c.notes])
    list = list.filter((c) => {
      const matchSvc = svcFilter.length === 0 ||
        svcFilter.some((k) => c.client_services?.includes(k))
      const matchDia = !diaFilter || infoDeclaracion(c.ruc).dia === Number(diaFilter)
      return matchSvc && matchDia
    })
    if (ordenFecha) {
      list = [...list].sort((a, b) => {
        const fa = infoDeclaracion(a.ruc).proximaFecha
        const fb = infoDeclaracion(b.ruc).proximaFecha
        if (!fa && !fb) return 0
        if (!fa) return 1
        if (!fb) return -1
        return fa - fb
      })
    }
    return list
  }, [allRows, search, svcFilter, diaFilter, ordenFecha])

  // Auto-ocultar la contraseña revelada después de REVEAL_TTL_SECONDS
  useEffect(() => {
    if (!reveal) return
    if (reveal.ttl <= 0) { setReveal(null); return }
    const t = setTimeout(() => setReveal((r) => r ? { ...r, ttl: r.ttl - 1 } : null), 1000)
    return () => clearTimeout(t)
  }, [reveal])

  const onReveal = async (cred) => {
    if (!confirm(
      `Vas a revelar la contraseña del portal SRI de:\n\n${cred.nombre} (${cred.ruc})\n\n` +
      `Esta acción quedará registrada en el log de auditoría con tu usuario, IP y fecha.\n\n` +
      `¿Continuar?`
    )) return
    try {
      const res = await credentialsAPI.reveal(cred.id)
      setReveal({
        id: cred.id,
        ruc: cred.ruc,
        nombre: cred.nombre,
        username: res.data.username || '',
        password: res.data.password,
        ttl: REVEAL_TTL_SECONDS,
      })
    } catch (e) {
      alert('No se pudo revelar: ' + (e.response?.data?.detail || e.message))
    }
  }

  const onDelete = async (cred) => {
    if (!confirm(`Eliminar credencial SRI de "${cred.nombre}" (${cred.ruc})?\n\nEsta acción no se puede deshacer.`)) return
    setBusy(true)
    try {
      await credentialsAPI.delete(cred.id)
      await load()
    } catch (e) {
      alert('Error eliminando: ' + (e.response?.data?.detail || e.message))
    } finally {
      setBusy(false)
    }
  }

  const onToggleService = async (row, serviceKey) => {
    const ruc = row.ruc
    const isActive = (servicesByRuc[ruc] || []).includes(serviceKey)
    // Optimista por RUC: aplica a TODAS las filas del contribuyente al instante.
    const flip = (add) => setServicesByRuc((prev) => {
      const set = new Set(prev[ruc] || [])
      add ? set.add(serviceKey) : set.delete(serviceKey)
      return { ...prev, [ruc]: Array.from(set).sort() }
    })
    flip(!isActive)
    try {
      // El backend lo aplica a todos los períodos del contribuyente (todo el módulo).
      await credentialsAPI.toggleService(row.client_id, serviceKey, !isActive)
    } catch (e) {
      flip(isActive)  // rollback
      alert('Error al cambiar servicio: ' + (e.response?.data?.detail || e.message))
    }
  }

  const onCopy = async (text, label = 'valor') => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
    } catch {
      alert(`No se pudo copiar el ${label} al portapapeles.`)
    }
  }

  return (
    <div className="adm-cred">
      <header className="adm-cred-head">
        <div>
          <h2>{isSuperAdmin ? '🔐 Credenciales de servicios externos' : '🗂️ Declaraciones por contribuyente'}</h2>
          <p className="adm-cred-sub">
            {isSuperAdmin ? (
              <>Acceso exclusivo del administrador. Las contraseñas están cifradas en base de datos
              (AES + HMAC con llave fuera del repo). Cada revelado queda registrado en auditoría.</>
            ) : (
              <>Marca qué declaraciones hace cada contribuyente. Las que estén marcadas y aún no
              subidas al SRI aparecen en <strong>Clientes pendientes</strong>; al desmarcarlas, se
              quitan de ese menú. (No se muestran las claves del portal SRI.)</>
            )}
          </p>
        </div>
        {isSuperAdmin && (
          <button className="adm-cred-add" onClick={() => setEditor({ mode: 'create' })} disabled={busy}>
            + Nueva credencial
          </button>
        )}
      </header>

      <div className="adm-cred-toolbar">
        <input
          className="adm-cred-search"
          placeholder="🔍 Buscar por nombre, RUC, usuario o notas…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="adm-cred-count">
          {filtered.length} de {allRows.length}
        </span>
      </div>

      {creds.some((c) => c.needs_reentry) && (
        <div className="adm-cred-reentry-banner">
          ⚠ {creds.filter((c) => c.needs_reentry).length} credencial(es) fueron cifradas con una llave anterior
          y no se pueden descifrar. Editá cada una (✎) y volvé a ingresar la contraseña del portal SRI
          para guardarla con la llave actual.
        </div>
      )}

      <div className="adm-cred-filters">
        <span className="adm-cred-filters-lbl">Filtrar por servicio:</span>
        {CLIENT_SERVICES.map((s) => {
          const active = svcFilter.includes(s.key)
          return (
            <button
              key={s.key}
              type="button"
              className={`adm-cred-chip${active ? ' is-active' : ''}`}
              onClick={() => toggleSvcFilter(s.key)}
              title={s.title}
            >
              {s.title}
            </button>
          )
        })}
        {svcFilter.length > 0 && (
          <button
            type="button"
            className="adm-cred-chip adm-cred-chip-clear"
            onClick={() => setSvcFilter([])}
            title="Quitar filtros"
          >
            ✕ Todos
          </button>
        )}

        <span className="adm-cred-filters-lbl" style={{ marginLeft: 'auto' }}>Fecha máx. declaración:</span>
        <select
          className="adm-cred-dia-select"
          value={diaFilter}
          onChange={(e) => setDiaFilter(e.target.value)}
          title="Filtrar por el día máximo de declaración (9no dígito del RUC)"
        >
          <option value="">Todas</option>
          {DIAS_DECL.map((d) => <option key={d} value={d}>día {d}</option>)}
        </select>
        <label className="adm-cred-orden" title="Ordenar por la próxima fecha de declaración (la más cercana primero)">
          <input type="checkbox" checked={ordenFecha} onChange={(e) => setOrdenFecha(e.target.checked)} />
          ↑ por fecha
        </label>
      </div>

      {loading ? (
        <div className="adm-cred-loading">Cargando…</div>
      ) : allRows.length === 0 ? (
        <div className="adm-cred-empty">
          Aún no hay contribuyentes. Creá un cliente primero.
        </div>
      ) : (
        <div className="adm-cred-tablewrap">
          <table className="adm-cred-table">
            <thead>
              <tr>
                <th>Cliente</th>
                <th>RUC</th>
                <th>Próxima declaración</th>
                {isSuperAdmin && <th>Usuario</th>}
                {CLIENT_SERVICES.map((s) => (
                  <th key={s.key} className="adm-cred-svc-th" title={s.title}>{s.label}</th>
                ))}
                {isSuperAdmin && <th>Modificada</th>}
                {isSuperAdmin && <th>Acciones</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className={c.needs_reentry ? 'adm-cred-row-reentry' : ''}>
                  <td>
                    {c.nombre || '—'}
                    {c.needs_reentry && (
                      <span className="adm-cred-reentry-badge" title="Esta contraseña fue cifrada con una llave anterior. Editá la credencial y volvé a ingresar la contraseña para guardarla con la llave actual.">
                        ⚠ reingresar
                      </span>
                    )}
                  </td>
                  <td className="mono">
                    <span className="adm-cred-copyable" title="Click para copiar RUC" onClick={() => onCopy(c.ruc, 'RUC')}>
                      {c.ruc || '—'}
                    </span>
                  </td>
                  <td className="adm-cred-decl-cell">
                    {infoDeclaracion(c.ruc).valido
                      ? <BadgeVencimiento ruc={c.ruc} />
                      : <span className="adm-cred-dim">—</span>}
                  </td>
                  {isSuperAdmin && <td>{c.username || <span className="adm-cred-dim">{c._sinClave ? '(sin clave)' : '(usa el RUC)'}</span>}</td>}
                  {CLIENT_SERVICES.map((s) => {
                    const checked = c.client_services?.includes(s.key) || false
                    return (
                      <td key={s.key} className="adm-cred-svc-cell">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => onToggleService(c, s.key)}
                          title={`${s.title} — ${checked ? 'activo' : 'sin contratar'}`}
                        />
                      </td>
                    )
                  })}
                  {isSuperAdmin && <td className="adm-cred-dim">{(c.updated_at || '').slice(0, 16).replace('T', ' ')}</td>}
                  {isSuperAdmin && (
                  <td className="adm-cred-actions">
                    {c._sinClave ? (
                      <button className="btn-add-clave" title="Agregar la clave del portal SRI de este contribuyente"
                        onClick={() => setEditor({ mode: 'create', presetClientId: c.client_id })}>＋ Clave</button>
                    ) : (
                      <>
                        <button className="btn-reveal" onClick={() => onReveal(c)}>👁</button>
                        <button className="btn-edit" onClick={() => setEditor({ mode: 'edit', credential: c })}>✎</button>
                        <button className="btn-del" onClick={() => onDelete(c)} disabled={busy}>🗑</button>
                      </>
                    )}
                  </td>
                  )}
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={isSuperAdmin ? 10 : 7} className="adm-cred-empty-row">
                    Ningún cliente coincide con el filtro seleccionado.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {reveal && (
        <RevealModal
          reveal={reveal}
          onClose={() => setReveal(null)}
          onCopy={onCopy}
        />
      )}

      {editor && (
        <EditorModal
          mode={editor.mode}
          credential={editor.credential}
          presetClientId={editor.presetClientId}
          contribs={contribs}
          onClose={() => setEditor(null)}
          onSaved={() => { setEditor(null); load() }}
        />
      )}
    </div>
  )
}

function RevealModal({ reveal, onClose, onCopy }) {
  return (
    <div className="adm-cred-modal-bg" onClick={onClose}>
      <div className="adm-cred-modal" onClick={(e) => e.stopPropagation()}>
        <div className="adm-cred-modal-head">
          <strong>🔓 Credencial revelada</strong>
          <span className="adm-cred-ttl" title="Se ocultará automáticamente">
            {reveal.ttl}s
          </span>
        </div>
        <div className="adm-cred-modal-body">
          <div className="adm-cred-row">
            <span className="adm-cred-lbl">Cliente</span>
            <span>{reveal.nombre}</span>
          </div>
          <div className="adm-cred-row">
            <span className="adm-cred-lbl">RUC</span>
            <span className="mono">{reveal.ruc}</span>
          </div>
          {reveal.username && (
            <div className="adm-cred-row">
              <span className="adm-cred-lbl">Usuario</span>
              <span className="mono">{reveal.username}</span>
              <button className="adm-cred-copybtn" onClick={() => onCopy(reveal.username, 'usuario')}>📋</button>
            </div>
          )}
          <div className="adm-cred-row">
            <span className="adm-cred-lbl">Contraseña</span>
            <span className="adm-cred-secret">{reveal.password}</span>
            <button className="adm-cred-copybtn" onClick={() => onCopy(reveal.password, 'contraseña')}>📋</button>
          </div>
        </div>
        <div className="adm-cred-modal-foot">
          <small>Este acceso quedó registrado en el log de auditoría.</small>
          <button onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  )
}

function EditorModal({ mode, credential, presetClientId, contribs, onClose, onSaved }) {
  const isEdit = mode === 'edit'
  const [form, setForm] = useState({
    client_id: credential?.client_id || presetClientId || '',
    service: credential?.service || 'sri_portal',
    username: credential?.username || '',
    password: '',
    notes: credential?.notes || '',
  })
  const [showPwd, setShowPwd] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const save = async (e) => {
    e.preventDefault()
    setError('')
    if (!isEdit && !form.client_id) { setError('Seleccioná un cliente'); return }
    if (!isEdit && !form.password) { setError('La contraseña es obligatoria'); return }
    if (isEdit && !form.password && form.username === (credential.username || '') && form.notes === (credential.notes || '')) {
      setError('Sin cambios')
      return
    }
    setSaving(true)
    try {
      if (isEdit) {
        const patch = {}
        if (form.username !== (credential.username || '')) patch.username = form.username || null
        if (form.notes !== (credential.notes || '')) patch.notes = form.notes || null
        if (form.password) patch.password = form.password
        await credentialsAPI.update(credential.id, patch)
      } else {
        await credentialsAPI.create({
          client_id: form.client_id,
          service: form.service,
          username: form.username || null,
          password: form.password,
          notes: form.notes || null,
        })
      }
      onSaved()
    } catch (e) {
      setError(e.response?.data?.detail || e.message || 'Error guardando')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="adm-cred-modal-bg" onClick={onClose}>
      <div className="adm-cred-modal" onClick={(e) => e.stopPropagation()}>
        <div className="adm-cred-modal-head">
          <strong>{isEdit ? '✎ Editar credencial' : '+ Nueva credencial'}</strong>
        </div>
        <form className="adm-cred-modal-body" onSubmit={save}>
          {isEdit ? (
            <div className="adm-cred-row">
              <span className="adm-cred-lbl">Cliente</span>
              <span>{credential.nombre} <span className="mono">({credential.ruc})</span></span>
            </div>
          ) : (
            <label className="adm-cred-field">
              <span>Cliente</span>
              <select required value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })}>
                <option value="">— Seleccionar contribuyente —</option>
                {contribs.map((c) => (
                  <option key={c.id} value={c.id}>{c.nombre} ({c.identificacion})</option>
                ))}
              </select>
            </label>
          )}
          <label className="adm-cred-field">
            <span>Servicio</span>
            <select value={form.service} onChange={(e) => setForm({ ...form, service: e.target.value })} disabled={isEdit}>
              {SERVICIOS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
          <label className="adm-cred-field">
            <span>Usuario (opcional)</span>
            <input
              type="text"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="Vacío = se usa el RUC al iniciar sesión"
            />
          </label>
          <label className="adm-cred-field">
            <span>{isEdit ? 'Contraseña (dejar vacío = no cambiar)' : 'Contraseña'}</span>
            <div className="adm-cred-pwd-row">
              <input
                type={showPwd ? 'text' : 'password'}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                required={!isEdit}
                autoComplete="new-password"
              />
              <button type="button" className="adm-cred-pwd-toggle" onClick={() => setShowPwd((s) => !s)}>
                {showPwd ? '🙈' : '👁'}
              </button>
            </div>
          </label>
          <label className="adm-cred-field">
            <span>Notas (opcional)</span>
            <textarea
              rows={2}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Ej: pregunta de seguridad, número de teléfono asociado, …"
            />
          </label>
          {error && <div className="adm-cred-error">{error}</div>}
          <div className="adm-cred-modal-foot">
            <button type="button" onClick={onClose}>Cancelar</button>
            <button type="submit" disabled={saving}>{saving ? 'Guardando…' : 'Guardar'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
