import { useState, useMemo, useEffect } from 'react'
import { invoicesAPI, memoryAPI, classificationAPI } from '../services/api'
import ClasifEditor from './ClasifEditor'
import BulkBar from './BulkBar'
import './InvoiceTable.css'

const GASTOS_PERSONALES = [
  'ALIMENTACIÓN', 'EDUCACIÓN', 'SALUD', 'VESTIMENTA', 'VIVIENDA',
  'TURISMO', 'ARTE Y CULTURA', 'VARIOS',
]

import { fmtMoney as money } from '../utils/format'

// Filtro por tipo de valor: muestra solo facturas con monto > 0 en esa columna.
const VALOR_OPCIONES = [
  { key: 'no_objeto_iva', label: 'No Objeto IVA' },
  { key: 'exento_iva', label: 'Exento IVA' },
  { key: 'base_0', label: 'Base 0%' },
  { key: 'base_15', label: 'Base 15%' },
  { key: 'iva_15', label: 'IVA 15%' },
  { key: 'base_5', label: 'Base 5%' },
  { key: 'iva_5', label: 'IVA 5%' },
]

const FILTROS_KEY = 'gastos_filtros_v1'

function readPersistedFiltros() {
  try {
    const raw = localStorage.getItem(FILTROS_KEY)
    if (!raw) return null
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? obj : null
  } catch {
    return null
  }
}

export default function InvoiceTable({ invoices, onInvoicesChange }) {
  const [edit, setEdit] = useState({ id: null, field: null })
  const [value, setValue] = useState('')
  const persisted = readPersistedFiltros() || {}
  const [search, setSearch] = useState(persisted.search || '')
  const [fClasif, setFClasif] = useState(persisted.fClasif || '')
  const [fForma, setFForma] = useState(persisted.fForma || '')
  const [fValor, setFValor] = useState(persisted.fValor || '')
  const [selected, setSelected] = useState(() => new Set())
  const [copiedId, setCopiedId] = useState('')

  useEffect(() => {
    try {
      localStorage.setItem(
        FILTROS_KEY,
        JSON.stringify({ search, fClasif, fForma, fValor })
      )
    } catch { /* localStorage lleno o deshabilitado: ignorar */ }
  }, [search, fClasif, fForma, fValor])

  const copyCell = async (text, cellId) => {
    if (!text) return
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopiedId(cellId)
      setTimeout(() => setCopiedId((c) => (c === cellId ? '' : c)), 1100)
    } catch { /* clipboard bloqueado: feedback omitido */ }
  }

  // Catálogo maestro de categorías (las definidas en el Clasificador de Gastos)
  const [catalog, setCatalog] = useState([])
  useEffect(() => {
    classificationAPI.list()
      .then((res) => {
        const cats = (res.data || [])
          .map((c) => (c.categoria || '').toUpperCase().trim())
          .filter(Boolean)
        setCatalog([...new Set(cats)])
      })
      .catch(() => {})
  }, [])

  const categorias = useMemo(() => {
    const set = new Set(GASTOS_PERSONALES)
    catalog.forEach((c) => set.add(c))
    invoices.forEach((i) => i.clasificacion && i.clasificacion !== 'SIN CLASIFICAR' && set.add(i.clasificacion))
    return Array.from(set).sort()
  }, [invoices, catalog])

  // Opciones de los desplegables, según los datos presentes
  const clasifOpciones = useMemo(() => {
    const set = new Set()
    invoices.forEach((i) => set.add(i.clasificacion || 'SIN CLASIFICAR'))
    return Array.from(set).sort()
  }, [invoices])

  const formaOpciones = useMemo(() => {
    const set = new Set()
    invoices.forEach((i) => { if (i.forma_pago) set.add(i.forma_pago) })
    return Array.from(set).sort()
  }, [invoices])

  const hayFiltros = search.trim() || fClasif || fForma || fValor

  const limpiarFiltros = () => {
    setSearch(''); setFClasif(''); setFForma(''); setFValor('')
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return invoices.filter((i) => {
      if (q && ![i.fecha, i.ruc_proveedor, i.nombre_proveedor, i.clasificacion, i.concepto, i.factura_numero]
        .some((f) => String(f || '').toLowerCase().includes(q))) return false
      if (fClasif && (i.clasificacion || 'SIN CLASIFICAR') !== fClasif) return false
      if (fForma && i.forma_pago !== fForma) return false
      if (fValor && !((parseFloat(i[fValor]) || 0) > 0)) return false
      return true
    })
  }, [invoices, search, fClasif, fForma, fValor])

  // ---- Selección múltiple ----
  const toggleSel = (id) => setSelected((prev) => {
    const n = new Set(prev)
    n.has(id) ? n.delete(id) : n.add(id)
    return n
  })
  const allSelected = filtered.length > 0 && filtered.every((i) => selected.has(i.id))
  const toggleAll = () => setSelected((prev) => {
    if (filtered.every((i) => prev.has(i.id))) {
      const n = new Set(prev)
      filtered.forEach((i) => n.delete(i.id))
      return n
    }
    return new Set([...prev, ...filtered.map((i) => i.id)])
  })
  const clearSel = () => setSelected(new Set())

  const bulkMove = async (clientId) => {
    const ids = [...selected]
    try {
      const res = await invoicesAPI.bulkMove(ids, clientId)
      clearSel()
      await onInvoicesChange()
      const m = res.data?.moved ?? ids.length
      const s = res.data?.skipped ?? 0
      alert(`Movidas: ${m}${s ? ` · Omitidas (duplicadas en destino): ${s}` : ''}`)
    } catch (e) {
      alert('Error al mover: ' + (e.response?.data?.detail || e.message))
    }
  }

  const bulkDelete = async () => {
    const ids = [...selected]
    if (!window.confirm(`¿Eliminar ${ids.length} factura(s) seleccionada(s)?`)) return
    try {
      await invoicesAPI.bulkDelete(ids)
      clearSel()
      await onInvoicesChange()
    } catch (e) {
      alert('Error al eliminar: ' + (e.response?.data?.detail || e.message))
    }
  }

  const startEdit = (id, field, current) => {
    setEdit({ id, field })
    setValue(current ?? '')
  }

  const cancel = () => setEdit({ id: null, field: null })

  const save = async (inv) => {
    const { field } = edit
    try {
      if (field === 'desc_manual') {
        await invoicesAPI.update(inv.id, { desc_manual: parseFloat(value) || 0 })
      } else if (field === 'tarjeta_credito') {
        const val = value.toUpperCase()
        await invoicesAPI.update(inv.id, { tarjeta_credito: val })
        const memKey = `${inv.nombre_proveedor}|${(parseFloat(inv.total_original) || 0).toFixed(2)}`
        try { await memoryAPI.save(memKey, val) } catch { /* memoria best-effort */ }
      } else {
        await invoicesAPI.update(inv.id, { [field]: value })
      }
      cancel()
      onInvoicesChange()
    } catch (e) {
      alert('Error al guardar: ' + (e.response?.data?.detail || e.message))
    }
  }

  const handleDelete = async (id) => {
    if (!window.confirm('¿Eliminar esta factura?')) return
    try {
      await invoicesAPI.delete(id)
      onInvoicesChange()
    } catch (e) {
      alert('Error al eliminar: ' + (e.response?.data?.detail || e.message))
    }
  }

  // Guarda la clasificación con un valor explícito (desde el combo de búsqueda).
  // El backend propaga la categoría a las demás facturas SIN CLASIFICAR del mismo RUC.
  const saveClasif = async (inv, v) => {
    try {
      const res = await invoicesAPI.update(inv.id, { clasificacion: v })
      cancel()
      const n = res?.data?.reclasificadas || 0
      await onInvoicesChange()
      if (n > 1) alert(`Se clasificaron ${n} gastos sin clasificar del mismo proveedor (RUC ${inv.ruc_proveedor}).`)
    } catch (e) {
      alert('Error al guardar: ' + (e.response?.data?.detail || e.message))
    }
  }

  const renderEditable = (inv, field, display, type = 'text') => {
    const isEditing = edit.id === inv.id && edit.field === field
    if (isEditing && field === 'clasificacion') {
      return (
        <ClasifEditor
          initial={inv.clasificacion}
          options={categorias}
          onCommit={(v) => saveClasif(inv, v)}
          onCancel={cancel}
        />
      )
    }
    if (isEditing) {
      return (
        <>
          <input
            autoFocus
            type={type}
            value={value}
            list={field === 'clasificacion' ? 'categorias-list' : undefined}
            onChange={(e) => setValue(field === 'clasificacion' ? e.target.value.toUpperCase() : e.target.value)}
            onBlur={() => save(inv)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save(inv)
              if (e.key === 'Escape') cancel()
            }}
            className="cell-edit"
            step={type === 'number' ? '0.01' : undefined}
          />
        </>
      )
    }
    return (
      <span className="editable-cell" onClick={() => startEdit(inv.id, field, inv[field])}>
        {display}
      </span>
    )
  }

  const rowClass = (inv) => {
    if (inv.estado === 'DUPLICADO') return 'row-dup'
    if (inv.es_yanbal) return 'row-yanbal'
    if (parseFloat(inv.desc_manual) > 0) return 'row-mod'
    if (parseFloat(inv.desc_info) > 0) return 'row-desc'
    if (!inv.clasificacion || inv.clasificacion === 'SIN CLASIFICAR') return 'row-unclass'
    return ''
  }

  return (
    <div className="invoice-table-wrap">
      <datalist id="categorias-list">
        {categorias.map((c) => <option key={c} value={c} />)}
      </datalist>

      <div className="it-toolbar">
        <input
          className="it-search"
          placeholder="🔍 Proveedor, RUC, concepto…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="it-filter" value={fClasif} onChange={(e) => setFClasif(e.target.value)}>
          <option value="">Clasificación: todas</option>
          {clasifOpciones.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="it-filter" value={fForma} onChange={(e) => setFForma(e.target.value)}>
          <option value="">Forma de pago: todas</option>
          {formaOpciones.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <select className="it-filter" value={fValor} onChange={(e) => setFValor(e.target.value)}>
          <option value="">Tipo de valor: todos</option>
          {VALOR_OPCIONES.map((v) => <option key={v.key} value={v.key}>Con {v.label}</option>)}
        </select>
        {hayFiltros && (
          <button className="it-clear" onClick={limpiarFiltros}>✕ Limpiar</button>
        )}
        <span className="it-hint">
          {filtered.length} de {invoices.length} · clic para editar Clasificación / Desc. Manual / Tarjeta
        </span>
      </div>

      <BulkBar count={selected.size} onMove={bulkMove} onDelete={bulkDelete} onClear={clearSel} />

      <div className="it-scroll">
        <table className="invoice-table">
          <thead>
            <tr>
              <th className="sel-col"><input type="checkbox" checked={allSelected} onChange={toggleAll} title="Seleccionar todo" /></th>
              <th>Estado</th>
              <th>Fecha</th>
              <th>RUC</th>
              <th>Factura</th>
              <th>Proveedor</th>
              <th>Clasificación</th>
              <th>Concepto</th>
              <th>Forma Pago</th>
              <th>Tarjeta</th>
              <th className="r">No Obj.</th>
              <th className="r">Exento</th>
              <th className="r">Base 0%</th>
              <th className="r">Base 15%</th>
              <th className="r">IVA 15%</th>
              <th className="r">Base 5%</th>
              <th className="r">IVA 5%</th>
              <th className="r">Desc.Info</th>
              <th className="r">Desc.Man.</th>
              <th className="r">Total</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((inv) => (
              <tr key={inv.id} className={`${rowClass(inv)} ${selected.has(inv.id) ? 'row-sel' : ''}`}>
                <td className="sel-col">
                  <input type="checkbox" checked={selected.has(inv.id)} onChange={() => toggleSel(inv.id)} />
                </td>
                <td className="estado">
                  {inv.estado}
                  {inv.es_yanbal && <span className="tag-yanbal">Y</span>}
                </td>
                <td>{inv.fecha || '-'}</td>
                <td
                  className={`copyable${copiedId === `ruc-${inv.id}` ? ' copied' : ''}`}
                  title={inv.ruc_proveedor ? 'Clic para copiar RUC' : ''}
                  onClick={() => copyCell(inv.ruc_proveedor, `ruc-${inv.id}`)}
                >
                  {inv.ruc_proveedor || '-'}
                </td>
                <td
                  className={`copyable${copiedId === `fac-${inv.id}` ? ' copied' : ''}`}
                  title={inv.factura_numero ? 'Clic para copiar N° factura' : ''}
                  onClick={() => copyCell(inv.factura_numero, `fac-${inv.id}`)}
                >
                  {inv.factura_numero || '-'}
                </td>
                <td
                  className={`prov copyable${copiedId === `prov-${inv.id}` ? ' copied' : ''}`}
                  title={inv.nombre_proveedor ? `Clic para copiar — ${inv.nombre_proveedor}` : ''}
                  onClick={() => copyCell(inv.nombre_proveedor, `prov-${inv.id}`)}
                >
                  {inv.nombre_proveedor || '-'}
                </td>
                <td className="clasif">
                  {renderEditable(inv, 'clasificacion',
                    <span className={!inv.clasificacion || inv.clasificacion === 'SIN CLASIFICAR' ? 'unclass' : 'classed'}>
                      {inv.clasificacion || 'SIN CLASIFICAR'}
                    </span>
                  )}
                </td>
                <td className="concepto" title={inv.concepto}>{inv.concepto || '-'}</td>
                <td className="fpago" title={inv.forma_pago}>{inv.forma_pago || '-'}</td>
                <td>{renderEditable(inv, 'tarjeta_credito', inv.tarjeta_credito || '—')}</td>
                <td className="r">{money(inv.no_objeto_iva)}</td>
                <td className="r">{money(inv.exento_iva)}</td>
                <td className="r">{money(inv.base_0)}</td>
                <td className="r">{money(inv.base_15)}</td>
                <td className="r">{money(inv.iva_15)}</td>
                <td className="r">{money(inv.base_5)}</td>
                <td className="r">{money(inv.iva_5)}</td>
                <td className="r desc">{money(inv.desc_info)}</td>
                <td className="r desc-man">{renderEditable(inv, 'desc_manual', money(inv.desc_manual), 'number')}</td>
                <td className="r total">{money(inv.total)}</td>
                <td>
                  <button className="del-btn" onClick={() => handleDelete(inv.id)} title="Eliminar">✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
