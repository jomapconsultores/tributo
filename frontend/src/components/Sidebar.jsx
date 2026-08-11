/* ------------------------------------------------------------
 * Desarrollado por Marco Antonio Posligua San Martín
 * ------------------------------------------------------------ */
import { useState, useEffect, useMemo, Fragment } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useClients } from '../context/ClientContext'
import { useAccess, homeFor } from '../context/AccessContext'
import { actividadAPI } from '../services/api'
import { setBajadorEmitidosHref } from '../utils/bajadorEmitidos'
import { setBajadorGastosHref } from '../utils/bajadorGastos'
import { filtrarClientesPorTexto } from '../utils/clientSearch'
import BajadorSRI from './BajadorSRI'
import './Sidebar.css'

export default function Sidebar({ onNewClient, onLogout, userEmail, open = false }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { clients, selectedClientId, selectClient, setFocusIdent } = useClients()
  const { has, hasSub, isSuperAdmin, role } = useAccess()
  const [clientSearch, setClientSearch] = useState('')
  const [movNuevos, setMovNuevos] = useState(0)
  // Módulo abierto en la SEGUNDA columna. null = seguir la ruta actual.
  const [openKey, setOpenKey] = useState(null)
  // Bajador abierto en el panel copiable ('gastos' | 'emitidos'), o null.
  const [bajador, setBajador] = useState(null)

  // Insignia de movimientos nuevos (solo admin).
  useEffect(() => {
    if (!isSuperAdmin) return
    const load = () => actividadAPI.resumen().then((r) => setMovNuevos(r.data?.nuevos || 0)).catch(() => {})
    load()
    const id = setInterval(load, 60 * 1000)
    const onVista = () => setMovNuevos(0)
    window.addEventListener('actividad-vista', onVista)
    return () => { clearInterval(id); window.removeEventListener('actividad-vista', onVista) }
  }, [isSuperAdmin])

  // Contribuyentes únicos (por identificación) para el listado por nombre
  const contribuyentes = useMemo(() => {
    const porIdentificacion = new Map()
    for (const c of clients) {
      const existing = porIdentificacion.get(c.identificacion)
      if (existing) {
        if (c.is_shared) {
          existing.is_shared = true
          if (!existing.owner_email && c.owner_email) existing.owner_email = c.owner_email
        }
        continue
      }
      porIdentificacion.set(c.identificacion, {
        identificacion: c.identificacion,
        nombre: c.nombre,
        is_shared: !!c.is_shared,
        owner_email: c.owner_email || '',
      })
    }
    return Array.from(porIdentificacion.values())
      .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
  }, [clients])
  const sharedCount = contribuyentes.filter((c) => c.is_shared).length
  const contribFiltrados = filtrarClientesPorTexto(contribuyentes, clientSearch)

  const verContribuyente = (ident) => {
    setFocusIdent(ident)
    selectClient(null)
    navigate('/')
  }

  const path = location.pathname
  const moduleHome = homeFor(has, hasSub)

  // ── Modelo declarativo del menú ────────────────────────────────────────────
  // Columna 1 = cada entrada; columna 2 = sus `items` (o su panel `custom`).
  const menus = useMemo(() => {
    const L = (ico, label, to, visible = true) => ({ kind: 'link', ico, label, path: to, visible })
    const defs = [
      {
        key: 'ingresos_iva', ico: '📈', rail: 'Ingresos IVA', title: 'Ingresos IVA',
        color: 'ingresos', visible: has('ingresos_ice'),
        items: [
          L('📈', 'Ingresos IVA', '/ingresos-iva', hasSub('ice_ingresos_iva')),
          { kind: 'bajador', which: 'emitidos', ico: '📥', label: 'Bajador-INGRESOS (SRI)', visible: true },
        ],
      },
      {
        key: 'ingresos_ice', ico: '🥃', rail: 'Ingresos ICE', title: 'Ingresos ICE',
        color: 'ingresos', visible: has('ingresos_ice'),
        items: [
          L('🧮', 'Cálculo previo ICE', '/calculo-ice', hasSub('ice_calculo')),
          L('📄', 'Anexo PVP+ICE', '/anexo-pvp-ice', hasSub('ice_anexo')),
          L('🥃', 'Ingresos ICE - XML', '/ice', hasSub('ice_xml')),
          L('📚', 'Catálogo de productos', '/catalogo-productos', hasSub('ice_catalogo')),
          L('⚖️', 'Rebajas y exenciones', '/rebajas-exenciones', hasSub('ice_rebajas')),
          { kind: 'title', label: 'Información útil', visible: true },
          { kind: 'external', ico: '📕', label: 'Presentación ICE', href: '/recursos/ICE-presentacion.pdf', visible: true },
          L('📊', 'Códigos ICE', '/recursos-ice'),
          L('📖', 'Normativa (LRTI y más)', '/normativa'),
        ],
      },
      {
        key: 'gastos', ico: '💸', rail: 'Gastos', title: 'Gastos',
        color: 'gastos', visible: has('gastos'),
        items: [
          L('💸', 'Gastos', '/', hasSub('gastos_facturas')),
          L('🏷️', 'Clasificador de Gastos', '/clasificador', hasSub('gastos_clasificar')),
          L('📊', 'Datos guardados', '/datos', hasSub('gastos_facturas')),
          { kind: 'bajador', which: 'gastos', ico: '📥', label: 'Bajador-GASTOS (SRI)', visible: true },
        ],
      },
      {
        key: 'retenciones', ico: '🧾', rail: 'Retenciones', title: 'Retenciones',
        color: 'retenciones', visible: has('retenciones'),
        items: [
          L('🧾', 'Retenciones', '/retenciones'),
          // Mismo marcador que Gastos: el panel pregunta si bajar gastos, retenciones o ambos.
          { kind: 'bajador', which: 'gastos', ico: '📥', label: 'Bajador-GASTOS (SRI)', visible: true },
        ],
      },
      {
        key: 'agente_ret', ico: '🧷', rail: 'Agente de retención', title: 'Agente de retención',
        color: 'retenciones', visible: has('agente_retencion'),
        items: [L('🧷', 'Retenciones efectuadas', '/retenciones-efectuadas', hasSub('agret_retenciones'))],
      },
      {
        key: 'declaraciones', ico: '📋', rail: 'Declaraciones', title: 'Declaraciones',
        color: 'declaraciones', visible: has('declaraciones'),
        items: [
          L('🧾', 'Declaración IVA', '/declaracion-iva', hasSub('decl_iva')),
          L('🧷', 'Declaración 103 (Renta)', '/declaracion-103', has('agente_retencion') && hasSub('agret_103')),
          L('🥃', 'Declaración ICE', '/declaracion-ice', hasSub('decl_ice')),
        ],
      },
      {
        key: 'pendientes', ico: '⏳', rail: 'Clientes pendientes', title: 'Clientes pendientes',
        color: 'declaraciones', visible: has('declaraciones') || has('agente_retencion'),
        autoNav: true,
        items: [L('⏳', 'Clientes pendientes', '/clientes-pendientes')],
      },
      {
        key: 'devoluciones', ico: '💰', rail: 'Devoluciones IVA', title: 'Devoluciones IVA',
        color: 'devoluciones', visible: has('declaraciones') && hasSub('decl_devoluciones'),
        items: [
          L('👵', 'Adultos mayores', '/devoluciones-iva/tercera-edad'),
          L('♿', 'Discapacidad', '/devoluciones-iva/discapacidad'),
        ],
      },
      {
        key: 'reportes', ico: '📑', rail: 'Reportes', title: 'Reportes',
        visible: true, match: (p) => p.startsWith('/reportes') || p.startsWith('/informe-general'),
        items: [
          L('🟠', 'Faltantes', '/reportes/faltantes'),
          L('✅', 'Realizados', '/reportes/realizados'),
          L('📊', 'Informe general', '/informe-general'),
        ],
      },
      {
        key: 'odoo', ico: '🧾', rail: 'Facturación Odoo', title: 'Facturación Odoo',
        visible: true, match: (p) => p.startsWith('/odoo-facturacion'),
        items: [
          L('📤', 'Emitir facturas', '/odoo-facturacion'),
          L('✅', 'Facturas procesadas', '/odoo-facturacion/procesadas'),
        ],
      },
      {
        key: 'capacitaciones', ico: '🎓', rail: 'Capacitaciones', title: 'Capacitaciones',
        visible: true, autoNav: true,
        items: [L('🎓', 'Capacitaciones', '/capacitaciones')],
      },
      {
        key: 'clientes', ico: '👤', rail: 'Clientes', title: 'Clientes',
        visible: true, custom: 'clientes',
      },
      {
        key: 'compradores', ico: '👥', rail: 'Compradores', title: 'Compradores',
        visible: has('ingresos_ice') && hasSub('ice_compradores'), autoNav: true,
        items: [L('👥', 'Compradores', '/compradores')],
      },
      {
        key: 'admin', ico: '🛠️', rail: 'Administración', title: 'Administración',
        visible: isSuperAdmin,
        items: [
          L('🛠️', 'Administración', '/admin'),
          { kind: 'link', ico: '📜', label: 'Movimientos', path: '/movimientos', visible: true, badge: movNuevos },
          L('🔐', 'Credenciales SRI', '/admin/credenciales'),
          L('🔑', 'Acceso a clientes', '/admin/acceso-clientes'),
          L('🛡️', 'Permisos', '/admin/permisos'),
          L('🏢', 'Empresas', '/admin/empresas'),
        ],
      },
      {
        // El administrador DE UNA EMPRESA (no de la plataforma) gestiona el
        // equipo de su despacho, y solo eso: se le da la entrada suelta en vez
        // del panel completo de Administración.
        key: 'empresas', ico: '🏢', rail: 'Empresas', title: 'Mi empresa',
        visible: !isSuperAdmin && role === 'admin', autoNav: true,
        items: [L('🏢', 'Empresas', '/admin/empresas')],
      },
      {
        key: 'credenciales', ico: '🔐', rail: 'Credenciales', title: 'Credenciales SRI',
        visible: !isSuperAdmin && (role === 'socio' || role === 'trabajador'), autoNav: true,
        items: [L('🔐', 'Credenciales SRI', '/admin/credenciales')],
      },
    ]
    // Agrupación de la franja: da orden y hace el menú más fácil de recorrer.
    const GRUPOS = {
      ingresos_iva: 'Ingresos', ingresos_ice: 'Ingresos',
      gastos: 'Egresos', retenciones: 'Egresos', agente_ret: 'Egresos',
      declaraciones: 'Tributario', pendientes: 'Tributario', devoluciones: 'Tributario',
      reportes: 'Gestión', odoo: 'Gestión', capacitaciones: 'Gestión',
      clientes: 'Datos', compradores: 'Datos',
      admin: 'Sistema', credenciales: 'Sistema', empresas: 'Sistema',
    }
    return defs
      .filter((m) => m.visible)
      .map((m) => ({
        ...m,
        group: GRUPOS[m.key] || '',
        items: (m.items || []).filter((i) => i.visible !== false),
      }))
  }, [has, hasSub, isSuperAdmin, role, movNuevos])

  // Módulo al que pertenece la ruta actual (para resaltar y abrir su panel).
  const activeKey = useMemo(() => {
    const m = menus.find((x) => (
      (x.items || []).some((i) => i.kind === 'link' && i.path === path) ||
      (typeof x.match === 'function' && x.match(path))
    ))
    return m?.key || null
  }, [menus, path])

  // Al navegar, el panel sigue a la ruta. Excepción: si está abierto el panel de
  // CLIENTES se mantiene, para poder seguir eligiendo contribuyentes sin que se
  // cierre al abrir uno.
  useEffect(() => {
    if (!activeKey) return
    setOpenKey((prev) => (prev === 'clientes' ? prev : activeKey))
  }, [activeKey])

  const selKey = openKey || activeKey || menus[0]?.key
  const sel = menus.find((m) => m.key === selKey) || menus[0]

  const onRailClick = (m) => {
    setOpenKey(m.key)
    if (m.autoNav) {
      const first = (m.items || []).find((i) => i.kind === 'link')
      if (first) navigate(first.path)
    }
  }

  const renderItem = (it, i) => {
    if (it.kind === 'title') return <div key={`t${i}`} className="info-title">{it.label}</div>
    if (it.kind === 'external') {
      return (
        <a key={`e${i}`} className="nav-item info-item" href={it.href} target="_blank" rel="noreferrer">
          <span className="nav-ico">{it.ico}</span><span>{it.label}</span>
        </a>
      )
    }
    if (it.kind === 'bajador') {
      // Se puede ARRASTRAR a los marcadores (el href es el script) o TOCAR para
      // abrir el panel, que además lo deja copiar y pegar en la consola del SRI.
      const refs = { gastos: setBajadorGastosHref, emitidos: setBajadorEmitidosHref }
      return (
        <a
          key={`b${i}`}
          ref={refs[it.which]}
          className="nav-item submodule bajador-item"
          draggable="true"
          title="Tocalo para copiarlo o instalarlo (también podés arrastrarlo a tus marcadores)"
          onClick={(e) => { e.preventDefault(); setBajador(it.which) }}
        >
          <span className="nav-ico">{it.ico}</span><span>{it.label}</span>
        </a>
      )
    }
    return (
      <button
        key={it.path}
        className={`nav-item submodule ${path === it.path ? 'active' : ''}`}
        onClick={() => navigate(it.path)}
      >
        <span className="nav-ico">{it.ico}</span>
        <span>{it.label}</span>
        {it.badge > 0 && <span className="mov-badge">🔔 {it.badge > 99 ? '99+' : it.badge}</span>}
      </button>
    )
  }

  // Panel de datos de Clientes (segunda columna)
  const renderClientes = () => (
    <>
      {selectedClientId && (() => {
        const cl = clients.find((c) => c.id === selectedClientId)
        return cl ? (
          <div className="sidebar-quick-nav">
            <div className="sqn-title">📌 {cl.nombre}</div>
            <div className="sqn-chips">
              {has('gastos') && hasSub('gastos_facturas') && (
                <button className="sqn-chip" onClick={() => navigate('/')}>💸 Gastos</button>
              )}
              {has('retenciones') && (
                <button className="sqn-chip" onClick={() => navigate('/retenciones')}>🧾 Retenciones</button>
              )}
              {has('agente_retencion') && hasSub('agret_retenciones') && cl.es_agente_retencion && (
                <button className="sqn-chip" onClick={() => navigate('/retenciones-efectuadas')}>🧷 Ret. efect.</button>
              )}
              {has('declaraciones') && hasSub('decl_iva') && (
                <button className="sqn-chip" onClick={() => navigate('/declaracion-iva')}>📋 Decl. IVA</button>
              )}
              {has('agente_retencion') && hasSub('agret_103') && cl.es_agente_retencion && (
                <button className="sqn-chip" onClick={() => navigate('/declaracion-103')}>🧷 Decl. 103</button>
              )}
              {has('declaraciones') && hasSub('decl_ice') && (
                <button className="sqn-chip" onClick={() => navigate('/declaracion-ice')}>🥃 Decl. ICE</button>
              )}
              {has('ingresos_ice') && hasSub('ice_calculo') && (
                <button className="sqn-chip" onClick={() => navigate('/calculo-ice')}>🧮 Cálculo ICE</button>
              )}
            </div>
          </div>
        ) : null
      })()}

      <button
        className={`nav-item level-1 ${path === '/' && !selectedClientId ? 'active' : ''}`}
        onClick={() => { selectClient(null); navigate(moduleHome) }}
      >
        <span className="nav-ico">🗄️</span><span>Base de datos</span>
      </button>

      <input
        className="client-search"
        placeholder="🔍 Buscar cliente…"
        value={clientSearch}
        onChange={(e) => setClientSearch(e.target.value)}
      />
      {contribFiltrados.length === 0 && (
        <div className="client-empty">{clients.length === 0 ? 'Sin clientes aún' : 'Sin coincidencias'}</div>
      )}
      {sharedCount > 0 && !isSuperAdmin && (
        <div className="client-shared-notice">
          🔗 {sharedCount} compartido{sharedCount !== 1 ? 's' : ''} por el administrador
        </div>
      )}
      {contribFiltrados.map((c) => (
        <button
          key={c.identificacion}
          className="nav-item client-item"
          onClick={() => verContribuyente(c.identificacion)}
          title={c.is_shared ? `${c.identificacion} — compartido por ${c.owner_email || 'administrador'}` : `${c.identificacion} — ${c.nombre}`}
        >
          <span className={`client-dot ${c.is_shared ? 'shared' : ''}`} />
          <span className="client-info">
            <span className="client-name">
              {c.nombre}
              {c.is_shared && <span className="client-shared-ico" title={`Compartido por ${c.owner_email || 'administrador'}`}> 🔗</span>}
            </span>
            <span className="client-periodo">{c.identificacion}</span>
          </span>
        </button>
      ))}
      <button className="nav-item add-client" onClick={onNewClient}>
        <span className="nav-ico">＋</span><span>Nuevo cliente</span>
      </button>
    </>
  )

  return (
    <aside className={`sidebar ${open ? 'is-open' : ''}`}>
      <div className="sidebar-brand">
        <span className="brand-icon">📑</span>
        <div>
          <div className="brand-title">Gestor Tributario</div>
          <div className="brand-sub">Gastos · Retenciones · Tributos</div>
        </div>
      </div>
      {userEmail && (
        <div className="sidebar-user-chip">
          <span className="sidebar-user-ico">👤</span>
          <span className="sidebar-user-email" title={userEmail}>{userEmail}</span>
        </div>
      )}

      {/* Dos columnas: franja de módulos + panel del módulo seleccionado */}
      <div className="sb-cols">
        <nav className="sb-rail">
          {menus.map((m, i) => (
            <Fragment key={m.key}>
              {m.group && m.group !== menus[i - 1]?.group && (
                <div className="sb-rail-group">{m.group}</div>
              )}
              <button
                className={`sb-rail-btn ${m.color || ''} ${selKey === m.key ? 'sel' : ''} ${activeKey === m.key ? 'active' : ''}`}
                onClick={() => onRailClick(m)}
                title={m.title}
              >
                <span className="sb-rail-ico">{m.ico}</span>
                <span className="sb-rail-lbl">{m.rail}</span>
                {m.key === 'admin' && movNuevos > 0 && <span className="sb-rail-dot" />}
              </button>
            </Fragment>
          ))}
        </nav>

        <div className="sb-panel">
          <div className="sb-panel-head">
            <span className="sb-panel-head-ico">{sel?.ico}</span>
            <span className="sb-panel-head-txt">{sel?.title}</span>
          </div>
          <div className="sb-panel-body">
            {sel?.custom === 'clientes' ? renderClientes() : (sel?.items || []).map(renderItem)}
          </div>
        </div>
      </div>

      <div className="sidebar-footer">
        <div className="user-email" title={userEmail}>{userEmail}</div>
        {/* Mi cuenta: datos propios y cambio de clave (disponible para todo rol) */}
        <button className="logout-link" onClick={() => navigate('/mi-cuenta')}>Mi cuenta</button>
        <button className="logout-link" onClick={onLogout}>Cerrar sesión</button>
      </div>

      {bajador && <BajadorSRI which={bajador} onClose={() => setBajador(null)} />}
    </aside>
  )
}
