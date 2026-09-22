// ------------------------------------------------------------
// Desarrollado por Marco Antonio Posligua San Martín
// ------------------------------------------------------------
//
// El cierre de una declaración, en UNA franja y en orden:
//
//   1. Guardada  →  2. Presentada en el SRI  →  3. Facturada
//
// Antes eran tres cosas sueltas que no se sabía cuál contaba: «Guardar» decía
// «lista para facturar», Clientes pendientes esperaba otra marca (la del SRI) y
// facturar era ir a otro módulo, elegir el mes y buscar al contribuyente. Ahora
// el trabajo está TERMINADO cuando se presenta en el SRI —es lo único que
// cuenta en Honorarios y en Pendientes—, se marca con un solo botón (que guarda
// si hacía falta) y la factura sale desde acá, en el sistema que le toca a ese
// contribuyente: CMAJ en Odoo, Marco Antonio en Contabilidad MAP.
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { facturarAPI } from '../services/api'
import { useAccess } from '../context/AccessContext'
import { fmtMoney as money } from '../utils/format'
import './CierreDeclaracion.css'

const NOMBRE_CORTO = { cmaj: 'CMAJ · Odoo', map: 'Marco Antonio · Contabilidad MAP' }

export default function CierreDeclaracion({
  tipo, hayDecl, declActual, identificacion, preguntar, onPresentar, onDeshacer, onNoTodavia, ocupado,
}) {
  const { isAdmin } = useAccess()
  const guardada = !!declActual
  const presentada = !!declActual?.presentada_sri

  return (
    <section className={`cd-cierre ${presentada ? 'cd-ok' : ''} ${preguntar && !presentada ? 'cd-pregunta' : ''}`}>
      <ol className="cd-pasos">
        <li className={guardada ? 'hecho' : ''}>
          <span className="cd-num">{guardada ? '✓' : '1'}</span> Guardada
        </li>
        <li className={presentada ? 'hecho' : ''}>
          <span className="cd-num">{presentada ? '✓' : '2'}</span> Presentada en el SRI
        </li>
        <li className={presentada ? 'activo' : ''}>
          <span className="cd-num">3</span> Facturada
        </li>
      </ol>

      {!presentada ? (
        <div className="cd-fila">
          <span className="cd-msg">
            {preguntar
              ? <>¿Ya <strong>presentaste</strong> la declaración {tipo} en el portal del SRI?</>
              : <>Cuando la presentes en el portal del SRI, márcalo acá: queda <strong>terminada</strong>,
                sale de Clientes pendientes y pasa a facturarse.{!guardada && ' Se guarda sola.'}</>}
          </span>
          <span className="cd-acciones">
            <button className="dc-btn primary" disabled={!hayDecl || ocupado} onClick={onPresentar}>
              {ocupado ? '⏳ Registrando…' : '✅ Ya la presenté en el SRI'}
            </button>
            {preguntar && (
              <button className="dc-btn small" onClick={onNoTodavia}>Todavía no</button>
            )}
          </span>
        </div>
      ) : (
        <>
          <div className="cd-fila">
            <span className="cd-msg">
              ✅ <strong>Terminada</strong>: presentada en el SRI
              {declActual.presentada_sri_at && <> el {new Date(declActual.presentada_sri_at).toLocaleDateString('es-EC')}</>}.
            </span>
            <button className="cd-deshacer" disabled={ocupado} onClick={onDeshacer}
              title="Si se marcó por error">Deshacer</button>
          </div>
          {isAdmin
            ? <Facturar identificacion={identificacion} />
            : <p className="cd-nota">Queda lista para facturar en 🧾 Facturación.</p>}
        </>
      )}
    </section>
  )
}

// La factura de honorarios del mes, desde el sistema que le toca.
function Facturar({ identificacion }) {
  const navigate = useNavigate()
  const [r, setR] = useState(null)
  const [error, setError] = useState('')
  const [emitiendo, setEmitiendo] = useState(false)
  const [resultado, setResultado] = useState(null)

  const cargar = useCallback(async () => {
    if (!identificacion) return
    setError('')
    try {
      const { data } = await facturarAPI.resumen(identificacion)
      setR(data)
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
    }
  }, [identificacion])
  useEffect(() => { setR(null); setResultado(null); cargar() }, [cargar])

  const cambiarEmisor = async (emisor) => {
    if (!r || r.emisor === emisor) return
    setR({ ...r, emisor, emisor_origen: 'guardado' })
    try { await facturarAPI.emisor(identificacion, emisor) }
    catch (e) { setError(e.response?.data?.detail || e.message); cargar() }
  }

  const emitir = async () => {
    setEmitiendo(true); setError('')
    try {
      const { data } = await facturarAPI.emitir(identificacion, r.periodo.mes, r.periodo.anio)
      setResultado(data)
      cargar()
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
    } finally { setEmitiendo(false) }
  }

  if (error && !r) return <p className="cd-error">⚠ {error}</p>
  if (!r) return <p className="cd-nota">Buscando los honorarios del mes…</p>

  const irAHonorarios = () => navigate(`/facturacion/honorarios?p=${r.periodo.anio}-${String(r.periodo.mes).padStart(2, '0')}`)

  if (r.sin_honorarios) {
    return (
      <div className="cd-factura">
        <span className="cd-msg">Este contribuyente no tiene servicios con honorario para {r.periodo.etiqueta}.</span>
        <button className="dc-btn small" onClick={irAHonorarios}>💵 Ir a Honorarios</button>
      </div>
    )
  }

  if (r.facturada) {
    const f = r.factura || {}
    return (
      <div className="cd-factura cd-facturada">
        <span className="cd-msg">
          🧾 <strong>Facturada</strong> · {f.numero || 's/n'}
          {f.sistema === 'map' ? ' en Contabilidad MAP' : ' en Odoo'}
          {f.autorizada ? ' · autorizada por el SRI' : ' · esperando autorización del SRI'}
        </span>
      </div>
    )
  }

  const sinValor = !r.lineas.length
  const mapSinConfig = r.emisor === 'map' && !r.map_configurado
  return (
    <div className="cd-factura">
      <div className="cd-factura-cab">
        <strong>🧾 Factura de honorarios · {r.periodo.etiqueta}</strong>
        <span className="cd-emisor" role="group" aria-label="Quién factura">
          {Object.keys(NOMBRE_CORTO).map((k) => (
            <button key={k} className={r.emisor === k ? 'act' : ''} onClick={() => cambiarEmisor(k)}>
              {NOMBRE_CORTO[k]}
            </button>
          ))}
        </span>
      </div>
      {r.emisor_origen === 'odoo' && (
        <p className="cd-nota">Según su última factura en Odoo. Si no corresponde, elige el otro: queda guardado.</p>
      )}
      {sinValor ? (
        <p className="cd-nota">No hay valor a cobrar cargado para este mes.</p>
      ) : (
        <ul className="cd-lineas">
          {r.lineas.map((l) => (
            <li key={l.concepto}>
              <span>{l.concepto}{l.descuento > 0 && <small> (−{l.descuento}%)</small>}</span>
              <span>{money(l.bruto)}</span>
            </li>
          ))}
          <li className="cd-total"><span>Total con IVA</span><span>{money(r.total)}</span></li>
        </ul>
      )}
      {mapSinConfig && <p className="cd-error">⚠ Contabilidad MAP todavía no está conectada en el servidor (falta MAP_TOKEN).</p>}
      {error && <p className="cd-error">⚠ {error}</p>}
      {resultado && !resultado.ya_existia && resultado.estado && resultado.estado !== 'AUTORIZADA' && (
        <p className="cd-nota">
          Quedó {String(resultado.estado).toLowerCase()} ante el SRI
          {resultado.mensajes?.length ? `: ${resultado.mensajes.join(' · ')}` : ''}.
        </p>
      )}
      <div className="cd-acciones">
        <button className="dc-btn primary" disabled={sinValor || emitiendo || mapSinConfig} onClick={emitir}>
          {emitiendo ? '⏳ Emitiendo…' : `🧾 Emitir ${money(r.total)} en ${r.emisor === 'map' ? 'Contabilidad MAP' : 'Odoo'}`}
        </button>
        <button className="dc-btn small" onClick={irAHonorarios}>Ajustar valores</button>
      </div>
    </div>
  )
}
