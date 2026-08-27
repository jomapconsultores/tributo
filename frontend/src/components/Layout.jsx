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

// Aviso de cobro. Lo ve todo el mundo MENOS el administrador de la plataforma:
// antes se le escondía a cualquier admin o socio, y con multiempresa eso deja
// sin aviso justo a quien tiene que pagar —el contribuyente que se independizó
// es administrador de SU empresa—. Quien vende el producto no se cobra a sí mismo.
function SubBanner() {
  const { isPlatformAdmin, subscription, org } = useAccess()
  if (isPlatformAdmin || !subscription || !subscription.estado) return null
  const dias = diasHasta(subscription.proximo_pago)
  const de = org?.nombre ? <> de <strong>{org.nombre}</strong></> : ''
  if (subscription.estado === 'suspendido') {
    return <div className="sub-banner danger">La suscripción{de} está <strong>suspendida</strong>. Contacta al administrador para reactivarla.</div>
  }
  if (subscription.vencida) {
    return <div className="sub-banner danger">La suscripción{de} <strong>venció</strong> el {subscription.proximo_pago}. Hay que pagar para recuperar el acceso.</div>
  }
  if (subscription.estado === 'prueba' && dias !== null) {
    return (
      <div className="sub-banner warn">
        Prueba gratuita{de}: quedan <strong>{dias} día(s)</strong> (hasta el {subscription.proximo_pago}).
        Después habrá que pagar
        {subscription.precio_mensual ? <> <strong>${Number(subscription.precio_mensual).toFixed(2)} + IVA</strong> al mes</> : ''} para seguir entrando.
      </div>
    )
  }
  // Tres días, los mismos que espera el correo de aviso (DIAS_AVISO_RENOVACION
  // en el backend): al cliente se le avisa por las dos vías a la vez, y que una
  // dijera cinco días y la otra tres solo servía para confundir.
  if (dias !== null && dias <= 3) {
    return (
      <div className="sub-banner warn">
        El próximo pago{de} vence en <strong>{dias} día(s)</strong> ({subscription.proximo_pago})
        {subscription.precio_mensual
          ? <>: <strong>${Number(subscription.precio_mensual).toFixed(2)}{subscription.iva_incluido ? ' (IVA incluido)' : ' + IVA'}</strong></>
          : ''}.
      </div>
    )
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
  const { isSuperAdmin, role, puedeCrearContribuyente } = useAccess()
  const verClaves = isSuperAdmin || ['admin', 'socio', 'trabajador'].includes(role)

  // null cuando no puede: los botones de alta se apagan solos con eso, en el
  // menú, en el selector de contribuyente y en la pantalla de elección.
  const openNewClient = puedeCrearContribuyente ? () => setModalOpen(true) : null

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
      {puedeCrearContribuyente && (
        <NewClientModal open={modalOpen} onClose={() => setModalOpen(false)} />
      )}
      <CobrosPendientesModal />
    </div>
  )
}
