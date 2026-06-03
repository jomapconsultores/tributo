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
  console.log('Token from localStorage:', token ? 'exists' : 'missing')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  } else {
    console.warn('No token found in localStorage')
  }
  return config
}, (error) => {
  return Promise.reject(error)
})

// Auth
export const authAPI = {
  login: (email, password) => api.post('/auth/login', { email, password }),
  signup: (email, password) => api.post('/auth/signup', { email, password }),
  logout: () => api.post('/auth/logout'),
}

// Invoices
export const invoicesAPI = {
  list: (skip = 0, limit = 50) => api.get('/api/invoices/', { params: { skip, limit } }),
  processTxt: (file) => {
    const formData = new FormData()
    formData.append('file', file)
    return api.post('/api/invoices/process-txt', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  processXml: (files) => {
    const formData = new FormData()
    files.forEach((file, index) => {
      formData.append('files', file)
    })
    return api.post('/api/invoices/process-xml', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  update: (id, data) => api.put(`/api/invoices/${id}`, data),
  delete: (id) => api.delete(`/api/invoices/${id}`),
  clear: () => api.delete('/api/invoices/clear'),
  exportExcel: () => api.get('/api/invoices/export/excel', { responseType: 'blob' }),
  exportPdf: () => api.get('/api/invoices/export/pdf', { responseType: 'blob' }),
}

// Classification
export const classificationAPI = {
  list: () => api.get('/api/classification/'),
  create: (ruc, nombre_proveedor, categoria) =>
    api.post('/api/classification/', { ruc, nombre_proveedor, categoria }),
  update: (ruc, nombre_proveedor, categoria) =>
    api.put(`/api/classification/${ruc}`, { ruc, nombre_proveedor, categoria }),
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
  save: (mem_key, tarjeta_credito) =>
    api.post('/api/memory/', { mem_key, tarjeta_credito }),
}

export default api
