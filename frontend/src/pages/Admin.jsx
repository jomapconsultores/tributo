import { useState, useEffect } from 'react'
import { adminAPI } from '../services/api'
import { useAccess } from '../context/AccessContext'
import './Admin.css'

const ROL_LBL = { admin: '👑 Administrador', socio: '🤝 Socio', cliente: '👤 Cliente' }

const MODS = [
  { key: 'gastos', label: 'Gastos' },
  { key: 'retenciones', label: 'Retenc.' },
  { key: 'ingresos_ice', label: 'ICE' },
  { key: 'declaraciones', label: 'Declar.' },
]
const PLANES = [
  { key: 'ice', label: 'Cálculo ICE ($50)' },
  { key: 'gastos_ret', label: 'Gastos y Retenciones ($50)' },
  { key: 'completo', label: 'Sistema Completo ($150)' },
]
const ESTADOS = ['prueba', 'activo', 'suspendido']
const DESCUENTOS = { 1: 0, 3: 0.05, 6: 0.10, 12: 0.25 }

export default function Admin() {
  const { isSuperAdmin } = useAccess()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [edit, setEdit] = useState({})
  const [nuevo, setNuevo] = useState({ email: '', password: '', plan: 'completo' })
  const [busy, setBusy] = useState(false)
  const [contactos, setContactos] = useState([])

  useEffect(() => { adminAPI.contactos().then((r) => setContactos(r.data?.data || [])).catch(() => {}) }, [])

  const load = () => {
    setLoading(true)
    adminAPI.listUsers().then((r) => {
      const list = r.data || []
      setUsers(list)
      const e = {}
      for (const u of list) {
        const activos = new Set(Object.entries(u.modules || {}).filter(([, v]) => v.activo).map(([k]) => k))
        const s = u.subscription || {}
        e[u.user_id] = {
          mods: activos,
          plan: s.plan || '',
          precio: s.precio_mensual ?? '',
          estado: s.estado || 'prueba',
          proximo_pago: s.proximo_pago || '',
        }
      }
      setEdit(e)
    }).catch((err) => alert('Error: ' + (err.response?.data?.detail || err.message)))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const cambiarRol = async (uid, role) => {
    if (!window.confirm(`¿Cambiar el rol de este usuario a "${role}"?`)) return
    setBusy(true)
    try { await adminAPI.setRole(uid, role); await load() }
    catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
    finally { setBusy(false) }
  }

  const upd = (uid, patch) => setEdit((e) => ({ ...e, [uid]: { ...e[uid], ...patch } }))
  const toggle = (uid, key) => {
    const s = new Set(edit[uid].mods)
    s.has(key) ? s.delete(key) : s.add(key)
    upd(uid, { mods: s })
  }

  const guardar = async (uid) => {
    setBusy(true)
    try {
      const e = edit[uid]
      await adminAPI.setModules(uid, [...e.mods], null)
      await adminAPI.setSubscription(uid, {
        plan: e.plan || null, precio_mensual: e.precio === '' ? null : parseFloat(e.precio),
        estado: e.estado || null, proximo_pago: e.proximo_pago || null,
      })
      await load()
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) } finally { setBusy(false) }
  }
  const aplicarPlan = async (uid, plan) => {
    if (!plan) return
    setBusy(true)
    try { await adminAPI.setPlan(uid, plan, null); await adminAPI.setSubscription(uid, { plan }); await load() }
    catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) } finally { setBusy(false) }
  }
  const registrarPago = async (uid) => {
    const mStr = prompt('Meses a pagar por anticipado (1, 3, 6 o 12):', '1')
    if (mStr === null) return
    let meses = parseInt(mStr, 10)
    if (![1, 3, 6, 12].includes(meses)) meses = 1
    const precio = parseFloat(edit[uid].precio) || 0
    const desc = DESCUENTOS[meses]
    const sugerido = (precio * meses * (1 - desc)).toFixed(2)
    const monto = prompt(`Monto recibido (USD) por ${meses} mes(es)${desc ? ` — ${desc * 100}% descuento` : ''}:`, sugerido)
    if (monto === null) return
    setBusy(true)
    try {
      const r = await adminAPI.registrarPago(uid, { monto: parseFloat(monto) || 0, meses, avanzar_mes: true })
      await load()
      alert(`✔ Pago registrado (${meses} mes(es) = ${meses * 30} días). Próximo pago: ${r.data.proximo_pago || '—'}`)
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) } finally { setBusy(false) }
  }
  const resetIps = async (uid) => {
    if (!window.confirm('¿Borrar las IPs registradas de este usuario? Podrá iniciar sesión desde nuevos dispositivos.')) return
    setBusy(true)
    try { await adminAPI.resetIps(uid); await load(); alert('✔ IPs restablecidas.') }
    catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) } finally { setBusy(false) }
  }
  const crear = async () => {
    if (!nuevo.email.trim() || nuevo.password.length < 6) { alert('Email válido y contraseña de 6+ caracteres.'); return }
    setBusy(true)
    try {
      await adminAPI.createUser({ email: nuevo.email.trim(), password: nuevo.password, plan: nuevo.plan })
      setNuevo({ email: '', password: '', plan: 'completo' })
      await load()
      alert('✔ Usuario creado con su clave y plan asignado.')
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) } finally { setBusy(false) }
  }

  return (
    <div className="adm-page">
      <header className="adm-header">
        <h1>🛠️ Administración de usuarios y cobros</h1>
        <p className="adm-sub">Crea cuentas, asigna módulos contratados y gestiona la suscripción mensual.</p>
      </header>

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

      {loading ? <div className="adm-loading">Cargando…</div> : (
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead><tr>
              <th>Usuario</th>{MODS.map((m) => <th key={m.key} className="c">{m.label}</th>)}
              <th>Estado</th><th>Precio</th><th>Próx. pago</th><th>Plan rápido</th><th></th>
            </tr></thead>
            <tbody>
              {users.map((u) => {
                const e = edit[u.user_id] || { mods: new Set() }
                const venc = u.subscription?.vencida
                return (
                  <tr key={u.user_id} className={venc ? 'vencida' : ''}>
                    <td>
                      <div className="adm-email">{u.email}</div>
                      <div className="adm-meta">{ROL_LBL[u.role] || '👤 Cliente'} · alta {u.created_at}{venc ? ' · ⚠ vencida' : ''} · IPs {u.ips ?? 0}/3</div>
                      {isSuperAdmin && (
                        <select className="adm-rol-select" value={u.role || 'cliente'} disabled={busy}
                          onChange={(ev) => cambiarRol(u.user_id, ev.target.value)} title="Cambiar rol">
                          <option value="cliente">👤 Cliente</option>
                          <option value="socio">🤝 Socio</option>
                          <option value="admin">👑 Administrador</option>
                        </select>
                      )}
                    </td>
                    {MODS.map((m) => (
                      <td key={m.key} className="c">
                        <input type="checkbox" disabled={u.is_admin} checked={u.is_admin || e.mods.has(m.key)} onChange={() => toggle(u.user_id, m.key)} />
                      </td>
                    ))}
                    <td>
                      <select disabled={u.is_admin} value={e.estado} onChange={(ev) => upd(u.user_id, { estado: ev.target.value })}>
                        {ESTADOS.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </td>
                    <td><input className="adm-precio" type="number" step="0.01" disabled={u.is_admin} value={e.precio} onChange={(ev) => upd(u.user_id, { precio: ev.target.value })} /></td>
                    <td><input type="date" disabled={u.is_admin} value={e.proximo_pago || ''} onChange={(ev) => upd(u.user_id, { proximo_pago: ev.target.value })} /></td>
                    <td>
                      <select disabled={u.is_admin} defaultValue="" onChange={(ev) => { aplicarPlan(u.user_id, ev.target.value); ev.target.value = '' }}>
                        <option value="">Plan…</option>
                        {PLANES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                      </select>
                    </td>
                    <td className="adm-acts">
                      <button className="adm-btn" disabled={busy || u.is_admin} onClick={() => guardar(u.user_id)}>💾</button>
                      <button className="adm-btn pay" disabled={busy || u.is_admin} onClick={() => registrarPago(u.user_id)}>💵 Pago</button>
                      <button className="adm-btn" disabled={busy || u.is_admin} title="Restablecer IPs" onClick={() => resetIps(u.user_id)}>🔓 IPs</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="adm-note">Al <strong>registrar un pago</strong> se marca la suscripción como <em>activa</em> y se adelanta el próximo pago <strong>30 días por cada mes</strong> pagado (1, 3, 6 o 12). Descuentos por anticipo: <strong>3m −5% · 6m −10% · 12m −25%</strong>. Si el próximo pago vence, el usuario queda <strong>suspendido automáticamente</strong> hasta el siguiente pago. Los administradores no se cobran.</p>

      {/* Mensajes de contacto */}
      <div className="adm-contactos">
        <h2>📨 Mensajes de contacto ({contactos.length})</h2>
        {contactos.length === 0 ? <p className="adm-note">Sin mensajes todavía.</p> : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead><tr><th>Fecha</th><th>Nombre</th><th>Email</th><th>Teléfono</th><th>Mensaje</th></tr></thead>
              <tbody>
                {contactos.map((c) => (
                  <tr key={c.id}>
                    <td>{String(c.created_at).slice(0, 10)}</td>
                    <td>{c.nombre}</td>
                    <td>{c.email}</td>
                    <td>{c.telefono || '—'}</td>
                    <td>{c.mensaje || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
