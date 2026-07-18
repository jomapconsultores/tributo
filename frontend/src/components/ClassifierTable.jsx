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

  // Ancho de columnas ajustable arrastrando el borde del encabezado. Se guarda en
  // el navegador para que el ancho elegido se conserve entre sesiones.
  const COLS = ['ruc', 'nombre', 'actividad', 'categoria', 'calif', 'acciones']
  const DEFAULT_W = { ruc: 150, nombre: 220, actividad: 300, categoria: 170, calif: 130, acciones: 70 }
  const [colW, setColW] = useState(() => {
    try { return { ...DEFAULT_W, ...JSON.parse(localStorage.getItem('cl_colw') || '{}') } }
    catch { return { ...DEFAULT_W } }
  })
  const totalW = COLS.reduce((s, k) => s + (colW[k] || DEFAULT_W[k]), 0)
  const startColResize = (key) => (e) => {
    e.preventDefault(); e.stopPropagation()
    const startX = e.clientX
    const startW = colW[key] || DEFAULT_W[key]
    const onMove = (ev) => setColW((prev) => ({ ...prev, [key]: Math.max(60, startW + (ev.clientX - startX)) }))
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('cl-col-resizing')
      setColW((prev) => { try { localStorage.setItem('cl_colw', JSON.stringify(prev)) } catch { /* */ } return prev })
    }
    document.body.classList.add('cl-col-resizing')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const resetColW = () => { setColW({ ...DEFAULT_W }); try { localStorage.removeItem('cl_colw') } catch { /* */ } }

  const handleSave = (item) => {
    const { field } = edit
    const ruc = field === 'ruc' ? value.trim() : item.ruc
    const nombre = field === 'nombre_proveedor' ? value : item.nombre_proveedor
    const categoria = field === 'categoria' ? value : item.categoria
    // GUARDADO OPTIMISTA: al dar Enter cerramos el editor y actualizamos ESA fila
    // de inmediato (cambio instantáneo, sin esperar al backend). El guardado va en
    // segundo plano; si falla, recargamos para volver al estado real. Antes se
    // esperaba (await) la respuesta —que además consultaba el SRI—, por eso el
    // cambio se sentía lento.
    cancel()
    const marca = isAdmin ? {} : { es_propio: true, es_general: false }
    if (onRowChange) onRowChange(item.id, { ruc, nombre_proveedor: nombre, categoria, ...marca })
    classificationAPI.updateById(item.id, ruc, nombre, categoria)
      .then((res) => {
        if (!onRowChange) onClassificationsChange()
        const n = res?.data?.reclasificadas
        if (n > 0) alert(`✔ ${n} factura(s) del RUC ${ruc} se reclasificaron a "${categoria.toUpperCase()}".`)
      })
      .catch((error) => {
        alert('Error al guardar: ' + (error.response?.data?.detail || error.message))
        onClassificationsChange() // recargar para volver al estado real si falló
      })
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
    // Clic simple = EDITAR (igual que la tabla de gastos, InvoiceTable). Antes el
    // clic simple sobre una celda con valor COPIABA y solo el doble clic editaba,
    // lo que daba la sensación de que "solo deja copiar, no cambiar". Copiar sigue
    // disponible en un botón explícito por celda.
    return (
      <span className={`cl-cell ${copied === clave ? 'copied' : ''}`}>
        <span
          className={`editable ${extraClass} ${vacio && placeholder !== '-' ? 'sin-clasif' : ''}`}
          title={vacio ? 'Clic para clasificar' : 'Clic para editar'}
          onClick={() => startEdit(item.id, field, item[field] || '')}
        >
          {item[field] || placeholder}
        </span>
        {!vacio && (
          <button
            type="button"
            className="cl-copy-btn"
            title="Copiar al portapapeles"
            onClick={(e) => { e.stopPropagation(); copiar(item[field], clave) }}
          >
            {copied === clave ? '✓' : '⧉'}
          </button>
        )}
      </span>
    )
  }

  return (
    <div className="table-container">
      <table className="classifier-table cl-resizable" style={{ width: totalW + 'px', tableLayout: 'fixed' }}>
        <colgroup>
          {COLS.map((k) => <col key={k} style={{ width: (colW[k] || DEFAULT_W[k]) + 'px' }} />)}
        </colgroup>
        <thead>
          <tr>
            <th>RUC<span className="col-resizer" title="Arrastra para ampliar la columna" onMouseDown={startColResize('ruc')} /></th>
            <th>Nombre Proveedor<span className="col-resizer" title="Arrastra para ampliar la columna" onMouseDown={startColResize('nombre')} /></th>
            <th>Actividad económica (SRI)<span className="col-resizer" title="Arrastra para ampliar la columna" onMouseDown={startColResize('actividad')} /></th>
            <th>Categoría<span className="col-resizer" title="Arrastra para ampliar la columna" onMouseDown={startColResize('categoria')} /></th>
            <th>Calificación<span className="col-resizer" title="Arrastra para ampliar la columna" onMouseDown={startColResize('calif')} /></th>
            <th>Acciones<button type="button" className="cl-col-reset" title="Restablecer ancho de columnas" onClick={resetColW}>⤢</button></th>
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
