import axios from 'axios'
import { clearAll } from './cache'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Empresa activa (multiempresa). Se manda en TODAS las peticiones y el backend
// la valida contra las membresías reales del usuario: si aquí quedó una empresa
// a la que ya no pertenece, no da error, el backend cae a la que le corresponda
// y AccessContext corrige este valor con lo que devuelve /api/access/me.
export const SELECTED_ORG_KEY = 'selectedOrgId'

// Interceptor para agregar token y empresa activa a todas las requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  const orgId = localStorage.getItem(SELECTED_ORG_KEY)
  if (orgId) {
    config.headers['X-Org-Id'] = orgId
  }
  return config
}, (error) => Promise.reject(error))

// Interceptor de respuesta: si el token EXPIRA o es inválido (401), cerrar sesión
// de forma limpia y enviar a /login, en vez de dejar la app sin datos —lo que se
// veía erróneamente como "Sin módulos contratados"—. Se excluyen los endpoints de
// auth (un 401 al iniciar sesión con credenciales malas lo maneja el formulario).
let _authRedireccionando = false
const _esEndpointAuth = (url = '') => /\/auth\/(login|signup|reset|forgot)/.test(url)

api.interceptors.response.use(
  (res) => res,
  (error) => {
    const status = error?.response?.status
    if (status === 401 && !_esEndpointAuth(error?.config?.url) && localStorage.getItem('token')) {
      // Sesión vencida: limpiar credenciales y caché para no arrastrar estado.
      localStorage.removeItem('token')
      localStorage.removeItem('userId')
      localStorage.removeItem('email')
      try { clearAll() } catch { /* noop */ }
      if (!_authRedireccionando && !window.location.pathname.startsWith('/login')) {
        _authRedireccionando = true
        window.location.assign('/login?expired=1')
      }
    }
    return Promise.reject(error)
  },
)

// Auth
export const authAPI = {
  login: (email, password) => api.post('/auth/login', { email, password }),
  signup: (email, password) => api.post('/auth/signup', { email, password }),
  logout: () => api.post('/auth/logout'),
  forgot: (email) => api.post('/auth/forgot', { email }),
  reset: (access_token, password) => api.post('/auth/reset', { access_token, password }),
  // Mi cuenta: datos propios y cambio de clave con verificación de la anterior
  perfil: () => api.get('/auth/perfil'),
  guardarPerfil: (data) => api.put('/auth/perfil', data),
  cambiarClave: (clave_actual, clave_nueva) =>
    api.post('/auth/cambiar-clave', { clave_actual, clave_nueva }),
}

// Acceso por módulos contratados
export const accessAPI = {
  me: () => api.get('/api/access/me'),
  // Cambia el rol activo del propio usuario (solo entre los roles que el admin le otorgó)
  switchRole: (role) => api.post('/api/access/switch-role', { role }),
}

// Empresas (multiempresa) y sus miembros
export const orgsAPI = {
  // Empresas entre las que el usuario puede cambiar (alimenta el selector)
  list: () => api.get('/api/organizations/'),
  create: (data) => api.post('/api/organizations/', data),
  update: (id, data) => api.put(`/api/organizations/${id}`, data),
  remove: (id) => api.delete(`/api/organizations/${id}`),
  // Miembros: quién pertenece a la empresa, con qué rol y qué permisos
  members: (id) => api.get(`/api/organizations/${id}/members`),
  candidatos: (id) => api.get(`/api/organizations/${id}/candidatos`),
  addMember: (id, data) => api.post(`/api/organizations/${id}/members`, data),
  updateMember: (id, uid, data) => api.put(`/api/organizations/${id}/members/${uid}`, data),
  removeMember: (id, uid) => api.delete(`/api/organizations/${id}/members/${uid}`),
  // Convertir un contribuyente en empresa propia (se lleva todos sus períodos)
  exportarContribuyente: (identificacion, conservar_acceso = true, nombre = null) =>
    api.post('/api/organizations/exportar-contribuyente', { identificacion, conservar_acceso, nombre }),
  // Autorizaciones entre empresas: la dueña abre el acceso, y solo ella lo revoca
  autorizaciones: (id) => api.get(`/api/organizations/${id}/autorizaciones`),
  autorizar: (id, data) => api.post(`/api/organizations/${id}/autorizaciones`, data),
  revocar: (id, grantId) => api.delete(`/api/organizations/${id}/autorizaciones/${grantId}`),
  // Reparto de la cartera entre empresas
  contribuyentes: (id) => api.get(`/api/organizations/${id}/contribuyentes`),
  huerfanos: () => api.get('/api/organizations/sin-empresa/contribuyentes'),
  asignarContribuyentes: (id, identificaciones) =>
    api.put(`/api/organizations/${id}/contribuyentes`, { identificaciones }),
}

// Formulario de contacto (público)
export const contactoAPI = {
  enviar: (data) => api.post('/api/contacto/', data),
}

// Administración (solo admins)
export const adminAPI = {
  // acceso a clientes compartidos
  clientAccess: (uid) => api.get('/api/admin/client-access', { params: { uid } }),
  setClientAccess: (body) => api.put('/api/admin/client-access', body),
  setClientAccessBulk: (granted_to, identificaciones, grant) => api.put('/api/admin/client-access/bulk', { granted_to, identificaciones, grant }),
  listUsers: () => api.get('/api/admin/users'),
  createUser: (data) => api.post('/api/admin/users', data),
  deleteUser: (uid) => api.delete(`/api/admin/users/${uid}`),
  setModules: (uid, modules, valid_until = null) => api.put(`/api/admin/users/${uid}/modules`, { modules, valid_until }),
  setRole: (uid, role) => api.put(`/api/admin/users/${uid}/role`, { role }),
  setRoles: (uid, roles) => api.put(`/api/admin/users/${uid}/roles`, { roles }),
  setSubmodules: (uid, submodules) => api.put(`/api/admin/users/${uid}/submodules`, { submodules }),
  submodulosCatalogo: () => api.get('/api/admin/submodulos-catalogo'),
  setPlan: (uid, plan, valid_until = null) => api.post(`/api/admin/users/${uid}/plan`, { plan, valid_until }),
  setSubscription: (uid, data) => api.put(`/api/admin/users/${uid}/subscription`, data),
  registrarPago: (uid, data) => api.post(`/api/admin/users/${uid}/pago`, data),
  pagos: (uid) => api.get(`/api/admin/users/${uid}/pagos`),
  descuentos: () => api.get('/api/admin/descuentos'),
  contactos: () => api.get('/api/admin/contactos'),
  resetIps: (uid) => api.delete(`/api/admin/users/${uid}/ips`),
  // Recuperación de clave olvidada: genera una clave temporal de un solo uso
  resetPassword: (uid) => api.post(`/api/admin/users/${uid}/reset-password`),
  permisos: () => api.get('/api/admin/permisos'),
}

// MOVIMIENTOS: bitácora de actividad de los usuarios (solo admin)
export const actividadAPI = {
  list: (params = {}) => api.get('/api/admin/actividad', { params }),
  resumen: () => api.get('/api/admin/actividad/resumen'),
  marcarVisto: () => api.post('/api/admin/actividad/visto'),
}

// Credenciales de servicios externos (portal SRI, etc.) — SOLO ADMIN
// Las contraseñas viajan cifradas en la DB; solo /reveal las descifra y queda auditado.
export const credentialsAPI = {
  list: (q = '') => api.get('/api/credentials', { params: q ? { q } : undefined }),
  revealAll: () => api.get('/api/credentials/reveal-all'),
  reveal: (id) => api.get(`/api/credentials/${id}/reveal`),
  create: (data) => api.post('/api/credentials', data),
  update: (id, data) => api.put(`/api/credentials/${id}`, data),
  delete: (id) => api.delete(`/api/credentials/${id}`),
  auditLog: (params = {}) => api.get('/api/credentials/audit-log', { params }),
  // Toggle de servicios contratados por cliente
  // service: 'declaracion_iva' | 'declaracion_ice' | 'declaracion_renta' | 'devolucion_iva'
  toggleService: (clientId, service, active = null) =>
    api.put(`/api/credentials/services/${clientId}/${service}`, active != null ? { active } : {}),
}

// Clientes (contribuyentes)
export const clientsAPI = {
  list: () => api.get('/api/clients/'),
  contribuyentes: () => api.get('/api/clients/contribuyentes'),
  get: (id) => api.get(`/api/clients/${id}`),
  create: (data) => api.post('/api/clients/', data),
  update: (id, data) => api.put(`/api/clients/${id}`, data),
  delete: (id) => api.delete(`/api/clients/${id}`),
  summary: (identificacion) => api.get(`/api/clients/summary/${identificacion}`),
  byService: (service) => api.get('/api/clients/by-service', { params: { service } }),
  servicesMap: () => api.get('/api/clients/services-map'),
  consultaRuc: (ruc) => api.get('/api/clients/consulta-ruc', { params: { ruc } }),
  // Declaración mes vencido: abre el período a declarar (mes anterior) para los
  // contribuyentes trabajados el ciclo previo. Idempotente.
  abrirPeriodoVencido: () => api.post('/api/clients/abrir-periodo-vencido'),
  // Periodicidad de IVA del contribuyente (mensual ⇄ semestral) sin crear otro
  // contribuyente. `preview` solo informa qué pasaría; `set` lo aplica.
  periodicidadPreview: (data) => api.post('/api/clients/periodicidad/preview', data),
  setPeriodicidad: (data) => api.post('/api/clients/periodicidad', data),
}

// Invoices (por cliente)
export const invoicesAPI = {
  list: (clientId, skip = 0, limit = 500) =>
    api.get('/api/invoices/', { params: { client_id: clientId, skip, limit } }),
  processTxt: (clientId, file) => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('client_id', clientId)
    return api.post('/api/invoices/process-txt', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      // El SRI es lento y reintentamos varias rondas; damos margen amplio.
      timeout: 300000,
    })
  },
  processXml: (clientId, files) => {
    const formData = new FormData()
    files.forEach((file) => formData.append('files', file))
    formData.append('client_id', clientId)
    return api.post('/api/invoices/process-xml', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  update: (id, data) => api.put(`/api/invoices/${id}`, data),
  delete: (id) => api.delete(`/api/invoices/${id}`),
  clear: (clientId) => api.delete('/api/invoices/clear', { params: { client_id: clientId } }),
  bulkMove: (ids, clientId) => api.post('/api/invoices/bulk-move', { ids, client_id: clientId }),
  bulkDelete: (ids) => api.post('/api/invoices/bulk-delete', { ids }),
  exportExcel: (clientId) =>
    api.get('/api/invoices/export/excel', { params: { client_id: clientId }, responseType: 'blob' }),
  exportPdf: (clientId) =>
    api.get('/api/invoices/export/pdf', { params: { client_id: clientId }, responseType: 'blob' }),
}

// Retenciones (por cliente)
export const retentionsAPI = {
  list: (clientId) => api.get('/api/retentions/', { params: { client_id: clientId } }),
  processXml: (clientId, files) => {
    const formData = new FormData()
    files.forEach((file) => formData.append('files', file))
    formData.append('client_id', clientId)
    return api.post('/api/retentions/process-xml', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  delete: (id) => api.delete(`/api/retentions/${id}`),
  clear: (clientId) => api.delete('/api/retentions/clear', { params: { client_id: clientId } }),
  bulkMove: (ids, clientId) => api.post('/api/retentions/bulk-move', { ids, client_id: clientId }),
  bulkDelete: (ids) => api.post('/api/retentions/bulk-delete', { ids }),
  exportExcel: (clientId) =>
    api.get('/api/retentions/export/excel', { params: { client_id: clientId }, responseType: 'blob' }),
}

// Retenciones EFECTUADAS: el cliente actúa como agente de retención hacia sus proveedores
export const retencionesEfectuadasAPI = {
  conceptosRenta: () => api.get('/api/retenciones-efectuadas/conceptos-renta'),
  list: (clientId) => api.get('/api/retenciones-efectuadas/', { params: { client_id: clientId } }),
  create: (row) => api.post('/api/retenciones-efectuadas/', row),
  update: (id, data) => api.put(`/api/retenciones-efectuadas/${id}`, data),
  processXml: (clientId, files) => {
    const formData = new FormData()
    files.forEach((file) => formData.append('files', file))
    formData.append('client_id', clientId)
    return api.post('/api/retenciones-efectuadas/process-xml', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  delete: (id) => api.delete(`/api/retenciones-efectuadas/${id}`),
  clear: (clientId) => api.delete('/api/retenciones-efectuadas/clear', { params: { client_id: clientId } }),
  bulkMove: (ids, clientId) => api.post('/api/retenciones-efectuadas/bulk-move', { ids, client_id: clientId }),
  bulkDelete: (ids) => api.post('/api/retenciones-efectuadas/bulk-delete', { ids }),
  exportExcel: (clientId) =>
    api.get('/api/retenciones-efectuadas/export/excel', { params: { client_id: clientId }, responseType: 'blob' }),
}

// ICE (ventas de licor por cliente)
export const iceAPI = {
  list: (clientId) => api.get('/api/ice/', { params: { client_id: clientId } }),
  taxYears: () => api.get('/api/ice/tax-years'),
  report: (clientId, anio) => api.get('/api/ice/report', { params: { client_id: clientId, anio } }),
  processXml: (clientId, files) => {
    const formData = new FormData()
    files.forEach((file) => formData.append('files', file))
    formData.append('client_id', clientId)
    return api.post('/api/ice/process-xml', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  delete: (id) => api.delete(`/api/ice/${id}`),
  clear: (clientId) => api.delete('/api/ice/clear', { params: { client_id: clientId } }),
  bulkMove: (ids, clientId) => api.post('/api/ice/bulk-move', { ids, client_id: clientId }),
  bulkDelete: (ids) => api.post('/api/ice/bulk-delete', { ids }),
  exportExcel: (clientId, anio) =>
    api.get('/api/ice/export/excel', { params: { client_id: clientId, anio }, responseType: 'blob' }),
  exportPdf: (clientId, anio) =>
    api.get('/api/ice/export/pdf', { params: { client_id: clientId, anio }, responseType: 'blob' }),
  anexo: (clientId, actImport) =>
    api.get('/api/ice/anexo', { params: { client_id: clientId, act_import: actImport } }),
  catalog: () => api.get('/api/ice/catalog'),
  anexoRows: (clientId, actImport, tipo = 'ICE') =>
    api.get('/api/ice/anexo-rows', { params: { client_id: clientId, act_import: actImport, tipo } }),
}

// Ingresos IVA (ventas SIN ICE, por cliente). Las ventas CON ICE van por iceAPI.
export const salesIvaAPI = {
  list: (clientId) => api.get('/api/sales-iva/', { params: { client_id: clientId } }),
  processXml: (clientId, files) => {
    const formData = new FormData()
    files.forEach((file) => formData.append('files', file))
    formData.append('client_id', clientId)
    return api.post('/api/sales-iva/process-xml', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  // Sube el reporte/lista de claves (TXT del SRI: "Descargar reporte" de Emitidos)
  processTxt: (clientId, file) => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('client_id', clientId)
    return api.post('/api/sales-iva/process-txt', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 300000,  // baja por SOAP con reintentos; margen amplio
    })
  },
  update: (id, data) => api.put(`/api/sales-iva/${id}`, data),
  delete: (id) => api.delete(`/api/sales-iva/${id}`),
  clear: (clientId) => api.delete('/api/sales-iva/clear', { params: { client_id: clientId } }),
  bulkMove: (ids, clientId) => api.post('/api/sales-iva/bulk-move', { ids, client_id: clientId }),
  bulkDelete: (ids) => api.post('/api/sales-iva/bulk-delete', { ids }),
}

// Cálculo ICE manual (por cliente)
export const iceCalcAPI = {
  tarifas: () => api.get('/api/ice-calc/tarifas'),
  list: (clientId) => api.get('/api/ice-calc/', { params: { client_id: clientId } }),
  create: (row) => api.post('/api/ice-calc/', row),
  update: (id, data) => api.put(`/api/ice-calc/${id}`, data),
  delete: (id) => api.delete(`/api/ice-calc/${id}`),
  clear: (clientId) => api.delete('/api/ice-calc/clear', { params: { client_id: clientId } }),
  exportExcel: (clientId) => api.get('/api/ice-calc/export/excel', { params: { client_id: clientId }, responseType: 'blob' }),
  exportPdf: (clientId) => api.get('/api/ice-calc/export/pdf', { params: { client_id: clientId }, responseType: 'blob' }),
}

// Catálogo de productos por contribuyente
export const productsAPI = {
  list: (identificacion) => api.get('/api/products/', { params: { identificacion } }),
  searchCodigos: (q, impuesto = '3031') => api.get('/api/products/codigos-ice/search', { params: { q, impuesto } }),
  countCodigos: () => api.get('/api/products/codigos-ice/count'),
  importCodigos: () => api.post('/api/products/codigos-ice/import'),
  lookups: () => api.get('/api/products/codigos-ice/lookups'),
  byClient: (clientId) => api.get(`/api/products/by-client/${clientId}`),
  create: (p) => api.post('/api/products/', p),
  update: (id, data) => api.put(`/api/products/${id}`, data),
  delete: (id) => api.delete(`/api/products/${id}`),
}

// Anexos PVP/ICE guardados por cliente/período
export const anexosAPI = {
  list: (clientId) => api.get('/api/anexos/', { params: { client_id: clientId } }),
  get: (id) => api.get(`/api/anexos/${id}`),
  save: (clientId, tipo, datos) => api.post('/api/anexos/', { client_id: clientId, tipo, datos }),
  update: (id, tipo, datos) => api.put(`/api/anexos/${id}`, { tipo, datos }),
  delete: (id) => api.delete(`/api/anexos/${id}`),
  exportExcel: (tipo, header, rows) =>
    api.post('/api/anexos/export/excel', { tipo, header, rows }, { responseType: 'blob' }),
  exportPdf: (tipo, header, rows) =>
    api.post('/api/anexos/export/pdf', { tipo, header, rows }, { responseType: 'blob' }),
}

// Clientes importados (compradores de las facturas), aparte de los contribuyentes
export const compradoresAPI = {
  list: (identificacion) => api.get('/api/compradores/', { params: identificacion ? { identificacion } : undefined }),
  listEnriquecido: (identificacion) => api.get('/api/compradores/enriquecido', { params: identificacion ? { identificacion } : undefined }),
  enriquecerActividades: (identificacion) => api.post('/api/compradores/enriquecer-actividades', null, { params: identificacion ? { identificacion } : undefined }),
  sync: () => api.post('/api/compradores/sync'),
  delete: (id) => api.delete(`/api/compradores/${id}`),
}

// Rebajas y exenciones ICE (ingredientes por producto)
export const rebajasAPI = {
  list: (identificacion, producto) => api.get('/api/rebajas/', { params: { identificacion, producto } }),
  verificarRuc: (ruc) => api.get('/api/rebajas/verificar-ruc', { params: { ruc } }),
  create: (entry) => api.post('/api/rebajas/', entry),
  bulk: (entry) => api.post('/api/rebajas/bulk', entry),
  parseFile: (identificacion, producto, file) => {
    const fd = new FormData()
    fd.append('file', file); fd.append('identificacion', identificacion); fd.append('producto', producto)
    return api.post('/api/rebajas/parse-file', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
  },
  update: (id, entry) => api.put(`/api/rebajas/${id}`, entry),
  delete: (id) => api.delete(`/api/rebajas/${id}`),
  // Catálogo reutilizable de proveedores (RUC → nombre + calificado)
  listProveedores: (identificacion) => api.get('/api/rebajas/proveedores', { params: { identificacion } }),
  upsertProveedor: (entry) => api.put('/api/rebajas/proveedores', entry),
  deleteProveedor: (id) => api.delete(`/api/rebajas/proveedores/${id}`),
  verificarTodos: (identificacion, producto) => api.post('/api/rebajas/proveedores/verificar-todos', null, { params: { identificacion, producto } }),
  enriquecerActProveedores: (identificacion) => api.post('/api/rebajas/proveedores/enriquecer-actividades', null, { params: { identificacion } }),
  subirDocProveedor: ({ identificacion, ruc, nombre, calificado, vigente_hasta, file }) => {
    const fd = new FormData()
    fd.append('file', file); fd.append('identificacion', identificacion)
    if (ruc && String(ruc).trim()) fd.append('ruc', String(ruc).trim())
    if (nombre) fd.append('nombre', nombre)
    if (calificado != null) fd.append('calificado', calificado)
    if (vigente_hasta) fd.append('vigente_hasta', vigente_hasta)
    return api.post('/api/rebajas/proveedores/documento', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
  },
  docUrl: (path) => api.get('/api/rebajas/proveedores/documento-url', { params: { path } }),
  // Condiciones normativas del producto (cerveza / nueva marca / cupo anual SRI)
  getCondiciones: (identificacion, producto) => api.get('/api/rebajas/producto', { params: { identificacion, producto } }),
  setCondiciones: (entry) => api.put('/api/rebajas/producto', entry),
}

// Normativa (cuerpos legales consultables: LRTI, Reglamento, normativa vigente)
export const normativaAPI = {
  list: () => api.get('/api/normativa/'),
  pagina: (slug, num) => api.get(`/api/normativa/${slug}/pagina/${num}`),
  buscar: (slug, q) => api.get(`/api/normativa/${slug}/buscar`, { params: { q } }),
  pdfUrl: (slug) => api.get(`/api/normativa/${slug}/pdf`),
  reemplazar: (slug, file) => {
    const fd = new FormData()
    fd.append('file', file)
    return api.post(`/api/normativa/${slug}/reemplazar`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
  },
}

// REPORTES: honorarios a cobrar por contribuyente y concepto (servicio)
export const reportesAPI = {
  // Honorarios del período (mes/año). Sin período = el mes en curso.
  cobros: (mes, anio) => api.get('/api/reportes/cobros', { params: { mes, anio } }),
  guardarCobro: (entry) => api.put('/api/reportes/cobros', entry),   // entry.mes/anio = período a escribir
  borrarCobro: (identificacion, producto, mes, anio) => api.delete('/api/reportes/cobros', { params: { identificacion, producto, mes, anio } }),
  setClienteIva: (clientId, iva_incluido) => api.put(`/api/reportes/cliente-iva/${clientId}`, null, { params: { iva_incluido } }),
  enviarCorreo: (iva_incluido = false, mes, anio) => api.post('/api/reportes/enviar-correo', null, { params: { iva_incluido, mes, anio } }),
  exportExcel: (iva_incluido = false, mes, anio) => api.get('/api/reportes/export/excel', { params: { iva_incluido, mes, anio }, responseType: 'blob' }),
  exportPdf: (iva_incluido = false, mes, anio) => api.get('/api/reportes/export/pdf', { params: { iva_incluido, mes, anio }, responseType: 'blob' }),
  // Informe consolidado del período: lo realizado, lo declarado y los cobros.
  // El alcance y las columnas de valores dependen del rol del usuario.
  general: (mes = null, anio = null) =>
    api.get('/api/reportes/general', { params: { mes: mes ?? undefined, anio: anio ?? undefined } }),
}

// CAPACITACIONES: el cliente solicita una hora ($50+IVA); socio/admin autoriza
export const capacitacionesAPI = {
  crear: (data) => api.post('/api/capacitaciones/', data),
  mias: () => api.get('/api/capacitaciones/mias'),
  listar: (estado) => api.get('/api/capacitaciones/', { params: estado ? { estado } : undefined }),
  actualizar: (id, data) => api.put(`/api/capacitaciones/${id}`, data),
}

// XML originales subidos (re-descarga en ZIP con nombre Tipo_RUC_nombre_mes_año)
// modulo: 'gasto' | 'ingreso_ice' | 'ingreso_iva' | 'retencion'
export const xmlOriginalesAPI = {
  contar: (clientId, modulo) => api.get('/api/xml-originales/contar', { params: { client_id: clientId, modulo } }),
  descargar: (clientId, modulo) => api.get('/api/xml-originales/descargar', { params: { client_id: clientId, modulo }, responseType: 'blob' }),
}

// Declaraciones (IVA / ICE)
export const declaracionesAPI = {
  // credito_adq/credito_ret: override del crédito tributario mes anterior (605/606)
  // diferir_meses: preview de recálculo con N meses de aplazamiento (no persiste hasta save)
  // rebaja_ice/exencion_ice: override manual de rebajas y exenciones ICE (si no, auto del módulo)
  // rebaja_manual/exencion_manual: casillas "aplica" sin cálculo (1/0) — generan advertencia
  // ventas_15/ventas_5/ventas_0: override manual de las ventas (cuando no hay XML)
  calcular: (clientId, tipo, { credito_adq, credito_ret, diferir_meses, rebaja_ice, exencion_ice, rebaja_manual, exencion_manual, ventas_15, ventas_5, ventas_0, factor_prop } = {}) => api.get('/api/declaraciones/calcular', {
    params: { client_id: clientId, tipo, credito_adq, credito_ret, diferir_meses, rebaja_ice, exencion_ice, rebaja_manual, exencion_manual, ventas_15, ventas_5, ventas_0, factor_prop },
  }),
  list: (clientId, tipo) => api.get('/api/declaraciones/', { params: { client_id: clientId, tipo } }),
  // Contribuyentes con declaraciones pendientes en su período más reciente (según permisos).
  pendientes: () => api.get('/api/declaraciones/pendientes'),
  // Historial completo del contribuyente (todos sus períodos/meses), por identificación.
  historial: (identificacion, tipo) => api.get('/api/declaraciones/', { params: { identificacion, tipo } }),
  // Borrador automático (server-side) del período+tipo — recuperable en cualquier dispositivo.
  getBorrador: (clientId, tipo) => api.get('/api/declaraciones/borrador', { params: { client_id: clientId, tipo } }),
  putBorrador: (clientId, tipo, datos) => api.put('/api/declaraciones/borrador', { client_id: clientId, tipo, datos }),
  delBorrador: (clientId, tipo) => api.delete('/api/declaraciones/borrador', { params: { client_id: clientId, tipo } }),
  // Servicios contratados + credencial SRI (admin). reveal=true descifra en un viaje.
  credenciales: (clientId, reveal = false) => api.get('/api/declaraciones/credenciales', { params: { client_id: clientId, reveal: reveal || undefined } }),
  // diferir_pago_meses: 0/1/2/3 (IVA), 0/1 (ICE)
  save: (clientId, tipo, datos, diferir_pago_meses = 0) =>
    api.post('/api/declaraciones/', { client_id: clientId, tipo, datos, diferir_pago_meses }),
  guardarOverrides: (clientId, tipo, vals) =>
    api.put('/api/declaraciones/overrides', { client_id: clientId, tipo, ...vals }),
  delete: (id) => api.delete(`/api/declaraciones/${id}`),
  // Marca/revierte que la declaración ya se subió al portal del SRI (deja de estar pendiente).
  marcarPresentada: (id, presentada = true) => api.put(`/api/declaraciones/${id}/presentada`, { presentada }),
  // Igual pero desde Clientes pendientes (por client_id+tipo): crea el registro si no existía.
  marcarPresentadaDirecta: (client_id, tipo, presentada = true) =>
    api.put('/api/declaraciones/presentada-directa', { client_id, tipo, presentada }),
  // Estado de declaración de un cliente/período: {esperados, presentadas, pendientes, todo_presentado}.
  estadoCliente: (clientId) => api.get('/api/declaraciones/estado-cliente', { params: { client_id: clientId } }),
  // Estado de TODOS los contribuyentes visibles, keyed por identificación (para los badges de lista).
  estadoTodos: () => api.get('/api/declaraciones/estado-todos'),
  exportExcel: (clientId, tipo, ov = {}) => api.get('/api/declaraciones/export/excel', { params: { client_id: clientId, tipo, ...ov }, responseType: 'blob' }),
  exportOficial: (clientId, tipo, ov = {}) => api.get('/api/declaraciones/export/oficial', { params: { client_id: clientId, tipo, ...ov }, responseType: 'blob' }),
  // Pagos aplazados
  listAplazados: (clientId, estado) => api.get('/api/declaraciones/aplazados', {
    params: { client_id: clientId, estado },
  }),
  marcarAplazado: (id, estado) => api.put(`/api/declaraciones/aplazados/${id}`, { estado }),
}

// Devolución de IVA (adultos mayores / personas con discapacidad)
// Permiso de uso de los bajadores del SRI. La llave se incrusta en el marcador
// al generarlo: sin ella —o revocada, o en otra máquina— el marcador no trabaja.
export const bajadoresAPI = {
  // La llave de quien está usando el sistema (403 si no está autorizado).
  miLlave: (cual = 'todos') => api.get('/api/bajadores/mi-llave', { params: { cual } }),
  // Administración (solo el administrador de la plataforma).
  llaves: () => api.get('/api/bajadores/llaves'),
  autorizar: (body) => api.post('/api/bajadores/llaves', body),
  estado: (id, activa) => api.post(`/api/bajadores/llaves/${id}/estado`, { activa }),
  liberarEquipo: (id) => api.post(`/api/bajadores/llaves/${id}/liberar-equipo`),
  usos: (limite = 100) => api.get('/api/bajadores/usos', { params: { limite } }),
}

export const devolucionesIvaAPI = {
  // Comprobantes del período pedido (mes/anio) o, si no se indica, el del cliente
  comprobantes: (clientId, mes = null, anio = null) =>
    api.get('/api/devoluciones-iva/comprobantes', {
      params: { client_id: clientId, mes: mes ?? undefined, anio: anio ?? undefined },
    }),
  // Meses con gasto cargado y en qué estado está la devolución de cada uno
  periodos: (clientId) => api.get('/api/devoluciones-iva/periodos', { params: { client_id: clientId } }),
  // Ingresa el listado que el portal del SRI muestra del período (lo trae el
  // enviador). Es el camino normal: el SRI ya sabe qué comprobantes califican.
  portal: (body) => api.post('/api/devoluciones-iva/portal', body),
  // Prepara de una sola vez la solicitud de varios meses: [{mes, anio}, ...]
  lote: (body) => api.post('/api/devoluciones-iva/solicitudes/lote', body),
  // Qué comprobantes quedan FUERA de la devolución del período (lista completa:
  // reemplaza). Siguen en Gastos; lo que se arma con el listado del SRI es la
  // solicitud. Vive en el servidor: antes era del navegador, y el mes trabajado
  // en una máquina no se veía en otra.
  excluidos: (body) => api.post('/api/devoluciones-iva/excluidos', body),
  // Vacía el período: borra la solicitud y el listado traído del portal.
  limpiarPeriodo: (body) => api.post('/api/devoluciones-iva/periodo/limpiar', body),
  // Reporte de lo procesado y presentado (sin client_id: consolidado del rol)
  reporte: (clientId = null, anio = null) =>
    api.get('/api/devoluciones-iva/reporte', {
      params: { client_id: clientId ?? undefined, anio: anio ?? undefined },
    }),
  // Historial de solicitudes del contribuyente (todos sus períodos)
  solicitudes: (clientId) => api.get('/api/devoluciones-iva/solicitudes', { params: { client_id: clientId } }),
  // Tope mensual y parámetros vigentes. porcentaje solo aplica a discapacidad.
  parametros: (anio, tipo = 'tercera_edad', porcentaje = null) =>
    api.get('/api/devoluciones-iva/parametros', { params: { anio, tipo, porcentaje: porcentaje ?? undefined } }),
  // Crea/reemplaza la solicitud del período (queda en borrador)
  guardar: (body) => api.post('/api/devoluciones-iva/solicitudes', body),
  // Cambia el estado (borrador/presentada/aprobada/rechazada)
  cambiarEstado: (id, estado) => api.put(`/api/devoluciones-iva/solicitudes/${id}`, { estado }),
  eliminar: (id) => api.delete(`/api/devoluciones-iva/solicitudes/${id}`),
  exportExcel: (id) => api.get(`/api/devoluciones-iva/solicitudes/${id}/export/excel`, { responseType: 'blob' }),
  // Catálogo de tipos de gasto a los que se direcciona cada comprobante
  rubros: () => api.get('/api/devoluciones-iva/rubros'),
  // Trae del SRI la actividad económica de los proveedores del contribuyente:
  // es la mejor pista del tipo de gasto. El catastro se consulta por RUC, así
  // que sirve para los proveedores que el sistema ya conoce con número.
  sincronizarActividades: (clientId) =>
    api.post('/api/devoluciones-iva/actividades', null, { params: { client_id: clientId } }),
  // Graba el tipo de gasto elegido a mano para un proveedor, en el momento en
  // que se elige: así la decisión no depende de acordarse de guardar.
  aprenderRubro: (nombreProveedor, rubro) =>
    api.post('/api/devoluciones-iva/rubro-proveedor',
      { nombre_proveedor: nombreProveedor, rubro }),
  // Usuario y clave del portal del SRI del contribuyente: el trámite se hace
  // allá, y salir a buscarla a otra pantalla en cada devolución es fricción.
  claveSri: (clientId) =>
    api.get('/api/devoluciones-iva/clave-sri', { params: { client_id: clientId } }),
  // Los contribuyentes que van en esta pantalla: los marcados con ese tipo de
  // beneficiario y los que todavía no tienen ninguna solicitud.
  contribuyentes: (tipo) =>
    api.get('/api/devoluciones-iva/contribuyentes', { params: { tipo } }),
  // Paquete listo para llevar la solicitud al portal del SRI (lo usa el enviador)
  envio: (id) => api.get(`/api/devoluciones-iva/solicitudes/${id}/envio`),
  // Deja constancia de lo presentado al SRI y devuelve el reporte del envío.
  // `envio` = { comprobantes, monto, fecha_carga, mensaje } según lo que confirmó el portal.
  marcarEnviada: (id, envio = {}) => api.post(`/api/devoluciones-iva/solicitudes/${id}/enviar`, envio),
}

// Recursos (Códigos ICE reemplazable)
export const resourcesAPI = {
  codigosInfo: () => api.get('/api/resources/codigos-ice/info'),
  getCodigos: () => api.get('/api/resources/codigos-ice', { responseType: 'blob' }),
  replaceCodigos: (file) => {
    const fd = new FormData()
    fd.append('file', file)
    return api.post('/api/resources/codigos-ice', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
  },
}

// Classification
export const classificationAPI = {
  list: () => api.get('/api/classification/'),
  create: (ruc, nombre_proveedor, categoria) =>
    api.post('/api/classification/', { ruc, nombre_proveedor, categoria }),
  update: (ruc, nombre_proveedor, categoria) =>
    api.put(`/api/classification/${ruc}`, { ruc, nombre_proveedor, categoria }),
  updateById: (id, ruc, nombre_proveedor, categoria) =>
    api.put(`/api/classification/by-id/${id}`, { ruc, nombre_proveedor, categoria }),
  delete: (ruc) => api.delete(`/api/classification/${ruc}`),
  deleteById: (id) => api.delete(`/api/classification/by-id/${id}`),
  enriquecerActividades: () => api.post('/api/classification/enriquecer-actividades'),
  porContribuyente: (identificacion) => api.get('/api/classification/por-contribuyente', { params: { identificacion } }),
  actividadesRucs: (rucs) => api.post('/api/classification/actividades-rucs', { rucs }),
  // Excepción de clasificación por contribuyente + período (solo este client_id)
  getExcepciones: (clientId) => api.get('/api/classification/excepciones', { params: { client_id: clientId } }),
  setExcepcion: (clientId, ruc, categoria) => api.post('/api/classification/excepcion', { client_id: clientId, ruc, categoria }),
  removeExcepcion: (clientId, ruc) => api.delete('/api/classification/excepcion', { params: { client_id: clientId, ruc } }),
  import: (file) => {
    const formData = new FormData()
    formData.append('file', file)
    return api.post('/api/classification/import', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  exportExcel: () => api.get('/api/classification/export/excel', { responseType: 'blob' }),
  exportPdf: () => api.get('/api/classification/export/pdf', { responseType: 'blob' }),
}

// Memory
export const memoryAPI = {
  get: () => api.get('/api/memory/'),
  save: (mem_key, tarjeta_credito) => api.post('/api/memory/', { mem_key, tarjeta_credito }),
}

// ODOO: facturación directa desde honorarios (solo admin)
export const odooAPI = {
  estado: () => api.get('/api/odoo/estado'),
  empresas: () => api.get('/api/odoo/empresas'),       // compañías emisoras en Odoo
  productos: (q = '') => api.get('/api/odoo/productos', { params: q ? { q } : undefined }),
  cobrosPendientes: () => api.get('/api/odoo/cobros-pendientes'),  // clientes que deben (aviso al iniciar)
  cuentas: (companyId) => api.get('/api/odoo/cuentas', { params: companyId ? { company_id: companyId } : undefined }),  // diarios de banco/efectivo (por empresa)
  cuentasCobrar: (clientes) => api.post('/api/odoo/cuentas-cobrar', { clientes }),  // cuenta x cobrar por cliente (cada uno con su company_id)
  crearCuentaCobrar: (ruc, nombre, company_id, codigo) => api.post('/api/odoo/crear-cuenta-cobrar', { ruc, nombre, company_id, codigo }),
  crearCliente: (ruc, nombre) => api.post('/api/odoo/crear-cliente', { ruc, nombre }),  // crea el cliente (res.partner) en Odoo
  estadoSri: (ids) => api.post('/api/odoo/estado-sri', { ids }),   // verifica/reintenta el envío al SRI
  // Facturas procesadas (emitidas) en Odoo. Con período, solo las de ese mes
  // de honorarios; sin período, las más recientes de todos los meses.
  facturas: (mes, anio) => api.get('/api/odoo/facturas', { params: { mes, anio } }),
  facturar: (body) => api.post('/api/odoo/facturar', body),
  // Cruce mes a mes: honorarios registrados en el sistema ↔ facturas en Odoo
  cruceMensual: (meses = 12, mes, anio) => api.get('/api/odoo/cruce-mensual', { params: { meses, mes, anio } }),
  pendientesPorMes: (meses = 12, mes, anio) => api.get('/api/odoo/pendientes-por-mes', { params: { meses, mes, anio } }),
  porFacturar: (meses = 12, mes, anio) => api.get('/api/odoo/por-facturar', { params: { meses, mes, anio } }),  // meses anteriores al período, sin facturar
  // Reporte del mes: quién declaró (todo/parcial), a quién falta facturarle
  // y qué tiene Odoo emitido, con el comparativo entre lo uno y lo otro.
  reporteFacturacion: (mes, anio) => api.get('/api/odoo/reporte-facturacion', { params: { mes, anio } }),
}

// Helper de descarga de blobs
export const downloadBlob = (data, filename, type) => {
  const url = window.URL.createObjectURL(new Blob([data], type ? { type } : undefined))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.URL.revokeObjectURL(url)
}

export default api
