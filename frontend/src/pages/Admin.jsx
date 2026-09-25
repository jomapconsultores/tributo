import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { adminAPI, activacionAPI, orgsAPI } from '../services/api'
import { useAccess } from '../context/AccessContext'
import { clearAll as clearApiCache } from '../services/cache'
import './Admin.css'

const ROL_LBL = { admin: '👑 Administrador', socio: '🤝 Socio', trabajador: '👷 Funcionario', cliente: '👤 Cliente' }
const ROLES_ASIGNABLES = ['cliente', 'trabajador', 'socio', 'admin']
const MI_UID = localStorage.getItem('userId')  // para refrescar el acceso si me edito a mí mismo

const MODS = [
  { key: 'gastos', label: 'Gastos' },
  { key: 'retenciones', label: 'Retenc.' },
  { key: 'ingresos_ice', label: 'ICE' },
  { key: 'declaraciones', label: 'Declar.' },
  { key: 'agente_retencion', label: 'Agente Ret.' },
  { key: 'gestion', label: 'Gestión' },
  { key: 'datos', label: 'Datos' },
]
// Los mismos módulos, con el nombre completo para el detalle de permisos: en la
// tabla van abreviados por espacio, pero en el modal se lee el nombre entero.
const MODS_DETALLE = [
  { key: 'gastos', label: 'Gastos' },
  { key: 'retenciones', label: 'Retenciones' },
  { key: 'ingresos_ice', label: 'Ingresos / ICE' },
  { key: 'declaraciones', label: 'Declaraciones' },
  { key: 'agente_retencion', label: 'Agente de retención' },
  { key: 'gestion', label: 'Gestión' },
  { key: 'datos', label: 'Datos' },
]
const PLANES = [
  { key: 'ice', label: 'Cálculo previo ICE ($50)' },
  { key: 'gastos_ret', label: 'Gastos y Retenciones ($50)' },
  { key: 'completo', label: 'Sistema Completo ($150)' },
]
const ESTADOS = ['prueba', 'activo', 'suspendido']

export default function Admin() {
  const { isSuperAdmin } = useAccess()
  const navigate = useNavigate()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [edit, setEdit] = useState({})
  const [nuevo, setNuevo] = useState({ email: '', password: '', plan: 'completo' })
  const [verClave, setVerClave] = useState(false)
  const [busy, setBusy] = useState(false)
  const [contactos, setContactos] = useState([])
  const [pagoModal, setPagoModal] = useState(null) // { uid, email, precio }
  const [subModal, setSubModal] = useState(null)   // { uid, email, modules, submodules }
  const [catalogoSub, setCatalogoSub] = useState({}) // { modulo: [{key,label}] }
  // Traído del backend (mismo dict que usa /api/admin/precio) para no mantener
  // una copia local que podría desincronizarse.
  const [descuentos, setDescuentos] = useState({ 1: 0, 3: 0.05, 6: 0.10, 12: 0.25 })

  const [activPend, setActivPend] = useState(0)

  useEffect(() => { adminAPI.contactos().then((r) => setContactos(r.data?.data || [])).catch(() => {}) }, [])
  // Comprobantes esperando revisión: se avisa acá porque este panel es donde el
  // administrador entra a resolver los cobros.
  useEffect(() => { activacionAPI.resumen().then((r) => setActivPend(r.data?.pendientes || 0)).catch(() => {}) }, [])
  useEffect(() => { adminAPI.descuentos().then((r) => setDescuentos(r.data?.descuentos || {})).catch(() => {}) }, [])
  useEffect(() => { adminAPI.submodulosCatalogo().then((r) => setCatalogoSub(r.data?.catalogo || {})).catch(() => {}) }, [])

  // Guarda módulos y pantallas DONDE MANDAN. Si el usuario pertenece a una
  // empresa que define sus permisos, escribir en el panel global no tendría
  // ningún efecto: access.py lee los de la membresía y los globales ni los
  // mira. Por eso el destino lo decide el origen, no la pantalla.
  const guardarDetalle = async (uid, { modules, submodules, org }) => {
    setBusy(true)
    try {
      if (org) {
        await orgsAPI.updateMember(org.org_id, uid, { modules, submodules })
      } else {
        await adminAPI.setModules(uid, modules, null)
        await adminAPI.setSubmodules(uid, submodules)
      }
      setSubModal(null)
      if (uid === MI_UID) { clearApiCache(); window.location.reload(); return }
      await load()
    }
    catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
    finally { setBusy(false) }
  }

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
          iva_incluido: s.iva_incluido || false,
        }
      }
      setEdit(e)
    }).catch((err) => alert('Error: ' + (err.response?.data?.detail || err.message)))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  // Si el admin se edita a SÍ MISMO (roles/pantallas), su propio acceso cambia:
  // hay que refrescar /me (cacheado) para que el selector de rol arriba a la
  // derecha aparezca/cambie al instante. La forma segura es limpiar caché y recargar.
  const refrescarSiSoyYo = (uid) => {
    if (uid === MI_UID) { clearApiCache(); window.location.reload(); return true }
    return false
  }

  // Otorga el CONJUNTO de roles del usuario (puede tener varios y cambiar entre ellos).
  const toggleRol = async (uid, actuales, r) => {
    const s = new Set(actuales)
    s.has(r) ? s.delete(r) : s.add(r)
    const nuevos = [...s]
    if (nuevos.length === 0) { alert('El usuario debe tener al menos un rol.'); return }
    setBusy(true)
    try {
      await adminAPI.setRoles(uid, nuevos)
      if (refrescarSiSoyYo(uid)) return   // recarga la app; no sigue
      await load()
    }
    catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
    finally { setBusy(false) }
  }

  // Cuántas pantallas tiene habilitadas de las que podría tener, contando solo
  // los módulos que sí están activos. Es el resumen que dice de un vistazo si a
  // alguien le recortaron algo, sin abrir el detalle.
  const pantallas = (u, orgManda) => {
    const activos = orgManda
      ? (orgManda.modules || [])
      : Object.entries(u.modules || {}).filter(([, v]) => v.activo).map(([k]) => k)
    const permitidas = new Set((orgManda ? orgManda.submodules : u.submodules) || [])
    let total = 0, ok = 0
    for (const m of activos) {
      const keys = (catalogoSub[m] || []).map((x) => x.key)
      total += keys.length
      ok += keys.filter((k) => permitidas.has(k)).length
    }
    return { permitidas: ok, total }
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
        iva_incluido: e.iva_incluido,
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
  const registrarPago = (uid) => {
    const u = users.find((x) => x.user_id === uid)
    setPagoModal({ uid, email: u?.email || uid, precio: parseFloat(edit[uid]?.precio) || 0, iva_incluido: edit[uid]?.iva_incluido || false })
  }
  const confirmarPago = async ({ uid, meses, monto, iva_incluido }) => {
    setBusy(true)
    try {
      const r = await adminAPI.registrarPago(uid, { monto: parseFloat(monto) || 0, meses, avanzar_mes: true, iva_incluido })
      setPagoModal(null)
      await load()
      const total = iva_incluido ? parseFloat(monto) : parseFloat(monto) * 1.15
      alert(`✔ Pago registrado — Total c/IVA: $${total.toFixed(2)} (${meses} mes(es)). Próximo pago: ${r.data.proximo_pago || '—'}`)
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) } finally { setBusy(false) }
  }
  // Activar / suspender el uso de la plataforma. Es el botón que faltaba: hasta
  // ahora abrirle el acceso a alguien era acordarse de poner el estado en
  // 'activo', revisar que la fecha no estuviera vencida y marcarle los módulos,
  // tres cosas en tres sitios distintos. El backend las hace juntas.
  const cambiarAcceso = async (u, activar) => {
    const e = edit[u.user_id] || {}
    const tieneModulos = (e.mods?.size || 0) > 0
    let plan = null
    if (activar && !tieneModulos) {
      // Sin módulos no se entra a ninguna pantalla: activar sin plan sería
      // abrir una puerta a un pasillo cerrado.
      plan = e.plan || u.subscription?.plan || ''
      if (!plan) {
        alert('Este usuario no tiene módulos ni plan asignado.\n\n' +
              'Elige primero un plan en la columna "Plan rápido" y vuelve a activarlo.')
        return
      }
    }
    const msg = activar
      ? `¿Activar el acceso de ${u.email}?\n\n` +
        (plan ? `Se le habilitará el plan "${plan}".\n` : '') +
        'Se le avisará por correo que ya puede entrar.'
      : `¿Suspender el acceso de ${u.email}?\n\nNo podrá entrar hasta que vuelvas a activarlo.`
    if (!window.confirm(msg)) return
    setBusy(true)
    try {
      const r = await adminAPI.activarAcceso(u.user_id, { activar, plan })
      await load()
      alert(activar
        ? `✔ Acceso activado${r.data?.proximo_pago ? ` — vigente hasta ${r.data.proximo_pago}` : ''}.`
        : '✔ Acceso suspendido.')
    } catch (err) { alert('Error: ' + (err.response?.data?.detail || err.message)) } finally { setBusy(false) }
  }

  const resetIps = async (uid) => {
    if (!window.confirm('¿Borrar el registro de equipos desde los que ha entrado este usuario?\n\n'
      + 'Ya no hace falta para que pueda entrar —el límite de dispositivos se quitó—; '
      + 'solo limpia el historial de accesos.')) return
    setBusy(true)
    try { await adminAPI.resetIps(uid); await load(); alert('✔ IPs restablecidas.') }
    catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) } finally { setBusy(false) }
  }
  // Recuperación de clave olvidada: alternativa al enlace por correo, para
  // cuando el usuario ya no tiene acceso al correo registrado. La clave temporal
  // se muestra UNA sola vez.
  const resetClave = async (u) => {
    if (!window.confirm(
      `¿Restablecer la clave de ${u.email}?\n\n` +
      `Se generará una clave temporal de un solo uso que deberás entregarle en persona.\n` +
      `Su clave actual dejará de funcionar y tendrá que cambiarla al entrar.`
    )) return
    setBusy(true)
    try {
      const r = await adminAPI.resetPassword(u.user_id)
      window.prompt(
        `Clave temporal de ${u.email}\n\n` +
        `Cópiala ahora: no se volverá a mostrar. Caduca en 72 horas.`,
        r.data.clave_temporal,
      )
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) } finally { setBusy(false) }
  }
  const eliminarUsuario = async (u) => {
    if (!window.confirm(
      `¿ELIMINAR la cuenta de ${u.email}?\n\n` +
      `Se borra su acceso, roles, módulos, pantallas y asignación de clientes.\n` +
      `NO se borran los contribuyentes que haya creado ni la bitácora.\n\n` +
      `Esta acción no se puede deshacer.`
    )) return
    setBusy(true)
    try { await adminAPI.deleteUser(u.user_id); await load(); alert('✔ Usuario eliminado.') }
    catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
    finally { setBusy(false) }
  }

  const crear = async () => {
    if (!nuevo.email.trim() || nuevo.password.length < 6) { alert('Email válido y contraseña de 6+ caracteres.'); return }
    setBusy(true)
    try {
      await adminAPI.createUser({ email: nuevo.email.trim(), password: nuevo.password, plan: nuevo.plan })
      setNuevo({ email: '', password: '', plan: 'completo' })
      setVerClave(false)   // que la del siguiente usuario no nazca a la vista
      await load()
      alert('✔ Usuario creado con su clave y plan asignado.')
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) } finally { setBusy(false) }
  }

  return (
    <div className="adm-page">
      {pagoModal && (
        <PagoModalForm
          email={pagoModal.email}
          precioBase={pagoModal.precio}
          ivaIncluidoDefault={pagoModal.iva_incluido}
          descuentos={descuentos}
          onConfirm={(data) => confirmarPago({ uid: pagoModal.uid, ...data })}
          onCancel={() => setPagoModal(null)}
          busy={busy}
        />
      )}
      {subModal && (
        <SubmodulosModal
          user={subModal}
          catalogo={catalogoSub}
          modLabels={Object.fromEntries(MODS.map((m) => [m.key, m.label]))}
          todosLosModulos={MODS_DETALLE}
          onSave={(datos) => guardarDetalle(subModal.uid, datos)}
          onCancel={() => setSubModal(null)}
          busy={busy}
        />
      )}
      <header className="adm-header">
        <h1>🛠️ Administración de usuarios y cobros</h1>
        <p className="adm-sub">Crea cuentas, asigna módulos contratados y gestiona la suscripción mensual.</p>
      </header>

      {activPend > 0 && (
        <div className="adm-activaciones">
          <span>
            💳 <strong>{activPend}</strong> cliente{activPend === 1 ? '' : 's'} envió su comprobante
            de pago y está esperando que le actives el acceso.
          </span>
          <button className="adm-btn primary" onClick={() => navigate('/admin/activaciones')}>
            Revisar activaciones
          </button>
        </div>
      )}

      <div className="adm-new">
        <h2>Crear usuario</h2>
        <div className="adm-new-row">
          <input placeholder="correo@cliente.com" value={nuevo.email} onChange={(e) => setNuevo({ ...nuevo, email: e.target.value })} />
          {/* La clave se puede ver mientras se escribe: quien crea la cuenta es
              quien luego se la dicta al usuario, y a ciegas se equivocaba. */}
          <div className="adm-new-pwd">
            <input
              type={verClave ? 'text' : 'password'}
              placeholder="contraseña (mín. 6)"
              value={nuevo.password}
              onChange={(e) => setNuevo({ ...nuevo, password: e.target.value })}
              autoComplete="new-password"
            />
            <button
              type="button" className="adm-new-pwd-toggle"
              onClick={() => setVerClave((v) => !v)}
              title={verClave ? 'Ocultar la clave' : 'Ver la clave'}
            >
              {verClave ? '🙈' : '👁'}
            </button>
          </div>
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
              <th>Estado</th><th>Precio</th><th className="c">+IVA</th><th>Próx. pago</th><th>Plan rápido</th><th></th>
            </tr></thead>
            <tbody>
              {users.map((u) => {
                const e = edit[u.user_id] || { mods: new Set() }
                const venc = u.subscription?.vencida
                // Tiene acceso quien no está suspendido ni vencido. Sin fila de
                // suscripción se considera con acceso, que es lo que hace el
                // backend (no bloquear a quien nunca se le fijó un plan).
                const activo = u.subscription
                  ? (u.subscription.estado !== 'suspendido' && !venc)
                  : true
                // Empresa que define sus permisos, si la hay. Cuando existe, las
                // casillas de esta tabla NO son lo que el sistema lee.
                const orgManda = (u.orgs || []).find((o) => o.manda) || null
                return (
                  <tr key={u.user_id} className={venc ? 'vencida' : ''}>
                    <td>
                      <div className="adm-email">{u.email}</div>
                      {/* El «/3» se fue con el tope: ya no se corta a nadie por
                          entrar desde varios equipos. El número se queda porque
                          sigue diciendo algo —desde cuántos sitios entra esta
                          cuenta—, pero ya no es una cuota. */}
                      <div className="adm-meta">Rol activo: {ROL_LBL[u.role] || '👤 Cliente'} · alta {u.created_at}{venc ? ' · ⚠ vencida' : ''} · equipos {u.ips ?? 0}</div>
                      {/* De dónde salen sus permisos. Sin esto, el administrador
                          marcaba casillas aquí para un miembro de empresa y no
                          pasaba nada: el sistema lee las de su membresía. */}
                      {(() => {
                        const p = pantallas(u, orgManda)
                        return (
                          <div className="adm-meta">
                            {orgManda
                              ? <>Permisos de la empresa <strong>{orgManda.nombre || 'sin nombre'}</strong></>
                              : 'Permisos propios'}
                            {p.total > 0 && (
                              <> · pantallas <strong className={p.permitidas < p.total ? 'adm-recorte' : ''}>
                                {p.permitidas}/{p.total}
                              </strong></>
                            )}
                          </div>
                        )
                      })()}
                      {isSuperAdmin && (
                        <div className="adm-roles" title="Roles otorgados: si tiene más de uno, el usuario puede cambiar entre ellos con el selector de arriba a la derecha.">
                          <span className="adm-roles-lbl">Roles:</span>
                          {ROLES_ASIGNABLES.map((r) => {
                            const otorgados = u.roles || [u.role || 'cliente']
                            return (
                              <label key={r} className="adm-rol-chk">
                                <input type="checkbox" disabled={busy}
                                  checked={otorgados.includes(r)}
                                  onChange={() => toggleRol(u.user_id, otorgados, r)} />
                                {ROL_LBL[r]}
                              </label>
                            )
                          })}
                        </div>
                      )}
                    </td>
                    {MODS.map((m) => (
                      <td key={m.key} className="c"
                          title={orgManda
                            ? `Los permisos de este usuario los define la empresa ${orgManda.nombre || ''}. Edítalos con el botón «Pantallas».`
                            : undefined}>
                        <input type="checkbox"
                               disabled={u.role === 'admin' || !!orgManda}
                               checked={u.role === 'admin' || (orgManda ? (orgManda.modules || []).includes(m.key) : e.mods.has(m.key))}
                               onChange={() => toggle(u.user_id, m.key)} />
                      </td>
                    ))}
                    <td>
                      <select disabled={u.role === 'admin'} value={e.estado} onChange={(ev) => upd(u.user_id, { estado: ev.target.value })}>
                        {ESTADOS.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </td>
                    <td><input className="adm-precio" type="number" step="0.01" disabled={u.role === 'admin'} value={e.precio} onChange={(ev) => upd(u.user_id, { precio: ev.target.value })} /></td>
                    <td className="c" title="¿Los valores de este cliente ya incluyen IVA?">
                      <input type="checkbox" disabled={u.role === 'admin'} checked={e.iva_incluido || false} onChange={(ev) => upd(u.user_id, { iva_incluido: ev.target.checked })} />
                    </td>
                    <td><input type="date" disabled={u.role === 'admin'} value={e.proximo_pago || ''} onChange={(ev) => upd(u.user_id, { proximo_pago: ev.target.value })} /></td>
                    <td>
                      <select disabled={u.role === 'admin'} defaultValue="" onChange={(ev) => { aplicarPlan(u.user_id, ev.target.value); ev.target.value = '' }}>
                        <option value="">Plan…</option>
                        {PLANES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                      </select>
                    </td>
                    <td className="adm-acts">
                      {/* Activar / suspender: lo primero que se busca en esta
                          fila cuando un cliente llama porque no puede entrar. */}
                      {activo ? (
                        <button className="adm-btn warn" disabled={busy || u.role === 'admin'}
                                title="Suspender el acceso a la plataforma"
                                onClick={() => cambiarAcceso(u, false)}>⏸ Suspender</button>
                      ) : (
                        <button className="adm-btn ok" disabled={busy || u.role === 'admin'}
                                title="Activar el uso de la plataforma para este cliente"
                                onClick={() => cambiarAcceso(u, true)}>✅ Activar</button>
                      )}
                      <button className="adm-btn" disabled={busy || u.role === 'admin'} onClick={() => guardar(u.user_id)}>💾</button>
                      {/* Detalle fino: módulos y, dentro de cada uno, las
                          pantallas. Escribe donde de verdad mandan (empresa o
                          usuario), que es lo que antes no se podía hacer. */}
                      <button className="adm-btn" disabled={busy}
                              title="Marcar al detalle qué módulos y qué pantallas puede abrir"
                              onClick={() => setSubModal({
                                uid: u.user_id, email: u.email,
                                modules: u.modules, submodules: u.submodules,
                                org: (u.orgs || []).find((o) => o.manda) || null,
                              })}>
                        🖥 Pantallas
                      </button>
                      <button className="adm-btn" disabled={u.role === 'admin'} title="Contribuyentes que puede ver/trabajar" onClick={() => navigate(`/admin/acceso-clientes?uid=${u.user_id}`)}>🔐 Permisos</button>
                      <button className="adm-btn pay" disabled={busy || u.role === 'admin'} onClick={() => registrarPago(u.user_id)}>💵 Pago</button>
                      <button className="adm-btn" disabled={busy || u.role === 'admin'} title="Borrar el historial de equipos desde los que entró" onClick={() => resetIps(u.user_id)}>🔓 Equipos</button>
                      <button className="adm-btn" disabled={busy} title="Olvidó su clave: genera una clave temporal de un solo uso" onClick={() => resetClave(u)}>🔑 Clave</button>
                      <button className="adm-btn danger" disabled={busy || u.role === 'admin' || u.user_id === MI_UID} title="Eliminar usuario" onClick={() => eliminarUsuario(u)}>🗑</button>
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

/**
 * Permisos al detalle de un usuario: qué módulos tiene y, dentro de cada uno,
 * qué pantallas ve.
 *
 * `org` indica de dónde salen sus permisos efectivos. Si el usuario pertenece a
 * una empresa que los define, se editan ahí (organization_member_*): lo que se
 * guarde en el panel global no lo lee nadie. El modal lo dice en pantalla para
 * que no haya que adivinarlo, y guarda en el sitio correcto.
 */
function SubmodulosModal({ user, catalogo, modLabels, todosLosModulos, onSave, onCancel, busy }) {
  const org = user.org || null
  // Estado inicial: los módulos y pantallas que MANDAN hoy para esta persona.
  const [mods, setMods] = useState(() => new Set(
    org
      ? (org.modules || [])
      : Object.entries(user.modules || {}).filter(([, v]) => v.activo).map(([k]) => k),
  ))
  const [checked, setChecked] = useState(() => new Set(
    (org ? org.submodules : user.submodules) || [],
  ))

  const toggleModulo = (m) => setMods((prev) => {
    const s = new Set(prev)
    if (s.has(m)) { s.delete(m) } else {
      s.add(m)
      // Un módulo que se acaba de dar nace con TODAS sus pantallas: es lo que
      // significa «le di el módulo». Recortar viene después, si hace falta.
      setChecked((c) => {
        const n = new Set(c); (catalogo[m] || []).forEach((x) => n.add(x.key)); return n
      })
    }
    return s
  })

  const toggle = (k) => setChecked((prev) => { const s = new Set(prev); s.has(k) ? s.delete(k) : s.add(k); return s })
  const toggleTodas = (m, on) => setChecked((prev) => {
    const s = new Set(prev); (catalogo[m] || []).forEach((x) => { on ? s.add(x.key) : s.delete(x.key) }); return s
  })

  const save = () => {
    const keys = []
    for (const m of mods) {
      const delMod = catalogo[m] || []
      if (delMod.length === 0) continue          // módulo de una sola pantalla
      const marcadas = delMod.filter((x) => checked.has(x.key))
      if (marcadas.length === 0) {
        alert(`El módulo "${modLabels[m] || m}" quedó sin ninguna pantalla.\n\n`
          + 'Marca al menos una, o desmarca el módulo entero arriba si no debe verlo.')
        return
      }
      marcadas.forEach((x) => keys.push(x.key))
    }
    onSave({ modules: [...mods], submodules: keys, org })
  }

  return (
    <div className="pago-overlay">
      <div className="pago-modal adm-detalle">
        <h3 className="pago-title">🖥 Permisos al detalle</h3>
        <p className="pago-email">{user.email}</p>

        <div className={`adm-origen ${org ? 'org' : ''}`}>
          {org ? (
            <>Sus permisos los define la empresa <strong>{org.nombre || 'sin nombre'}</strong>
              {org.role ? ` (donde es ${org.role})` : ''}. Se guardan ahí, que es lo que el
              sistema lee para esta persona.</>
          ) : (
            <>Permisos propios del usuario. Se guardan en su cuenta.</>
          )}
        </div>

        <p className="adm-note" style={{ marginTop: 0 }}>
          Marca los módulos y, dentro de cada uno, las pantallas que puede abrir.
          Con todas marcadas ve el módulo completo.
        </p>

        {todosLosModulos.map((m) => {
          const activo = mods.has(m.key)
          const pantallas = catalogo[m.key] || []
          return (
            <div key={m.key} className={`submod-group ${activo ? '' : 'apagado'}`}>
              <div className="submod-group-head">
                <label className="submod-mod-chk">
                  <input type="checkbox" checked={activo} onChange={() => toggleModulo(m.key)} />
                  <strong>{m.label}</strong>
                </label>
                {activo && pantallas.length > 0 && (
                  <span className="submod-actions">
                    <button type="button" className="submod-mini" onClick={() => toggleTodas(m.key, true)}>Todas</button>
                    <button type="button" className="submod-mini" onClick={() => toggleTodas(m.key, false)}>Ninguna</button>
                  </span>
                )}
              </div>
              {activo && (pantallas.length === 0
                ? <p className="submod-unica">Módulo de una sola pantalla: se ve completo.</p>
                : pantallas.map((x) => (
                  <label key={x.key} className="submod-item">
                    <input type="checkbox" checked={checked.has(x.key)} onChange={() => toggle(x.key)} />
                    {x.label}
                  </label>
                )))}
            </div>
          )
        })}

        <div className="pago-actions">
          <button type="button" className="adm-btn" onClick={onCancel} disabled={busy}>Cancelar</button>
          <button type="button" className="adm-btn primary" onClick={save} disabled={busy}>
            {busy ? 'Guardando…' : '✔ Guardar permisos'}
          </button>
        </div>
      </div>
    </div>
  )
}

function PagoModalForm({ email, precioBase, ivaIncluidoDefault, descuentos, onConfirm, onCancel, busy }) {
  const [meses, setMeses] = useState(1)
  const [monto, setMonto] = useState('')
  const [ivaIncluido, setIvaIncluido] = useState(ivaIncluidoDefault || false)
  const inputRef = useRef(null)

  useEffect(() => {
    const desc = descuentos[meses] || 0
    const sugerido = precioBase ? (precioBase * meses * (1 - desc)).toFixed(2) : ''
    setMonto(sugerido)
  }, [meses, precioBase, descuentos])

  useEffect(() => { inputRef.current?.focus() }, [])

  const val = parseFloat(monto) || 0
  const desc = descuentos[meses] || 0
  const base = ivaIncluido ? val / 1.15 : val
  const iva = ivaIncluido ? val - base : val * 0.15
  const total = ivaIncluido ? val : val * 1.15

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!val) return
    onConfirm({ meses, monto: val, iva_incluido: ivaIncluido })
  }

  return (
    <div className="pago-overlay">
      <div className="pago-modal">
        <h3 className="pago-title">💵 Registrar Pago</h3>
        <p className="pago-email">{email}</p>
        <form onSubmit={handleSubmit} className="pago-form">
          <label className="pago-label">Meses
            <select value={meses} onChange={(e) => setMeses(parseInt(e.target.value))} className="pago-select">
              {[1, 3, 6, 12].map((m) => (
                <option key={m} value={m}>{m} mes{m > 1 ? 'es' : ''}{descuentos[m] ? ` (−${descuentos[m] * 100}%)` : ''}</option>
              ))}
            </select>
          </label>
          <label className="pago-label">Valor ($)
            <input ref={inputRef} type="number" step="0.01" min="0.01" value={monto}
              onChange={(e) => setMonto(e.target.value)} className="pago-input" required />
          </label>
          <label className="pago-check">
            <input type="checkbox" checked={ivaIncluido} onChange={(e) => setIvaIncluido(e.target.checked)} />
            Valor ya incluye IVA (15%)
          </label>
          {val > 0 && (
            <div className="pago-preview">
              {desc > 0 && <div>Descuento: {desc * 100}%</div>}
              <div>Base imponible: <strong>${base.toFixed(2)}</strong></div>
              <div>IVA 15%: <strong>${iva.toFixed(2)}</strong></div>
              <div className="pago-total">Total c/IVA: <strong>${total.toFixed(2)}</strong></div>
            </div>
          )}
          <div className="pago-actions">
            <button type="button" className="adm-btn" onClick={onCancel} disabled={busy}>Cancelar</button>
            <button type="submit" className="adm-btn primary" disabled={busy || !val}>✔ Confirmar</button>
          </div>
        </form>
      </div>
    </div>
  )
}
