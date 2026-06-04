import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import NewClientModal from './NewClientModal'
import './Layout.css'

export default function Layout({ user, onLogout }) {
  const [modalOpen, setModalOpen] = useState(false)

  const openNewClient = () => setModalOpen(true)

  return (
    <div className="layout">
      <Sidebar onNewClient={openNewClient} onLogout={onLogout} userEmail={user?.email} />
      <main className="layout-content">
        <Outlet context={{ openNewClient }} />
      </main>
      <NewClientModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  )
}
