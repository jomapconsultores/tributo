import { useState, useEffect, useMemo, useRef } from 'react'
import { classificationAPI, downloadBlob } from '../services/api'
import ClassifierTable from '../components/ClassifierTable'
import WorkflowGuide from '../components/WorkflowGuide'
import './Classifier.css'

const CL_STEPS = [
  { icon: '📥', label: 'Gastos (subir TXT/XML)', path: '/' },
  { icon: '🗂', label: 'Clasificar comprobantes', current: true },
  { icon: '📄', label: 'Declaraciones IVA / ICE', path: '/declaracion-iva' },
  { icon: '📑', label: 'Reportes y cobros', path: '/reportes' },
]

export default function Classifier() {
  const [classifications, setClassifications] = useState([])
  // loading = primera carga (sí muestra spinner). refreshing = reload tras edición
  // (mantiene la tabla visible para que el usuario no pierda el contexto).
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [search, setSearch] = useState('')
  const [newEntry, setNewEntry] = useState({ ruc: '', nombre_proveedor: '', categoria: '' })
  // Filtros por columna
  const [fRuc, setFRuc] = useState('')
  const [fNombre, setFNombre] = useState('')
  const [fActividad, setFActividad] = useState('')
  const [fCat, setFCat] = useState('')
  const [fCalif, setFCalif] = useState('todos') // todos | si | no
  const [enriq, setEnriq] = useState('') // texto de progreso del SRI
  const autoRef = useRef(false)

  useEffect(() => { loadClassifications(true) }, [])

  // Auto: al cargar, si faltan actividades del SRI, las trae y graba (una vez)
  useEffect(() => {
    if (autoRef.current || enriq || !classifications.length) return
    if (classifications.some((c) => !String(c.actividad || '').trim())) {
      autoRef.current = true
      traerActividades(true)
    }
  }, [classifications]) // eslint-disable-line react-hooks/exhaustive-deps

  const traerActividades = async (silent = false) => {
    if (enriq) return
    try {
      let restantes = 1, total = 0
      for (let i = 0; i < 400 && restantes > 0; i++) {
        const r = await classificationAPI.enriquecerActividades()
        total += r.data?.actualizados || 0
        restantes = r.data?.restantes ?? 0
        setEnriq(`Trayendo actividad económica del SRI… faltan ${restantes}`)
        if ((r.data?.procesados || 0) === 0) break
      }
      setEnriq('')
      await loadClassifications()
      if (!silent) alert(`✔ Actividad económica del SRI actualizada (${total} proveedores).`)
    } catch (e) {
      setEnriq('')
      if (!silent) alert('Error trayendo actividades: ' + (e.response?.data?.detail || e.message))
    }
  }

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

  // Actualización local de una fila (sin recargar toda la tabla)
  const onRowChange = (id, patch) => setClassifications((arr) => arr.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  const onRowDelete = (id) => setClassifications((arr) => arr.filter((c) => c.id !== id))

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const r = fRuc.trim().toLowerCase()
    const n = fNombre.trim().toLowerCase()
    const a = fActividad.trim().toLowerCase()
    const c = fCat.trim().toLowerCase()
    const inc = (v, t) => String(v || '').toLowerCase().includes(t)
    return classifications.filter((x) => {
      if (q && ![x.ruc, x.nombre_proveedor, x.categoria, x.actividad, x.calif_categoria].some((f) => inc(f, q))) return false
      if (r && !inc(x.ruc, r)) return false
      if (n && !inc(x.nombre_proveedor, n)) return false
      if (a && !inc(x.actividad, a)) return false
      if (c && !inc(x.categoria, c)) return false
      if (fCalif === 'si' && !x.calificado) return false
      if (fCalif === 'no' && x.calificado) return false
      return true
    })
  }, [classifications, search, fRuc, fNombre, fActividad, fCat, fCalif])

  // Listas de sugerencias por columna (datalist) para "buscar viendo la lista"
  const opc = useMemo(() => {
    const u = (k) => [...new Set(classifications.map((c) => String(c[k] || '').trim()).filter((v) => v && v !== '—'))].sort()
    return { ruc: u('ruc'), nombre: u('nombre_proveedor'), act: u('actividad'), cat: u('categoria') }
  }, [classifications])

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
      <WorkflowGuide steps={CL_STEPS} />
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
          <button onClick={traerActividades} className="import-label" disabled={!!enriq} title="Trae la actividad económica principal del SRI por RUC">
            {enriq ? '⏳ ' + enriq : '🏛️ Traer actividad económica (SRI)'}
          </button>
        </div>
        <div className="toolbar-right">
          <button onClick={handleExportExcel} className="export-btn">📥 Exportar Excel</button>
          <button onClick={handleExportPdf} className="export-btn">📄 Exportar PDF</button>
        </div>
      </div>

      {/* Filtros por columna */}
      <div className="cl-filters">
        <input list="opc-ruc" placeholder="Filtrar RUC…" value={fRuc} onChange={(e) => setFRuc(e.target.value)} />
        <input list="opc-nombre" placeholder="Filtrar proveedor…" value={fNombre} onChange={(e) => setFNombre(e.target.value)} />
        <input list="opc-act" placeholder="Filtrar actividad…" value={fActividad} onChange={(e) => setFActividad(e.target.value)} />
        <input list="opc-cat" placeholder="Filtrar categoría…" value={fCat} onChange={(e) => setFCat(e.target.value)} />
        <datalist id="opc-ruc">{opc.ruc.map((v) => <option key={v} value={v} />)}</datalist>
        <datalist id="opc-nombre">{opc.nombre.map((v) => <option key={v} value={v} />)}</datalist>
        <datalist id="opc-act">{opc.act.map((v) => <option key={v} value={v} />)}</datalist>
        <datalist id="opc-cat">{opc.cat.map((v) => <option key={v} value={v} />)}</datalist>
        <select value={fCalif} onChange={(e) => setFCalif(e.target.value)}>
          <option value="todos">Calificación: todas</option>
          <option value="si">Solo calificados</option>
          <option value="no">No calificados</option>
        </select>
        {(fRuc || fNombre || fActividad || fCat || fCalif !== 'todos') && (
          <button className="cl-clear" onClick={() => { setFRuc(''); setFNombre(''); setFActividad(''); setFCat(''); setFCalif('todos') }}>✕ Limpiar</button>
        )}
        <span className="cl-count">{filtered.length} de {classifications.length}</span>
      </div>

      {loading ? (
        <div className="loading">Cargando clasificador…</div>
      ) : (
        <ClassifierTable
          classifications={filtered}
          onClassificationsChange={loadClassifications}
          onRowChange={onRowChange}
          onRowDelete={onRowDelete}
          opcionesCategoria={opc.cat}
        />
      )}
    </div>
  )
}
