import { useState } from 'react'
import { invoicesAPI } from '../services/api'
import './InvoiceTable.css'

export default function InvoiceTable({ invoices, onInvoicesChange }) {
  const [editingId, setEditingId] = useState(null)
  const [editField, setEditField] = useState(null)
  const [editValue, setEditValue] = useState('')
  const [selectedIds, setSelectedIds] = useState(new Set())

  const columns = [
    'estado', 'fecha', 'ruc_proveedor', 'nombre_proveedor', 'clasificacion', 'concepto',
    'base_15', 'iva_15', 'total'
  ]

  const handleCellClick = (id, field, value) => {
    if (['clasificacion', 'desc_manual', 'tarjeta_credito'].includes(field)) {
      setEditingId(id)
      setEditField(field)
      setEditValue(value || '')
    }
  }

  const handleSave = async (id) => {
    try {
      const update = { [editField]: editValue }
      await invoicesAPI.update(id, update)
      setEditingId(null)
      setEditField(null)
      onInvoicesChange()
    } catch (error) {
      console.error('Error saving:', error)
    }
  }

  const handleDelete = async (id) => {
    if (window.confirm('¿Está seguro de eliminar esta factura?')) {
      try {
        await invoicesAPI.delete(id)
        onInvoicesChange()
      } catch (error) {
        console.error('Error deleting:', error)
      }
    }
  }

  const toggleSelect = (id) => {
    const newSelected = new Set(selectedIds)
    if (newSelected.has(id)) {
      newSelected.delete(id)
    } else {
      newSelected.add(id)
    }
    setSelectedIds(newSelected)
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === invoices.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(invoices.map(i => i.id)))
    }
  }

  const getRowClass = (invoice) => {
    if (invoice.estado === 'DUPLICADO') return 'row-duplicate'
    if (invoice.desc_manual > 0) return 'row-modified'
    if (invoice.desc_info > 0) return 'row-discount'
    return 'row-ok'
  }

  return (
    <div className="table-container">
      <table className="invoice-table">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                checked={selectedIds.size === invoices.length && invoices.length > 0}
                onChange={toggleSelectAll}
              />
            </th>
            {columns.map(col => (
              <th key={col}>{col.replace(/_/g, ' ').toUpperCase()}</th>
            ))}
            <th>ACCIONES</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((invoice) => (
            <tr key={invoice.id} className={getRowClass(invoice)}>
              <td>
                <input
                  type="checkbox"
                  checked={selectedIds.has(invoice.id)}
                  onChange={() => toggleSelect(invoice.id)}
                />
              </td>
              {columns.map(col => (
                <td
                  key={col}
                  onClick={() => handleCellClick(invoice.id, col, invoice[col])}
                  className={['clasificacion', 'desc_manual'].includes(col) ? 'editable' : ''}
                >
                  {editingId === invoice.id && editField === col ? (
                    <input
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => handleSave(invoice.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSave(invoice.id)
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      className="inline-edit"
                    />
                  ) : (
                    formatValue(invoice[col], col)
                  )}
                </td>
              ))}
              <td className="actions">
                <button
                  onClick={() => handleDelete(invoice.id)}
                  className="delete-btn"
                  title="Eliminar"
                >
                  🗑
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function formatValue(value, field) {
  if (value === null || value === undefined) return '-'
  if (['base_0', 'base_15', 'base_5', 'exento_iva', 'no_objeto_iva', 'iva_15', 'iva_5', 'desc_info', 'desc_manual', 'total'].includes(field)) {
    return `$${parseFloat(value).toFixed(2)}`
  }
  return String(value).substring(0, 30)
}
