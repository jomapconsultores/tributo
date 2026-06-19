import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useClients } from '../context/ClientContext'
import { useAccess, homeFor } from '../context/AccessContext'
import { actividadAPI } from '../services/api'
import bajadorBookmarklet from '../utils/bajador-facturas.bookmarklet.txt?raw'
import bajadorIngresosBookmarklet from '../utils/bajador-ingresos.bookmarklet.txt?raw'
import './Sidebar.css'

export default function Sidebar({ onNewClient, onLogout, userEmail, open = false }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { clients, selectedClientId, selectClient, setFocusIdent } = useClients()
  const { has, isAdmin, isSuperAdmin } = useAccess()
  const [clientsOpen, setClientsOpen] = useState(false)
  const [ingresosIvaOpen, setIngresosIvaOpen] = useState(false)
  const [ingresosIceOpen, setIngresosIceOpen] = useState(false)
  const [gastosOpen, setGastosOpen] = useState(false)
  const [retencionesOpen, setRetencionesOpen] = useState(false)
  const [declaracionesOpen, setDeclaracionesOpen] = useState(false)
  const [devolucionesOpen, setDevolucionesOpen] = useState(false)
  const [odooOpen, setOdooOpen] = useState(false)
  const [clientSearch, setClientSearch] = useState('')
  const [movNuevos, setMovNuevos] = useState(0)

  // Insignia de movimientos nuevos (solo admin). Se refresca al navegar y cuando
  // la página de Movimientos avisa que ya fueron vistos.
  useEffect(() => {
    if (!isSuperAdmin) return
    actividadAPI.resumen().then((r) => setMovNuevos(r.data?.nuevos || 0)).catch(() => {})
    const onVista = () => setMovNuevos(0)
    window.addEventListener('actividad-vista', onVista)
    return () => window.removeEventListener('actividad-vista', onVista)
  }, [isSuperAdmin, location.pathname])

  // Contribuyentes únicos (por identificación) para el listado por nombre
  const contribuyentes = []
  const vistos = new Set()
  for (const c of clients) {
    if (vistos.has(c.identificacion)) {
      // Si algún período es compartido, marcar el contribuyente como compartido
      const existing = contribuyentes.find((x) => x.identificacion === c.identificacion)
      if (existing && c.is_shared) {
        existing.is_shared = true
        if (!existing.owner_email && c.owner_email) existing.owner_email = c.owner_email
      }
      continue
    }
    vistos.add(c.identificacion)
    contribuyentes.push({
      identificacion: c.identificacion,
      nombre: c.nombre,
      is_shared: !!c.is_shared,
      owner_email: c.owner_email || '',
    })
  }
  contribuyentes.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
  const sharedCount = contribuyentes.filter((c) => c.is_shared).length
  const contribFiltrados = clientSearch.trim()
    ? contribuyentes.filter((c) => [c.nombre, c.identificacion].some((f) => String(f || '').toLowerCase().includes(clientSearch.toLowerCase())))
    : contribuyentes

  const verContribuyente = (ident) => {
    setFocusIdent(ident)
    selectClient(null)
    navigate('/')
  }

  // El href "javascript:" se fija con un callback ref que se reaplica en CADA
  // render (React sanitiza/ restaura un href en el JSX, por eso no se pone ahí).
  // Asi el marcador siempre guarda el bookmarklet y no la URL de la pagina.
  const setBajadorHref = (el) => {
    if (el) el.setAttribute('href', bajadorBookmarklet.trim())
  }
  const setBajadorIngresosHref = (el) => {
    if (el) el.setAttribute('href', bajadorIngresosBookmarklet.trim())
  }

  const path = location.pathname
  const isRetenciones = path === '/retenciones'
  const isDeclIva = path === '/declaracion-iva'
  const isDeclIce = path === '/declaracion-ice'
  const isDeclaraciones = isDeclIva || isDeclIce
  const isDevTerceraEdad = path === '/devoluciones-iva/tercera-edad'
  const isDevoluciones = isDevTerceraEdad
  const isIceXml = path === '/ice'
  const isCalculo = path === '/calculo-ice'
  const isIngresosIva = path === '/ingresos-iva'
  const isAnexo = path === '/anexo-pvp-ice'
  const isCatalogo = path === '/catalogo-productos'
  const isRebajas = path === '/rebajas-exenciones'
  const isNormativa = path === '/normativa'
  const isRecursos = path === '/recursos-ice'
  const isCompradores = path === '/compradores'
  const isReportes = path === '/reportes'
  const isInIngresosIvaMenu = isIngresosIva
  const isInIngresosIceMenu = isIceXml || isCalculo || isAnexo || isCatalogo || isRebajas || isRecursos || isCompradores || isNormativa
  const isIngresos = isInIngresosIvaMenu || isInIngresosIceMenu
  const isGastos = !isRetenciones && !isIngresos && !isDeclaraciones && !isDevoluciones // todo lo demás pertenece al proceso de Gastos
  const isDatabase = path === '/'
  const isClassifier = path === '/clasificador'
  const isSaved = path === '/datos'

  const moduleHome = isRetenciones ? '/retenciones' : isCalculo ? '/calculo-ice' : isIceXml ? '/ice' : homeFor(has)

  return (
    <aside className={`sidebar ${open ? 'is-open' : ''}`}>
      <div className="sidebar-brand">
        <span className="brand-icon">📑</span>
        <div>
          <div className="brand-title">Gestor SRI</div>
          <div className="brand-sub">Gastos · Retenciones · Tributos</div>
        </div>
      </div>
      {userEmail && (
        <div className="sidebar-user-chip">
          <span className="sidebar-user-ico">👤</span>
          <span className="sidebar-user-email" title={userEmail}>{userEmail}</span>
        </div>
      )}

      <nav className="sidebar-nav">
        {/* Módulo INGRESOS IVA (desplegable, solo IVA) */}
        {has('ingresos_ice') && (<>
        <button
          className={`nav-item module-btn ingresos ${isInIngresosIvaMenu ? 'active' : ''}`}
          onClick={() => setIngresosIvaOpen((o) => !o)}
        >
          <span className={`caret ${ingresosIvaOpen ? 'open' : ''}`}>▸</span>
          <span className="nav-ico">📈</span>
          <span>INGRESOS IVA</span>
        </button>
        {ingresosIvaOpen && (
          <div className="submodule-list">
            <button
              className={`nav-item submodule ${isIngresosIva ? 'active' : ''}`}
              onClick={() => navigate('/ingresos-iva')}
            >
              <span className="nav-ico">📈</span>
              <span>Ingresos IVA</span>
            </button>
            <a
              ref={setBajadorIngresosHref}
              className="nav-item submodule bajador-item"
              draggable="true"
              title="Arrástralo a tu barra de marcadores para instalarlo"
              onClick={(e) => {
                e.preventDefault()
                alert(
                  '📥 Bajador-INGRESOS\n\n' +
                  'Para instalarlo: ARRÁSTRA este botón a la barra de marcadores (favoritos).\n\n' +
                  'IMPORTANTE: úsalo en la CONSULTA de "Comprobantes electrónicos EMITIDOS"\n' +
                  '(SRI en línea → Facturación Electrónica → Consultas → Emitidos), donde los XML\n' +
                  'se bajan con íconos. Ahí pon Fecha inicio/fin, Consultar y toca el marcador.\n\n' +
                  'En el FACTURADOR (pantalla de emisión) el SRI bloquea la descarga automática del XML.'
                )
              }}
            >
              <span className="nav-ico">📥</span><span>Bajador-INGRESOS</span>
            </a>
          </div>
        )}

        {/* Módulo INGRESOS ICE (desplegable, todo lo de ICE) */}
        <button
          className={`nav-item module-btn ingresos ${isInIngresosIceMenu ? 'active' : ''}`}
          onClick={() => setIngresosIceOpen((o) => !o)}
        >
          <span className={`caret ${ingresosIceOpen ? 'open' : ''}`}>▸</span>
          <span className="nav-ico">🥃</span>
          <span>INGRESOS ICE</span>
        </button>
        {ingresosIceOpen && (
          <div className="submodule-list">
            <button
              className={`nav-item submodule ${isCalculo ? 'active' : ''}`}
              onClick={() => navigate('/calculo-ice')}
            >
              <span className="nav-ico">🧮</span>
              <span>Cálculo ICE</span>
            </button>
            <button
              className={`nav-item submodule ${isIceXml ? 'active' : ''}`}
              onClick={() => navigate('/ice')}
            >
              <span className="nav-ico">🥃</span>
              <span>ICE - XML</span>
            </button>
            <button
              className={`nav-item submodule ${isAnexo ? 'active' : ''}`}
              onClick={() => navigate('/anexo-pvp-ice')}
            >
              <span className="nav-ico">📄</span>
              <span>Anexo PVP+ICE</span>
            </button>
            <button
              className={`nav-item submodule ${isCatalogo ? 'active' : ''}`}
              onClick={() => navigate('/catalogo-productos')}
            >
              <span className="nav-ico">📚</span>
              <span>Catálogo de productos</span>
            </button>
            <button
              className={`nav-item submodule ${isRebajas ? 'active' : ''}`}
              onClick={() => navigate('/rebajas-exenciones')}
            >
              <span className="nav-ico">⚖️</span>
              <span>Rebajas y exenciones</span>
            </button>

            {/* Información útil (menú pequeño) */}
            <div className="info-title">Información útil</div>
            <a
              className="nav-item info-item"
              href="/recursos/ICE-presentacion.pdf"
              target="_blank"
              rel="noreferrer"
            >
              <span className="nav-ico">📕</span>
              <span>Presentación ICE</span>
            </a>
            <button
              className={`nav-item info-item ${isRecursos ? 'active' : ''}`}
              onClick={() => navigate('/recursos-ice')}
            >
              <span className="nav-ico">📊</span>
              <span>Códigos ICE</span>
            </button>
            <button
              className={`nav-item info-item ${isNormativa ? 'active' : ''}`}
              onClick={() => navigate('/normativa')}
            >
              <span className="nav-ico">📖</span>
              <span>Normativa (LRTI y más)</span>
            </button>
          </div>
        )}
        </>)}

        {/* Módulo GASTOS (desplegable) */}
        {has('gastos') && (<>
        <button
          className={`nav-item module-btn gastos ${isGastos ? 'active' : ''}`}
          onClick={() => setGastosOpen((o) => !o)}
        >
          <span className={`caret ${gastosOpen ? 'open' : ''}`}>▸</span>
          <span className="nav-ico">💸</span>
          <span>GASTOS</span>
        </button>
        {gastosOpen && (
          <div className="submodule-list">
            <button className={`nav-item submodule ${isDatabase ? 'active' : ''}`} onClick={() => navigate('/')}>
              <span className="nav-ico">💸</span><span>Gastos</span>
            </button>
            <button className={`nav-item submodule ${isClassifier ? 'active' : ''}`} onClick={() => navigate('/clasificador')}>
              <span className="nav-ico">🏷️</span><span>Clasificador de Gastos</span>
            </button>
            <button className={`nav-item submodule ${isSaved ? 'active' : ''}`} onClick={() => navigate('/datos')}>
              <span className="nav-ico">📊</span><span>Datos guardados</span>
            </button>
            <a
              ref={setBajadorHref}
              className="nav-item submodule bajador-item"
              draggable="true"
              title="Arrástralo a tu barra de marcadores para instalarlo"
              onClick={(e) => {
                e.preventDefault()
                alert(
                  '📥 Bajador-GASTOS\n\n' +
                  'Para instalarlo: ARRÁSTRA este botón hacia la barra de marcadores (favoritos) de tu navegador.\n\n' +
                  'Sirve en el portal SRI de comprobantes RECIBIDOS: descarga TODOS los XML (todas las páginas).'
                )
              }}
            >
              <span className="nav-ico">📥</span><span>Bajador-GASTOS</span>
            </a>
          </div>
        )}
        </>)}

        {/* Módulo RETENCIONES (desplegable) */}
        {has('retenciones') && (<>
        <button
          className={`nav-item module-btn retenciones ${isRetenciones ? 'active' : ''}`}
          onClick={() => setRetencionesOpen((o) => !o)}
        >
          <span className={`caret ${retencionesOpen ? 'open' : ''}`}>▸</span>
          <span className="nav-ico">🧾</span>
          <span>RETENCIONES</span>
        </button>
        {retencionesOpen && (
          <div className="submodule-list">
            <button className={`nav-item submodule ${isRetenciones ? 'active' : ''}`} onClick={() => navigate('/retenciones')}>
              <span className="nav-ico">🧾</span><span>Retenciones</span>
            </button>
          </div>
        )}
        </>)}

        {/* Módulo DECLARACIONES (desplegable) */}
        {has('declaraciones') && (<>
        <button
          className={`nav-item module-btn declaraciones ${isDeclaraciones ? 'active' : ''}`}
          onClick={() => setDeclaracionesOpen((o) => !o)}
        >
          <span className={`caret ${declaracionesOpen ? 'open' : ''}`}>▸</span>
          <span className="nav-ico">📋</span>
          <span>DECLARACIONES</span>
        </button>
        {declaracionesOpen && (
          <div className="submodule-list">
            <button className={`nav-item submodule ${isDeclIce ? 'active' : ''}`} onClick={() => navigate('/declaracion-ice')}>
              <span className="nav-ico">🥃</span><span>Declaración ICE</span>
            </button>
            <button className={`nav-item submodule ${isDeclIva ? 'active' : ''}`} onClick={() => navigate('/declaracion-iva')}>
              <span className="nav-ico">🧾</span><span>Declaración IVA</span>
            </button>
          </div>
        )}
        </>)}

        {/* Módulo DEVOLUCIONES IVA (desplegable) */}
        {has('declaraciones') && (<>
        <button
          className={`nav-item module-btn devoluciones ${isDevoluciones ? 'active' : ''}`}
          onClick={() => setDevolucionesOpen((o) => !o)}
        >
          <span className={`caret ${devolucionesOpen ? 'open' : ''}`}>▸</span>
          <span className="nav-ico">💰</span>
          <span>DEVOLUCIONES IVA</span>
        </button>
        {devolucionesOpen && (
          <div className="submodule-list">
            <button className={`nav-item submodule ${isDevTerceraEdad ? 'active' : ''}`} onClick={() => navigate('/devoluciones-iva/tercera-edad')}>
              <span className="nav-ico">👵</span><span>Adultos mayores</span>
            </button>
          </div>
        )}
        </>)}

        {/* REPORTES: honorarios a cobrar por contribuyente y producto */}
        <button
          className={`nav-item module-btn ${isReportes ? 'active' : ''}`}
          onClick={() => navigate('/reportes')}
        >
          <span className="nav-ico">📑</span>
          <span>REPORTES</span>
        </button>

        {/* CAPACITACIONES: reservar capacitación; socio/admin autoriza */}
        <button
          className={`nav-item module-btn ${path === '/capacitaciones' ? 'active' : ''}`}
          onClick={() => navigate('/capacitaciones')}
        >
          <span className="nav-ico">🎓</span>
          <span>CAPACITACIONES</span>
        </button>

        {/* FACTURACIÓN ODOO (desplegable): emitir y ver facturas procesadas */}
        <button
          className={`nav-item module-btn ${path.startsWith('/odoo-facturacion') ? 'active' : ''}`}
          onClick={() => setOdooOpen((o) => !o)}
        >
          <span className={`caret ${odooOpen ? 'open' : ''}`}>▸</span>
          <span className="nav-ico">🧾</span>
          <span>FACTURACIÓN ODOO</span>
        </button>
        {odooOpen && (
          <div className="submodule-list">
            <button className={`nav-item submodule ${path === '/odoo-facturacion' ? 'active' : ''}`} onClick={() => navigate('/odoo-facturacion')}>
              <span className="nav-ico">📤</span><span>Emitir facturas</span>
            </button>
            <button className={`nav-item submodule ${path === '/odoo-facturacion/procesadas' ? 'active' : ''}`} onClick={() => navigate('/odoo-facturacion/procesadas')}>
              <span className="nav-ico">✅</span><span>Facturas procesadas</span>
            </button>
          </div>
        )}

        <div className="nav-divider" />

        {/* Panel de administración (solo administrador principal) */}
        {isSuperAdmin && (<>
          <button
            className={`nav-item module-btn ${path === '/admin' ? 'active' : ''}`}
            onClick={() => navigate('/admin')}
          >
            <span className="nav-ico">🛠️</span>
            <span>ADMINISTRACIÓN</span>
          </button>
          <button
            className={`nav-item module-btn ${path === '/movimientos' ? 'active' : ''}`}
            onClick={() => navigate('/movimientos')}
          >
            <span className="nav-ico">📜</span>
            <span>MOVIMIENTOS</span>
            {movNuevos > 0 && <span className="mov-badge">🔔 {movNuevos > 99 ? '99+' : movNuevos}</span>}
          </button>
          <button
            className={`nav-item module-btn ${path === '/admin/credenciales' ? 'active' : ''}`}
            onClick={() => navigate('/admin/credenciales')}
          >
            <span className="nav-ico">🔐</span>
            <span>CREDENCIALES SRI</span>
          </button>
          <button
            className={`nav-item module-btn ${path === '/admin/acceso-clientes' ? 'active' : ''}`}
            onClick={() => navigate('/admin/acceso-clientes')}
          >
            <span className="nav-ico">🔑</span>
            <span>ACCESO A CLIENTES</span>
          </button>
          <button
            className={`nav-item module-btn ${path === '/admin/permisos' ? 'active' : ''}`}
            onClick={() => navigate('/admin/permisos')}
          >
            <span className="nav-ico">🛡️</span>
            <span>PERMISOS</span>
          </button>
        </>)}

        {/* Acceso rápido a módulos cuando hay un cliente seleccionado */}
        {selectedClientId && (() => {
          const cl = clients.find((c) => c.id === selectedClientId)
          return cl ? (
            <div className="sidebar-quick-nav">
              <div className="sqn-title">📌 {cl.nombre}</div>
              <div className="sqn-chips">
                {has('gastos') && (
                  <button className={`sqn-chip ${isGastos ? 'active' : ''}`} onClick={() => navigate('/')}>💸 Gastos</button>
                )}
                {has('retenciones') && (
                  <button className={`sqn-chip ${isRetenciones ? 'active' : ''}`} onClick={() => navigate('/retenciones')}>🧾 Retenciones</button>
                )}
                {has('declaraciones') && (
                  <button className={`sqn-chip ${isDeclIva ? 'active' : ''}`} onClick={() => navigate('/declaracion-iva')}>📋 Decl. IVA</button>
                )}
                {has('declaraciones') && (
                  <button className={`sqn-chip ${isDeclIce ? 'active' : ''}`} onClick={() => navigate('/declaracion-ice')}>🥃 Decl. ICE</button>
                )}
                {has('ingresos_ice') && (
                  <button className={`sqn-chip ${isCalculo ? 'active' : ''}`} onClick={() => navigate('/calculo-ice')}>🧮 Cálculo ICE</button>
                )}
              </div>
            </div>
          ) : null
        })()}

        {/* Nivel 1: BASE DE DATOS */}
        <button
          className={`nav-item level-1 ${isDatabase && !selectedClientId ? 'active' : ''}`}
          onClick={() => { selectClient(null); navigate(moduleHome) }}
        >
          <span className="nav-ico">🗄️</span>
          <span>BASE DE DATOS</span>
        </button>

        {/* Clientes (desplegable, por nombre, con buscador) */}
        <button
          className="nav-item clients-toggle"
          onClick={() => setClientsOpen((o) => !o)}
        >
          <span className={`caret ${clientsOpen ? 'open' : ''}`}>▸</span>
          <span>Clientes</span>
          {contribuyentes.length > 0 && <span className="client-badge">{contribuyentes.length}</span>}
        </button>

        {clientsOpen && (
          <div className="client-list">
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
              <span className="nav-ico">＋</span>
              <span>Nuevo cliente</span>
            </button>
          </div>
        )}

        {/* Compradores: clientes importados de las facturas de ventas */}
        {has('ingresos_ice') && (
          <button
            className={`nav-item clients-toggle ${isCompradores ? 'active' : ''}`}
            onClick={() => navigate('/compradores')}
          >
            <span className="nav-ico">👥</span>
            <span>Compradores</span>
          </button>
        )}
      </nav>

      <div className="sidebar-footer">
        <div className="user-email" title={userEmail}>{userEmail}</div>
        <button className="logout-link" onClick={onLogout}>Cerrar sesión</button>
      </div>
    </aside>
  )
}
