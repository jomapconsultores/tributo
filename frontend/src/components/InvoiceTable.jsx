import { useState } from 'react'
import { invoicesAPI } from '../services/api'
import './InvoiceTable.css'

export default function InvoiceTable({ invoices, onInvoicesChange }) {
  const [editingId, setEditingId] = useState(null)
  const [editField, setEditField] = useState(null)
  const [editValue, setEditValue] = useState('')
  const [copiedCell, setCopiedCell] = useState(null)

  const columns = [
    { key: 'estado', label: 'Estado', width: '70px' },
    { key: 'fecha', label: 'Fecha', width: '80px' },
    { key: 'ruc_proveedor', label: 'RUC', width: '100px' },
    { key: 'nombre_proveedor', label: 'Proveedor', width: '150px' },
    { key: 'clasificacion', label: 'Clasificación', width: '120px' },
    { key: 'concepto', label: 'Concepto', width: '140px' },
    { key: 'base_15', label: 'Base 15%', width: '90px' },
    { key: 'iva_15', label: 'IVA 15%', width: '80px' },
    { key: 'total', label: 'Total', width: '100px' },
  ]

  const handleCellClick = (id, field, value) => {
    if (['clasificacion', 'desc_manual'].includes(field)) {
      setEditingId(id)
      setEditField(field)
      setEditValue(value || '')
    }
  }

  const handleCopy = (text) => {
    navigator.clipboard.writeText(text)
    setCopiedCell(text)
    setTimeout(() => setCopiedCell(null), 1500)
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
    if (window.confirm('¿Eliminar esta factura?')) {
      try {
        await invoicesAPI.delete(id)
        onInvoicesChange()
      } catch (error) {
        console.error('Error deleting:', error)
      }
    }
  }

  const getRowClass = (invoice) => {
    if (invoice.estado === 'DUPLICADO') return 'row-duplicate'
    if (!invoice.clasificacion || invoice.clasificacion === 'SIN CLASIFICAR') return 'row-unclassified'
    return 'row-ok'
  }

  const formatValue = (value, key) => {
    if (value === null || value === undefined) return '-'
    if (['base_0', 'base_15', 'base_5', 'exento_iva', 'iva_15', 'iva_5', 'desc_info', 'total'].includes(key)) {
      return `$${parseFloat(value).toFixed(2)}`
    }
    return String(value).substring(0, 50)
  }

  return (
    <div className="table-wrapper">
      <div className="table-container">
        <table className="invoice-table">
          <thead>
            <tr>
              {columns.map(col => (
                <th key={col.key} style={{ width: col.width }}>
                  {col.label}
                </th>
              ))}
              <th style={{ width: '80px' }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((invoice) => (
              <tr key={invoice.id} className={getRowClass(invoice)}>
                {columns.map(col => (
                  <td
                    key={col.key}
                    onClick={() => handleCellClick(invoice.id, col.key, invoice[col.key])}
                    className={['clasificacion', 'desc_manual'].includes(col.key) ? 'editable' : 'copyable'}
                    title="Click para copiar"
                  >
                    {editingId === invoice.id && editField === col.key ? (
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
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span
                        onDoubleClick={() => handleCopy(formatValue(invoice[col.key], col.key))}
                        className={copiedCell === formatValue(invoice[col.key], col.key) ? 'copied' : ''}
                      >
                        {formatValue(invoice[col.key], col.key)}
                      </span>
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
      <div className="table-footer">
        <p className="footer-text">
          💡 Doble-click para copiar | Click en clasificación para editar
        </p>
      </div>
    </div>
  )
}
