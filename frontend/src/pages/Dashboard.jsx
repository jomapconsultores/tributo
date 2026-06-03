import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { invoicesAPI } from '../services/api'
import InvoiceTable from '../components/InvoiceTable'
import UploadPanel from '../components/UploadPanel'
import './Dashboard.css'

export default function Dashboard({ user, onLogout }) {
  const navigate = useNavigate()
  const [invoices, setInvoices] = useState([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [limit, setLimit] = useState(20)
  const [searchTerm, setSearchTerm] = useState('')
  const [filterClassification, setFilterClassification] = useState('ALL')

  useEffect(() => {
    loadInvoices(page)
  }, [page])

  const loadInvoices = async (pageNum) => {
    setLoading(true)
    try {
      const skip = (pageNum - 1) * limit
      const response = await invoicesAPI.list(skip, limit)
      setInvoices(response.data?.data || [])
      setTotal(response.data?.total || 0)
      setPage(pageNum)
    } catch (error) {
      console.error('Error loading invoices:', error)
    } finally {
      setLoading(false)
    }
  }

  const getFilteredInvoices = () => {
    let filtered = invoices

    if (searchTerm) {
      filtered = filtered.filter(inv =>
        inv.nombre_proveedor?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        inv.ruc_proveedor?.includes(searchTerm)
      )
    }

    if (filterClassification !== 'ALL') {
      if (filterClassification === 'UNCLASSIFIED') {
        filtered = filtered.filter(inv => !inv.clasificacion || inv.clasificacion === 'SIN CLASIFICAR')
      } else {
        filtered = filtered.filter(inv => inv.clasificacion === filterClassification)
      }
    }

    return filtered
  }

  const filteredInvoices = getFilteredInvoices()
  const unclassified = invoices.filter(i => !i.clasificacion || i.clasificacion === 'SIN CLASIFICAR').length
  const totalAmount = invoices.reduce((sum, inv) => sum + (inv.total || 0), 0)

  const handleExportExcel = async () => {
    try {
      const blob = await invoicesAPI.exportExcel()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `facturas_${new Date().toISOString().split('T')[0]}.xlsx`
      a.click()
    } catch (error) {
      console.error('Error:', error)
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
      console.error('Error:', error)
    }
  }

  const handleClear = async () => {
    if (window.confirm('¿Está seguro de que desea eliminar TODAS las facturas?')) {
      try {
        await invoicesAPI.clear()
        setInvoices([])
        setTotal(0)
      } catch (error) {
        console.error('Error:', error)
      }
    }
  }

  return (
    <div className="dashboard">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <h1>Facturas SRI</h1>
        </div>
        <div className="header-right">
          <button onClick={() => navigate('/clasificador')} className="link-btn">Clasificador</button>
          <button onClick={onLogout} className="link-btn logout">Salir</button>
        </div>
      </header>

      {/* Main Content */}
      <main className="content">
        {/* Quick Stats */}
        <div className="mini-stats">
          <div className="stat">
            <span className="stat-num">{total}</span>
            <span className="stat-label">Facturas</span>
          </div>
          <div className="stat">
            <span className="stat-num">${totalAmount.toFixed(0)}</span>
            <span className="stat-label">Total</span>
          </div>
          <div className="stat warning">
            <span className="stat-num">{unclassified}</span>
            <span className="stat-label">Sin clasificar</span>
          </div>
        </div>

        {/* Upload */}
        <UploadPanel
          onProcessTxt={async (file) => {
            await invoicesAPI.processTxt(file)
            loadInvoices(1)
          }}
          onProcessXml={async (files) => {
            await invoicesAPI.processXml(files)
            loadInvoices(1)
          }}
        />

        {/* Controls */}
        <div className="controls">
          <input
            type="text"
            placeholder="🔍 Buscar proveedor o RUC..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="search"
          />
          <select value={filterClassification} onChange={(e) => setFilterClassification(e.target.value)} className="select">
            <option value="ALL">Todas</option>
            <option value="UNCLASSIFIED">Sin clasificar</option>
          </select>
          <button onClick={handleExportExcel} className="btn-small">Excel</button>
          <button onClick={handleExportPdf} className="btn-small">PDF</button>
          <button onClick={handleClear} className="btn-small danger">Limpiar</button>
        </div>

        {/* Table */}
        {loading ? (
          <div className="loading">Cargando...</div>
        ) : filteredInvoices.length === 0 ? (
          <div className="empty">Sin facturas. Sube un archivo para comenzar.</div>
        ) : (
          <>
            <InvoiceTable invoices={filteredInvoices} onInvoicesChange={() => loadInvoices(page)} />

            {/* Pagination */}
            {total > limit && (
              <div className="pagination">
                <button onClick={() => loadInvoices(page - 1)} disabled={page === 1} className="pag-btn">← Anterior</button>
                <span className="pag-info">Página {page} de {Math.ceil(total / limit)}</span>
                <button onClick={() => loadInvoices(page + 1)} disabled={page * limit >= total} className="pag-btn">Siguiente →</button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
