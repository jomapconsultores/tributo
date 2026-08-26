/* ------------------------------------------------------------
 * Desarrollado por Marco Antonio Posligua San Martín
 * ------------------------------------------------------------ */
import { useState, useEffect, useCallback } from 'react'
import { orgsAPI } from '../services/api'
import { useAccess } from '../context/AccessContext'
import './AdminEmpresas.css'

const ROLES = [
  { key: 'admin', label: 'Administrador', ayuda: 'Ve todos los contribuyentes de la empresa y gestiona a sus miembros.' },
  { key: 'socio', label: 'Socio', ayuda: 'Ve todo menos lo que registró un administrador de la empresa.' },
  { key: 'trabajador', label: 'Funcionario', ayuda: 'Solo lo suyo y lo que le compartan.' },
  { key: 'cliente', label: 'Cliente', ayuda: 'Solo lo suyo y lo que le compartan.' },
]
const ROL_LABEL = Object.fromEntries(ROLES.map((r) => [r.key, r.label]))

const MOD_LABEL = {
  gastos: 'Gastos',
  retenciones: 'Retenciones',
  ingresos_ice: 'Ingresos ICE',
  declaraciones: 'Declaraciones',
  agente_retencion: 'Agente de retención',
}

export default function AdminEmpresas() {
  const { isPlatformAdmin, platformRole, role, org: orgActiva } = useAccess()

  const [empresas, setEmpresas] = useState([])
  const [selectedOrg, setSelectedOrg] = useState('')
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState('')
  const [aviso, setAviso] = useState('')

  const [miembros, setMiembros] = useState([])
  const [catModulos, setCatModulos] = useState([])
  const [catSubmodulos, setCatSubmodulos] = useState({})
  const [cargandoMiembros, setCargandoMiembros] = useState(false)
  const [expandido, setExpandido] = useState('')   // user_id con el detalle de permisos abierto
  const [busy, setBusy] = useState('')             // user_id en curso (bloquea sus controles)

  const [candidatos, setCandidatos] = useState([])
  const [nuevoUid, setNuevoUid] = useState('')
  const [nuevoRol, setNuevoRol] = useState('cliente')

  const [nombreNuevo, setNombreNuevo] = useState('')
  const [rucNuevo, setRucNuevo] = useState('')
  const [creando, setCreando] = useState(false)

  const [contribuyentes, setContribuyentes] = useState([])
  const [huerfanos, setHuerfanos] = useState([])
  const [seleccionHuerfanos, setSeleccionHuerfanos] = useState(new Set())

  // Anexar contribuyentes que hoy están en OTRA empresa
  const [origenOrg, setOrigenOrg] = useState('')
  const [contribOrigen, setContribOrigen] = useState([])
  const [seleccionOrigen, setSeleccionOrigen] = useState(new Set())
  const [anexConservar, setAnexConservar] = useState(true)
  const [anexando, setAnexando] = useState(false)

  // Exportar un contribuyente a empresa propia + autorizaciones entre empresas
  const [expIdent, setExpIdent] = useState('')
  const [expConservar, setExpConservar] = useState(true)
  const [exportando, setExportando] = useState(false)
  const [autor, setAutor] = useState({ otorgadas: [], recibidas: [], empresas: [] })
  const [autDestino, setAutDestino] = useState('')
  const [autIdent, setAutIdent] = useState('')

  const mostrarError = (e, fallback) => {
    const d = e?.response?.data?.detail
    setError(typeof d === 'string' ? d : (d ? JSON.stringify(d) : (e?.message || fallback)))
    setAviso('')
  }

  const cargarEmpresas = useCallback(async () => {
    try {
      const r = await orgsAPI.list()
      const lista = r.data?.data || []
      setEmpresas(lista)
      setSelectedOrg((actual) => actual || r.data?.activa || lista[0]?.org_id || '')
      setError('')
    } catch (e) {
      mostrarError(e, 'No se pudieron cargar las empresas')
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => { cargarEmpresas() }, [cargarEmpresas])

  const cargarMiembros = useCallback(async (orgId) => {
    if (!orgId) { setMiembros([]); return }
    setCargandoMiembros(true)
    try {
      const r = await orgsAPI.members(orgId)
      setMiembros(r.data?.data || [])
      setCatModulos(r.data?.catalogo_modulos || [])
      setCatSubmodulos(r.data?.catalogo_submodulos || {})
      setError('')
    } catch (e) {
      setMiembros([])
      mostrarError(e, 'No se pudieron cargar los miembros')
    } finally {
      setCargandoMiembros(false)
    }
  }, [])

  useEffect(() => {
    setExpandido('')
    cargarMiembros(selectedOrg)
    if (!selectedOrg) { setCandidatos([]); setContribuyentes([]); return }
    orgsAPI.candidatos(selectedOrg).then((r) => setCandidatos(r.data?.data || [])).catch(() => setCandidatos([]))
    orgsAPI.contribuyentes(selectedOrg).then((r) => setContribuyentes(r.data?.data || [])).catch(() => setContribuyentes([]))
    cargarAutorizaciones(selectedOrg)
    setExpIdent(''); setAutDestino(''); setAutIdent('')
    setOrigenOrg(''); setContribOrigen([]); setSeleccionOrigen(new Set())
  }, [selectedOrg, cargarMiembros])

  // Cartera de la empresa ORIGEN, para elegir a quién traerse de ella.
  useEffect(() => {
    setSeleccionOrigen(new Set())
    if (!origenOrg) { setContribOrigen([]); return }
    orgsAPI.contribuyentes(origenOrg)
      .then((r) => setContribOrigen(r.data?.data || []))
      .catch(() => setContribOrigen([]))
  }, [origenOrg])

  const cargarAutorizaciones = useCallback((orgId) => {
    if (!orgId) { setAutor({ otorgadas: [], recibidas: [], empresas: [] }); return }
    orgsAPI.autorizaciones(orgId)
      .then((r) => setAutor({
        otorgadas: r.data?.otorgadas || [], recibidas: r.data?.recibidas || [],
        empresas: r.data?.empresas || [],
      }))
      .catch(() => setAutor({ otorgadas: [], recibidas: [], empresas: [] }))
  }, [])

  const exportar = async (e) => {
    e.preventDefault()
    if (!expIdent || exportando) return
    const c = contribuyentes.find((x) => x.identificacion === expIdent)
    const msg = `¿Convertir «${c?.nombre || expIdent}» en una empresa propia?\n\n` +
      `Se le mueven sus ${c?.periodos || '?'} período(s) con todos sus datos.\n` +
      (expConservar
        ? 'Esta empresa conservará el acceso mediante una autorización revocable.'
        : 'ATENCIÓN: esta empresa DEJARÁ de ver ese contribuyente.')
    if (!window.confirm(msg)) return
    setExportando(true)
    try {
      const r = await orgsAPI.exportarContribuyente(expIdent, expConservar)
      setExpIdent('')
      await cargarEmpresas()
      const [ctb, aut] = await Promise.all([
        orgsAPI.contribuyentes(selectedOrg), orgsAPI.autorizaciones(selectedOrg),
      ])
      setContribuyentes(ctb.data?.data || [])
      setAutor({ otorgadas: aut.data?.otorgadas || [], recibidas: aut.data?.recibidas || [], empresas: aut.data?.empresas || [] })
      setAviso(`«${r.data?.nombre}» es ahora una empresa con ${r.data?.periodos_movidos} período(s).` +
        (r.data?.autorizacion_de_vuelta ? ' Se creó la autorización de vuelta.' : ''))
      setError('')
    } catch (e2) {
      mostrarError(e2, 'No se pudo exportar')
    } finally {
      setExportando(false)
    }
  }

  const autorizar = async (e) => {
    e.preventDefault()
    if (!autDestino) return
    try {
      await orgsAPI.autorizar(selectedOrg, {
        grantee_org_id: autDestino, identificacion: autIdent || null,
      })
      setAutDestino(''); setAutIdent('')
      cargarAutorizaciones(selectedOrg)
      setAviso('Autorización creada.')
      setError('')
    } catch (e2) {
      mostrarError(e2, 'No se pudo autorizar')
    }
  }

  const revocar = async (g) => {
    if (!window.confirm(`¿Revocar el acceso de «${g.empresa}» a ${g.alcance}?`)) return
    try {
      await orgsAPI.revocar(selectedOrg, g.id)
      cargarAutorizaciones(selectedOrg)
      setAviso('Autorización revocada.')
      setError('')
    } catch (e2) {
      mostrarError(e2, 'No se pudo revocar')
    }
  }

  useEffect(() => {
    if (!isPlatformAdmin) return
    orgsAPI.huerfanos().then((r) => setHuerfanos(r.data?.data || [])).catch(() => setHuerfanos([]))
  }, [isPlatformAdmin])

  // ── Empresas ────────────────────────────────────────────────────────────
  const crearEmpresa = async (e) => {
    e.preventDefault()
    if (!nombreNuevo.trim() || creando) return
    setCreando(true)
    try {
      const r = await orgsAPI.create({ nombre: nombreNuevo.trim(), identificacion: rucNuevo.trim() || null })
      setNombreNuevo(''); setRucNuevo('')
      await cargarEmpresas()
      if (r.data?.id) setSelectedOrg(r.data.id)
      setAviso(`Empresa «${r.data?.nombre}» creada. Ya puedes agregarle miembros.`)
      setError('')
    } catch (e2) {
      mostrarError(e2, 'No se pudo crear la empresa')
    } finally {
      setCreando(false)
    }
  }

  const renombrar = async () => {
    const actual = empresas.find((x) => x.org_id === selectedOrg)
    const nombre = window.prompt('Nuevo nombre de la empresa:', actual?.nombre || '')
    if (nombre === null || !nombre.trim()) return
    try {
      await orgsAPI.update(selectedOrg, { nombre: nombre.trim() })
      await cargarEmpresas()
      setAviso('Nombre actualizado.')
      setError('')
    } catch (e) {
      mostrarError(e, 'No se pudo renombrar')
    }
  }

  const eliminar = async () => {
    const actual = empresas.find((x) => x.org_id === selectedOrg)
    if (!window.confirm(`¿Eliminar la empresa «${actual?.nombre}»?\n\nSolo se puede si ya no tiene contribuyentes asignados.`)) return
    try {
      await orgsAPI.remove(selectedOrg)
      setSelectedOrg('')
      await cargarEmpresas()
      setAviso('Empresa eliminada.')
      setError('')
    } catch (e) {
      mostrarError(e, 'No se pudo eliminar')
    }
  }

  // ── Miembros ────────────────────────────────────────────────────────────
  const agregarMiembro = async (e) => {
    e.preventDefault()
    if (!nuevoUid || !selectedOrg) return
    setBusy('nuevo')
    try {
      await orgsAPI.addMember(selectedOrg, { user_id: nuevoUid, role: nuevoRol })
      setNuevoUid('')
      await cargarMiembros(selectedOrg)
      const r = await orgsAPI.candidatos(selectedOrg)
      setCandidatos(r.data?.data || [])
      setAviso('Miembro agregado. Revisa sus módulos: por defecto hereda los que tenga a nivel global.')
      setError('')
    } catch (e2) {
      mostrarError(e2, 'No se pudo agregar el miembro')
    } finally {
      setBusy('')
    }
  }

  const actualizar = async (uid, cambios, mensaje) => {
    setBusy(uid)
    try {
      await orgsAPI.updateMember(selectedOrg, uid, cambios)
      await cargarMiembros(selectedOrg)
      setAviso(mensaje)
      setError('')
    } catch (e) {
      mostrarError(e, 'No se pudo guardar el cambio')
    } finally {
      setBusy('')
    }
  }

  const cambiarRol = (m, role) => {
    if (role === m.role) return
    actualizar(m.user_id, { role }, `${m.email}: ahora es ${ROL_LABEL[role]} en esta empresa.`)
  }

  const modulosActivos = (m) =>
    new Set(Object.entries(m.modules || {}).filter(([, v]) => v.activo).map(([k]) => k))

  const toggleModulo = (m, key) => {
    const next = modulosActivos(m)
    next.has(key) ? next.delete(key) : next.add(key)
    actualizar(m.user_id, { modules: [...next] },
      `${m.email}: ${next.has(key) ? 'con' : 'sin'} acceso a ${MOD_LABEL[key] || key}.`)
  }

  const toggleSubmodulo = (m, key) => {
    const next = new Set(m.submodules || [])
    next.has(key) ? next.delete(key) : next.add(key)
    actualizar(m.user_id, { submodules: [...next] }, `${m.email}: pantallas actualizadas.`)
  }

  const quitar = async (m) => {
    if (!window.confirm(`¿Quitar a ${m.email} de esta empresa?\n\nNo se borra nada de lo que haya registrado: solo deja de verlo.`)) return
    setBusy(m.user_id)
    try {
      await orgsAPI.removeMember(selectedOrg, m.user_id)
      await cargarMiembros(selectedOrg)
      const r = await orgsAPI.candidatos(selectedOrg)
      setCandidatos(r.data?.data || [])
      setAviso(`${m.email} ya no pertenece a esta empresa.`)
      setError('')
    } catch (e) {
      mostrarError(e, 'No se pudo quitar el miembro')
    } finally {
      setBusy('')
    }
  }

  // ── Anexar contribuyentes de otra empresa ───────────────────────────────
  const toggleOrigen = (ident) => {
    setSeleccionOrigen((prev) => {
      const next = new Set(prev)
      next.has(ident) ? next.delete(ident) : next.add(ident)
      return next
    })
  }

  const anexar = async () => {
    if (!selectedOrg || !origenOrg || seleccionOrigen.size === 0 || anexando) return
    const destino = empresas.find((x) => x.org_id === selectedOrg)?.nombre || 'esta empresa'
    const origen = empresas.find((x) => x.org_id === origenOrg)?.nombre || 'la otra empresa'
    if (!window.confirm(
      `¿Mover ${seleccionOrigen.size} contribuyente(s) de «${origen}» a «${destino}»?\n\n` +
      'Se llevan todos sus períodos, con sus facturas, declaraciones y anexos.\n' +
      (anexConservar
        ? `«${origen}» los seguirá viendo mediante una autorización revocable.`
        : `ATENCIÓN: «${origen}» DEJARÁ de verlos.`)
    )) return
    setAnexando(true)
    try {
      const r = await orgsAPI.asignarContribuyentes(selectedOrg, [...seleccionOrigen], anexConservar)
      setSeleccionOrigen(new Set())
      const [aqui, alla] = await Promise.all([
        orgsAPI.contribuyentes(selectedOrg), orgsAPI.contribuyentes(origenOrg),
      ])
      setContribuyentes(aqui.data?.data || [])
      setContribOrigen(alla.data?.data || [])
      cargarAutorizaciones(selectedOrg)   // las de vuelta se acaban de crear
      const devueltas = r.data?.autorizaciones?.length || 0
      setAviso(`${r.data?.movidos ?? 0} contribuyente(s) anexado(s) a «${destino}».` +
        (devueltas ? ` «${origen}» conserva el acceso a ${devueltas} de ellos.` : ''))
      setError('')
    } catch (e) {
      mostrarError(e, 'No se pudieron anexar los contribuyentes')
    } finally {
      setAnexando(false)
    }
  }

  // ── Contribuyentes huérfanos ────────────────────────────────────────────
  const toggleHuerfano = (ident) => {
    setSeleccionHuerfanos((prev) => {
      const next = new Set(prev)
      next.has(ident) ? next.delete(ident) : next.add(ident)
      return next
    })
  }

  const asignarHuerfanos = async () => {
    if (!selectedOrg || seleccionHuerfanos.size === 0) return
    try {
      await orgsAPI.asignarContribuyentes(selectedOrg, [...seleccionHuerfanos], false)
      setSeleccionHuerfanos(new Set())
      const [h, c] = await Promise.all([orgsAPI.huerfanos(), orgsAPI.contribuyentes(selectedOrg)])
      setHuerfanos(h.data?.data || [])
      setContribuyentes(c.data?.data || [])
      setAviso('Contribuyentes asignados a la empresa.')
      setError('')
    } catch (e) {
      mostrarError(e, 'No se pudieron asignar')
    }
  }

  if (cargando) return <div className="loading">Cargando empresas…</div>

  const empresaSel = empresas.find((x) => x.org_id === selectedOrg)

  return (
    <div className="empresas-page">
      <header className="empresas-header">
        <h1>🏢 Empresas</h1>
        <p>
          Cada empresa es un despacho con su propia cartera de contribuyentes y su propio equipo.
          Un mismo usuario puede pertenecer a varias y tener un rol y unos permisos distintos en cada una.
        </p>
      </header>

      {error && <div className="empresas-error">⚠️ {error}</div>}
      {aviso && <div className="empresas-aviso">✓ {aviso}</div>}

      {empresas.length === 0 && (
        <div className="empresas-vacio">
          Todavía no hay empresas creadas. Si acabas de desplegar, aplica la migración
          <code>051_organizations.sql</code> para que el sistema cree la empresa inicial con todo lo existente.
        </div>
      )}

      <div className="empresas-grid">
        {/* ── Columna izquierda: empresas ───────────────────────────────── */}
        <section className="empresas-col">
          <h2>Empresas</h2>
          <ul className="empresas-lista">
            {empresas.map((e) => (
              <li key={e.org_id}>
                <button
                  className={`empresa-item ${e.org_id === selectedOrg ? 'sel' : ''}`}
                  onClick={() => setSelectedOrg(e.org_id)}
                >
                  <span className="empresa-nombre">{e.nombre}</span>
                  <span className="empresa-meta">
                    {ROL_LABEL[e.role] || e.role}
                    {!e.activa && <em className="empresa-suspendida"> · suspendida</em>}
                    {e.org_id === orgActiva?.org_id && <em className="empresa-actual"> · en uso</em>}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {isPlatformAdmin && (
            <form className="empresa-nueva" onSubmit={crearEmpresa}>
              <h3>Nueva empresa</h3>
              <input
                type="text" placeholder="Nombre del despacho" value={nombreNuevo}
                onChange={(ev) => setNombreNuevo(ev.target.value)} maxLength={120}
              />
              <input
                type="text" placeholder="RUC (opcional)" value={rucNuevo}
                onChange={(ev) => setRucNuevo(ev.target.value)} maxLength={13}
              />
              <button type="submit" disabled={creando || !nombreNuevo.trim()}>
                {creando ? 'Creando…' : 'Crear empresa'}
              </button>
            </form>
          )}

          {/* Sin el formulario, la pantalla callaba y no había forma de saber si
              faltaba el permiso, el despliegue o la migración. Que lo diga. */}
          {!isPlatformAdmin && (
            <div className="empresas-nota-permiso">
              <h3>Nueva empresa</h3>
              <p>
                Crear empresas y repartir la cartera entre ellas es del administrador
                de la plataforma. Tu rol en el sistema es
                {' '}<strong>{ROL_LABEL[platformRole || role] || platformRole || role}</strong>
                {platformRole && platformRole !== role && (
                  <> (dentro de esta empresa actúas como {ROL_LABEL[role] || role})</>
                )}.
              </p>
              <p>
                Si debería ser <strong>Administrador</strong>, cámbialo en el selector de rol
                de la barra superior. Si ahí ya dice Administrador y esto sigue apareciendo,
                el servidor está respondiendo con una versión anterior: vuelve a entrar a la
                sesión y recarga la página.
              </p>
            </div>
          )}
        </section>

        {/* ── Columna derecha: miembros de la empresa ───────────────────── */}
        <section className="empresas-col ancha">
          {!selectedOrg ? (
            <p className="empresas-hint">Elige una empresa para ver su equipo.</p>
          ) : (
            <>
              <div className="empresa-titulo">
                <h2>{empresaSel?.nombre}</h2>
                <div className="empresa-acciones">
                  <button onClick={renombrar}>Renombrar</button>
                  {isPlatformAdmin && <button className="peligro" onClick={eliminar}>Eliminar</button>}
                </div>
              </div>
              <p className="empresa-sub">
                {contribuyentes.length} contribuyente(s) asignado(s) · {miembros.length} miembro(s)
              </p>

              {/* ── Autorizaciones entre empresas ───────────────────────── */}
              <div className="bloque">
                <h3>Compartir contribuyentes con otra empresa</h3>
                <p>
                  Comparte un contribuyente de «{empresaSel?.nombre}» con otra empresa SIN moverlo:
                  sigue siendo de esta cartera y las dos lo ven. Es lo que hay que usar cuando el
                  contribuyente pasa a declarar por su cuenta y el despacho lo sigue llevando.
                  Por defecto ninguna empresa ve los datos de otra, y revocarlo vuelve a cerrar la puerta.
                </p>

                <form className="fila-form" onSubmit={autorizar}>
                  <select value={autDestino} onChange={(ev) => setAutDestino(ev.target.value)}>
                    <option value="">Compartir con la empresa…</option>
                    {autor.empresas.map((e) => (
                      <option key={e.id} value={e.id}>{e.nombre}</option>
                    ))}
                  </select>
                  <select value={autIdent} onChange={(ev) => setAutIdent(ev.target.value)}>
                    <option value="">Toda la cartera</option>
                    {contribuyentes.map((c) => (
                      <option key={c.identificacion} value={c.identificacion}>
                        Solo {c.nombre}
                      </option>
                    ))}
                  </select>
                  <button type="submit" disabled={!autDestino}>Compartir</button>
                </form>
                {autDestino && !autIdent && (
                  <p className="aviso-rojo">
                    «Toda la cartera» es un cheque en blanco: incluye también los contribuyentes
                    que esta empresa registre en el futuro. Lo habitual es autorizar RUC por RUC.
                  </p>
                )}

                <h4>Lo que esta empresa comparte</h4>
                {autor.otorgadas.length === 0 ? (
                  <p className="vacio">Ninguno. Sus datos no los ve ninguna otra empresa.</p>
                ) : (
                  <ul className="lista-grants">
                    {autor.otorgadas.map((g) => (
                      <li key={g.id}>
                        <span><strong>{g.empresa}</strong> puede ver: {g.alcance}</span>
                        <button className="peligro" onClick={() => revocar(g)}>Revocar</button>
                      </li>
                    ))}
                  </ul>
                )}

                <h4>Lo que otras empresas comparten con esta</h4>
                {autor.recibidas.length === 0 ? (
                  <p className="vacio">Ninguno.</p>
                ) : (
                  <ul className="lista-grants">
                    {autor.recibidas.map((g) => (
                      <li key={g.id}>
                        <span>De <strong>{g.empresa}</strong>: {g.alcance}</span>
                        <em className="solo-dueno">solo {g.empresa} puede revocarlo</em>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* ── Anexar contribuyentes de otra empresa ───────────────── */}
              {isPlatformAdmin && empresas.length > 1 && (
                /* Va arriba, y se destaca mientras la empresa esté vacía: recién
                   creada, poblarla es lo único que hay que hacer aquí, y al
                   final de la columna no se encontraba. */
                <div className={`bloque ${contribuyentes.length === 0 ? 'destacado' : ''}`}>
                  <h3>Anexar contribuyentes de otra empresa</h3>
                  <p>
                    {contribuyentes.length === 0
                      ? `«${empresaSel?.nombre}» todavía no tiene contribuyentes. Tráelos desde otra empresa: `
                      : `Trae a «${empresaSel?.nombre}» contribuyentes que hoy están en otra empresa. `}
                    Se mueven enteros: todos sus períodos con sus facturas, declaraciones y anexos.
                    Si solo quieres que otra empresa los VEA, no muevas nada: usa «Compartir», aquí arriba.
                  </p>
                  <form className="fila-form" onSubmit={(ev) => { ev.preventDefault(); anexar() }}>
                    <select value={origenOrg} onChange={(ev) => setOrigenOrg(ev.target.value)}>
                      <option value="">Desde la empresa…</option>
                      {empresas.filter((e) => e.org_id !== selectedOrg).map((e) => (
                        <option key={e.org_id} value={e.org_id}>{e.nombre}</option>
                      ))}
                    </select>
                    <label className="check">
                      <input
                        type="checkbox" checked={anexConservar}
                        onChange={(ev) => setAnexConservar(ev.target.checked)}
                      />
                      Conservar el acceso de quien los tiene hoy
                    </label>
                    <button type="submit" disabled={seleccionOrigen.size === 0 || anexando}>
                      {anexando ? 'Anexando…' : `Anexar ${seleccionOrigen.size || ''}`}
                    </button>
                  </form>
                  {!anexConservar && origenOrg && (
                    <p className="aviso-rojo">
                      Sin conservar el acceso, «{empresas.find((e) => e.org_id === origenOrg)?.nombre}»
                      dejará de ver a esos contribuyentes en cuanto se muevan. Es lo que hay que marcar
                      cuando el contribuyente pasa a declarar por su cuenta pero el despacho lo sigue llevando.
                    </p>
                  )}
                  {origenOrg && (
                    contribOrigen.length === 0 ? (
                      <p className="vacio">Esa empresa no tiene contribuyentes que traer.</p>
                    ) : (
                      <div className="huerfanos-lista">
                        {contribOrigen.map((c) => (
                          <label key={c.identificacion}>
                            <input
                              type="checkbox"
                              checked={seleccionOrigen.has(c.identificacion)}
                              onChange={() => toggleOrigen(c.identificacion)}
                            />
                            {c.nombre} <span className="huerfano-ruc">{c.identificacion}</span>
                          </label>
                        ))}
                      </div>
                    )
                  )}
                </div>
              )}


              <form className="miembro-nuevo" onSubmit={agregarMiembro}>
                <select value={nuevoUid} onChange={(ev) => setNuevoUid(ev.target.value)}>
                  <option value="">Agregar usuario…</option>
                  {candidatos.map((c) => (
                    <option key={c.user_id} value={c.user_id}>{c.email}</option>
                  ))}
                </select>
                <select value={nuevoRol} onChange={(ev) => setNuevoRol(ev.target.value)}>
                  {ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
                <button type="submit" disabled={!nuevoUid || busy === 'nuevo'}>
                  {busy === 'nuevo' ? 'Agregando…' : 'Agregar'}
                </button>
              </form>

              {cargandoMiembros ? (
                <div className="loading">Cargando miembros…</div>
              ) : (
                <table className="miembros-tabla">
                  <thead>
                    <tr>
                      <th>Usuario</th>
                      <th>Rol en la empresa</th>
                      <th>Módulos</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {miembros.map((m) => {
                      const activos = modulosActivos(m)
                      const abierto = expandido === m.user_id
                      return (
                        <tr key={m.user_id} className={abierto ? 'abierto' : ''}>
                          <td>
                            <div className="miembro-email">{m.email}</div>
                            <button
                              className="miembro-detalle"
                              onClick={() => setExpandido(abierto ? '' : m.user_id)}
                            >
                              {abierto ? '▴ ocultar pantallas' : '▾ pantallas permitidas'}
                            </button>
                            {abierto && (
                              <div className="submodulos">
                                {Object.entries(catSubmodulos).map(([mod, subs]) => (
                                  activos.has(mod) && (
                                    <div key={mod} className="submodulo-grupo">
                                      <strong>{MOD_LABEL[mod] || mod}</strong>
                                      {subs.map((s) => (
                                        <label key={s.key}>
                                          <input
                                            type="checkbox"
                                            checked={(m.submodules || []).includes(s.key)}
                                            disabled={busy === m.user_id}
                                            onChange={() => toggleSubmodulo(m, s.key)}
                                          />
                                          {s.label}
                                        </label>
                                      ))}
                                    </div>
                                  )
                                ))}
                                <p className="submodulos-nota">
                                  Con todas marcadas no hay restricción. Para negar un módulo entero,
                                  desmárcalo en la columna «Módulos».
                                </p>
                              </div>
                            )}
                          </td>
                          <td>
                            <select
                              value={m.role}
                              disabled={busy === m.user_id}
                              onChange={(ev) => cambiarRol(m, ev.target.value)}
                            >
                              {ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                            </select>
                          </td>
                          <td>
                            <div className="modulos-chips">
                              {(catModulos.length ? catModulos : Object.keys(MOD_LABEL)).map((mod) => (
                                <label key={mod} className={activos.has(mod) ? 'chip on' : 'chip'}>
                                  <input
                                    type="checkbox"
                                    checked={activos.has(mod)}
                                    disabled={busy === m.user_id}
                                    onChange={() => toggleModulo(m, mod)}
                                  />
                                  {MOD_LABEL[mod] || mod}
                                </label>
                              ))}
                            </div>
                          </td>
                          <td>
                            <button
                              className="peligro"
                              disabled={busy === m.user_id}
                              onClick={() => quitar(m)}
                            >
                              Quitar
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                    {miembros.length === 0 && (
                      <tr><td colSpan={4} className="sin-datos">Esta empresa todavía no tiene miembros.</td></tr>
                    )}
                  </tbody>
                </table>
              )}

              {/* ── Exportar un contribuyente a empresa propia ──────────── */}
              {isPlatformAdmin && contribuyentes.length > 0 && (
                <div className="bloque">
                  <h3>Exportar un contribuyente a empresa</h3>
                  <p>
                    Convierte un contribuyente de esta cartera en una empresa con vida propia,
                    para poder darle acceso a su propia gente. Se lleva todos sus períodos y sus datos.
                  </p>
                  <form className="fila-form" onSubmit={exportar}>
                    <select value={expIdent} onChange={(ev) => setExpIdent(ev.target.value)}>
                      <option value="">Elige un contribuyente…</option>
                      {contribuyentes.map((c) => (
                        <option key={c.identificacion} value={c.identificacion}>
                          {c.nombre} — {c.identificacion} ({c.periodos} período{c.periodos !== 1 ? 's' : ''})
                        </option>
                      ))}
                    </select>
                    <label className="check">
                      <input
                        type="checkbox" checked={expConservar}
                        onChange={(ev) => setExpConservar(ev.target.checked)}
                      />
                      Conservar el acceso de {empresaSel?.nombre}
                    </label>
                    <button type="submit" disabled={!expIdent || exportando}>
                      {exportando ? 'Exportando…' : 'Exportar'}
                    </button>
                  </form>
                  {!expConservar && (
                    <p className="aviso-rojo">
                      Sin conservar el acceso, esta empresa dejará de ver ese contribuyente
                      en cuanto se exporte. Se puede volver a autorizar después, desde la empresa nueva.
                    </p>
                  )}
                </div>
              )}

              {isPlatformAdmin && huerfanos.length > 0 && (
                <div className="huerfanos">
                  <h3>Contribuyentes sin empresa ({huerfanos.length})</h3>
                  <p>
                    Quedaron fuera de toda empresa y hoy solo los ve el administrador de la plataforma.
                    Márcalos y asígnalos a «{empresaSel?.nombre}».
                  </p>
                  <div className="huerfanos-lista">
                    {huerfanos.map((h) => (
                      <label key={h.identificacion}>
                        <input
                          type="checkbox"
                          checked={seleccionHuerfanos.has(h.identificacion)}
                          onChange={() => toggleHuerfano(h.identificacion)}
                        />
                        {h.nombre} <span className="huerfano-ruc">{h.identificacion}</span>
                      </label>
                    ))}
                  </div>
                  <button disabled={seleccionHuerfanos.size === 0} onClick={asignarHuerfanos}>
                    Asignar {seleccionHuerfanos.size || ''} a esta empresa
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
