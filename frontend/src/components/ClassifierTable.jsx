import { useState, useMemo, useEffect } from 'react'
import { classificationAPI } from '../services/api'
import { useEditableCell, useCopyFeedback } from '../hooks/useEditableCell'
import './ClassifierTable.css'

const PAGE_SIZE = 50

export default function ClassifierTable({ classifications, onClassificationsChange, onRowChange = null, onRowDelete = null, opcionesCategoria = null, isAdmin = false }) {
  // Opciones existentes para desplegar al editar (clasificación ágil)
  const cats = useMemo(() => (opcionesCategoria
    || [...new Set((classifications || []).map((c) => String(c.categoria || '').trim()).filter(Boolean))]).sort(),
    [opcionesCategoria, classifications])
  const noms = useMemo(() => [...new Set((classifications || []).map((c) => String(c.nombre_proveedor || '').trim()).filter(Boolean))].sort(),
    [classifications])
  // Paginación (acelera el render cuando hay muchos RUC)
  const [page, setPage] = useState(1)
  const total = (classifications || []).length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  useEffect(() => { setPage(1) }, [total]) // al cambiar filtro/cantidad, vuelve a la 1
  const pageSafe = Math.min(page, totalPages)
  const pageRows = (classifications || []).slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE)
  const { edit, value, setValue, isEditing, startEdit, cancel, bind } = useEditableCell()
  const [vigOpen, setVigOpen] = useState(null) // id cuya vigencia se muestra
  const [actOpen, setActOpen] = useState(null) // id cuya actividad se ve completa
  const { copiedKey: copied, copy: copiar } = useCopyFeedback()

  const handleSave = async (item) => {
    const { field } = edit
    const ruc = field === 'ruc' ? value.trim() : item.ruc
    const nombre = field === 'nombre_proveedor' ? value : item.nombre_proveedor
    const categoria = field === 'categoria' ? value : item.categoria
    try {
      const res = await classificationAPI.updateById(item.id, ruc, nombre, categoria)
      cancel()
      // Solo actualiza ESA fila en pantalla (no recarga toda la tabla → mucho más rápido).
      // Si NO es admin, la edición pasa a ser un override personal → marca el distintivo.
      const marca = isAdmin ? {} : { es_propio: true, es_general: false }
      if (onRowChange) onRowChange(item.id, { ruc, nombre_proveedor: nombre, categoria, ...marca })
      else onClassificationsChange()
      const n = res?.data?.reclasificadas
      if (n > 0) alert(`✔ ${n} factura(s) SIN CLASIFICAR de este RUC se actualizaron a "${categoria.toUpperCase()}"`)
    } catch (error) {
      alert('Error al guardar: ' + (error.response?.data?.detail || error.message))
      onClassificationsChange() // si falló, recargar para volver al estado real (se mantiene en edición con lo escrito)
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

  // Distintivo del clasificador general vs override personal:
  //  - usuario normal: '✎ Tuyo' cuando la categoría es un override suyo
  //  - admin: '👤 N' cuando N usuarios personalizaron ese RUC (para decidir adoptarlo)
  const distintivo = (item) => {
    if (isAdmin) {
      return item.override_users > 0
        ? <span className="cl-badge override" title={`${item.override_users} usuario(s) personalizaron este RUC`}>👤 {item.override_users}</span>
        : null
    }
    return item.es_propio
      ? <span className="cl-badge propio" title="Clasificación tuya: solo te afecta a ti (el resto ve la general)">✎ Tuyo</span>
      : null
  }

  const cell = (item, field, extraClass = '', placeholder = '-') => {
    if (isEditing(item.id, field)) {
      return (
        <input
          autoFocus
          list={field === 'categoria' ? 'cl-cats' : field === 'nombre_proveedor' ? 'cl-noms' : undefined}
          className="inline-edit"
          {...bind(() => handleSave(item))}
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
                <td>{cell(item, 'categoria', '', 'SIN CLASIFICAR')}{distintivo(item)}</td>
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
