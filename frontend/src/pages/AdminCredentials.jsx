import { useEffect, useMemo, useState } from 'react'
import { credentialsAPI, clientsAPI } from '../services/api'
import './AdminCredentials.css'

const SERVICIOS = [{ key: 'sri_portal', label: 'Portal SRI' }]
const REVEAL_TTL_SECONDS = 30

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
  const [creds, setCreds] = useState([])
  const [contribs, setContribs] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [reveal, setReveal] = useState(null) // { id, ruc, nombre, password, ttl }
  const [editor, setEditor] = useState(null) // { mode: 'create'|'edit', credential?: {...} }
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const [credsRes, contribsRes] = await Promise.all([
        credentialsAPI.list(),
        clientsAPI.list(),
      ])
      setCreds(credsRes.data?.data || [])
      setContribs(dedupContribuyentes(contribsRes.data || []))
    } catch (e) {
      alert('Error cargando credenciales: ' + (e.response?.data?.detail || e.message))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return creds
    return creds.filter((c) =>
      [c.nombre, c.ruc, c.username, c.notes].some((f) => String(f || '').toLowerCase().includes(q))
    )
  }, [creds, search])

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
          <h2>🔐 Credenciales de servicios externos</h2>
          <p className="adm-cred-sub">
            Acceso exclusivo del administrador. Las contraseñas están cifradas en base de datos
            (AES + HMAC con llave fuera del repo). Cada revelado queda registrado en auditoría.
          </p>
        </div>
        <button className="adm-cred-add" onClick={() => setEditor({ mode: 'create' })} disabled={busy}>
          + Nueva credencial
        </button>
      </header>

      <div className="adm-cred-toolbar">
        <input
          className="adm-cred-search"
          placeholder="🔍 Buscar por nombre, RUC, usuario o notas…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="adm-cred-count">
          {filtered.length} de {creds.length}
        </span>
      </div>

      {loading ? (
        <div className="adm-cred-loading">Cargando…</div>
      ) : creds.length === 0 ? (
        <div className="adm-cred-empty">
          Aún no hay credenciales guardadas. Usá "+ Nueva credencial" para agregar la primera.
        </div>
      ) : (
        <div className="adm-cred-tablewrap">
          <table className="adm-cred-table">
            <thead>
              <tr>
                <th>Cliente</th>
                <th>RUC</th>
                <th>Servicio</th>
                <th>Usuario</th>
                <th>Modificada</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id}>
                  <td>{c.nombre || '—'}</td>
                  <td className="mono">
                    <span className="adm-cred-copyable" title="Click para copiar RUC" onClick={() => onCopy(c.ruc, 'RUC')}>
                      {c.ruc || '—'}
                    </span>
                  </td>
                  <td>{SERVICIOS.find((s) => s.key === c.service)?.label || c.service}</td>
                  <td>{c.username || <span className="adm-cred-dim">(usa el RUC)</span>}</td>
                  <td className="adm-cred-dim">{(c.updated_at || '').slice(0, 16).replace('T', ' ')}</td>
                  <td className="adm-cred-actions">
                    <button className="btn-reveal" onClick={() => onReveal(c)}>👁 Revelar</button>
                    <button className="btn-edit" onClick={() => setEditor({ mode: 'edit', credential: c })}>✎</button>
                    <button className="btn-del" onClick={() => onDelete(c)} disabled={busy}>🗑</button>
                  </td>
                </tr>
              ))}
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

function EditorModal({ mode, credential, contribs, onClose, onSaved }) {
  const isEdit = mode === 'edit'
  const [form, setForm] = useState({
    client_id: credential?.client_id || '',
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
