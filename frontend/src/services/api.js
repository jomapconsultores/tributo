import axios from 'axios'
import { clearAll } from './cache'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Interceptor para agregar token a todas las requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
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
}

// Acceso por módulos contratados
export const accessAPI = {
  me: () => api.get('/api/access/me'),
  // Cambia el rol activo del propio usuario (solo entre los roles que el admin le otorgó)
  switchRole: (role) => api.post('/api/access/switch-role', { role }),
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
  cobros: () => api.get('/api/reportes/cobros'),
  guardarCobro: (entry) => api.put('/api/reportes/cobros', entry),
  borrarCobro: (identificacion, producto) => api.delete('/api/reportes/cobros', { params: { identificacion, producto } }),
  setClienteIva: (clientId, iva_incluido) => api.put(`/api/reportes/cliente-iva/${clientId}`, null, { params: { iva_incluido } }),
  enviarCorreo: (iva_incluido = false) => api.post('/api/reportes/enviar-correo', null, { params: { iva_incluido } }),
  exportExcel: (iva_incluido = false) => api.get('/api/reportes/export/excel', { params: { iva_incluido }, responseType: 'blob' }),
  exportPdf: (iva_incluido = false) => api.get('/api/reportes/export/pdf', { params: { iva_incluido }, responseType: 'blob' }),
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
  exportExcel: (clientId, tipo, ov = {}) => api.get('/api/declaraciones/export/excel', { params: { client_id: clientId, tipo, ...ov }, responseType: 'blob' }),
  exportOficial: (clientId, tipo, ov = {}) => api.get('/api/declaraciones/export/oficial', { params: { client_id: clientId, tipo, ...ov }, responseType: 'blob' }),
  // Pagos aplazados
  listAplazados: (clientId, estado) => api.get('/api/declaraciones/aplazados', {
    params: { client_id: clientId, estado },
  }),
  marcarAplazado: (id, estado) => api.put(`/api/declaraciones/aplazados/${id}`, { estado }),
}

// Devolución de IVA (adultos mayores / personas con discapacidad)
export const devolucionesIvaAPI = {
  // Comprobantes del período del cliente + solicitud guardada (si hay)
  comprobantes: (clientId) => api.get('/api/devoluciones-iva/comprobantes', { params: { client_id: clientId } }),
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
  facturas: () => api.get('/api/odoo/facturas'),                   // facturas procesadas (emitidas) en Odoo
  facturar: (body) => api.post('/api/odoo/facturar', body),
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
