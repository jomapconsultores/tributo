import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { invoicesAPI, classificationAPI } from '../services/api'
import InvoiceTable from '../components/InvoiceTable'
import UploadPanel from '../components/UploadPanel'
import './Dashboard.css'

export default function Dashboard({ user, onLogout }) {
  const navigate = useNavigate()
  const [invoices, setInvoices] = useState([])
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState({})

  useEffect(() => {
    loadInvoices()
  }, [])

  const loadInvoices = async () => {
    try {
      const response = await invoicesAPI.list()
      setInvoices(response.data)
      updateStats(response.data)
    } catch (error) {
      console.error('Error loading invoices:', error)
    } finally {
      setLoading(false)
    }
  }

  const updateStats = (data) => {
    const total = data.reduce((sum, inv) => sum + (inv.total || 0), 0)
    setStats({
      count: data.length,
      total: total.toFixed(2),
      duplicates: data.filter(i => i.estado === 'DUPLICADO').length,
      unclassified: data.filter(i => i.clasificacion === 'SIN CLASIFICAR').length,
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
      a.download = 'facturas.xlsx'
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
      a.download = 'resumen.pdf'
      a.click()
    } catch (error) {
      console.error('Error exporting:', error)
    }
  }

  const handleClear = async () => {
    if (window.confirm('¿Está seguro de que desea eliminar todas las facturas?')) {
      try {
        await invoicesAPI.clear()
        setInvoices([])
        setStats({})
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

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div className="header-left">
          <h1>📊 Gestor SRI</h1>
        </div>
        <div className="header-right">
          <span className="user-info">{user.email}</span>
          <button onClick={() => navigate('/clasificador')} className="nav-btn">
            Clasificador
          </button>
          <button onClick={handleLogout} className="logout-btn">
            Cerrar sesión
          </button>
        </div>
      </header>

      <main className="dashboard-content">
        <div className="stats-bar">
          <div className="stat-card">
            <div className="stat-label">Total Facturas</div>
            <div className="stat-value">{stats.count || 0}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Monto Total</div>
            <div className="stat-value">${stats.total || '0.00'}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Sin Clasificar</div>
            <div className="stat-value warning">{stats.unclassified || 0}</div>
          </div>
        </div>

        <UploadPanel
          onProcessTxt={handleProcessTxt}
          onProcessXml={handleProcessXml}
        />

        <div className="actions-bar">
          <button onClick={handleExportExcel} className="action-btn primary">
            📥 Exportar Excel
          </button>
          <button onClick={handleExportPdf} className="action-btn primary">
            📄 Exportar PDF
          </button>
          <button onClick={handleClear} className="action-btn danger">
            🗑 Limpiar Todo
          </button>
        </div>

        {loading ? (
          <div className="loading">Cargando facturas...</div>
        ) : invoices.length === 0 ? (
          <div className="empty-state">
            <p>No hay facturas. Sube un archivo TXT o XMLs para comenzar.</p>
          </div>
        ) : (
          <InvoiceTable
            invoices={invoices}
            onInvoicesChange={loadInvoices}
          />
        )}
      </main>
    </div>
  )
}
