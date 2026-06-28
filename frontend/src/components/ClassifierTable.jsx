import { useState, useRef, useEffect } from 'react'
import { classificationAPI } from '../services/api'
import './ClassifierTable.css'

const PAGE_SIZE = 50

export default function ClassifierTable({ classifications, onClassificationsChange, onRowChange = null, onRowDelete = null, opcionesCategoria = null }) {
  // Opciones existentes para desplegar al editar (clasificación ágil)
  const cats = (opcionesCategoria
    || [...new Set((classifications || []).map((c) => String(c.categoria || '').trim()).filter(Boolean))]).sort()
  const noms = [...new Set((classifications || []).map((c) => String(c.nombre_proveedor || '').trim()).filter(Boolean))].sort()
  // Paginación (acelera el render cuando hay muchos RUC)
  const [page, setPage] = useState(1)
  const total = (classifications || []).length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  useEffect(() => { setPage(1) }, [total]) // al cambiar filtro/cantidad, vuelve a la 1
  const pageSafe = Math.min(page, totalPages)
  const pageRows = (classifications || []).slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE)
  const [edit, setEdit] = useState({ id: null, field: null })
  const [value, setValue] = useState('')
  const [vigOpen, setVigOpen] = useState(null) // id cuya vigencia se muestra
  const [actOpen, setActOpen] = useState(null) // id cuya actividad se ve completa
  const [copied, setCopied] = useState(null)   // clave recién copiada (feedback)
  const escRef = useRef(false)                  // se presionó Esc (no guardar al blur)

  const copiar = (texto, clave) => {
    const t = String(texto ?? '').trim()
    if (!t || t === '-') return
    try { navigator.clipboard?.writeText(t) } catch { /* */ }
    setCopied(clave)
    setTimeout(() => setCopied((k) => (k === clave ? null : k)), 1000)
  }

  const startEdit = (id, field, current) => {
    setEdit({ id, field })
    setValue(current ?? '')
  }

  const cancel = () => setEdit({ id: null, field: null })

  const handleSave = async (item) => {
    const { field } = edit
    const ruc = field === 'ruc' ? value.trim() : item.ruc
    const nombre = field === 'nombre_proveedor' ? value : item.nombre_proveedor
    const categoria = field === 'categoria' ? value : item.categoria
    cancel()
    try {
      const res = await classificationAPI.updateById(item.id, ruc, nombre, categoria)
      // Solo actualiza ESA fila en pantalla (no recarga toda la tabla → mucho más rápido)
      if (onRowChange) onRowChange(item.id, { ruc, nombre_proveedor: nombre, categoria })
      else onClassificationsChange()
      const n = res?.data?.reclasificadas
      if (n > 0) alert(`✔ ${n} factura(s) SIN CLASIFICAR de este RUC se actualizaron a "${categoria.toUpperCase()}"`)
    } catch (error) {
      alert('Error al guardar: ' + (error.response?.data?.detail || error.message))
      onClassificationsChange() // si falló, recargar para volver al estado real
    }
  }

  const handleDelete = async (item) => {
    if (!window.confirm(`¿Eliminar el RUC ${item.ruc}?`)) return
    try {
      await classificationAPI.deleteById(item.id)
      if (onRowDelete) onRowDelete(item.id)
      else onClassificationsChange()
    } catch (error) {
      alert('Error al eliminar: ' + (error.response?.data?.detail || error.message))
    }
  }

  const cell = (item, field, extraClass = '', placeholder = '-') => {
    const isEditing = edit.id === item.id && edit.field === field
    if (isEditing) {
      return (
        <input
          autoFocus
          value={value}
          list={field === 'categoria' ? 'cl-cats' : field === 'nombre_proveedor' ? 'cl-noms' : undefined}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => { if (escRef.current) { escRef.current = false; cancel(); return } handleSave(item) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave(item)
            if (e.key === 'Escape') { escRef.current = true; cancel() }  // vuelve al estado normal
          }}
          className="inline-edit"
        />
      )
    }
    const clave = `${item.id}:${field}`
    const vacio = !String(item[field] || '').trim()
    return (
      <span
        className={`editable ${extraClass} ${copied === clave ? 'copied' : ''} ${vacio && placeholder !== '-' ? 'sin-clasif' : ''}`}
        title={vacio ? 'Doble clic para clasificar' : 'Clic: copiar · Doble clic: editar'}
        onClick={() => (vacio ? startEdit(item.id, field, '') : copiar(item[field], clave))}
        onDoubleClick={() => startEdit(item.id, field, item[field])}
      >
        {item[field] || placeholder}{copied === clave && <span className="copied-tag">✓ copiado</span>}
      </span>
    )
  }

  return (
    <div className="table-container">
      <table className="classifier-table">
        <thead>
          <tr>
            <th>RUC</th>
            <th>Nombre Proveedor</th>
            <th>Actividad económica (SRI)</th>
            <th>Categoría</th>
            <th>Calificación</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          {total === 0 ? (
            <tr>
              <td colSpan="6" className="empty">No hay clasificaciones. Agrega una nueva o importa desde Excel.</td>
            </tr>
          ) : (
            pageRows.map((item) => (
              <tr key={item.id}>
                <td className="ruc-cell">{cell(item, 'ruc', 'ruc-edit')}</td>
                <td>{cell(item, 'nombre_proveedor')}</td>
                <td className={`actividad-cell ${actOpen === item.id ? 'full' : ''}`}
                    title="Clic para ver la actividad completa"
                    onClick={() => setActOpen(actOpen === item.id ? null : item.id)}>
                  {item.actividad || '—'}
                </td>
                <td>{cell(item, 'categoria', '', 'SIN CLASIFICAR')}</td>
                <td>
                  {item.calificado ? (
                    <button
                      type="button"
                      className="calif-badge ok"
                      title="Clic para ver la vigencia"
                      onClick={() => setVigOpen(vigOpen === item.id ? null : item.id)}
                    >
                      ✔ {item.calif_categoria || 'Calificado'}
                    </button>
                  ) : (
                    <span className="calif-badge no">— No</span>
                  )}
                  {item.calificado && vigOpen === item.id && (
                    <div className="calif-vig">
                      Vigencia: {item.calif_inicio || '—'} → {item.calif_fin || '—'}
                    </div>
                  )}
                </td>
                <td className="actions">
                  <button onClick={() => handleDelete(item)} className="delete-btn" title="Eliminar">🗑</button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {totalPages > 1 && (
        <div className="cl-pager">
          <button onClick={() => setPage(1)} disabled={pageSafe === 1}>«</button>
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={pageSafe === 1}>‹ Anterior</button>
          <span>Página {pageSafe} de {totalPages} · {total} registros</span>
          <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={pageSafe === totalPages}>Siguiente ›</button>
          <button onClick={() => setPage(totalPages)} disabled={pageSafe === totalPages}>»</button>
        </div>
      )}
      <datalist id="cl-cats">{cats.map((v) => <option key={v} value={v} />)}</datalist>
      <datalist id="cl-noms">{noms.map((v) => <option key={v} value={v} />)}</datalist>
    </div>
  )
}
