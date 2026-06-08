import { useState, useEffect, useMemo } from 'react'
import { classificationAPI, downloadBlob } from '../services/api'
import ClassifierTable from '../components/ClassifierTable'
import './Classifier.css'

export default function Classifier() {
  const [classifications, setClassifications] = useState([])
  // loading = primera carga (sí muestra spinner). refreshing = reload tras edición
  // (mantiene la tabla visible para que el usuario no pierda el contexto).
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [search, setSearch] = useState('')
  const [newEntry, setNewEntry] = useState({ ruc: '', nombre_proveedor: '', categoria: '' })

  useEffect(() => { loadClassifications(true) }, [])

  const loadClassifications = async (initial = false) => {
    if (initial) setLoading(true)
    else setRefreshing(true)
    try {
      const response = await classificationAPI.list()
      setClassifications(response.data || [])
    } catch (error) {
      console.error('Error loading classifications:', error)
    } finally {
      if (initial) setLoading(false)
      else setRefreshing(false)
    }
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return classifications
    const q = search.toLowerCase()
    return classifications.filter((c) =>
      [c.ruc, c.nombre_proveedor, c.categoria].some((f) => String(f || '').toLowerCase().includes(q))
    )
  }, [classifications, search])

  const handleAddEntry = async (e) => {
    e.preventDefault()
    if (!newEntry.ruc || !newEntry.categoria) {
      alert('RUC y Categoría son obligatorios')
      return
    }
    try {
      const res = await classificationAPI.create(newEntry.ruc, newEntry.nombre_proveedor, newEntry.categoria)
      const n = res?.data?.reclasificadas
      setNewEntry({ ruc: '', nombre_proveedor: '', categoria: '' })
      loadClassifications()
      if (n > 0) alert(`✔ ${n} factura(s) SIN CLASIFICAR de este RUC se actualizaron a "${newEntry.categoria.toUpperCase()}"`)
    } catch (error) {
      alert('Error: ' + (error.response?.data?.detail || error.message))
    }
  }

  const handleImportExcel = async (file) => {
    try {
      const response = await classificationAPI.import(file)
      const recl = response.data.reclasificadas ? ` · ${response.data.reclasificadas} factura(s) reclasificadas` : ''
      alert(`Importados: ${response.data.imported} · Actualizados: ${response.data.updated}${recl}`)
      loadClassifications()
    } catch (error) {
      alert('Error al importar: ' + (error.response?.data?.detail || error.message))
    }
  }

  const handleExportExcel = async () => {
    try {
      const response = await classificationAPI.exportExcel()
      downloadBlob(response.data, 'clasificador.xlsx')
    } catch (error) {
      alert('Error al exportar Excel: ' + (error.response?.data?.detail || error.message))
    }
  }

  const handleExportPdf = async () => {
    try {
      const response = await classificationAPI.exportPdf()
      downloadBlob(response.data, 'clasificador.pdf', 'application/pdf')
    } catch (error) {
      alert('Error al exportar PDF: ' + (error.response?.data?.detail || error.message))
    }
  }

  return (
    <div className="classifier">
      <header className="classifier-header">
        <div>
          <h1>🏷️ Clasificador de Gastos {refreshing && <span className="classifier-refresh-indic">↻ actualizando…</span>}</h1>
          <p className="classifier-sub">{classifications.length} RUCs · clic en cualquier celda (incluido el RUC) para editar</p>
        </div>
      </header>

      <div className="add-entry-section">
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
          <button type="submit" className="add-btn">➕ Agregar</button>
        </form>
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <input
            className="classifier-search"
            placeholder="🔍 Buscar RUC, proveedor o categoría…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label htmlFor="file-import" className="import-label">📥 Importar Excel</label>
          <input
            id="file-import"
            type="file"
            accept=".xlsx"
            onChange={(e) => { if (e.target.files?.[0]) handleImportExcel(e.target.files[0]) }}
            style={{ display: 'none' }}
          />
        </div>
        <div className="toolbar-right">
          <button onClick={handleExportExcel} className="export-btn">📥 Exportar Excel</button>
          <button onClick={handleExportPdf} className="export-btn">📄 Exportar PDF</button>
        </div>
      </div>

      {loading ? (
        <div className="loading">Cargando clasificador…</div>
      ) : (
        <ClassifierTable
          classifications={filtered}
          onClassificationsChange={loadClassifications}
        />
      )}
    </div>
  )
}
