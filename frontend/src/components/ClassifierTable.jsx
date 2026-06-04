import { useState } from 'react'
import { classificationAPI } from '../services/api'
import './ClassifierTable.css'

export default function ClassifierTable({ classifications, onClassificationsChange }) {
  const [edit, setEdit] = useState({ id: null, field: null })
  const [value, setValue] = useState('')

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
    try {
      const res = await classificationAPI.updateById(item.id, ruc, nombre, categoria)
      cancel()
      onClassificationsChange()
      const n = res?.data?.reclasificadas
      if (n > 0) alert(`✔ ${n} factura(s) SIN CLASIFICAR de este RUC se actualizaron a "${categoria.toUpperCase()}"`)
    } catch (error) {
      alert('Error al guardar: ' + (error.response?.data?.detail || error.message))
    }
  }

  const handleDelete = async (ruc) => {
    if (!window.confirm(`¿Eliminar el RUC ${ruc}?`)) return
    try {
      await classificationAPI.delete(ruc)
      onClassificationsChange()
    } catch (error) {
      alert('Error al eliminar: ' + (error.response?.data?.detail || error.message))
    }
  }

  const cell = (item, field, extraClass = '') => {
    const isEditing = edit.id === item.id && edit.field === field
    if (isEditing) {
      return (
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => handleSave(item)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave(item)
            if (e.key === 'Escape') cancel()
          }}
          className="inline-edit"
        />
      )
    }
    return (
      <span className={`editable ${extraClass}`} onClick={() => startEdit(item.id, field, item[field])}>
        {item[field] || '-'}
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
            <th>Categoría</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          {classifications.length === 0 ? (
            <tr>
              <td colSpan="4" className="empty">No hay clasificaciones. Agrega una nueva o importa desde Excel.</td>
            </tr>
          ) : (
            classifications.map((item) => (
              <tr key={item.id}>
                <td className="ruc-cell">{cell(item, 'ruc', 'ruc-edit')}</td>
                <td>{cell(item, 'nombre_proveedor')}</td>
                <td>{cell(item, 'categoria')}</td>
                <td className="actions">
                  <button onClick={() => handleDelete(item.ruc)} className="delete-btn" title="Eliminar">🗑</button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
