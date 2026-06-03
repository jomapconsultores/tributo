import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { classificationAPI } from '../services/api'
import ClassifierTable from '../components/ClassifierTable'
import './Classifier.css'

export default function Classifier({ user, onLogout }) {
  const navigate = useNavigate()
  const [classifications, setClassifications] = useState([])
  const [loading, setLoading] = useState(true)
  const [newEntry, setNewEntry] = useState({ ruc: '', nombre_proveedor: '', categoria: '' })

  useEffect(() => {
    loadClassifications()
  }, [])

  const loadClassifications = async () => {
    try {
      const response = await classificationAPI.list()
      setClassifications(response.data)
    } catch (error) {
      console.error('Error loading classifications:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleAddEntry = async (e) => {
    e.preventDefault()
    if (!newEntry.ruc || !newEntry.categoria) {
      alert('RUC y Categoría son obligatorios')
      return
    }

    try {
      await classificationAPI.create(
        newEntry.ruc,
        newEntry.nombre_proveedor,
        newEntry.categoria
      )
      setNewEntry({ ruc: '', nombre_proveedor: '', categoria: '' })
      loadClassifications()
    } catch (error) {
      console.error('Error adding entry:', error)
    }
  }

  const handleImportExcel = async (file) => {
    try {
      const response = await classificationAPI.import(file)
      alert(`Se importaron ${response.data.imported} registros`)
      loadClassifications()
    } catch (error) {
      console.error('Error importing:', error)
    }
  }

  const handleExportExcel = async () => {
    try {
      const response = await classificationAPI.exportExcel()
      const url = window.URL.createObjectURL(new Blob([response.data]))
      const a = document.createElement('a')
      a.href = url
      a.download = 'clasificador.xlsx'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch (error) {
      alert('Error al exportar Excel: ' + (error.response?.data?.detail || error.message))
    }
  }

  const handleExportPdf = async () => {
    try {
      const response = await classificationAPI.exportPdf()
      const url = window.URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }))
      const a = document.createElement('a')
      a.href = url
      a.download = 'clasificador.pdf'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch (error) {
      alert('Error al exportar PDF: ' + (error.response?.data?.detail || error.message))
    }
  }

  const handleLogout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('userId')
    localStorage.removeItem('email')
    onLogout()
  }

  return (
    <div className="classifier">
      <header className="classifier-header">
        <div className="header-left">
          <h1>📋 Clasificador de RUCs</h1>
        </div>
        <div className="header-right">
          <button onClick={() => navigate('/')} className="nav-btn">
            Dashboard
          </button>
          <button onClick={handleLogout} className="logout-btn">
            Cerrar sesión
          </button>
        </div>
      </header>

      <main className="classifier-content">
        <div className="add-entry-section">
          <h2>Agregar Nueva Entrada</h2>
          <form onSubmit={handleAddEntry} className="add-entry-form">
            <input
              type="text"
              placeholder="RUC (13 dígitos)"
              value={newEntry.ruc}
              onChange={(e) => setNewEntry({ ...newEntry, ruc: e.target.value })}
              maxLength="13"
            />
            <input
              type="text"
              placeholder="Nombre Proveedor"
              value={newEntry.nombre_proveedor}
              onChange={(e) => setNewEntry({ ...newEntry, nombre_proveedor: e.target.value })}
            />
            <input
              type="text"
              placeholder="Categoría"
              value={newEntry.categoria}
              onChange={(e) => setNewEntry({ ...newEntry, categoria: e.target.value })}
            />
            <button type="submit" className="add-btn">
              ➕ Agregar
            </button>
          </form>
        </div>

        <div className="toolbar">
          <div className="toolbar-left">
            <label htmlFor="file-import" className="import-label">
              📥 Importar Excel
            </label>
            <input
              id="file-import"
              type="file"
              accept=".xlsx"
              onChange={(e) => {
                if (e.target.files?.[0]) {
                  handleImportExcel(e.target.files[0])
                }
              }}
              style={{ display: 'none' }}
            />
          </div>
          <div className="toolbar-right">
            <button onClick={handleExportExcel} className="export-btn">
              📥 Exportar Excel
            </button>
            <button onClick={handleExportPdf} className="export-btn">
              📄 Exportar PDF
            </button>
          </div>
        </div>

        {loading ? (
          <div className="loading">Cargando clasificador...</div>
        ) : (
          <ClassifierTable
            classifications={classifications}
            onClassificationsChange={loadClassifications}
          />
        )}
      </main>
    </div>
  )
}
