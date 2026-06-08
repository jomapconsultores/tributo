import { useRef, useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useClients } from '../context/ClientContext'
import { useAccess, homeFor } from '../context/AccessContext'
import bajadorBookmarklet from '../utils/bajador-facturas.bookmarklet.txt?raw'
import './Sidebar.css'

export default function Sidebar({ onNewClient, onLogout, userEmail }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { clients, selectedClientId, selectClient, setFocusIdent } = useClients()
  const { has, isAdmin } = useAccess()
  const bajadorRef = useRef(null)
  const [clientsOpen, setClientsOpen] = useState(true)
  const [ingresosOpen, setIngresosOpen] = useState(true)
  const [gastosOpen, setGastosOpen] = useState(true)
  const [retencionesOpen, setRetencionesOpen] = useState(true)
  const [declaracionesOpen, setDeclaracionesOpen] = useState(true)
  const [devolucionesOpen, setDevolucionesOpen] = useState(true)
  const [clientSearch, setClientSearch] = useState('')

  // Contribuyentes únicos (por identificación) para el listado por nombre
  const contribuyentes = []
  const vistos = new Set()
  for (const c of clients) {
    if (vistos.has(c.identificacion)) continue
    vistos.add(c.identificacion)
    contribuyentes.push({ identificacion: c.identificacion, nombre: c.nombre })
  }
  contribuyentes.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
  const contribFiltrados = clientSearch.trim()
    ? contribuyentes.filter((c) => [c.nombre, c.identificacion].some((f) => String(f || '').toLowerCase().includes(clientSearch.toLowerCase())))
    : contribuyentes

  const verContribuyente = (ident) => {
    setFocusIdent(ident)
    selectClient(null)
    navigate('/')
  }

  // El href "javascript:" se fija por ref para que React no lo sanitice y el
  // enlace pueda arrastrarse a la barra de marcadores.
  useEffect(() => {
    if (bajadorRef.current) {
      bajadorRef.current.setAttribute('href', bajadorBookmarklet.trim())
    }
  }, [gastosOpen])

  const path = location.pathname
  const isRetenciones = path === '/retenciones'
  const isDeclIva = path === '/declaracion-iva'
  const isDeclIce = path === '/declaracion-ice'
  const isDeclaraciones = isDeclIva || isDeclIce
  const isDevTerceraEdad = path === '/devoluciones-iva/tercera-edad'
  const isDevoluciones = isDevTerceraEdad
  const isIceXml = path === '/ice'
  const isCalculo = path === '/calculo-ice'
  const isAnexo = path === '/anexo-pvp-ice'
  const isCatalogo = path === '/catalogo-productos'
  const isRebajas = path === '/rebajas-exenciones'
  const isRecursos = path === '/recursos-ice'
  const isIngresos = isIceXml || isCalculo || isAnexo || isCatalogo || isRebajas || isRecursos
  const isGastos = !isRetenciones && !isIngresos && !isDeclaraciones && !isDevoluciones // todo lo demás pertenece al proceso de Gastos
  const isDatabase = path === '/'
  const isClassifier = path === '/clasificador'
  const isSaved = path === '/datos'

  const moduleHome = isRetenciones ? '/retenciones' : isCalculo ? '/calculo-ice' : isIceXml ? '/ice' : homeFor(has)

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-icon">📑</span>
        <div>
          <div className="brand-title">Gestor SRI</div>
          <div className="brand-sub">Gastos · Retenciones · Tributos</div>
        </div>
      </div>

      <nav className="sidebar-nav">
        {/* Módulo INGRESOS+ICE (al inicio, desplegable) */}
        {has('ingresos_ice') && (<>
        <button
          className={`nav-item module-btn ingresos ${isIngresos ? 'active' : ''}`}
          onClick={() => setIngresosOpen((o) => !o)}
        >
          <span className={`caret ${ingresosOpen ? 'open' : ''}`}>▸</span>
          <span className="nav-ico">📈</span>
          <span>INGRESOS+ICE</span>
        </button>
        {ingresosOpen && (
          <div className="submodule-list">
            <button
              className={`nav-item submodule ${isCalculo ? 'active' : ''}`}
              onClick={() => navigate('/calculo-ice')}
            >
              <span className="nav-ico">🧮</span>
              <span>Cálculo ICE</span>
            </button>
            <button
              className={`nav-item submodule ${isAnexo ? 'active' : ''}`}
              onClick={() => navigate('/anexo-pvp-ice')}
            >
              <span className="nav-ico">📄</span>
              <span>Anexo PVP+ICE</span>
            </button>
            <button
              className={`nav-item submodule ${isIceXml ? 'active' : ''}`}
              onClick={() => navigate('/ice')}
            >
              <span className="nav-ico">🥃</span>
              <span>ICE - XML</span>
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
              ref={bajadorRef}
              className="nav-item submodule bajador-item"
              href="#"
              draggable="true"
              title="Arrástralo a tu barra de marcadores para instalarlo"
              onClick={(e) => {
                e.preventDefault()
                alert(
                  '📥 Bajador de facturas\n\n' +
                  'Para instalarlo: ARRÁSTRA este botón hacia la barra de marcadores (favoritos) de tu navegador.\n\n' +
                  'Luego, dentro del portal del SRI, haz clic en el marcador para detectar y descargar los XML.'
                )
              }}
            >
              <span className="nav-ico">📥</span><span>Bajador de facturas</span>
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

        <div className="nav-divider" />

        {/* Panel de administración (solo admins) */}
        {isAdmin && (<>
          <button
            className={`nav-item module-btn ${path === '/admin' ? 'active' : ''}`}
            onClick={() => navigate('/admin')}
          >
            <span className="nav-ico">🛠️</span>
            <span>ADMINISTRACIÓN</span>
          </button>
          <button
            className={`nav-item module-btn ${path === '/admin/credenciales' ? 'active' : ''}`}
            onClick={() => navigate('/admin/credenciales')}
          >
            <span className="nav-ico">🔐</span>
            <span>CREDENCIALES SRI</span>
          </button>
        </>)}

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
            {contribFiltrados.map((c) => (
              <button
                key={c.identificacion}
                className="nav-item client-item"
                onClick={() => verContribuyente(c.identificacion)}
                title={`${c.identificacion} — ${c.nombre}`}
              >
                <span className="client-dot" />
                <span className="client-info">
                  <span className="client-name">{c.nombre}</span>
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
      </nav>

      <div className="sidebar-footer">
        <div className="user-email" title={userEmail}>{userEmail}</div>
        <button className="logout-link" onClick={onLogout}>Cerrar sesión</button>
      </div>
    </aside>
  )
}
