import { useState, useMemo, useEffect } from 'react'
import InvoiceTable from './InvoiceTable'
import { esPersonal, GASTOS_PERSONALES } from '../utils/categorias'
import { classificationAPI } from '../services/api'
import './InvoiceTabs.css'

import { fmtMoney as money } from '../utils/format'

// Columnas del RESUMEN, en el mismo orden que la hoja RESUMEN del Excel.
const RESUMEN_COLS = [
  { label: 'No Objeto IVA', key: 'no_objeto_iva' },
  { label: 'Exento IVA', key: 'exento_iva' },
  { label: 'Base 0%', key: 'base_0' },
  { label: 'Base 5%', key: 'base_5' },
  { label: 'IVA 5%', key: 'iva_5' },
  { label: 'Base 15%', key: 'base_15' },
  { label: 'IVA 15%', key: 'iva_15' },
  { label: 'Total', key: 'total' },
]

function emptyAgg() {
  return RESUMEN_COLS.reduce((o, c) => ({ ...o, [c.key]: 0 }), { num: 0 })
}

function SummaryTable({ titulo, filas, color }) {
  if (!filas.length) return null
  const total = filas.reduce((t, f) => {
    const o = { num: t.num + f.num }
    RESUMEN_COLS.forEach((c) => { o[c.key] = (t[c.key] || 0) + f[c.key] })
    return o
  }, emptyAgg())

  return (
    <div className="rs-block">
      <div className="rs-title" style={{ borderColor: color }}>{titulo}</div>
      <div className="rs-scroll">
        <table className="rs-table">
          <thead>
            <tr style={{ background: color }}>
              <th>Concepto</th>
              <th className="r"># Fact.</th>
              {RESUMEN_COLS.map((c) => <th key={c.key} className="r">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.clasificacion}>
                <td>{f.clasificacion}</td>
                <td className="r">{f.num}</td>
                {RESUMEN_COLS.map((c) => <td key={c.key} className="r">{money(f[c.key])}</td>)}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="rs-total">
              <td>TOTAL GENERAL</td>
              <td className="r">{total.num}</td>
              {RESUMEN_COLS.map((c) => <td key={c.key} className="r">{money(total[c.key])}</td>)}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

export default function InvoiceTabs({ invoices, onInvoicesChange }) {
  const [tab, setTab] = useState('datos')
  const [pendCatalog, setPendCatalog] = useState([])
  const [pendInput, setPendInput] = useState({})
  const [pendBusy, setPendBusy] = useState('')

  useEffect(() => {
    classificationAPI.list()
      .then((res) => {
        const cats = (res.data || [])
          .map((c) => (c.categoria || '').toUpperCase().trim())
          .filter(Boolean)
        setPendCatalog([...new Set(cats)])
      })
      .catch(() => {})
  }, [])

  const pendOpciones = useMemo(() => {
    const set = new Set([...GASTOS_PERSONALES].map((c) => c.toUpperCase()))
    pendCatalog.forEach((c) => set.add(c))
    return Array.from(set).sort()
  }, [pendCatalog])

  const aplicarPendiente = async (ruc, nombre) => {
    const cat = (pendInput[ruc] || '').trim().toUpperCase()
    if (!cat) {
      alert('Selecciona una categoría primero.')
      return
    }
    setPendBusy(ruc)
    try {
      const res = await classificationAPI.create(ruc, nombre, cat)
      const n = res?.data?.reclasificadas ?? 0
      setPendInput((prev) => { const o = { ...prev }; delete o[ruc]; return o })
      await onInvoicesChange()
      if (n > 0) {
        alert(`✔ ${n} factura(s) de ${nombre || ruc} se actualizaron a "${cat}"`)
      }
    } catch (e) {
      alert('Error al asignar: ' + (e.response?.data?.detail || e.message))
    } finally {
      setPendBusy('')
    }
  }

  // Solo facturas OK, igual que el Excel (rows_ok)
  const rowsOk = useMemo(() => invoices.filter((i) => i.estado === 'OK'), [invoices])

  // RESUMEN agregado por clasificación
  const { personales, ejercicio } = useMemo(() => {
    const agg = {}
    for (const inv of rowsOk) {
      const clasif = (inv.clasificacion || 'SIN CLASIFICAR').toUpperCase()
      if (clasif === 'SIN CLASIFICAR') continue
      const a = agg[clasif] || (agg[clasif] = { clasificacion: clasif, ...emptyAgg() })
      a.num += 1
      RESUMEN_COLS.forEach((c) => { a[c.key] += parseFloat(inv[c.key]) || 0 })
    }
    const filas = Object.values(agg).sort((x, y) => x.clasificacion.localeCompare(y.clasificacion))
    return {
      personales: filas.filter((f) => esPersonal(f.clasificacion)),
      ejercicio: filas.filter((f) => !esPersonal(f.clasificacion)),
    }
  }, [rowsOk])

  // PENDIENTES: RUC/Nombre únicos sin clasificar
  const pendientes = useMemo(() => {
    const map = {}
    for (const inv of rowsOk) {
      if (inv.clasificacion && inv.clasificacion !== 'SIN CLASIFICAR') continue
      const ruc = inv.ruc_proveedor || ''
      const k = `${ruc}|${inv.nombre_proveedor || ''}`
      if (!map[k]) map[k] = { ruc, nombre: inv.nombre_proveedor || '' }
    }
    return Object.values(map).sort((a, b) => a.nombre.localeCompare(b.nombre))
  }, [rowsOk])

  return (
    <div className="itabs">
      <div className="itabs-bar">
        <button className={tab === 'datos' ? 'active' : ''} onClick={() => setTab('datos')}>
          📋 Datos
        </button>
        <button className={tab === 'resumen' ? 'active' : ''} onClick={() => setTab('resumen')}>
          📊 Resumen
        </button>
        <button className={tab === 'pendientes' ? 'active' : ''} onClick={() => setTab('pendientes')}>
          ⚠️ Pendientes {pendientes.length > 0 && <span className="itabs-badge">{pendientes.length}</span>}
        </button>
      </div>

      {tab === 'datos' && (
        <InvoiceTable invoices={invoices} onInvoicesChange={onInvoicesChange} />
      )}

      {tab === 'resumen' && (
        <div className="rs-wrap">
          {personales.length === 0 && ejercicio.length === 0 ? (
            <div className="itabs-empty">Aún no hay facturas clasificadas para resumir.</div>
          ) : (
            <>
              <SummaryTable titulo="GASTOS PERSONALES" filas={personales} color="#16a34a" />
              <SummaryTable titulo="GASTOS DEL EJERCICIO" filas={ejercicio} color="#2563eb" />
            </>
          )}
        </div>
      )}

      {tab === 'pendientes' && (
        <div className="rs-wrap">
          {pendientes.length === 0 ? (
            <div className="itabs-empty">🎉 No hay facturas sin clasificar.</div>
          ) : (
            <>
              <datalist id="pend-cat-list">
                {pendOpciones.map((c) => <option key={c} value={c} />)}
              </datalist>
              <table className="rs-table pend-table">
                <thead>
                  <tr style={{ background: '#d97706' }}>
                    <th>RUC</th>
                    <th>Nombre</th>
                    <th>Asignar Categoría</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pendientes.map((p) => {
                    const busy = pendBusy === p.ruc
                    const val = pendInput[p.ruc] || ''
                    return (
                      <tr key={`${p.ruc}|${p.nombre}`}>
                        <td>{p.ruc || '-'}</td>
                        <td>{p.nombre || '-'}</td>
                        <td>
                          <input
                            className="pend-cat-input"
                            list="pend-cat-list"
                            placeholder="Categoría…"
                            value={val}
                            disabled={busy}
                            onChange={(e) =>
                              setPendInput((prev) => ({ ...prev, [p.ruc]: e.target.value.toUpperCase() }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') aplicarPendiente(p.ruc, p.nombre)
                            }}
                          />
                        </td>
                        <td>
                          <button
                            className="pend-apply-btn"
                            disabled={busy || !val.trim()}
                            onClick={() => aplicarPendiente(p.ruc, p.nombre)}
                          >
                            {busy ? '…' : '✔ Asignar'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  )
}
