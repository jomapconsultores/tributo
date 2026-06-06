import { useState, useEffect } from 'react'
import { adminAPI } from '../services/api'
import './Admin.css'

const MODS = [
  { key: 'gastos', label: 'Gastos' },
  { key: 'retenciones', label: 'Retenciones' },
  { key: 'ingresos_ice', label: 'INGRESOS+ICE' },
  { key: 'declaraciones', label: 'Declaraciones' },
]
const PLANES = [
  { key: 'basico', label: 'Básico (Gastos+Ret.)' },
  { key: 'profesional', label: 'Profesional (+Decl.)' },
  { key: 'premium', label: 'Premium / ICE (todo)' },
]

export default function Admin() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [edit, setEdit] = useState({}) // uid -> { mods:Set, valid_until }
  const [nuevo, setNuevo] = useState({ email: '', password: '', plan: 'premium' })
  const [busy, setBusy] = useState(false)

  const load = () => {
    setLoading(true)
    adminAPI.listUsers().then((r) => {
      const list = r.data || []
      setUsers(list)
      const e = {}
      for (const u of list) {
        const activos = new Set(Object.entries(u.modules || {}).filter(([, v]) => v.activo).map(([k]) => k))
        const vu = Object.values(u.modules || {}).map((v) => v.valid_until).find(Boolean) || ''
        e[u.user_id] = { mods: activos, valid_until: vu }
      }
      setEdit(e)
    }).catch((err) => alert('Error: ' + (err.response?.data?.detail || err.message)))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const toggle = (uid, key) => {
    setEdit((e) => {
      const s = new Set(e[uid].mods)
      s.has(key) ? s.delete(key) : s.add(key)
      return { ...e, [uid]: { ...e[uid], mods: s } }
    })
  }
  const setVU = (uid, v) => setEdit((e) => ({ ...e, [uid]: { ...e[uid], valid_until: v } }))

  const guardar = async (uid) => {
    setBusy(true)
    try {
      await adminAPI.setModules(uid, [...edit[uid].mods], edit[uid].valid_until || null)
      await load()
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) } finally { setBusy(false) }
  }
  const aplicarPlan = async (uid, plan) => {
    if (!plan) return
    setBusy(true)
    try { await adminAPI.setPlan(uid, plan, edit[uid].valid_until || null); await load() }
    catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) } finally { setBusy(false) }
  }
  const crear = async () => {
    if (!nuevo.email.trim() || nuevo.password.length < 6) { alert('Email válido y contraseña de 6+ caracteres.'); return }
    setBusy(true)
    try {
      await adminAPI.createUser({ email: nuevo.email.trim(), password: nuevo.password, plan: nuevo.plan })
      setNuevo({ email: '', password: '', plan: 'premium' })
      await load()
      alert('✔ Usuario creado con su clave y plan asignado.')
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) } finally { setBusy(false) }
  }

  return (
    <div className="adm-page">
      <header className="adm-header">
        <h1>🛠️ Administración de usuarios</h1>
        <p className="adm-sub">Crea cuentas con su clave y asigna los módulos contratados.</p>
      </header>

      {/* Crear usuario */}
      <div className="adm-new">
        <h2>Crear usuario</h2>
        <div className="adm-new-row">
          <input placeholder="correo@cliente.com" value={nuevo.email} onChange={(e) => setNuevo({ ...nuevo, email: e.target.value })} />
          <input type="text" placeholder="contraseña (mín. 6)" value={nuevo.password} onChange={(e) => setNuevo({ ...nuevo, password: e.target.value })} />
          <select value={nuevo.plan} onChange={(e) => setNuevo({ ...nuevo, plan: e.target.value })}>
            {PLANES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          <button className="adm-btn primary" onClick={crear} disabled={busy}>＋ Crear usuario</button>
        </div>
      </div>

      {/* Usuarios */}
      {loading ? <div className="adm-loading">Cargando…</div> : (
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead><tr>
              <th>Usuario</th>{MODS.map((m) => <th key={m.key} className="c">{m.label}</th>)}
              <th>Vigencia (hasta)</th><th>Plan rápido</th><th></th>
            </tr></thead>
            <tbody>
              {users.map((u) => {
                const e = edit[u.user_id] || { mods: new Set(), valid_until: '' }
                return (
                  <tr key={u.user_id}>
                    <td>
                      <div className="adm-email">{u.email}</div>
                      <div className="adm-meta">{u.is_admin ? '👑 admin' : ''} · alta {u.created_at}</div>
                    </td>
                    {MODS.map((m) => (
                      <td key={m.key} className="c">
                        <input type="checkbox" disabled={u.is_admin} checked={u.is_admin || e.mods.has(m.key)} onChange={() => toggle(u.user_id, m.key)} />
                      </td>
                    ))}
                    <td><input type="date" value={e.valid_until || ''} onChange={(ev) => setVU(u.user_id, ev.target.value)} disabled={u.is_admin} /></td>
                    <td>
                      <select disabled={u.is_admin} defaultValue="" onChange={(ev) => { aplicarPlan(u.user_id, ev.target.value); ev.target.value = '' }}>
                        <option value="">Plan…</option>
                        {PLANES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                      </select>
                    </td>
                    <td><button className="adm-btn" disabled={busy || u.is_admin} onClick={() => guardar(u.user_id)}>💾 Guardar</button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="adm-note">Los administradores tienen todos los módulos automáticamente. La vigencia opcional desactiva el acceso después de esa fecha.</p>
    </div>
  )
}
