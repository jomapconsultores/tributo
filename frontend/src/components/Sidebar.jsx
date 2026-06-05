import { useRef, useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useClients } from '../context/ClientContext'
import { periodoCorto } from '../utils/periodo'
import bajadorBookmarklet from '../utils/bajador-facturas.bookmarklet.txt?raw'
import './Sidebar.css'

export default function Sidebar({ onNewClient, onLogout, userEmail }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { clients, selectedClientId, selectClient } = useClients()
  const bajadorRef = useRef(null)
  const [clientsOpen, setClientsOpen] = useState(true)
  const [ingresosOpen, setIngresosOpen] = useState(true)

  // El href "javascript:" se fija por ref para que React no lo sanitice y el
  // enlace pueda arrastrarse a la barra de marcadores.
  useEffect(() => {
    if (bajadorRef.current) {
      bajadorRef.current.setAttribute('href', bajadorBookmarklet.trim())
    }
  }, [])

  const path = location.pathname
  const isRetenciones = path === '/retenciones'
  const isIceXml = path === '/ice'
  const isCalculo = path === '/calculo-ice'
  const isAnexo = path === '/anexo-pvp-ice'
  const isRecursos = path === '/recursos-ice'
  const isIngresos = isIceXml || isCalculo || isAnexo || isRecursos
  const isGastos = !isRetenciones && !isIngresos // todo lo demás pertenece al proceso de Gastos
  const isDatabase = path === '/'
  const isClassifier = path === '/clasificador'
  const isSaved = path === '/datos'

  const moduleHome = isRetenciones ? '/retenciones' : isCalculo ? '/calculo-ice' : isIceXml ? '/ice' : '/'

  // Al elegir un cliente, navega dentro del módulo activo
  const goToClient = (id) => {
    selectClient(id)
    navigate(isIngresos ? '/ice' : moduleHome)
  }

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

        {/* Botones remarcados de módulo */}
        <button
          className={`nav-item module-btn gastos ${isGastos ? 'active' : ''}`}
          onClick={() => navigate('/')}
        >
          <span className="nav-ico">💸</span>
          <span>GASTOS</span>
        </button>

        <button
          className={`nav-item module-btn retenciones ${isRetenciones ? 'active' : ''}`}
          onClick={() => navigate('/retenciones')}
        >
          <span className="nav-ico">🧾</span>
          <span>RETENCIONES</span>
        </button>

        <div className="nav-divider" />

        {/* Nivel 1: BASE DE DATOS */}
        <button
          className={`nav-item level-1 ${isDatabase && !selectedClientId ? 'active' : ''}`}
          onClick={() => { selectClient(null); navigate(moduleHome) }}
        >
          <span className="nav-ico">🗄️</span>
          <span>BASE DE DATOS</span>
        </button>

        {/* Clientes (desplegable) */}
        <button
          className="nav-item clients-toggle"
          onClick={() => setClientsOpen((o) => !o)}
        >
          <span className={`caret ${clientsOpen ? 'open' : ''}`}>▸</span>
          <span>Clientes</span>
          {clients.length > 0 && <span className="client-badge">{clients.length}</span>}
        </button>

        {clientsOpen && (
          <div className="client-list">
            {clients.length === 0 && (
              <div className="client-empty">Sin clientes aún</div>
            )}
            {clients.map((c) => (
              <button
                key={c.id}
                className={`nav-item client-item ${selectedClientId === c.id ? 'active' : ''}`}
                onClick={() => goToClient(c.id)}
                title={`${c.identificacion} — ${c.nombre} — ${periodoCorto(c)}`}
              >
                <span className="client-dot" />
                <span className="client-info">
                  <span className="client-name">{c.nombre}</span>
                  <span className="client-periodo">{periodoCorto(c)}</span>
                </span>
                {c.num_facturas > 0 && <span className="client-badge">{c.num_facturas}</span>}
              </button>
            ))}
            <button className="nav-item add-client" onClick={onNewClient}>
              <span className="nav-ico">＋</span>
              <span>Nuevo cliente</span>
            </button>
          </div>
        )}

        {/* Datos guardados (consolidado del proceso de Gastos) */}
        <button
          className={`nav-item level-2 ${isSaved ? 'active' : ''}`}
          onClick={() => navigate('/datos')}
        >
          <span className="nav-ico">📊</span>
          <span>Datos guardados</span>
        </button>

        <div className="nav-divider" />

        {/* Nivel 2: Clasificador */}
        <button
          className={`nav-item level-2 ${isClassifier ? 'active' : ''}`}
          onClick={() => navigate('/clasificador')}
        >
          <span className="nav-ico">🏷️</span>
          <span>Clasificador de Gastos</span>
        </button>

        {/* Nivel 2: Bajador de facturas (bookmarklet arrastrable) */}
        <a
          ref={bajadorRef}
          className="nav-item level-2 bajador-item"
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
          <span className="nav-ico">📥</span>
          <span>Bajador de facturas</span>
        </a>
      </nav>

      <div className="sidebar-footer">
        <div className="user-email" title={userEmail}>{userEmail}</div>
        <button className="logout-link" onClick={onLogout}>Cerrar sesión</button>
      </div>
    </aside>
  )
}
