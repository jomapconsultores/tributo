import { useState, useEffect, lazy, Suspense } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import { AccessProvider, useAccess, homeFor } from './context/AccessContext'
import { ClientProvider, SELECTED_CLIENT_KEY } from './context/ClientContext'
import { clearAll as clearApiCache } from './services/cache'
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
const RetencionesEfectuadas    = lazy(() => import('./pages/RetencionesEfectuadas'))
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
  const { has, hasSub, loading } = useAccess()
  if (loading) return <PageLoader />
  if (!has(modulo)) return <Navigate to={homeFor(has, hasSub)} replace />
  return children
}

// Igual que RequireModule pero además exige el SUBMÓDULO (pantalla). El módulo
// padre se infiere: si no tiene el módulo o la pantalla, redirige a un destino
// que sí puede ver.
function RequireSubmodule({ modulo, sub, children }) {
  const { has, hasSub, loading } = useAccess()
  if (loading) return <PageLoader />
  if (!has(modulo) || !hasSub(sub)) return <Navigate to={homeFor(has, hasSub)} replace />
  return children
}

function SinAcceso({ onLogout }) {
  // Cierra la sesión actual y vuelve al login (evita quedar atrapado en esta
  // pantalla sin salida cuando la cuenta no tiene módulos habilitados).
  const volverALogin = () => {
    onLogout?.()
    window.location.assign('/login')
  }
  return (
    <div style={{ padding: 40, textAlign: 'center', color: '#475569' }}>
      <h2>Sin módulos contratados</h2>
      <p>Tu cuenta aún no tiene módulos habilitados. Contacta al administrador para activar tu plan.</p>
      <button
        onClick={volverALogin}
        style={{
          marginTop: 20, background: '#1a3d6b', color: '#fff', border: 'none',
          borderRadius: 8, padding: '10px 22px', fontWeight: 700, cursor: 'pointer',
          fontSize: '0.9rem',
        }}
      >
        Volver a iniciar sesión
      </button>
    </div>
  )
}

function HomeRedirect() {
  const { has, hasSub, loading } = useAccess()
  if (loading) return <PageLoader />
  return <Navigate to={homeFor(has, hasSub)} replace />
}

function RequireAdmin({ children }) {
  const { isAdmin, loading, has, hasSub } = useAccess()
  if (loading) return <PageLoader />
  if (!isAdmin) return <Navigate to={homeFor(has, hasSub)} replace />
  return children
}

function RequireSuperAdmin({ children }) {
  const { isSuperAdmin, loading, has, hasSub } = useAccess()
  if (loading) return <PageLoader />
  if (!isSuperAdmin) return <Navigate to={homeFor(has, hasSub)} replace />
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
    clearApiCache() // evita heredar datos cacheados de una sesión anterior en este navegador
    localStorage.setItem('token', token)
    localStorage.setItem('userId', userId)
    localStorage.setItem('email', email)
    setUser({ token, userId, email })
  }

  const handleLogout = () => {
    clearApiCache()
    localStorage.removeItem('token')
    localStorage.removeItem('userId')
    localStorage.removeItem('email')
    localStorage.removeItem(SELECTED_CLIENT_KEY)
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
              <Route path="/" element={<RequireSubmodule modulo="gastos" sub="gastos_facturas"><Database /></RequireSubmodule>} />
              <Route path="/clasificador" element={<RequireSubmodule modulo="gastos" sub="gastos_clasificar"><Classifier /></RequireSubmodule>} />
              <Route path="/datos" element={<RequireSubmodule modulo="gastos" sub="gastos_facturas"><SavedData /></RequireSubmodule>} />
              <Route path="/retenciones" element={<RequireModule modulo="retenciones"><Retenciones /></RequireModule>} />
              <Route path="/retenciones-efectuadas" element={<RequireSubmodule modulo="agente_retencion" sub="agret_retenciones"><RetencionesEfectuadas /></RequireSubmodule>} />
              <Route path="/declaracion-iva" element={<RequireSubmodule modulo="declaraciones" sub="decl_iva"><Declaraciones tipo="IVA" /></RequireSubmodule>} />
              <Route path="/declaracion-ice" element={<RequireSubmodule modulo="declaraciones" sub="decl_ice"><Declaraciones tipo="ICE" /></RequireSubmodule>} />
              <Route path="/declaracion-103" element={<RequireSubmodule modulo="agente_retencion" sub="agret_103"><Declaraciones tipo="103" /></RequireSubmodule>} />
              <Route path="/devoluciones-iva/tercera-edad" element={<RequireSubmodule modulo="declaraciones" sub="decl_devoluciones"><DevolucionesIvaTerceraEdad /></RequireSubmodule>} />
              <Route path="/ingresos-iva" element={<RequireSubmodule modulo="ingresos_ice" sub="ice_ingresos_iva"><IngresosIva /></RequireSubmodule>} />
              <Route path="/calculo-ice" element={<RequireSubmodule modulo="ingresos_ice" sub="ice_calculo"><CalculoICE /></RequireSubmodule>} />
              <Route path="/anexo-pvp-ice" element={<RequireSubmodule modulo="ingresos_ice" sub="ice_anexo"><AnexoPVPICE /></RequireSubmodule>} />
              <Route path="/recursos-ice" element={<RequireModule modulo="ingresos_ice"><RecursosICE /></RequireModule>} />
              <Route path="/ice" element={<RequireSubmodule modulo="ingresos_ice" sub="ice_xml"><ICE /></RequireSubmodule>} />
              <Route path="/catalogo-productos" element={<RequireSubmodule modulo="ingresos_ice" sub="ice_catalogo"><CatalogoProductos /></RequireSubmodule>} />
              <Route path="/compradores" element={<RequireSubmodule modulo="ingresos_ice" sub="ice_compradores"><Compradores /></RequireSubmodule>} />
              <Route path="/rebajas-exenciones" element={<RequireSubmodule modulo="ingresos_ice" sub="ice_rebajas"><RebajasExenciones /></RequireSubmodule>} />
              <Route path="/normativa" element={<Normativa />} />
              <Route path="/reportes" element={<Reportes modo="faltantes" />} />
              <Route path="/reportes/faltantes" element={<Reportes modo="faltantes" />} />
              <Route path="/reportes/realizados" element={<Reportes modo="realizados" />} />
              <Route path="/capacitaciones" element={<Capacitaciones />} />
              <Route path="/admin" element={<RequireSuperAdmin><Admin /></RequireSuperAdmin>} />
              <Route path="/admin/credenciales" element={<RequireSuperAdmin><AdminCredentials /></RequireSuperAdmin>} />
              <Route path="/odoo-facturacion" element={<RequireAdmin><OdooFacturacion /></RequireAdmin>} />
              {/* Sin guard a propósito: es de solo lectura y /api/odoo/facturas ya
                  filtra server-side por RUC autorizado para el rol 'cliente' (a
                  diferencia de /odoo-facturacion, que factura y sí requiere admin/socio). */}
              <Route path="/odoo-facturacion/procesadas" element={<FacturasProcesadas />} />
              <Route path="/admin/acceso-clientes" element={<RequireSuperAdmin><AdminClientAccess /></RequireSuperAdmin>} />
              <Route path="/admin/permisos" element={<RequireSuperAdmin><AdminPermisos /></RequireSuperAdmin>} />
              <Route path="/movimientos" element={<RequireSuperAdmin><Movimientos /></RequireSuperAdmin>} />
              <Route path="/sin-acceso" element={<SinAcceso onLogout={handleLogout} />} />
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
