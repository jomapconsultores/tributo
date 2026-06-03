import { useState } from 'react'
import { classificationAPI } from '../services/api'
import './ClassifierTable.css'

export default function ClassifierTable({ classifications, onClassificationsChange }) {
  const [editingRuc, setEditingRuc] = useState(null)
  const [editField, setEditField] = useState(null)
  const [editValue, setEditValue] = useState('')

  const handleCellClick = (ruc, field, value) => {
    setEditingRuc(ruc)
    setEditField(field)
    setEditValue(value || '')
  }

  const handleSave = async (ruc) => {
    const original = classifications.find(c => c.ruc === ruc)
    try {
      const nombre = editField === 'nombre_proveedor' ? editValue : original.nombre_proveedor
      const categoria = editField === 'categoria' ? editValue : original.categoria

      await classificationAPI.update(ruc, nombre, categoria)
      setEditingRuc(null)
      setEditField(null)
      onClassificationsChange()
    } catch (error) {
      console.error('Error saving:', error)
    }
  }

  const handleDelete = async (ruc) => {
    if (window.confirm(`¿Está seguro de eliminar ${ruc}?`)) {
      try {
        await classificationAPI.delete(ruc)
        onClassificationsChange()
      } catch (error) {
        console.error('Error deleting:', error)
      }
    }
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
              <td colSpan="4" className="empty">
                No hay clasificaciones. Agrega una nueva o importa desde Excel.
              </td>
            </tr>
          ) : (
            classifications.map((item) => (
              <tr key={item.ruc}>
                <td className="ruc-cell">{item.ruc}</td>
                <td
                  onClick={() => handleCellClick(item.ruc, 'nombre_proveedor', item.nombre_proveedor)}
                  className="editable"
                >
                  {editingRuc === item.ruc && editField === 'nombre_proveedor' ? (
                    <input
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => handleSave(item.ruc)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSave(item.ruc)
                        if (e.key === 'Escape') setEditingRuc(null)
                      }}
                      className="inline-edit"
                    />
                  ) : (
                    item.nombre_proveedor || '-'
                  )}
                </td>
                <td
                  onClick={() => handleCellClick(item.ruc, 'categoria', item.categoria)}
                  className="editable"
                >
                  {editingRuc === item.ruc && editField === 'categoria' ? (
                    <input
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => handleSave(item.ruc)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSave(item.ruc)
                        if (e.key === 'Escape') setEditingRuc(null)
                      }}
                      className="inline-edit"
                    />
                  ) : (
                    item.categoria
                  )}
                </td>
                <td className="actions">
                  <button
                    onClick={() => handleDelete(item.ruc)}
                    className="delete-btn"
                    title="Eliminar"
                  >
                    🗑
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
