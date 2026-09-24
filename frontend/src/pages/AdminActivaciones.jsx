/* ------------------------------------------------------------
 * Desarrollado por Marco Antonio Posligua San Martín
 * ------------------------------------------------------------ */

/**
 * Activaciones: los pagos que informan los clientes, esperando revisión.
 *
 * Cada tarjeta es un comprobante. El administrador abre el archivo (URL firmada
 * de una hora), comprueba que el valor coincida y con UN botón lo aprueba: se
 * asienta el pago, la suscripción queda activa, se corre el vencimiento y al
 * cliente le llega el correo de «ya puedes entrar». Si no cuadra, lo rechaza
 * con un motivo, que es lo que el cliente ve en su pantalla.
 */
import { useCallback, useEffect, useState } from 'react'
import { activacionAPI } from '../services/api'
import './AdminActivaciones.css'

const FILTROS = [
  { key: 'pendiente', label: '⏳ Por revisar' },
  { key: 'aprobado', label: '✅ Aprobados' },
  { key: 'rechazado', label: '⚠️ Rechazados' },
  { key: '', label: 'Todos' },
]

const PLANES = [
  { key: '', label: 'No cambiar el plan' },
  { key: 'ice', label: 'Cálculo previo ICE ($50)' },
  { key: 'gastos_ret', label: 'Gastos y Retenciones ($50)' },
  { key: 'completo', label: 'Sistema Completo ($150)' },
]

const ESTADO_CHIP = {
  pendiente: { cls: 'pend', txt: '⏳ Por revisar' },
  aprobado: { cls: 'ok', txt: '✅ Aprobado' },
  rechazado: { cls: 'err', txt: '⚠️ Rechazado' },
}

const money = (n) => `$${Number(n || 0).toFixed(2)}`
const dia = (v) => String(v || '').slice(0, 10)

export default function AdminActivaciones() {
  const [filtro, setFiltro] = useState('pendiente')
  const [lista, setLista] = useState([])
  const [cargando, setCargando] = useState(true)
  const [busy, setBusy] = useState(false)
  const [aprobando, setAprobando] = useState(null)   // comprobante abierto en el modal

  const cargar = useCallback(() => {
    setCargando(true)
    activacionAPI.listar(filtro || undefined)
      .then(({ data }) => setLista(data?.data || []))
      .catch((e) => alert('Error: ' + (e.response?.data?.detail || e.message)))
      .finally(() => {
        setCargando(false)
        // Que la insignia del menú vuelva a contar: tras aprobar o rechazar,
        // el número de la izquierda tiene que bajar en el acto.
        window.dispatchEvent(new Event('activaciones-vistas'))
      })
  }, [filtro])

  useEffect(cargar, [cargar])

  const verArchivo = async (c) => {
    try {
      const { data } = await activacionAPI.archivo(c.id)
      if (data.url) window.open(data.url, '_blank', 'noopener')
    } catch (e) {
      alert(e.response?.data?.detail || 'No se pudo abrir el comprobante')
    }
  }

  const confirmarAprobacion = async ({ monto, meses, plan, nota }) => {
    setBusy(true)
    try {
      const { data } = await activacionAPI.aprobar(aprobando.id, {
        monto, meses, plan: plan || null, nota: nota || null,
      })
      setAprobando(null)
      cargar()
      alert(`✔ Acceso activado — cobrado ${money(data.cobrado)} por ${data.meses} mes(es).\n` +
            `Próximo pago: ${data.proximo_pago || '—'}` +
            // Pagó, pero su cuenta sigue sin módulos: entraría a «Sin módulos
            // contratados». Mejor enterarse acá que por la llamada del cliente.
            (data.sin_modulos
              ? '\n\n⚠️ Ojo: esta cuenta no tiene ningún módulo habilitado, así que todavía ' +
                'no podrá usar el sistema. Asígnale un plan en Administración.'
              : ''))
    } catch (e) {
      alert('Error: ' + (e.response?.data?.detail || e.message))
    } finally { setBusy(false) }
  }

  const rechazar = async (c) => {
    const motivo = window.prompt(
      `Rechazar el comprobante de ${c.user_email}.\n\n` +
      'Escribe el motivo: el cliente lo verá en la app y le llegará por correo.',
      '')
    if (motivo === null) return
    setBusy(true)
    try {
      await activacionAPI.rechazar(c.id, motivo)
      cargar()
    } catch (e) {
      alert('Error: ' + (e.response?.data?.detail || e.message))
    } finally { setBusy(false) }
  }

  return (
    <div className="aa-wrap">
      {aprobando && (
        <AprobarModal
          comprobante={aprobando}
          busy={busy}
          onConfirm={confirmarAprobacion}
          onCancel={() => setAprobando(null)}
        />
      )}

      <header className="aa-header">
        <h1 className="aa-title">💳 Activaciones</h1>
        <p className="aa-sub">
          Pagos que informaron los clientes. Revisa el comprobante y actívales el
          acceso: se registra el cobro, se corre el próximo pago y se les avisa por correo.
        </p>
      </header>

      <div className="aa-filters">
        {FILTROS.map((f) => (
          <button key={f.key || 'todos'}
                  className={`aa-filter-btn ${filtro === f.key ? 'active' : ''}`}
                  onClick={() => setFiltro(f.key)}>
            {f.label}
          </button>
        ))}
        <span className="aa-count">{lista.length} comprobante{lista.length === 1 ? '' : 's'}</span>
      </div>

      {cargando ? <div className="aa-loading">Cargando…</div>
        : lista.length === 0 ? (
          <div className="aa-empty">
            {filtro === 'pendiente'
              ? 'No hay comprobantes esperando revisión.'
              : 'No hay comprobantes en este estado.'}
          </div>
        ) : (
          <div className="aa-list">
            {lista.map((c) => {
              const chip = ESTADO_CHIP[c.estado] || ESTADO_CHIP.pendiente
              return (
                <article key={c.id} className={`aa-card ${c.estado}`}>
                  <div className="aa-card-head">
                    <div>
                      <div className="aa-email">{c.user_email || c.user_id}</div>
                      <div className="aa-meta">
                        Informado el {dia(c.created_at)} · pagado el {dia(c.fecha_pago)}
                      </div>
                    </div>
                    <span className={`aa-chip ${chip.cls}`}>{chip.txt}</span>
                  </div>

                  <div className="aa-datos">
                    <div><span>Valor informado</span><strong>{money(c.monto)}</strong></div>
                    <div><span>Período</span><strong>{c.meses} mes(es)</strong></div>
                    <div><span>Forma de pago</span><strong>{c.metodo || '—'}</strong></div>
                    <div><span>Banco</span><strong>{c.banco || '—'}</strong></div>
                    <div><span>N.º comprobante</span><strong>{c.referencia || '—'}</strong></div>
                    {c.monto_aprobado != null && (
                      <div><span>Cobrado</span><strong>{money(c.monto_aprobado)}</strong></div>
                    )}
                  </div>

                  {c.nota && <p className="aa-nota"><strong>Nota del cliente:</strong> {c.nota}</p>}
                  {c.nota_admin && <p className="aa-nota admin"><strong>Respuesta:</strong> {c.nota_admin}</p>}

                  <div className="aa-acts">
                    {c.comprobante_path ? (
                      <button className="aa-btn" onClick={() => verArchivo(c)}>
                        📎 Ver comprobante{c.comprobante_nombre ? ` (${c.comprobante_nombre})` : ''}
                      </button>
                    ) : (
                      <span className="aa-sin-archivo">Sin archivo adjunto</span>
                    )}
                    {c.estado !== 'aprobado' && (
                      <>
                        <button className="aa-btn primary" disabled={busy}
                                onClick={() => setAprobando(c)}>
                          ✅ Aprobar y activar
                        </button>
                        {c.estado === 'pendiente' && (
                          <button className="aa-btn danger" disabled={busy} onClick={() => rechazar(c)}>
                            ⚠️ Rechazar
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        )}
    </div>
  )
}

/**
 * Antes de activar se confirma qué se cobra: el administrador puede corregir el
 * valor (si el cliente escribió otro), el plazo, y —cuando la cuenta todavía no
 * tiene módulos— elegir el plan que se le abre. Ese es el paso que evita cobrar
 * y dejar al cliente sin poder entrar a nada.
 */
function AprobarModal({ comprobante, busy, onConfirm, onCancel }) {
  const [monto, setMonto] = useState(String(Number(comprobante.monto || 0).toFixed(2)))
  const [meses, setMeses] = useState(comprobante.meses || 1)
  const [plan, setPlan] = useState('')
  const [nota, setNota] = useState('')

  const enviar = (e) => {
    e.preventDefault()
    onConfirm({ monto: parseFloat(monto) || 0, meses: Number(meses), plan, nota })
  }

  return (
    <div className="aa-overlay">
      <div className="aa-modal">
        <h3>✅ Aprobar y activar</h3>
        <p className="aa-modal-email">{comprobante.user_email}</p>
        <form onSubmit={enviar}>
          <div className="aa-modal-row">
            <label>Valor a registrar ($)
              <input type="number" step="0.01" min="0.01" required value={monto}
                     onChange={(e) => setMonto(e.target.value)} />
            </label>
            <label>Meses
              <select value={meses} onChange={(e) => setMeses(e.target.value)}>
                {[1, 3, 6, 12].map((m) => <option key={m} value={m}>{m} mes{m > 1 ? 'es' : ''}</option>)}
              </select>
            </label>
          </div>
          <p className="aa-modal-hint">
            El valor se registra tal cual: es lo que el cliente transfirió, con IVA incluido.
          </p>
          <label>Plan a habilitar
            <select value={plan} onChange={(e) => setPlan(e.target.value)}>
              {PLANES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </label>
          <p className="aa-modal-hint">
            Elígelo si esta cuenta todavía no tiene módulos habilitados; si ya los tiene,
            déjalo como está y solo se registra el pago.
          </p>
          <label>Nota (opcional, se incluye en el correo al cliente)
            <textarea rows={2} value={nota} onChange={(e) => setNota(e.target.value)} />
          </label>
          <div className="aa-modal-acts">
            <button type="button" className="aa-btn" onClick={onCancel} disabled={busy}>Cancelar</button>
            <button type="submit" className="aa-btn primary" disabled={busy}>
              {busy ? 'Activando…' : '✔ Confirmar y activar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
