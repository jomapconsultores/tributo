import { useState, useEffect, lazy, Suspense } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import { AccessProvider, useAccess, homeFor } from './context/AccessContext'
import { ClientProvider } from './context/ClientContext'
import Layout from './components/Layout'
import './App.css'

// Lazy-load every page: first load only downloads the current route's chunk
const Login                    = lazy(() => import('./pages/Login'))
const Landing                  = lazy(() => import('./pages/Landing'))
const ResetPassword            = lazy(() => import('./pages/ResetPassword'))
const Database                 = lazy(() => import('./pages/Database'))
const Classifier               = lazy(() => import('./pages/Classifier'))
const SavedData                = lazy(() => import('./pages/SavedData'))
const Retenciones              = lazy(() => import('./pages/Retenciones'))
const ICE                      = lazy(() => import('./pages/ICE'))
const CalculoICE               = lazy(() => import('./pages/CalculoICE'))
const AnexoPVPICE              = lazy(() => import('./pages/AnexoPVPICE'))
const IngresosIva              = lazy(() => import('./pages/IngresosIva'))
const RecursosICE              = lazy(() => import('./pages/RecursosICE'))
const Declaraciones            = lazy(() => import('./pages/Declaraciones'))
const DevolucionesIvaTerceraEdad = lazy(() => import('./pages/DevolucionesIvaTerceraEdad'))
const CatalogoProductos        = lazy(() => import('./pages/CatalogoProductos'))
const Compradores              = lazy(() => import('./pages/Compradores'))
const RebajasExenciones        = lazy(() => import('./pages/RebajasExenciones'))
const Normativa                = lazy(() => import('./pages/Normativa'))
const Reportes                 = lazy(() => import('./pages/Reportes'))
const Capacitaciones           = lazy(() => import('./pages/Capacitaciones'))
const Admin                    = lazy(() => import('./pages/Admin'))
const AdminCredentials         = lazy(() => import('./pages/AdminCredentials'))
const Movimientos              = lazy(() => import('./pages/Movimientos'))
const OdooFacturacion          = lazy(() => import('./pages/OdooFacturacion'))
const FacturasProcesadas       = lazy(() => import('./pages/FacturasProcesadas'))
const AdminClientAccess        = lazy(() => import('./pages/AdminClientAccess'))
const AdminPermisos            = lazy(() => import('./pages/AdminPermisos'))

const PageLoader = () => <div className="loading">Cargando…</div>

function RequireModule({ modulo, children }) {
  const { has, loading } = useAccess()
  if (loading) return <PageLoader />
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
  if (loading) return <PageLoader />
  return <Navigate to={homeFor(has)} replace />
}

function RequireAdmin({ children }) {
  const { isAdmin, loading, has } = useAccess()
  if (loading) return <PageLoader />
  if (!isAdmin) return <Navigate to={homeFor(has)} replace />
  return children
}

function RequireSuperAdmin({ children }) {
  const { isSuperAdmin, loading, has } = useAccess()
  if (loading) return <PageLoader />
  if (!isSuperAdmin) return <Navigate to={homeFor(has)} replace />
  return children
}

function UpdateBanner() {
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW()
  if (!needRefresh) return null
  return (
    <div style={{
      position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)',
      background: '#1a3d6b', color: '#fff', borderRadius: 10, padding: '12px 20px',
      display: 'flex', alignItems: 'center', gap: 14, zIndex: 9999,
      boxShadow: '0 4px 16px rgba(0,0,0,.25)', fontSize: '0.88rem', whiteSpace: 'nowrap',
    }}>
      <span>Nueva versión disponible</span>
      <button
        onClick={() => updateServiceWorker(true)}
        style={{
          background: '#fff', color: '#1a3d6b', border: 'none', borderRadius: 6,
          padding: '5px 14px', fontWeight: 700, cursor: 'pointer', fontSize: '0.85rem',
        }}
      >
        Actualizar
      </button>
    </div>
  )
}

function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = localStorage.getItem('token')
    const userId = localStorage.getItem('userId')
    const email = localStorage.getItem('email')
    if (token && userId) setUser({ token, userId, email })
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

  if (loading) return <PageLoader />

  return (
    <Router>
      <UpdateBanner />
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/login" element={user ? <Navigate to="/" /> : <Login onLogin={handleLogin} />} />
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
              <Route path="/normativa" element={<Normativa />} />
              <Route path="/reportes" element={<Reportes modo="faltantes" />} />
              <Route path="/reportes/faltantes" element={<Reportes modo="faltantes" />} />
              <Route path="/reportes/realizados" element={<Reportes modo="realizados" />} />
              <Route path="/capacitaciones" element={<Capacitaciones />} />
              <Route path="/admin" element={<RequireSuperAdmin><Admin /></RequireSuperAdmin>} />
              <Route path="/admin/credenciales" element={<RequireSuperAdmin><AdminCredentials /></RequireSuperAdmin>} />
              <Route path="/odoo-facturacion" element={<OdooFacturacion />} />
              <Route path="/odoo-facturacion/procesadas" element={<FacturasProcesadas />} />
              <Route path="/admin/acceso-clientes" element={<RequireSuperAdmin><AdminClientAccess /></RequireSuperAdmin>} />
              <Route path="/admin/permisos" element={<RequireSuperAdmin><AdminPermisos /></RequireSuperAdmin>} />
              <Route path="/movimientos" element={<RequireSuperAdmin><Movimientos /></RequireSuperAdmin>} />
              <Route path="/sin-acceso" element={<SinAcceso />} />
              <Route path="*" element={<HomeRedirect />} />
            </Route>
          ) : (
            <Route path="*" element={<Navigate to="/" />} />
          )}
        </Routes>
      </Suspense>
    </Router>
  )
}

export default App
