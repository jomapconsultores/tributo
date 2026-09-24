/* ------------------------------------------------------------
 * Desarrollado por Marco Antonio Posligua San Martín
 * ------------------------------------------------------------ */

/**
 * Archivo de XML: todo lo que se subió al sistema, mes a mes.
 *
 * Los XML siempre se guardaron —son el respaldo, y ante una discusión manda el
 * original—, pero no había manera de mirarlos: solo se podía bajar un ZIP del
 * período abierto en pantalla. Para ver qué se cargó en un mes anterior había
 * que cambiarle el período al contribuyente y descargar el paquete entero.
 *
 * Acá se recorre sin tocar nada: contribuyente → mes → comprobantes, con el
 * número, la fecha, el emisor y el total leídos del propio XML, y el contenido
 * completo a un clic.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { xmlOriginalesAPI } from '../services/api'
import { filtrarClientesPorTexto } from '../utils/clientSearch'
import './ArchivoXML.css'

const MOD_LBL = {
  gasto: 'Gastos', ingreso_iva: 'Ingresos IVA', ingreso_ice: 'Ingresos ICE',
  retencion: 'Retenciones', retencion_efectuada: 'Retenc. efectuadas',
}
const MOD_CLS = {
  gasto: 'g', ingreso_iva: 'i', ingreso_ice: 'c',
  retencion: 'r', retencion_efectuada: 're',
}
const MESES = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio',
  'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']

const money = (n) => (n === null || n === undefined ? '—' : `$${Number(n).toFixed(2)}`)
// El SRI escribe las fechas dd/mm/aaaa; se dejan tal cual, que es como se leen acá.
const fecha = (f) => f || '—'

export default function ArchivoXML() {
  const [contribuyentes, setContribuyentes] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState('')
  const [busqueda, setBusqueda] = useState('')

  const [sel, setSel] = useState(null)          // contribuyente elegido
  const [periodos, setPeriodos] = useState([])
  const [cargandoPeriodos, setCargandoPeriodos] = useState(false)

  const [periodo, setPeriodo] = useState(null)  // mes elegido
  const [modulo, setModulo] = useState('')      // filtro dentro del mes
  const [docs, setDocs] = useState([])
  const [cargandoDocs, setCargandoDocs] = useState(false)

  const [viendo, setViendo] = useState(null)    // XML abierto

  useEffect(() => {
    xmlOriginalesAPI.contribuyentes()
      .then(({ data }) => setContribuyentes(data?.data || []))
      .catch((e) => setError(e.response?.data?.detail || 'No se pudo cargar el archivo'))
      .finally(() => setCargando(false))
  }, [])

  const abrirContribuyente = useCallback((c) => {
    setSel(c); setPeriodo(null); setDocs([]); setModulo('')
    setCargandoPeriodos(true)
    xmlOriginalesAPI.periodos(c.identificacion)
      .then(({ data }) => setPeriodos(data?.data || []))
      .catch((e) => alert(e.response?.data?.detail || 'No se pudieron cargar los meses'))
      .finally(() => setCargandoPeriodos(false))
  }, [])

  const abrirPeriodo = useCallback((p, mod = '') => {
    setPeriodo(p); setModulo(mod)
    setCargandoDocs(true)
    xmlOriginalesAPI.listar(p.client_id, mod || undefined)
      .then(({ data }) => setDocs(data?.data || []))
      .catch((e) => alert(e.response?.data?.detail || 'No se pudieron cargar los comprobantes'))
      .finally(() => setCargandoDocs(false))
  }, [])

  const verXml = async (d) => {
    try {
      const { data } = await xmlOriginalesAPI.ver(d.id)
      setViendo({ ...d, xml: data.xml })
    } catch (e) {
      alert(e.response?.data?.detail || 'No se pudo abrir el XML')
    }
  }

  const descargarZip = async (p, mod) => {
    try {
      const r = await xmlOriginalesAPI.descargar(p.client_id, mod)
      const url = URL.createObjectURL(new Blob([r.data], { type: 'application/zip' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `${MOD_LBL[mod] || mod}_${sel?.identificacion}_${p.anio}_${String(p.mes).padStart(2, '0')}.zip`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      alert(e.response?.data?.detail || 'No se pudo descargar')
    }
  }

  const lista = useMemo(
    () => filtrarClientesPorTexto(contribuyentes, busqueda),
    [contribuyentes, busqueda],
  )
  const totalXml = useMemo(
    () => contribuyentes.reduce((s, c) => s + (c.total || 0), 0),
    [contribuyentes],
  )

  return (
    <div className="ax-page">
      {viendo && <VisorXML doc={viendo} onClose={() => setViendo(null)} />}

      <header className="ax-header">
        <div>
          <h1>🗂 Archivo de XML</h1>
          <p className="ax-sub">
            Todos los comprobantes que se han subido, mes a mes. Se guardan tal como
            vinieron del SRI: son el respaldo de lo declarado.
          </p>
        </div>
        {!cargando && !error && (
          <div className="ax-kpi">
            <span className="ax-kpi-num">{totalXml.toLocaleString('es-EC')}</span>
            <span className="ax-kpi-lbl">XML guardados</span>
          </div>
        )}
      </header>

      {error && <div className="ax-error">{error}</div>}

      {cargando ? <div className="ax-cargando">Cargando el archivo…</div> : (
        <div className="ax-cols">
          {/* Columna 1: contribuyentes con XML */}
          <aside className="ax-panel ax-contrib">
            <div className="ax-panel-head">Contribuyentes</div>
            <input className="ax-buscar" placeholder="🔍 Buscar por nombre o RUC…"
                   value={busqueda} onChange={(e) => setBusqueda(e.target.value)} />
            {lista.length === 0 ? (
              <p className="ax-vacio">
                {contribuyentes.length === 0
                  ? 'Todavía no hay XML guardados. Se guardan solos al subir comprobantes.'
                  : 'Sin coincidencias.'}
              </p>
            ) : lista.map((c) => (
              <button key={c.identificacion}
                      className={`ax-contrib-item ${sel?.identificacion === c.identificacion ? 'sel' : ''}`}
                      onClick={() => abrirContribuyente(c)}>
                <span className="ax-contrib-nombre">{c.nombre}</span>
                <span className="ax-contrib-meta">
                  {c.identificacion} · {c.total} XML · {c.periodos} mes{c.periodos === 1 ? '' : 'es'}
                </span>
              </button>
            ))}
          </aside>

          {/* Columna 2: meses y comprobantes */}
          <section className="ax-panel ax-detalle">
            {!sel ? (
              <div className="ax-placeholder">
                <span className="ax-placeholder-ico">🗂</span>
                Elige un contribuyente para ver sus meses guardados.
              </div>
            ) : (
              <>
                <div className="ax-panel-head">
                  {sel.nombre} <span className="ax-ruc">{sel.identificacion}</span>
                </div>

                {cargandoPeriodos ? <div className="ax-cargando">Cargando meses…</div> : (
                  <div className="ax-meses">
                    {periodos.map((p) => (
                      <article key={p.client_id}
                               className={`ax-mes ${periodo?.client_id === p.client_id ? 'sel' : ''}`}>
                        <button className="ax-mes-btn" onClick={() => abrirPeriodo(p)}>
                          <span className="ax-mes-nombre">{MESES[p.mes] || p.mes} {p.anio}</span>
                          <span className="ax-mes-total">{p.total} XML</span>
                        </button>
                        <div className="ax-mes-mods">
                          {Object.entries(p.modulos).map(([m, n]) => (
                            <button key={m} className={`ax-chip ${MOD_CLS[m] || ''} ${periodo?.client_id === p.client_id && modulo === m ? 'on' : ''}`}
                                    title={`Ver los ${n} de ${MOD_LBL[m] || m}`}
                                    onClick={() => abrirPeriodo(p, m)}>
                              {MOD_LBL[m] || m} <b>{n}</b>
                            </button>
                          ))}
                        </div>
                      </article>
                    ))}
                    {periodos.length === 0 && (
                      <p className="ax-vacio">Este contribuyente no tiene XML guardados.</p>
                    )}
                  </div>
                )}

                {periodo && (
                  <div className="ax-docs">
                    <div className="ax-docs-head">
                      <strong>
                        {MESES[periodo.mes] || periodo.mes} {periodo.anio}
                        {modulo ? ` · ${MOD_LBL[modulo] || modulo}` : ' · todos'}
                      </strong>
                      <span className="ax-docs-acts">
                        {modulo && (
                          <button className="ax-btn" onClick={() => descargarZip(periodo, modulo)}>
                            ⬇ Descargar ZIP
                          </button>
                        )}
                        {modulo && (
                          <button className="ax-btn" onClick={() => abrirPeriodo(periodo, '')}>
                            Ver todos
                          </button>
                        )}
                      </span>
                    </div>

                    {cargandoDocs ? <div className="ax-cargando">Leyendo los comprobantes…</div> : (
                      <div className="ax-tabla-wrap">
                        <table className="ax-tabla">
                          <thead>
                            <tr>
                              <th>Tipo</th><th>Número</th><th>Fecha</th>
                              <th>Emisor</th><th className="r">Total</th><th></th>
                            </tr>
                          </thead>
                          <tbody>
                            {docs.map((d) => (
                              <tr key={d.id}>
                                <td>
                                  <span className={`ax-chip mini ${MOD_CLS[d.modulo] || ''}`}>
                                    {MOD_LBL[d.modulo] || d.modulo}
                                  </span>
                                  {d.tipo && <div className="ax-tipo">{d.tipo}</div>}
                                </td>
                                <td className="ax-mono">{d.numero || '—'}</td>
                                <td>{fecha(d.fecha)}</td>
                                <td>
                                  <div className="ax-emisor">{d.emisor || '—'}</div>
                                  {d.ruc && <div className="ax-emisor-ruc">{d.ruc}</div>}
                                </td>
                                <td className="r ax-mono">{money(d.total)}</td>
                                <td>
                                  <button className="ax-link" onClick={() => verXml(d)}>Ver XML</button>
                                </td>
                              </tr>
                            ))}
                            {docs.length === 0 && (
                              <tr><td colSpan={6} className="ax-vacio">Sin comprobantes en esta selección.</td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

/** Visor del XML completo: se lee, se copia o se guarda como archivo. */
function VisorXML({ doc, onClose }) {
  const [copiado, setCopiado] = useState(false)

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(doc.xml || '')
      setCopiado(true)
      setTimeout(() => setCopiado(false), 1800)
    } catch { alert('No se pudo copiar. Selecciona el texto y cópialo a mano.') }
  }

  const descargar = () => {
    const url = URL.createObjectURL(new Blob([doc.xml || ''], { type: 'application/xml' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${(doc.numero || doc.clave || 'comprobante').replace(/[^\w-]/g, '_')}.xml`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="ax-overlay" onClick={onClose}>
      <div className="ax-visor" onClick={(e) => e.stopPropagation()}>
        <header className="ax-visor-head">
          <div>
            <h3>{doc.tipo || 'Comprobante'} {doc.numero}</h3>
            <p>{doc.emisor}{doc.ruc ? ` · ${doc.ruc}` : ''}{doc.fecha ? ` · ${doc.fecha}` : ''}</p>
          </div>
          <button className="ax-cerrar" onClick={onClose} title="Cerrar">✕</button>
        </header>
        {doc.clave && (
          <p className="ax-clave"><span>Clave de acceso</span><code>{doc.clave}</code></p>
        )}
        <pre className="ax-xml">{doc.xml}</pre>
        <footer className="ax-visor-pie">
          <button className="ax-btn" onClick={copiar}>{copiado ? '✔ Copiado' : '📋 Copiar'}</button>
          <button className="ax-btn" onClick={descargar}>⬇ Descargar .xml</button>
          <button className="ax-btn primary" onClick={onClose}>Cerrar</button>
        </footer>
      </div>
    </div>
  )
}
