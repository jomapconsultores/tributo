import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { invoicesAPI, classificationAPI } from '../services/api'
import InvoiceTable from '../components/InvoiceTable'
import UploadPanel from '../components/UploadPanel'
import './Dashboard.css'

export default function Dashboard({ user, onLogout }) {
  const navigate = useNavigate()
  const [invoices, setInvoices] = useState([])
  const [filteredInvoices, setFilteredInvoices] = useState([])
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState({})
  const [searchTerm, setSearchTerm] = useState('')
  const [filterClassification, setFilterClassification] = useState('ALL')
  const [showUnclassified, setShowUnclassified] = useState(false)

  useEffect(() => {
    loadInvoices()
  }, [])

  useEffect(() => {
    applyFilters()
  }, [invoices, searchTerm, filterClassification, showUnclassified])

  const loadInvoices = async () => {
    try {
      const response = await invoicesAPI.list(0, 500)
      setInvoices(response.data || [])
    } catch (error) {
      console.error('Error loading invoices:', error)
    } finally {
      setLoading(false)
    }
  }

  const applyFilters = () => {
    let filtered = invoices

    // Filtro de búsqueda
    if (searchTerm) {
      filtered = filtered.filter(inv =>
        inv.nombre_proveedor?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        inv.ruc_proveedor?.includes(searchTerm) ||
        inv.concepto?.toLowerCase().includes(searchTerm.toLowerCase())
      )
    }

    // Filtro de clasificación
    if (filterClassification !== 'ALL') {
      if (filterClassification === 'UNCLASSIFIED') {
        filtered = filtered.filter(inv =>
          !inv.clasificacion || inv.clasificacion === 'SIN CLASIFICAR'
        )
      } else {
        filtered = filtered.filter(inv => inv.clasificacion === filterClassification)
      }
    }

    setFilteredInvoices(filtered)
    updateStats(filtered)
  }

  const updateStats = (data) => {
    const total = data.reduce((sum, inv) => sum + (inv.total || 0), 0)
    const unclassified = data.filter(i => !i.clasificacion || i.clasificacion === 'SIN CLASIFICAR').length
    setStats({
      count: data.length,
      total: total.toFixed(2),
      unclassified,
    })
  }

  const handleProcessTxt = async (file) => {
    try {
      await invoicesAPI.processTxt(file)
      loadInvoices()
    } catch (error) {
      console.error('Error processing txt:', error)
    }
  }

  const handleProcessXml = async (files) => {
    try {
      await invoicesAPI.processXml(files)
      loadInvoices()
    } catch (error) {
      console.error('Error processing xml:', error)
    }
  }

  const handleExportExcel = async () => {
    try {
      const blob = await invoicesAPI.exportExcel()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `facturas_${new Date().toISOString().split('T')[0]}.xlsx`
      a.click()
    } catch (error) {
      console.error('Error exporting:', error)
    }
  }

  const handleExportPdf = async () => {
    try {
      const blob = await invoicesAPI.exportPdf()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `resumen_${new Date().toISOString().split('T')[0]}.pdf`
      a.click()
    } catch (error) {
      console.error('Error exporting:', error)
    }
  }

  const handleClear = async () => {
    if (window.confirm('¿Está seguro de que desea eliminar TODAS las facturas?')) {
      try {
        await invoicesAPI.clear()
        setInvoices([])
      } catch (error) {
        console.error('Error clearing:', error)
      }
    }
  }

  const handleLogout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('userId')
    localStorage.removeItem('email')
    onLogout()
  }

  const getClassifications = () => {
    const classifications = new Set(invoices
      .filter(i => i.clasificacion && i.clasificacion !== 'SIN CLASIFICAR')
      .map(i => i.clasificacion))
    return Array.from(classifications).sort()
  }

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div className="header-content">
          <h1>📊 Gestor SRI - Facturas</h1>
          <p className="subtitle">Procesa, clasifica y exporta tus facturas</p>
        </div>
        <div className="header-actions">
          <span className="user-email">{user.email}</span>
          <button onClick={() => navigate('/clasificador')} className="btn-nav">
            📋 Clasificador
          </button>
          <button onClick={handleLogout} className="btn-logout">
            Cerrar sesión
          </button>
        </div>
      </header>

      <main className="dashboard-content">
        {/* Stats Bar */}
        <div className="stats-container">
          <div className="stat-card primary">
            <div className="stat-icon">📁</div>
            <div className="stat-info">
              <div className="stat-label">Total Facturas</div>
              <div className="stat-value">{stats.count || 0}</div>
            </div>
          </div>
          <div className="stat-card success">
            <div className="stat-icon">💰</div>
            <div className="stat-info">
              <div className="stat-label">Monto Total</div>
              <div className="stat-value">${stats.total || '0.00'}</div>
            </div>
          </div>
          <div className="stat-card warning">
            <div className="stat-icon">⚠️</div>
            <div className="stat-info">
              <div className="stat-label">Sin Clasificar</div>
              <div className="stat-value">{stats.unclassified || 0}</div>
            </div>
          </div>
        </div>

        {/* Upload Panel */}
        <UploadPanel
          onProcessTxt={handleProcessTxt}
          onProcessXml={handleProcessXml}
        />

        {/* Filters and Actions */}
        <div className="filters-section">
          <div className="search-bar">
            <input
              type="text"
              placeholder="🔍 Buscar por proveedor, RUC o concepto..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="search-input"
            />
          </div>

          <div className="filter-group">
            <select
              value={filterClassification}
              onChange={(e) => setFilterClassification(e.target.value)}
              className="filter-select"
            >
              <option value="ALL">Todas las categorías</option>
              <option value="UNCLASSIFIED">Sin clasificar</option>
              {getClassifications().map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div className="actions-group">
            <button onClick={handleExportExcel} className="btn btn-primary" title="Descargar Excel">
              📥 Excel
            </button>
            <button onClick={handleExportPdf} className="btn btn-primary" title="Descargar PDF">
              📄 PDF
            </button>
            <button onClick={handleClear} className="btn btn-danger" title="Limpiar todo">
              🗑 Limpiar
            </button>
          </div>
        </div>

        {/* Table */}
        {loading ? (
          <div className="loading-state">
            <div className="spinner"></div>
            <p>Cargando facturas...</p>
          </div>
        ) : filteredInvoices.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📭</div>
            <h3>Sin facturas</h3>
            <p>Sube un archivo TXT con claves SRI o importa XMLs para comenzar</p>
          </div>
        ) : (
          <InvoiceTable
            invoices={filteredInvoices}
            onInvoicesChange={loadInvoices}
          />
        )}
      </main>
    </div>
  )
}
