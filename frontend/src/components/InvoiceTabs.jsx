import { useState, useMemo, useEffect, useRef } from 'react'
import InvoiceTable from './InvoiceTable'
import { esPersonal, GASTOS_PERSONALES } from '../utils/categorias'
import { classificationAPI, rebajasAPI } from '../services/api'
import { nombreMes } from '../utils/periodo'
import './InvoiceTabs.css'

import { fmtMoney as money } from '../utils/format'

// La fecha del comprobante viene como 'dd/mm/yyyy' (SRI) o 'yyyy-mm-dd'. La
// vigencia del proveedor se guarda como 'yyyy-mm-dd'. Normalizamos a ISO para
// comparar y para agrupar por mes (clave 'yyyy-mm').
function fechaISO(f) {
  if (!f) return ''
  const s = String(f).trim()
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  return ''
}

// True si la calificación del proveedor estaba VIGENTE en la fecha de la factura.
// Sin rango definido -> no se puede afirmar vigencia (gris).
function vigenteEn(iso, prov) {
  if (!iso || !prov || !prov.calificado) return false
  const ini = prov.vigencia_inicio || ''
  const fin = prov.vigente_hasta || ''
  if (!ini && !fin) return false
  if (ini && iso < ini) return false
  if (fin && iso > fin) return false
  return true
}

function etiquetaMes(key) {
  if (key === 'sin-fecha') return 'Sin fecha'
  const [y, m] = key.split('-')
  return `${nombreMes(m)} ${y}`
}

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

export default function InvoiceTabs({ invoices, client, onInvoicesChange }) {
  const [tab, setTab] = useState('datos')
  const [pendCatalog, setPendCatalog] = useState([])
  const [pendInput, setPendInput] = useState({})
  const [pendBusy, setPendBusy] = useState('')
  const [pendMsg, setPendMsg] = useState('') // confirmación no bloqueante
  const [actMap, setActMap] = useState({}) // RUC -> actividad económica (SRI)
  const [proveedores, setProveedores] = useState([]) // catálogo de proveedores calificados
  const [calIncluirNo, setCalIncluirNo] = useState(false) // mostrar también no calificados (para calificar)
  const [calMsg, setCalMsg] = useState('')
  const [calBusy, setCalBusy] = useState('') // RUC que se está guardando

  const ident = client?.identificacion || ''

  // Catálogo de proveedores calificados del contribuyente (RUC -> calificado + vigencia)
  const loadProveedores = () => {
    if (!ident) { setProveedores([]); return }
    rebajasAPI.listProveedores(ident)
      .then((res) => setProveedores(res.data?.data || []))
      .catch(() => {})
  }
  useEffect(() => { loadProveedores() }, [ident])

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

  useEffect(() => {
    if (!pendMsg) return
    const t = setTimeout(() => setPendMsg(''), 4000)
    return () => clearTimeout(t)
  }, [pendMsg])

  // Asigna y graba automáticamente, SIN salir del menú de Pendientes.
  const aplicarPendiente = async (ruc, nombre, catArg) => {
    const cat = (catArg ?? pendInput[ruc] ?? '').trim().toUpperCase()
    if (!cat || pendBusy) return
    setPendBusy(ruc)
    try {
      const res = await classificationAPI.create(ruc, nombre, cat)
      const n = res?.data?.reclasificadas ?? 0
      setPendInput((prev) => { const o = { ...prev }; delete o[ruc]; return o })
      setPendMsg(`✔ ${nombre || ruc} → ${cat}${n ? ` · ${n} factura(s)` : ''}`)
      await onInvoicesChange() // recarga: la fila desaparece de Pendientes; el tab se mantiene
    } catch (e) {
      setPendMsg('⚠ Error al asignar: ' + (e.response?.data?.detail || e.message))
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

  // Trae la actividad económica (SRI) de los RUC pendientes, para discriminar mejor.
  // Se excluyen los RUC ya resueltos (presentes en actMap) para no re-consultar
  // el mismo RUC en cada cambio de la lista de pendientes.
  const actMapRef = useRef(actMap)
  useEffect(() => { actMapRef.current = actMap }, [actMap])

  useEffect(() => {
    const rucs = pendientes.map((p) => p.ruc).filter((r) => r && !(r in actMapRef.current))
    if (rucs.length === 0) return
    classificationAPI.actividadesRucs(rucs)
      .then((res) => setActMap((m) => ({ ...m, ...(res.data || {}) })))
      .catch(() => {})
  }, [pendientes])

  // ── CALIFICADOS: gastos de proveedores calificados, agrupados por mes ──
  const provByRuc = useMemo(() => {
    const m = {}
    for (const p of proveedores) {
      const r = (p.ruc || '').trim()
      if (r) m[r] = p
    }
    return m
  }, [proveedores])

  // Nº de gastos cuyo proveedor está calificado (para la insignia de la pestaña)
  const calCount = useMemo(() => rowsOk.reduce((n, i) => {
    const p = provByRuc[(i.ruc_proveedor || '').trim()]
    return n + (p && p.calificado ? 1 : 0)
  }, 0), [rowsOk, provByRuc])

  // Agrupa los gastos por mes (yyyy-mm). Solo proveedores calificados, salvo que
  // se active "incluir no calificados" para poder calificarlos desde aquí.
  const calMeses = useMemo(() => {
    const groups = {}
    for (const inv of rowsOk) {
      const ruc = (inv.ruc_proveedor || '').trim()
      if (!ruc) continue
      const prov = provByRuc[ruc] || null
      const esCalif = !!(prov && prov.calificado)
      if (!calIncluirNo && !esCalif) continue
      const iso = fechaISO(inv.fecha)
      const key = iso ? iso.slice(0, 7) : 'sin-fecha'
      if (!groups[key]) groups[key] = { key, rows: [], total: 0, vigentes: 0 }
      const vig = esCalif && vigenteEn(iso, prov)
      groups[key].rows.push({ inv, prov, esCalif, iso, vig })
      groups[key].total += parseFloat(inv.total) || 0
      if (vig) groups[key].vigentes += 1
    }
    return Object.values(groups).sort((a, b) => (a.key < b.key ? 1 : -1))
  }, [rowsOk, provByRuc, calIncluirNo])

  useEffect(() => {
    if (!calMsg) return
    const t = setTimeout(() => setCalMsg(''), 4000)
    return () => clearTimeout(t)
  }, [calMsg])

  // Guarda/actualiza un proveedor del catálogo (calificación y/o vigencia).
  // Es a nivel de proveedor: afecta a todos sus gastos del listado.
  const guardarProveedor = async (ruc, nombre, patch) => {
    ruc = (ruc || '').trim()
    if (!ident || !ruc || calBusy) return
    const cur = provByRuc[ruc] || {}
    const body = {
      identificacion: ident,
      ruc,
      nombre: (cur.nombre || nombre || '').trim(),
      calificado: patch.calificado ?? !!cur.calificado,
      categoria: cur.categoria || '',
      actividad: cur.actividad || '',
      vigencia: cur.vigencia || '',
      vigencia_inicio: patch.vigencia_inicio ?? cur.vigencia_inicio ?? null,
      vigente_hasta: patch.vigente_hasta ?? cur.vigente_hasta ?? null,
    }
    setCalBusy(ruc)
    try {
      const res = await rebajasAPI.upsertProveedor(body)
      const saved = res?.data || body
      setProveedores((prev) => {
        const i = prev.findIndex((p) => (p.ruc || '').trim() === ruc)
        if (i >= 0) { const cp = [...prev]; cp[i] = { ...cp[i], ...saved }; return cp }
        return [...prev, saved]
      })
      setCalMsg(`✔ Guardado · ${body.nombre || ruc}`)
    } catch (e) {
      setCalMsg('⚠ No se pudo guardar: ' + (e.response?.data?.detail || e.message))
    } finally {
      setCalBusy('')
    }
  }

  // Sube un documento de respaldo de la calificación del proveedor. Los
  // documentos NO se descartan: quedan adjuntos al proveedor (junto con su
  // rango de vigencia inicio–fin), reutilizables en cualquier período.
  const subirDocumento = async (ruc, nombre, file) => {
    ruc = (ruc || '').trim()
    if (!ident || !ruc || !file || calBusy) return
    const cur = provByRuc[ruc] || {}
    setCalBusy(ruc)
    try {
      const res = await rebajasAPI.subirDocProveedor({
        identificacion: ident, ruc,
        nombre: cur.nombre || nombre || '',
        calificado: cur.calificado ?? false,
        vigente_hasta: cur.vigente_hasta || '',
        file,
      })
      const saved = res?.data
      if (saved) {
        setProveedores((prev) => {
          const i = prev.findIndex((p) => (p.ruc || '').trim() === ruc)
          if (i >= 0) { const cp = [...prev]; cp[i] = { ...cp[i], ...saved }; return cp }
          return [...prev, saved]
        })
      } else {
        loadProveedores()
      }
      setCalMsg(`✔ Documento adjuntado · ${cur.nombre || nombre || ruc}`)
    } catch (e) {
      setCalMsg('⚠ No se pudo subir el documento: ' + (e.response?.data?.detail || e.message))
    } finally {
      setCalBusy('')
    }
  }

  // Abre el documento en una pestaña nueva mediante URL firmada temporal.
  const verDocumento = async (path) => {
    try {
      const res = await rebajasAPI.docUrl(path)
      const url = res?.data?.url
      if (url) window.open(url, '_blank', 'noopener')
      else setCalMsg('⚠ No se pudo abrir el documento')
    } catch (e) {
      setCalMsg('⚠ No se pudo abrir: ' + (e.response?.data?.detail || e.message))
    }
  }

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
        <button className={tab === 'calificados' ? 'active' : ''} onClick={() => setTab('calificados')}>
          🏅 Calificados {calCount > 0 && <span className="itabs-badge cal">{calCount}</span>}
        </button>
      </div>

      {tab === 'datos' && (
        <InvoiceTable invoices={invoices} onInvoicesChange={onInvoicesChange} catalog={pendCatalog} clientId={client?.id} />
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
              {pendMsg && <div className="pend-msg">{pendMsg}</div>}
              <p className="pend-hint">Elige la categoría del listado y se graba automáticamente; puedes seguir asignando las demás sin salir de aquí.</p>
              <datalist id="pend-cat-list">
                {pendOpciones.map((c) => <option key={c} value={c} />)}
              </datalist>
              <table className="rs-table pend-table">
                <thead>
                  <tr style={{ background: '#d97706' }}>
                    <th>RUC</th>
                    <th>Nombre</th>
                    <th>Actividad económica (SRI)</th>
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
                        <td className="pend-act actividad-sri" title={actMap[p.ruc] || ''}>{actMap[p.ruc] || '—'}</td>
                        <td>
                          <input
                            className="pend-cat-input"
                            list="pend-cat-list"
                            placeholder="Categoría…"
                            value={val}
                            disabled={busy}
                            onChange={(e) => {
                              const v = e.target.value.toUpperCase()
                              setPendInput((prev) => ({ ...prev, [p.ruc]: v }))
                              // Si eligió una categoría completa del listado, grabar al instante
                              if (pendOpciones.includes(v)) aplicarPendiente(p.ruc, p.nombre, v)
                            }}
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

      {tab === 'calificados' && (
        <div className="rs-wrap">
          {!ident ? (
            <div className="itabs-empty">Selecciona un contribuyente para ver sus proveedores calificados.</div>
          ) : (
            <>
              {calMsg && <div className="pend-msg">{calMsg}</div>}
              <p className="pend-hint">
                Gastos de <strong>proveedores calificados</strong> por mes. En <span className="cal-key cal-vig">amarillo</span> los
                que estaban <strong>vigentes</strong> a la fecha de la factura; en <span className="cal-key cal-novig">gris</span> los
                que <strong>no están en vigencia</strong> (vencidos o sin fechas definidas). Define el rango de vigencia de cada
                calificación (puede ser de distintos años) en las celdas de fecha y <strong>adjunta los documentos</strong> de
                respaldo: no se descartan, quedan guardados con su rango de vigencia inicio–fin.
              </p>
              <label className="cal-toggle">
                <input type="checkbox" checked={calIncluirNo} onChange={(e) => setCalIncluirNo(e.target.checked)} />
                Incluir proveedores no calificados (para marcarlos como calificados)
              </label>

              {calMeses.length === 0 ? (
                <div className="itabs-empty">
                  {calIncluirNo
                    ? 'No hay gastos con RUC de proveedor en este período.'
                    : 'No hay gastos de proveedores calificados. Activa la casilla de arriba para marcar proveedores como calificados.'}
                </div>
              ) : (
                calMeses.map((g) => (
                  <details key={g.key} className="cal-mes" open>
                    <summary className="cal-mes-head">
                      <span className="cal-mes-nom">{etiquetaMes(g.key)}</span>
                      <span className="cal-mes-meta">
                        {g.rows.length} gasto(s) · {money(g.total)}
                        {g.vigentes > 0 && <span className="cal-mes-vig"> · {g.vigentes} vigente(s)</span>}
                      </span>
                    </summary>
                    <div className="rs-scroll">
                      <table className="rs-table cal-table">
                        <thead>
                          <tr>
                            <th>Fecha</th>
                            <th>RUC</th>
                            <th>Proveedor</th>
                            <th>Categoría</th>
                            <th className="r">Total</th>
                            <th>Vigencia (inicio → fin)</th>
                            <th>Documentos</th>
                            <th>Estado</th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.rows.map(({ inv, prov, esCalif, iso, vig }) => {
                            const ruc = (inv.ruc_proveedor || '').trim()
                            const guardando = calBusy === ruc
                            return (
                              <tr key={inv.id} className={vig ? 'cal-vig' : 'cal-novig'}>
                                <td>{inv.fecha || '-'}</td>
                                <td>{ruc || '-'}</td>
                                <td>{inv.nombre_proveedor || '-'}</td>
                                <td>{inv.clasificacion || 'SIN CLASIFICAR'}</td>
                                <td className="r">{money(parseFloat(inv.total) || 0)}</td>
                                <td className="cal-vigedit">
                                  {esCalif ? (
                                    <>
                                      <input type="date" value={prov?.vigencia_inicio || ''} disabled={guardando}
                                        onChange={(e) => guardarProveedor(ruc, inv.nombre_proveedor, { vigencia_inicio: e.target.value || null })} />
                                      <span className="cal-sep">→</span>
                                      <input type="date" value={prov?.vigente_hasta || ''} disabled={guardando}
                                        onChange={(e) => guardarProveedor(ruc, inv.nombre_proveedor, { vigente_hasta: e.target.value || null })} />
                                    </>
                                  ) : (
                                    <span className="cal-nocalif">—</span>
                                  )}
                                </td>
                                <td className="cal-docs">
                                  {esCalif ? (
                                    <>
                                      {(prov?.documentos || []).map((d, di) => (
                                        <button key={di} type="button" className="cal-doc-link"
                                          title={d.nombre || d.path}
                                          onClick={() => verDocumento(d.path)}>
                                          📄 {(() => { const n = d.nombre || 'documento'; return n.length > 18 ? n.slice(0, 16) + '…' : n })()}
                                        </button>
                                      ))}
                                      <label className="cal-doc-up">
                                        {guardando ? '…' : '＋ Adjuntar'}
                                        <input type="file" hidden disabled={guardando}
                                          accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.xlsx,.xls,.csv"
                                          onChange={(e) => { const f = e.target.files?.[0]; if (f) subirDocumento(ruc, inv.nombre_proveedor, f); e.target.value = '' }} />
                                      </label>
                                    </>
                                  ) : (
                                    <span className="cal-nocalif">—</span>
                                  )}
                                </td>
                                <td>
                                  {esCalif ? (
                                    <span className={`cal-badge ${vig ? 'vig' : 'novig'}`} title={iso ? `Factura: ${iso}` : ''}>
                                      {vig ? '✔ Vigente' : (prov?.vigencia_inicio || prov?.vigente_hasta ? '✗ No vigente' : 'Sin vigencia')}
                                    </span>
                                  ) : (
                                    <label className="cal-marcar">
                                      <input type="checkbox" disabled={guardando}
                                        onChange={() => guardarProveedor(ruc, inv.nombre_proveedor, { calificado: true })} />
                                      Calificar
                                    </label>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </details>
                ))
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
