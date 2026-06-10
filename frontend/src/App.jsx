import { useState, useEffect } from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import Login from './pages/Login'
import Landing from './pages/Landing'
import ResetPassword from './pages/ResetPassword'
import Database from './pages/Database'
import Classifier from './pages/Classifier'
import SavedData from './pages/SavedData'
import Retenciones from './pages/Retenciones'
import ICE from './pages/ICE'
import CalculoICE from './pages/CalculoICE'
import AnexoPVPICE from './pages/AnexoPVPICE'
import IngresosIva from './pages/IngresosIva'
import RecursosICE from './pages/RecursosICE'
import Declaraciones from './pages/Declaraciones'
import DevolucionesIvaTerceraEdad from './pages/DevolucionesIvaTerceraEdad'
import CatalogoProductos from './pages/CatalogoProductos'
import Compradores from './pages/Compradores'
import RebajasExenciones from './pages/RebajasExenciones'
import Admin from './pages/Admin'
import AdminCredentials from './pages/AdminCredentials'
import Layout from './components/Layout'
import { ClientProvider } from './context/ClientContext'
import { AccessProvider, useAccess, homeFor } from './context/AccessContext'
import './App.css'

// Bloquea una ruta si el usuario no tiene el módulo contratado
function RequireModule({ modulo, children }) {
  const { has, loading } = useAccess()
  if (loading) return <div className="loading">Cargando…</div>
  if (!has(modulo)) return <Navigate to={homeFor(has)} replace />
  return children
}

function SinAcceso() {
  return (
    <div style={{ padding: 40, textAlign: 'center', color: '#475569' }}>
      <h2>Sin módulos contratados</h2>
      <p>Tu cuenta aún no tiene módulos habilitados. Contacta al administrador para activar tu plan.</p>
    </div>
  )
}

function HomeRedirect() {
  const { has, loading } = useAccess()
  if (loading) return <div className="loading">Cargando…</div>
  return <Navigate to={homeFor(has)} replace />
}

function RequireAdmin({ children }) {
  const { isAdmin, loading, has } = useAccess()
  if (loading) return <div className="loading">Cargando…</div>
  if (!isAdmin) return <Navigate to={homeFor(has)} replace />
  return children
}

function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = localStorage.getItem('token')
    const userId = localStorage.getItem('userId')
    const email = localStorage.getItem('email')
    if (token && userId) {
      setUser({ token, userId, email })
    }
    setLoading(false)
  }, [])

  const handleLogin = (token, userId, email) => {
    localStorage.setItem('token', token)
    localStorage.setItem('userId', userId)
    localStorage.setItem('email', email)
    setUser({ token, userId, email })
  }

  const handleLogout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('userId')
    localStorage.removeItem('email')
    localStorage.removeItem('selectedClientId')
    setUser(null)
  }

  if (loading) {
    return <div className="loading">Cargando...</div>
  }

  return (
    <Router>
      <Routes>
        <Route
          path="/login"
          element={user ? <Navigate to="/" /> : <Login onLogin={handleLogin} />}
        />
        <Route path="/reset-password" element={<ResetPassword />} />
        {!user && <Route path="/" element={<Landing />} />}
        {user ? (
          <Route
            element={
              <AccessProvider>
                <ClientProvider>
                  <Layout user={user} onLogout={handleLogout} />
                </ClientProvider>
              </AccessProvider>
            }
          >
            <Route path="/" element={<RequireModule modulo="gastos"><Database /></RequireModule>} />
            <Route path="/clasificador" element={<RequireModule modulo="gastos"><Classifier /></RequireModule>} />
            <Route path="/datos" element={<RequireModule modulo="gastos"><SavedData /></RequireModule>} />
            <Route path="/retenciones" element={<RequireModule modulo="retenciones"><Retenciones /></RequireModule>} />
            <Route path="/declaracion-iva" element={<RequireModule modulo="declaraciones"><Declaraciones tipo="IVA" /></RequireModule>} />
            <Route path="/declaracion-ice" element={<RequireModule modulo="declaraciones"><Declaraciones tipo="ICE" /></RequireModule>} />
            <Route path="/devoluciones-iva/tercera-edad" element={<RequireModule modulo="declaraciones"><DevolucionesIvaTerceraEdad /></RequireModule>} />
            <Route path="/ingresos-iva" element={<RequireModule modulo="ingresos_ice"><IngresosIva /></RequireModule>} />
            <Route path="/calculo-ice" element={<RequireModule modulo="ingresos_ice"><CalculoICE /></RequireModule>} />
            <Route path="/anexo-pvp-ice" element={<RequireModule modulo="ingresos_ice"><AnexoPVPICE /></RequireModule>} />
            <Route path="/recursos-ice" element={<RequireModule modulo="ingresos_ice"><RecursosICE /></RequireModule>} />
            <Route path="/ice" element={<RequireModule modulo="ingresos_ice"><ICE /></RequireModule>} />
            <Route path="/catalogo-productos" element={<RequireModule modulo="ingresos_ice"><CatalogoProductos /></RequireModule>} />
            <Route path="/compradores" element={<RequireModule modulo="ingresos_ice"><Compradores /></RequireModule>} />
            <Route path="/rebajas-exenciones" element={<RequireModule modulo="ingresos_ice"><RebajasExenciones /></RequireModule>} />
            <Route path="/admin" element={<RequireAdmin><Admin /></RequireAdmin>} />
            <Route path="/admin/credenciales" element={<RequireAdmin><AdminCredentials /></RequireAdmin>} />
            <Route path="/sin-acceso" element={<SinAcceso />} />
            <Route path="*" element={<HomeRedirect />} />
          </Route>
        ) : (
          <Route path="*" element={<Navigate to="/" />} />
        )}
      </Routes>
    </Router>
  )
}

export default App
