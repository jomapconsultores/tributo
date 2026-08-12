/* ------------------------------------------------------------
 * Desarrollado por Marco Antonio Posligua San Martín
 * ------------------------------------------------------------ */
import { useState, useEffect } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import NewClientModal from './NewClientModal'
import AlertaDeclaracion from './AlertaDeclaracion'
import AvisoAperturaVencido from './AvisoAperturaVencido'
import RecordatorioAplazados from './RecordatorioAplazados'
import CobrosPendientesModal from './CobrosPendientesModal'
import RoleSwitcher from './RoleSwitcher'
import OrgSwitcher from './OrgSwitcher'
import AbrirSistemaMAP from './AbrirSistemaMAP'
import { useAccess } from '../context/AccessContext'
import './Layout.css'

function diasHasta(fecha) {
  if (!fecha) return null
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0)
  const d = new Date(fecha + 'T00:00:00')
  return Math.round((d - hoy) / 86400000)
}

function SubBanner() {
  const { isAdmin, subscription } = useAccess()
  if (isAdmin || !subscription || !subscription.estado) return null
  const dias = diasHasta(subscription.proximo_pago)
  if (subscription.estado === 'suspendido') {
    return <div className="sub-banner danger">Tu suscripción está <strong>suspendida</strong>. Contacta al administrador para reactivarla.</div>
  }
  if (subscription.vencida) {
    return <div className="sub-banner danger">Tu suscripción <strong>venció</strong> el {subscription.proximo_pago}. Regulariza el pago para recuperar el acceso.</div>
  }
  if (dias !== null && dias <= 5) {
    return <div className="sub-banner warn">Tu próximo pago vence en <strong>{dias} día(s)</strong> ({subscription.proximo_pago}).</div>
  }
  return null
}

export default function Layout({ user, onLogout }) {
  const [modalOpen, setModalOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const location = useLocation()
  // Acceso directo a las claves del SRI desde cualquier pantalla: es lo primero
  // que se necesita para entrar a declarar, y buscarlo en el menú cada vez era
  // el paso de más. Mismo alcance que la pantalla: el equipo del despacho.
  const { isSuperAdmin, role } = useAccess()
  const verClaves = isSuperAdmin || ['admin', 'socio', 'trabajador'].includes(role)

  const openNewClient = () => setModalOpen(true)

  // En móvil, al navegar se cierra el menú deslizable.
  useEffect(() => { setSidebarOpen(false) }, [location.pathname])

  return (
    <div className={`layout ${sidebarOpen ? 'sidebar-open' : ''}`}>
      {/* Barra superior solo en móvil: botón de menú */}
      <header className="layout-topbar">
        <button className="topbar-burger" onClick={() => setSidebarOpen((o) => !o)} aria-label="Menú">☰</button>
        <span className="topbar-title">📑 Gestor Tributario</span>
        {user?.email && verClaves && (
          <Link to="/admin/credenciales" className="topbar-claves" title="Claves del portal del SRI">🔐</Link>
        )}
        {user?.email && <span className="topbar-user">👤 {user.email}</span>}
        {user?.email && <RoleSwitcher />}
      </header>

      <div className="layout-overlay" onClick={() => setSidebarOpen(false)} />

      <Sidebar open={sidebarOpen} onNewClient={openNewClient} onLogout={onLogout} userEmail={user?.email} />
      <main className="layout-content">
        {user?.email && (
          <div className="user-topbar">
            <span className="user-topbar-ico">👤</span>
            <span className="user-topbar-email">{user.email}</span>
            {verClaves && (
              <Link to="/admin/credenciales" className="user-topbar-claves"
                title="Claves del portal del SRI">🔐 Claves SRI</Link>
            )}
            <RoleSwitcher />
            {/* Va DESPUÉS del selector de rol a propósito: .role-switcher lleva
                margin-left:auto y es quien empuja el grupo a la derecha. */}
            <OrgSwitcher />
            <AbrirSistemaMAP />
          </div>
        )}
        <SubBanner />
        <AvisoAperturaVencido />
        <AlertaDeclaracion />
        <RecordatorioAplazados />
        <Outlet context={{ openNewClient }} />
        <footer className="layout-credit">
          Desarrollado por Marco Antonio Posligua San Martín
        </footer>
      </main>
      <NewClientModal open={modalOpen} onClose={() => setModalOpen(false)} />
      <CobrosPendientesModal />
    </div>
  )
}
