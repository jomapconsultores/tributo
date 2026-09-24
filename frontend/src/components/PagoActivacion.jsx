/* ------------------------------------------------------------
 * Desarrollado por Marco Antonio Posligua San Martín
 * ------------------------------------------------------------ */

/**
 * Pago y activación del acceso, visto por el CLIENTE.
 *
 * Es la contraparte de Administración → Activaciones: acá el cliente ve cuánto
 * debe, hasta cuándo tiene acceso y sube el comprobante de su transferencia.
 * El comprobante llega al administrador (correo + insignia) y este lo activa
 * con un botón.
 *
 * Se usa en dos lugares y por eso es un componente y no una pantalla:
 *   · «Mi cuenta», para renovar antes de que venza;
 *   · «El acceso está en pausa» (/sin-acceso), que es donde cae quien ya está
 *     bloqueado — y era una calle sin salida: decía «avisa al administrador» y
 *     no había dónde dejar nada.
 */
import { useCallback, useEffect, useState } from 'react'
import { activacionAPI } from '../services/api'
import { clearAll as clearApiCache } from '../services/cache'
import './PagoActivacion.css'

const HOY = () => new Date().toISOString().slice(0, 10)

const METODO_LBL = {
  transferencia: 'Transferencia bancaria',
  deposito: 'Depósito',
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  otro: 'Otro',
}

const ESTADO_LBL = {
  pendiente: { ico: '⏳', txt: 'En revisión', cls: 'pend' },
  aprobado: { ico: '✅', txt: 'Aprobado', cls: 'ok' },
  rechazado: { ico: '⚠️', txt: 'No confirmado', cls: 'err' },
}

const money = (n) => `$${Number(n || 0).toFixed(2)}`

/**
 * `enPausa` lo fija la pantalla que monta el componente: en /sin-acceso el
 * usuario está fuera aunque su suscripción figure vigente (p. ej. cuenta nueva
 * sin módulos todavía), y la tarjeta no puede decirle «acceso activo» mientras
 * él está mirando una puerta cerrada.
 */
export default function PagoActivacion({ titulo = '💳 Mi plan y pagos', enPausa = false }) {
  const [datos, setDatos] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [abierto, setAbierto] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [aviso, setAviso] = useState(null)
  const [form, setForm] = useState({
    meses: 1, monto: '', fecha_pago: HOY(), metodo: 'transferencia',
    banco: '', referencia: '', nota: '', file: null,
  })

  const cargar = useCallback(() => {
    setCargando(true)
    activacionAPI.estado()
      .then(({ data }) => {
        setDatos(data)
        // Monto sugerido = lo que le toca pagar por un mes, con IVA. Es lo que
        // de verdad transfiere, así no tiene que hacer la cuenta él.
        const uno = (data.cobro?.opciones || []).find((o) => o.meses === 1)
        setForm((f) => ({ ...f, monto: uno?.total ? String(uno.total.toFixed(2)) : '' }))
      })
      .catch((e) => setError(e?.response?.data?.detail || 'No se pudo cargar tu plan'))
      .finally(() => setCargando(false))
  }, [])

  useEffect(cargar, [cargar])

  const upd = (patch) => setForm((f) => ({ ...f, ...patch }))

  // Al cambiar el plazo se recalcula el sugerido: el descuento por pago
  // anticipado lo aplica el servidor, no una cuenta hecha acá que podría
  // discrepar de la que ve el administrador.
  const cambiarMeses = (meses) => {
    const op = (datos?.cobro?.opciones || []).find((o) => o.meses === Number(meses))
    upd({ meses: Number(meses), monto: op?.total ? String(op.total.toFixed(2)) : form.monto })
  }

  const enviar = async (e) => {
    e.preventDefault()
    setAviso(null)
    if (!(parseFloat(form.monto) > 0)) {
      setAviso({ ok: false, texto: 'Escribe el valor que pagaste.' }); return
    }
    setEnviando(true)
    try {
      await activacionAPI.enviar({
        file: form.file, monto: parseFloat(form.monto), meses: form.meses,
        fecha_pago: form.fecha_pago, metodo: form.metodo, banco: form.banco,
        referencia: form.referencia, nota: form.nota,
      })
      setAbierto(false)
      setForm((f) => ({ ...f, referencia: '', nota: '', file: null }))
      setAviso({ ok: true, texto: 'Comprobante enviado. El administrador lo revisará y activará tu acceso.' })
      cargar()
    } catch (err) {
      setAviso({ ok: false, texto: err?.response?.data?.detail || 'No se pudo enviar el comprobante' })
    } finally { setEnviando(false) }
  }

  const verArchivo = async (id) => {
    try {
      const { data } = await activacionAPI.archivo(id)
      if (data.url) window.open(data.url, '_blank', 'noopener')
    } catch (err) {
      alert(err?.response?.data?.detail || 'No se pudo abrir el comprobante')
    }
  }

  if (cargando) return <section className="pa-card"><p className="pa-muted">Cargando tu plan…</p></section>
  if (error) return <section className="pa-card"><p className="pa-aviso err">{error}</p></section>

  const sub = datos?.suscripcion || {}
  const opciones = datos?.cobro?.opciones || []
  const pendiente = datos?.pendiente
  const bloqueado = !sub.vigente || enPausa
  const sinTarifa = !Number(datos?.cobro?.precio_mensual)

  return (
    <section className="pa-card">
      <header className="pa-head">
        <h2>{titulo}</h2>
        <span className={`pa-estado ${bloqueado ? 'err' : 'ok'}`}>
          {bloqueado ? '⛔ Acceso en pausa' : '✅ Acceso activo'}
        </span>
      </header>

      <div className="pa-resumen">
        <div><span>Plan</span><strong>{sub.plan || '—'}</strong></div>
        <div>
          <span>Valor mensual</span>
          <strong>
            {sinTarifa ? '—' : `${money(datos.cobro.precio_mensual)}${datos.cobro.iva_incluido ? ' (IVA incl.)' : ' + IVA'}`}
          </strong>
        </div>
        <div>
          <span>{sub.vencida ? 'Venció el' : 'Vigente hasta'}</span>
          <strong>{sub.proximo_pago || '—'}</strong>
        </div>
        {datos?.titular?.nombre && (
          <div><span>A nombre de</span><strong>{datos.titular.nombre}</strong></div>
        )}
      </div>

      {bloqueado && (
        <p className="pa-nota-bloqueo">
          Tu acceso está en pausa. Envía el comprobante de tu pago y el administrador
          lo activa en cuanto lo revise.
        </p>
      )}

      {pendiente && (
        <div className="pa-pendiente">
          ⏳ Tienes un comprobante por <strong>{money(pendiente.monto)}</strong> del{' '}
          {String(pendiente.fecha_pago || '').slice(0, 10)} esperando revisión.
        </div>
      )}

      {aviso && <p className={`pa-aviso ${aviso.ok ? 'ok' : 'err'}`}>{aviso.texto}</p>}

      {!abierto && (
        <div className="pa-acciones-top">
          <button type="button" className="pa-btn primary" onClick={() => setAbierto(true)}>
            📎 {pendiente ? 'Enviar otro comprobante' : 'Ya pagué: enviar comprobante'}
          </button>
          {/* Los permisos se guardan en memoria mientras la pestaña está
              abierta: sin esto, a quien acaban de activar le seguiría apareciendo
              la pantalla en pausa hasta que se le ocurriera recargar. */}
          {bloqueado && (
            <button type="button" className="pa-btn"
                    onClick={() => { clearApiCache(); window.location.assign('/') }}>
              🔄 Ya me activaron: entrar
            </button>
          )}
        </div>
      )}

      {abierto && (
        <form className="pa-form" onSubmit={enviar}>
          <p className="pa-hint">
            Sube la foto o el PDF de tu transferencia y confirma los datos. El valor
            es el que <strong>realmente transferiste</strong> (IVA incluido).
          </p>

          <div className="pa-row">
            <label>Período que pagas
              <select value={form.meses} onChange={(e) => cambiarMeses(e.target.value)}>
                {(opciones.length ? opciones : [{ meses: 1, descuento: 0 }]).map((o) => (
                  <option key={o.meses} value={o.meses}>
                    {o.meses} mes{o.meses > 1 ? 'es' : ''}
                    {o.descuento ? ` (−${Math.round(o.descuento * 100)}%)` : ''}
                    {o.total ? ` — ${money(o.total)}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>Valor pagado ($)
              <input type="number" step="0.01" min="0.01" required value={form.monto}
                     onChange={(e) => upd({ monto: e.target.value })} />
            </label>
          </div>

          <div className="pa-row">
            <label>Fecha del pago
              <input type="date" value={form.fecha_pago} max={HOY()}
                     onChange={(e) => upd({ fecha_pago: e.target.value })} />
            </label>
            <label>Forma de pago
              <select value={form.metodo} onChange={(e) => upd({ metodo: e.target.value })}>
                {(datos?.metodos || Object.keys(METODO_LBL)).map((m) => (
                  <option key={m} value={m}>{METODO_LBL[m] || m}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="pa-row">
            <label>Banco
              <input type="text" value={form.banco} placeholder="Pichincha, Guayaquil…"
                     onChange={(e) => upd({ banco: e.target.value })} />
            </label>
            <label>N.º de comprobante
              <input type="text" value={form.referencia} placeholder="Documento o transacción"
                     onChange={(e) => upd({ referencia: e.target.value })} />
            </label>
          </div>

          <label>Comprobante (imagen o PDF, hasta 8 MB)
            <input type="file" accept="image/*,application/pdf"
                   onChange={(e) => upd({ file: e.target.files?.[0] || null })} />
          </label>

          <label>Nota para el administrador (opcional)
            <textarea rows={2} value={form.nota} onChange={(e) => upd({ nota: e.target.value })} />
          </label>

          <div className="pa-acciones">
            <button type="button" className="pa-btn" disabled={enviando}
                    onClick={() => { setAbierto(false); setAviso(null) }}>Cancelar</button>
            <button type="submit" className="pa-btn primary" disabled={enviando}>
              {enviando ? 'Enviando…' : '✔ Enviar comprobante'}
            </button>
          </div>
        </form>
      )}

      {(datos?.comprobantes || []).length > 0 && (
        <div className="pa-historial">
          <h3>Comprobantes enviados</h3>
          <table className="pa-tabla">
            <thead><tr><th>Enviado</th><th>Pago</th><th>Valor</th><th>Estado</th><th></th></tr></thead>
            <tbody>
              {datos.comprobantes.map((c) => {
                const e = ESTADO_LBL[c.estado] || ESTADO_LBL.pendiente
                return (
                  <tr key={c.id}>
                    <td>{String(c.created_at || '').slice(0, 10)}</td>
                    <td>{String(c.fecha_pago || '').slice(0, 10)}</td>
                    <td>{money(c.monto)}</td>
                    <td>
                      <span className={`pa-chip ${e.cls}`}>{e.ico} {e.txt}</span>
                      {/* El motivo del rechazo se muestra acá: es la respuesta
                          que el cliente tendría que ir a pedir por teléfono. */}
                      {c.estado === 'rechazado' && c.nota_admin && (
                        <div className="pa-motivo">{c.nota_admin}</div>
                      )}
                    </td>
                    <td>
                      {c.comprobante_path && (
                        <button type="button" className="pa-link" onClick={() => verArchivo(c.id)}>Ver</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
