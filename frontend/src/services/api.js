import axios from 'axios'

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

// Auth
export const authAPI = {
  login: (email, password) => api.post('/auth/login', { email, password }),
  signup: (email, password) => api.post('/auth/signup', { email, password }),
  logout: () => api.post('/auth/logout'),
}

// Clientes (contribuyentes)
export const clientsAPI = {
  list: () => api.get('/api/clients/'),
  get: (id) => api.get(`/api/clients/${id}`),
  create: (data) => api.post('/api/clients/', data),
  update: (id, data) => api.put(`/api/clients/${id}`, data),
  delete: (id) => api.delete(`/api/clients/${id}`),
  summary: (identificacion) => api.get(`/api/clients/summary/${identificacion}`),
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
  exportExcel: (clientId) =>
    api.get('/api/invoices/export/excel', { params: { client_id: clientId }, responseType: 'blob' }),
  exportPdf: (clientId) =>
    api.get('/api/invoices/export/pdf', { params: { client_id: clientId }, responseType: 'blob' }),
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
