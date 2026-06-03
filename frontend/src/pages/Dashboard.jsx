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
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const limit = 20

  useEffect(() => {
    loadInvoices(1)
  }, [])

  const loadInvoices = async (pageNum) => {
    setLoading(true)
    setError('')
    try {
      const skip = (pageNum - 1) * limit
      const response = await invoicesAPI.list(skip, limit)
      const data = response.data?.data || []
      const tot = response.data?.total || 0
      setInvoices(data)
      setTotal(tot)
      setPage(pageNum)
    } catch (err) {
      const msg = err.response?.data?.detail || err.message || 'Error desconocido'
      setError('Error al cargar facturas: ' + msg)
      console.error('loadInvoices error:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleUploadTxt = async (file) => {
    setError('')
    try {
      const res = await invoicesAPI.processTxt(file)
      const d = res.data
      alert(`Procesadas: ${d.processed} | Nuevas: ${d.new} | Duplicadas: ${d.duplicates} | Errores SRI: ${d.errors}`)
      loadInvoices(1)
    } catch (err) {
      alert('Error: ' + (err.response?.data?.detail || err.message))
    }
  }

  const handleUploadXml = async (files) => {
    setError('')
    try {
      const res = await invoicesAPI.processXml(files)
      alert(`Nuevas: ${res.data.new} | Duplicadas: ${res.data.duplicates}`)
      loadInvoices(1)
    } catch (err) {
      alert('Error: ' + (err.response?.data?.detail || err.message))
    }
  }

  const handleExportExcel = async () => {
    try {
      const response = await invoicesAPI.exportExcel()
      const url = window.URL.createObjectURL(new Blob([response.data]))
      const a = document.createElement('a')
      a.href = url
      a.download = `facturas_${new Date().toISOString().split('T')[0]}.xlsx`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch (err) {
      alert('Error Excel: ' + (err.response?.data?.detail || err.message))
    }
  }

  const handleExportPdf = async () => {
    try {
      const response = await invoicesAPI.exportPdf()
      const url = window.URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `facturas_${new Date().toISOString().split('T')[0]}.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch (err) {
      alert('Error PDF: ' + (err.response?.data?.detail || err.message))
    }
  }

  const handleClear = async () => {
    if (!window.confirm('¿Eliminar TODAS las facturas?')) return
    try {
      await invoicesAPI.clear()
      setInvoices([])
      setTotal(0)
    } catch (err) {
      alert('Error: ' + (err.response?.data?.detail || err.message))
    }
  }

  const unclassified = invoices.filter(i => !i.clasificacion || i.clasificacion === 'SIN CLASIFICAR').length
  const totalAmount = invoices.reduce((sum, inv) => sum + (parseFloat(inv.total) || 0), 0)

  return (
    <div className="dashboard">
      <header className="header">
        <h1>Facturas SRI</h1>
        <div className="header-right">
          <span style={{fontSize:'0.85em', color:'#888', marginRight:'8px'}}>{user?.email}</span>
          <button onClick={() => navigate('/clasificador')} className="link-btn">Clasificador</button>
          <button onClick={onLogout} className="link-btn logout">Salir</button>
        </div>
      </header>

      <main className="content">
        {error && (
          <div style={{background:'#fff0f0', border:'1px solid #ffaaaa', padding:'10px 14px', borderRadius:'6px', color:'#c00', fontSize:'0.9em'}}>
            ⚠ {error}
          </div>
        )}

        <div className="mini-stats">
          <div className="stat">
            <span className="stat-num">{total}</span>
            <span className="stat-label">Total facturas</span>
          </div>
          <div className="stat">
            <span className="stat-num">${totalAmount.toFixed(2)}</span>
            <span className="stat-label">Monto</span>
          </div>
          <div className="stat warning">
            <span className="stat-num">{unclassified}</span>
            <span className="stat-label">Sin clasificar</span>
          </div>
        </div>

        <UploadPanel onProcessTxt={handleUploadTxt} onProcessXml={handleUploadXml} />

        <div className="controls">
          <button onClick={handleExportExcel} className="btn-small">⬇ Excel</button>
          <button onClick={handleExportPdf} className="btn-small">⬇ PDF</button>
          <button onClick={handleClear} className="btn-small danger">🗑 Limpiar todo</button>
        </div>

        <div className="table-section">
          {loading ? (
            <div className="loading">Cargando facturas...</div>
          ) : error ? null : invoices.length === 0 ? (
            <div className="empty">No hay facturas. Sube un TXT o XML para comenzar.</div>
          ) : (
            <>
              <InvoiceTable
                invoices={invoices}
                onInvoicesChange={() => loadInvoices(page)}
              />
              {total > limit && (
                <div className="pagination">
                  <button onClick={() => loadInvoices(page - 1)} disabled={page === 1} className="pag-btn">← Anterior</button>
                  <span className="pag-info">Página {page} de {Math.ceil(total / limit)} — {total} facturas</span>
                  <button onClick={() => loadInvoices(page + 1)} disabled={page * limit >= total} className="pag-btn">Siguiente →</button>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  )
}
