import { useState, useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import NewClientModal from './NewClientModal'
import AlertaDeclaracion from './AlertaDeclaracion'
import { useAccess } from '../context/AccessContext'
import { accessAPI } from '../services/api'
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

  const openNewClient = () => setModalOpen(true)

  // En móvil, al navegar se cierra el menú deslizable.
  useEffect(() => { setSidebarOpen(false) }, [location.pathname])

  // Keep-alive: ping cada 9 min para que Render free no duerma el backend
  useEffect(() => {
    const id = setInterval(() => { accessAPI.me().catch(() => {}) }, 9 * 60 * 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className={`layout ${sidebarOpen ? 'sidebar-open' : ''}`}>
      {/* Barra superior solo en móvil: botón de menú */}
      <header className="layout-topbar">
        <button className="topbar-burger" onClick={() => setSidebarOpen((o) => !o)} aria-label="Menú">☰</button>
        <span className="topbar-title">📑 Gestor SRI</span>
        {user?.email && <span className="topbar-user">👤 {user.email}</span>}
      </header>

      <div className="layout-overlay" onClick={() => setSidebarOpen(false)} />

      <Sidebar open={sidebarOpen} onNewClient={openNewClient} onLogout={onLogout} userEmail={user?.email} />
      <main className="layout-content">
        <SubBanner />
        <AlertaDeclaracion />
        <Outlet context={{ openNewClient }} />
      </main>
      <NewClientModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  )
}
