import { useRef, useEffect } from 'react'
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

  // El href "javascript:" se fija por ref para que React no lo sanitice y el
  // enlace pueda arrastrarse a la barra de marcadores.
  useEffect(() => {
    if (bajadorRef.current) {
      bajadorRef.current.setAttribute('href', bajadorBookmarklet.trim())
    }
  }, [])

  const isDatabase = location.pathname === '/'
  const isClassifier = location.pathname === '/clasificador'
  const isSaved = location.pathname === '/datos'

  const goToClient = (id) => {
    selectClient(id)
    navigate('/')
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-icon">📑</span>
        <div>
          <div className="brand-title">Gestor SRI</div>
          <div className="brand-sub">Gastos · Tributos</div>
        </div>
      </div>

      <nav className="sidebar-nav">
        {/* Botón superior: recuperar datos guardados */}
        <button
          className={`nav-item saved-data ${isSaved ? 'active' : ''}`}
          onClick={() => navigate('/datos')}
        >
          <span className="nav-ico">📊</span>
          <span>Datos guardados</span>
        </button>

        {/* Nivel 1: BASE DE DATOS */}
        <button
          className={`nav-item level-1 ${isDatabase && !selectedClientId ? 'active' : ''}`}
          onClick={() => { selectClient(null); navigate('/') }}
        >
          <span className="nav-ico">🗄️</span>
          <span>Base de Datos</span>
        </button>

        {/* Sub-nivel: clientes */}
        <div className="client-list">
          {clients.length === 0 && (
            <div className="client-empty">Sin clientes aún</div>
          )}
          {clients.map((c) => (
            <button
              key={c.id}
              className={`nav-item client-item ${isDatabase && selectedClientId === c.id ? 'active' : ''}`}
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

        <div className="nav-divider" />

        {/* Nivel 2 (menor jerarquía): Clasificador */}
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
