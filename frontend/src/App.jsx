/* ------------------------------------------------------------
 * Desarrollado por Marco Antonio Posligua San Martín
 * ------------------------------------------------------------ */
import { useState, useEffect, lazy, Suspense } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { BrowserRouter as Router, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom'
import { AccessProvider, useAccess, homeFor } from './context/AccessContext'
import { ClientProvider, SELECTED_CLIENT_KEY } from './context/ClientContext'
import { SELECTED_ORG_KEY } from './services/api'
import { clearAll as clearApiCache } from './services/cache'
import { useInactivityLogout } from './hooks/useInactivityLogout'
import Layout from './components/Layout'
import ErrorPantalla from './components/ErrorPantalla'
import './App.css'

// Lazy-load every page: first load only downloads the current route's chunk
const Login                    = lazy(() => import('./pages/Login'))
const Landing                  = lazy(() => import('./pages/Landing'))
const ResetPassword            = lazy(() => import('./pages/ResetPassword'))
const MiCuenta                 = lazy(() => import('./pages/MiCuenta'))
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
const ClientesPendientes       = lazy(() => import('./pages/ClientesPendientes'))
const DevolucionesIvaTerceraEdad = lazy(() => import('./pages/DevolucionesIvaTerceraEdad'))
const CatalogoProductos        = lazy(() => import('./pages/CatalogoProductos'))
const Compradores              = lazy(() => import('./pages/Compradores'))
const RebajasExenciones        = lazy(() => import('./pages/RebajasExenciones'))
const Normativa                = lazy(() => import('./pages/Normativa'))
const InformeGeneral           = lazy(() => import('./pages/InformeGeneral'))
const Capacitaciones           = lazy(() => import('./pages/Capacitaciones'))
const Admin                    = lazy(() => import('./pages/Admin'))
const AdminCredentials         = lazy(() => import('./pages/AdminCredentials'))
const Movimientos              = lazy(() => import('./pages/Movimientos'))
const Facturacion              = lazy(() => import('./pages/Facturacion'))
const AdminClientAccess        = lazy(() => import('./pages/AdminClientAccess'))
const AdminPermisos            = lazy(() => import('./pages/AdminPermisos'))
const AdminBajadores          = lazy(() => import('./pages/AdminBajadores'))
const AdminEmpresas            = lazy(() => import('./pages/AdminEmpresas'))

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

// Accesible si el usuario tiene CUALQUIERA de los módulos indicados (p.ej.
// Clientes pendientes: declaraciones o agente de retención). Redirige a un
// destino accesible si no tiene ninguno.
function RequireAnyModule({ modulos, sub, children }) {
  const { has, hasSub, loading } = useAccess()
  if (loading) return <PageLoader />
  if (!modulos.some((m) => has(m))) return <Navigate to={homeFor(has, hasSub)} replace />
  // La pantalla puede estar restringida aunque el módulo esté contratado.
  if (sub && !hasSub(sub)) return <Navigate to={homeFor(has, hasSub)} replace />
  return children
}

// Menú Credenciales: el admin ve todo (claves incluidas); socio y trabajador
// acceden a la vista LIMITADA (solo marcar qué declaraciones hace cada cliente).
function RequireCredenciales({ children }) {
  const { role, loading, has, hasSub } = useAccess()
  if (loading) return <PageLoader />
  if (!['admin', 'socio', 'trabajador'].includes(role)) return <Navigate to={homeFor(has, hasSub)} replace />
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

function RequireSuperAdmin({ children }) {
  const { isSuperAdmin, loading, has, hasSub } = useAccess()
  if (loading) return <PageLoader />
  if (!isSuperAdmin) return <Navigate to={homeFor(has, hasSub)} replace />
  return children
}

// Administración de EMPRESAS: entran el administrador de la plataforma (gestiona
// todas) y el administrador de la empresa activa (gestiona la suya). El backend
// vuelve a verificarlo empresa por empresa.
function RequireOrgAdmin({ children }) {
  const { isPlatformAdmin, role, loading, has, hasSub } = useAccess()
  if (loading) return <PageLoader />
  if (!isPlatformAdmin && role !== 'admin') return <Navigate to={homeFor(has, hasSub)} replace />
  return children
}

// Cada cuánto se pregunta si hay versión nueva. El navegador solo lo comprueba
// al cargar la página, así que una pestaña abierta desde la mañana se queda con
// el código viejo —y lo que se despliega "no aparece" aunque esté en el
// servidor—. Se revisa también al volver a la pestaña, que es cuando el usuario
// suele regresar del SRI o de Odoo.
const REVISAR_VERSION_MS = 5 * 60 * 1000

// /odoo-facturacion/xxx -> /facturacion/xxx (marcadores viejos)
function RedirFacturacion() {
  const { tab } = useParams()
  return <Navigate to={`/facturacion/${tab || ''}`} replace />
}

// La carga de honorarios se mudó a la primera pestaña de Facturación: cargar y
// facturar son el mismo trabajo y estaban en dos menús con meses distintos. Las
// direcciones viejas (/reportes, /reportes/faltantes, /reportes/realizados)
// siguen sirviendo —hay enlaces a ellas por toda la app— y conservan lo que
// traían: el buscador (?q=) del aviso de cobros y el período (?p=).
function RedirHonorarios({ modo }) {
  const { search } = useLocation()
  const sp = new URLSearchParams(search)
  if (modo) sp.set('modo', modo)
  return <Navigate to={`/facturacion/honorarios?${sp.toString()}`} replace />
}

function UpdateBanner() {
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_url, registro) {
      if (!registro) return
      const revisar = () => { registro.update().catch(() => { /* sin red: se reintenta */ }) }
      setInterval(revisar, REVISAR_VERSION_MS)
      window.addEventListener('focus', revisar)
      document.addEventListener('visibilitychange', () => { if (!document.hidden) revisar() })
    },
  })
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
    // Y la empresa activa de quien usara antes este navegador: la correcta la
    // fija el backend en la primera llamada a /api/access/me.
    localStorage.removeItem(SELECTED_ORG_KEY)
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
    // La empresa activa también se olvida al salir: si en este navegador entra
    // otra persona, no debe heredar la empresa de la sesión anterior.
    localStorage.removeItem(SELECTED_ORG_KEY)
    setUser(null)
  }

  // Cierra la sesión tras 30 minutos de inactividad (solo si hay sesión activa).
  useInactivityLogout(handleLogout, !!user)

  if (loading) return <PageLoader />

  return (
    <Router>
      <UpdateBanner />
      {/* Envuelve TODAS las pantallas: si una falla al cargarse porque se
          desplegó una versión nueva mientras la pestaña estaba abierta, se
          recarga sola en vez de quedar en blanco. */}
      <ErrorPantalla>
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
              <Route path="/devoluciones-iva/tercera-edad" element={<RequireSubmodule modulo="declaraciones" sub="decl_devoluciones"><DevolucionesIvaTerceraEdad beneficiario="tercera_edad" /></RequireSubmodule>} />
              <Route path="/devoluciones-iva/discapacidad" element={<RequireSubmodule modulo="declaraciones" sub="decl_devoluciones"><DevolucionesIvaTerceraEdad beneficiario="discapacidad" /></RequireSubmodule>} />
              <Route path="/clientes-pendientes" element={<RequireAnyModule modulos={['declaraciones', 'agente_retencion']} sub="decl_pendientes"><ClientesPendientes /></RequireAnyModule>} />
              <Route path="/ingresos-iva" element={<RequireSubmodule modulo="ingresos_ice" sub="ice_ingresos_iva"><IngresosIva /></RequireSubmodule>} />
              <Route path="/calculo-ice" element={<RequireSubmodule modulo="ingresos_ice" sub="ice_calculo"><CalculoICE /></RequireSubmodule>} />
              <Route path="/anexo-pvp-ice" element={<RequireSubmodule modulo="ingresos_ice" sub="ice_anexo"><AnexoPVPICE /></RequireSubmodule>} />
              <Route path="/recursos-ice" element={<RequireModule modulo="ingresos_ice"><RecursosICE /></RequireModule>} />
              <Route path="/ice" element={<RequireSubmodule modulo="ingresos_ice" sub="ice_xml"><ICE /></RequireSubmodule>} />
              <Route path="/catalogo-productos" element={<RequireSubmodule modulo="ingresos_ice" sub="ice_catalogo"><CatalogoProductos /></RequireSubmodule>} />
              <Route path="/compradores" element={<RequireSubmodule modulo="datos" sub="dat_compradores"><Compradores /></RequireSubmodule>} />
              <Route path="/rebajas-exenciones" element={<RequireSubmodule modulo="ingresos_ice" sub="ice_rebajas"><RebajasExenciones /></RequireSubmodule>} />
              {/* Mi cuenta: datos propios y cambio de clave. Sin restricción de
                  módulo: todo usuario con sesión debe poder administrar su cuenta. */}
              <Route path="/mi-cuenta" element={<MiCuenta />} />
              <Route path="/normativa" element={<Normativa />} />
              <Route path="/reportes" element={<RedirHonorarios modo="faltantes" />} />
              <Route path="/reportes/faltantes" element={<RedirHonorarios modo="faltantes" />} />
              <Route path="/reportes/realizados" element={<RedirHonorarios modo="realizados" />} />
              <Route path="/informe-general" element={<RequireSubmodule modulo="gestion" sub="gest_reportes"><InformeGeneral /></RequireSubmodule>} />
              <Route path="/capacitaciones" element={<RequireSubmodule modulo="gestion" sub="gest_capacitaciones"><Capacitaciones /></RequireSubmodule>} />
              <Route path="/admin" element={<RequireSuperAdmin><Admin /></RequireSuperAdmin>} />
              <Route path="/admin/credenciales" element={<RequireCredenciales><AdminCredentials /></RequireCredenciales>} />
              {/* TODA la facturación en una pantalla con pestañas. Sin guard acá: el
                  módulo decide por pestaña —emitir, reporte y cruce son de
                  admin/socio; "Facturas de Odoo" es de solo lectura y el backend
                  ya filtra por RUC autorizado para el rol 'cliente'—. */}
              <Route path="/facturacion" element={<RequireSubmodule modulo="gestion" sub="gest_facturacion"><Facturacion /></RequireSubmodule>} />
              <Route path="/facturacion/:tab" element={<RequireSubmodule modulo="gestion" sub="gest_facturacion"><Facturacion /></RequireSubmodule>} />
              {/* Las direcciones viejas siguen funcionando: marcadores, enlaces
                  guardados y lo que quedó escrito en otras pantallas. */}
              <Route path="/odoo-facturacion" element={<Navigate to="/facturacion" replace />} />
              <Route path="/odoo-facturacion/:tab" element={<RedirFacturacion />} />
              <Route path="/admin/acceso-clientes" element={<RequireSuperAdmin><AdminClientAccess /></RequireSuperAdmin>} />
              <Route path="/admin/permisos" element={<RequireSuperAdmin><AdminPermisos /></RequireSuperAdmin>} />
              <Route path="/admin/bajadores" element={<RequireSuperAdmin><AdminBajadores /></RequireSuperAdmin>} />
              <Route path="/admin/empresas" element={<RequireOrgAdmin><AdminEmpresas /></RequireOrgAdmin>} />
              <Route path="/movimientos" element={<RequireSuperAdmin><Movimientos /></RequireSuperAdmin>} />
              <Route path="/sin-acceso" element={<SinAcceso onLogout={handleLogout} />} />
              <Route path="*" element={<HomeRedirect />} />
            </Route>
          ) : (
            <Route path="*" element={<Navigate to="/" />} />
          )}
        </Routes>
      </Suspense>
      </ErrorPantalla>
    </Router>
  )
}

export default App
