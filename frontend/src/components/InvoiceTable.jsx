import { useState } from 'react'
import { invoicesAPI } from '../services/api'

export default function InvoiceTable({ invoices, onInvoicesChange }) {
  const [editingId, setEditingId] = useState(null)
  const [editField, setEditField] = useState(null)
  const [editValue, setEditValue] = useState('')

  const handleEdit = (id, field, value) => {
    setEditingId(id)
    setEditField(field)
    setEditValue(value || '')
  }

  const handleSave = async (id) => {
    try {
      await invoicesAPI.update(id, { [editField]: editValue })
      setEditingId(null)
      onInvoicesChange()
    } catch (e) {
      alert('Error al guardar: ' + e.message)
    }
  }

  const handleDelete = async (id) => {
    if (!window.confirm('¿Eliminar esta factura?')) return
    try {
      await invoicesAPI.delete(id)
      onInvoicesChange()
    } catch (e) {
      alert('Error al eliminar: ' + e.message)
    }
  }

  if (!invoices || invoices.length === 0) {
    return <p style={{textAlign:'center', color:'#999', padding:'40px'}}>No hay facturas para mostrar.</p>
  }

  return (
    <div style={{overflowX:'auto', background:'white', borderRadius:'8px', boxShadow:'0 1px 3px rgba(0,0,0,0.08)'}}>
      <p style={{padding:'8px 12px', margin:0, fontSize:'0.8em', color:'#888', borderBottom:'1px solid #eee'}}>
        {invoices.length} facturas — click en Clasificación para editar
      </p>
      <table style={{width:'100%', borderCollapse:'collapse', fontSize:'0.84em'}}>
        <thead>
          <tr style={{background:'#f5f5f5'}}>
            <th style={th}>Fecha</th>
            <th style={th}>RUC</th>
            <th style={th}>Proveedor</th>
            <th style={th}>Clasificación</th>
            <th style={th}>Concepto</th>
            <th style={{...th, textAlign:'right'}}>Base 15%</th>
            <th style={{...th, textAlign:'right'}}>IVA</th>
            <th style={{...th, textAlign:'right'}}>Total</th>
            <th style={th}>Estado</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => (
            <tr key={inv.id} style={{borderBottom:'1px solid #f0f0f0', background: inv.estado === 'DUPLICADO' ? '#fff5f5' : !inv.clasificacion || inv.clasificacion === 'SIN CLASIFICAR' ? '#fffbf0' : 'white'}}>
              <td style={td}>{inv.fecha || '-'}</td>
              <td style={td}>{inv.ruc_proveedor || '-'}</td>
              <td style={{...td, maxWidth:'180px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}} title={inv.nombre_proveedor}>{inv.nombre_proveedor || '-'}</td>
              <td style={td} onClick={() => handleEdit(inv.id, 'clasificacion', inv.clasificacion)}>
                {editingId === inv.id && editField === 'clasificacion' ? (
                  <input
                    autoFocus
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onBlur={() => handleSave(inv.id)}
                    onKeyDown={e => { if (e.key === 'Enter') handleSave(inv.id); if (e.key === 'Escape') setEditingId(null) }}
                    style={{width:'120px', padding:'2px 4px', border:'1px solid #667eea', borderRadius:'3px'}}
                    onClick={e => e.stopPropagation()}
                  />
                ) : (
                  <span style={{cursor:'pointer', color: !inv.clasificacion || inv.clasificacion === 'SIN CLASIFICAR' ? '#f59e0b' : '#667eea', fontWeight:500}}>
                    {inv.clasificacion || 'SIN CLASIFICAR'}
                  </span>
                )}
              </td>
              <td style={{...td, maxWidth:'150px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}} title={inv.concepto}>{inv.concepto || '-'}</td>
              <td style={{...td, textAlign:'right'}}>${parseFloat(inv.base_15 || 0).toFixed(2)}</td>
              <td style={{...td, textAlign:'right'}}>${parseFloat(inv.iva_15 || 0).toFixed(2)}</td>
              <td style={{...td, textAlign:'right', fontWeight:600}}>${parseFloat(inv.total || 0).toFixed(2)}</td>
              <td style={td}>{inv.estado || 'OK'}</td>
              <td style={td}>
                <button onClick={() => handleDelete(inv.id)} style={{background:'none', border:'none', cursor:'pointer', color:'#e53e3e', fontSize:'1em'}}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const th = {
  padding: '9px 12px',
  textAlign: 'left',
  fontWeight: 600,
  color: '#555',
  fontSize: '0.8em',
  textTransform: 'uppercase',
  letterSpacing: '0.3px',
  whiteSpace: 'nowrap',
  borderBottom: '2px solid #e0e0e0'
}

const td = {
  padding: '9px 12px',
  color: '#222',
  verticalAlign: 'middle'
}
