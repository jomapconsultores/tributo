import { useCallback, useEffect, useMemo, useState } from 'react'
import { adminAPI, bajadoresAPI } from '../services/api'
import './AdminBajadores.css'

/**
 * Quién puede usar los bajadores del SRI, y desde qué máquina.
 *
 * Los marcadores son código que corre en el navegador de quien los tiene: se
 * pueden copiar, y ningún candado escrito dentro del JS aguanta a alguien que
 * sepa editarlo. Lo que esta pantalla controla es lo que sí se sostiene: la
 * llave que el marcador necesita para trabajar. Revocada, el marcador se apaga
 * en el acto; activada en una PC, no corre en otra; y todo intento queda abajo,
 * en la bitácora, salga bien o mal.
 *
 * La autorización es de a UNO y POR UN PLAZO: se habilita a la persona, no al
 * módulo, y por tres meses como máximo. Vencido el plazo el marcador se apaga
 * solo —nadie tiene que acordarse de revocarlo— y renovarlo es una decisión
 * expresa del administrador, que vuelve a contar desde el día que la toma.
 */

const CUAL_LABEL = {
  todos: 'Los tres',
  gastos: 'Gastos',
  emitidos: 'Ingresos',
  devolucion: 'Devolución IVA (marcador + armar y presentar)',
}

const RESULTADO_LABEL = {
  ok: '✔ usado',
  activada: '🔑 activado en su equipo',
  revocada: '⛔ llave revocada',
  vencida: '⌛ autorización vencida',
  otra_maquina: '⛔ otra máquina',
  desconocida: '⛔ marcador no reconocido',
  otro_bajador: '⛔ fuera de su permiso',
}

// A partir de acá se avisa de que está por vencer, para que no se corte el
// trabajo de alguien en mitad de una declaración.
const AVISO_DIAS = 15

const cuando = (t) => {
  if (!t) return '—'
  const d = new Date(t)
  return isNaN(d) ? String(t).slice(0, 16) : d.toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' })
}

const soloFecha = (t) => {
  if (!t) return '—'
  const d = new Date(t)
  return isNaN(d) ? String(t).slice(0, 10) : d.toLocaleDateString('es-EC', { dateStyle: 'medium' })
}

// Cómo se lee el plazo de un vistazo. El backend ya dijo si está vencida y
// cuántos días quedan; acá solo se traduce a algo legible.
const vigencia = (l) => {
  if (!l.vence_at) return { clase: 'ab-vig-sin', texto: 'No caduca', detalle: 'Dueño de la herramienta' }
  if (l.vencida) return { clase: 'ab-vig-vencida', texto: 'Vencida', detalle: `el ${soloFecha(l.vence_at)}` }
  const d = l.dias_restantes
  if (d != null && d <= AVISO_DIAS) {
    return {
      clase: 'ab-vig-pronto',
      texto: d <= 0 ? 'Vence hoy' : `Vence en ${d} día${d === 1 ? '' : 's'}`,
      detalle: soloFecha(l.vence_at),
    }
  }
  return { clase: 'ab-vig-ok', texto: `Hasta el ${soloFecha(l.vence_at)}`, detalle: d != null ? `${d} días` : '' }
}

export default function AdminBajadores() {
  const [llaves, setLlaves] = useState([])
  const [usuarios, setUsuarios] = useState([])
  const [usos, setUsos] = useState([])
  const [cargando, setCargando] = useState(true)
  const [msg, setMsg] = useState(null)
  const [mesesMax, setMesesMax] = useState(3)
  const [nuevo, setNuevo] = useState({ user_id: '', cual: 'todos', nota: '', meses: 3 })

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      const [l, u, us] = await Promise.all([
        bajadoresAPI.llaves(),
        adminAPI.listUsers().catch(() => ({ data: [] })),
        bajadoresAPI.usos(80).catch(() => ({ data: { usos: [] } })),
      ])
      setLlaves(l.data?.llaves || [])
      // El techo lo fija el backend: si mañana cambia, la pantalla lo sigue.
      if (l.data?.meses_max) setMesesMax(l.data.meses_max)
      setUsuarios(u.data || [])
      setUsos(us.data?.usos || [])
    } catch (e) {
      setMsg({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudo cargar.' })
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => { cargar() }, [cargar])

  const emailDe = useMemo(() => {
    const m = {}
    usuarios.forEach((u) => { m[u.id] = u.email || u.id })
    return m
  }, [usuarios])

  const hacer = async (fn, exito) => {
    setMsg(null)
    try {
      await fn()
      await cargar()
      setMsg({ tipo: 'ok', texto: exito })
    } catch (e) {
      setMsg({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudo completar.' })
    }
  }

  const autorizar = (e) => {
    e.preventDefault()
    if (!nuevo.user_id) return
    const m = Number(nuevo.meses)
    hacer(
      () => bajadoresAPI.autorizar({ ...nuevo, meses: m }),
      `Autorizado por ${m} mes${m === 1 ? '' : 'es'}. Ya puede bajar su marcador desde el sistema.`,
    )
    setNuevo({ user_id: '', cual: 'todos', nota: '', meses: mesesMax })
  }

  const renovar = (l) => {
    const quien = emailDe[l.user_id] || l.user_id
    hacer(
      () => bajadoresAPI.renovar(l.id, mesesMax),
      `Renovado a ${quien} por ${mesesMax} mes${mesesMax === 1 ? '' : 'es'} más, contados desde hoy.`,
    )
  }

  // Los plazos que ofrece el selector, hasta el techo que fija el backend.
  const plazos = useMemo(
    () => Array.from({ length: mesesMax }, (_, i) => i + 1),
    [mesesMax],
  )

  // Lo que el administrador tiene que mirar primero.
  const porVencer = useMemo(
    () => llaves.filter((l) => l.activa && l.vence_at && (l.vencida || (l.dias_restantes ?? 99) <= AVISO_DIAS)),
    [llaves],
  )

  return (
    <div className="ab-page">
      <header className="ab-head">
        <h1>🔐 Bajadores del SRI</h1>
        <p>
          Los marcadores no son de uso libre: cada uno lleva la llave de la persona que lo
          bajó y, antes de tocar el portal, pregunta acá si sigue habilitada, si no se le
          pasó el plazo y si es su máquina. Revocar apaga el marcador en el acto, y el
          plazo lo apaga solo al cumplirse.
        </p>
        <p className="ab-nota-devol">
          La llave de <strong>Devolución IVA</strong> hace algo más que habilitar el marcador:
          sin ella, en el módulo de Devoluciones se puede <em>consultar</em>, pero no armar una
          solicitud, ni guardarla, ni mandarla al SRI, ni marcarla presentada. Tener la pantalla
          habilitada no alcanza.
        </p>
      </header>

      {msg && <div className={`ab-msg ${msg.tipo}`}>{msg.texto}</div>}

      {porVencer.length > 0 && (
        <div className="ab-porvencer">
          <strong>
            {porVencer.length === 1
              ? 'Hay 1 autorización vencida o a punto de vencer'
              : `Hay ${porVencer.length} autorizaciones vencidas o a punto de vencer`}
          </strong>
          <span>
            {porVencer.map((l) => emailDe[l.user_id] || l.user_id).join(' · ')}
          </span>
        </div>
      )}

      <section className="ab-bloque">
        <h2>Autorizar a alguien</h2>
        <p className="ab-sub">
          El permiso se da por un plazo: al cumplirse, el marcador de esa persona deja de
          funcionar sin que haya que hacer nada. Máximo {mesesMax} meses; después se renueva
          si corresponde.
        </p>
        <form className="ab-form" onSubmit={autorizar}>
          <select
            value={nuevo.user_id}
            onChange={(e) => setNuevo((n) => ({ ...n, user_id: e.target.value }))}
          >
            <option value="">— Elegí la persona —</option>
            {usuarios.map((u) => (
              <option key={u.id} value={u.id}>{u.email || u.id}</option>
            ))}
          </select>
          <select
            value={nuevo.cual}
            onChange={(e) => setNuevo((n) => ({ ...n, cual: e.target.value }))}
          >
            {Object.entries(CUAL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select
            className="ab-plazo"
            /* Si el techo del backend bajara, el valor guardado podría quedar
               fuera de la lista y el select saldría en blanco. */
            value={Math.min(nuevo.meses, mesesMax)}
            title="Cuánto dura la autorización"
            onChange={(e) => setNuevo((n) => ({ ...n, meses: Number(e.target.value) }))}
          >
            {plazos.map((m) => (
              <option key={m} value={m}>{m === 1 ? 'Por 1 mes' : `Por ${m} meses`}</option>
            ))}
          </select>
          <input
            placeholder="Nota (para acordarte por qué)"
            value={nuevo.nota}
            onChange={(e) => setNuevo((n) => ({ ...n, nota: e.target.value }))}
          />
          <button className="ab-btn primary" type="submit" disabled={!nuevo.user_id}>
            Autorizar
          </button>
        </form>
      </section>

      <section className="ab-bloque">
        <h2>Permisos dados</h2>
        {cargando ? <p className="ab-vacio">Cargando…</p> : llaves.length === 0 ? (
          <p className="ab-vacio">Nadie tiene permiso todavía. El tuyo se crea solo la primera
            vez que abrís el panel de un bajador.</p>
        ) : (
          <table className="ab-tabla">
            <thead>
              <tr>
                <th>Persona</th><th>Bajador</th><th>Vigencia</th><th>Equipo</th>
                <th>Último uso</th><th className="num">Usos</th><th>Estado</th><th></th>
              </tr>
            </thead>
            <tbody>
              {llaves.map((l) => {
                const v = vigencia(l)
                return (
                <tr key={l.id} className={!l.activa ? 'ab-revocada' : (l.vencida ? 'ab-vencida' : '')}>
                  <td>
                    {emailDe[l.user_id] || l.user_id}
                    {l.nota && <em className="ab-nota"> · {l.nota}</em>}
                  </td>
                  <td>{CUAL_LABEL[l.cual] || l.cual}</td>
                  <td className={`ab-vig ${v.clase}`}>
                    {v.texto}
                    {v.detalle && <em className="ab-nota"> · {v.detalle}</em>}
                    {l.renovaciones > 0 && (
                      <em className="ab-nota" title={`Última renovación: ${cuando(l.renovada_at)}`}>
                        {' '}· renovada {l.renovaciones}×
                      </em>
                    )}
                  </td>
                  <td>
                    {l.dispositivo_nombre || (l.dispositivo ? 'activado' : '— sin estrenar —')}
                    {l.activada_at && <em className="ab-nota"> · {cuando(l.activada_at)}</em>}
                  </td>
                  <td>{cuando(l.ultimo_uso_at)}</td>
                  <td className="num">{l.usos}</td>
                  <td>
                    {!l.activa ? '⛔ revocado' : l.vencida ? '⌛ vencido' : '✅ habilitado'}
                  </td>
                  <td className="ab-acciones">
                    <button
                      className={`ab-btn${l.activa && (l.vencida || (l.dias_restantes ?? 99) <= AVISO_DIAS) ? ' primary' : ''}`}
                      disabled={!l.vence_at}
                      title={l.vence_at
                        ? `Le da ${mesesMax} mes(es) más, contados desde hoy`
                        : 'Esta llave no caduca'}
                      onClick={() => renovar(l)}
                    >Renovar</button>
                    <button
                      className="ab-btn"
                      onClick={() => hacer(() => bajadoresAPI.estado(l.id, !l.activa),
                        l.activa ? 'Revocado: ese marcador ya no funciona.' : 'Habilitado de nuevo.')}
                    >{l.activa ? 'Revocar' : 'Habilitar'}</button>
                    <button
                      className="ab-btn"
                      disabled={!l.dispositivo}
                      title="Para que pueda activarlo en otra computadora"
                      onClick={() => hacer(() => bajadoresAPI.liberarEquipo(l.id),
                        'Equipo liberado: el próximo uso ata la llave a la máquina nueva.')}
                    >Liberar equipo</button>
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="ab-bloque">
        <h2>Bitácora de uso</h2>
        <p className="ab-sub">
          Cada vez que un marcador pide permiso queda acá, salga bien o mal. Un
          <strong> ⛔ marcador no reconocido</strong> es alguien intentando con una copia.
        </p>
        {usos.length === 0 ? <p className="ab-vacio">Todavía no se usó ninguno.</p> : (
          <table className="ab-tabla">
            <thead>
              <tr>
                <th>Cuándo</th><th>Persona</th><th>Bajador</th>
                <th>Resultado</th><th>Equipo</th><th>Contribuyente</th>
              </tr>
            </thead>
            <tbody>
              {usos.map((u) => (
                <tr key={u.id} className={u.resultado === 'ok' || u.resultado === 'activada' ? '' : 'ab-alerta'}>
                  <td>{cuando(u.created_at)}</td>
                  <td>{emailDe[u.user_id] || (u.user_id ? u.user_id.slice(0, 8) : '—')}</td>
                  <td>{CUAL_LABEL[u.cual] || u.cual}</td>
                  <td>{RESULTADO_LABEL[u.resultado] || u.resultado}</td>
                  <td>{u.dispositivo_nombre || '—'}</td>
                  <td>{u.identificacion || '—'}{u.periodo ? ` · ${u.periodo}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="ab-honesto">
        Hasta dónde llega esto: la llave ata el uso a una persona, a una máquina y a esta
        bitácora, y se apaga cuando quieras. Lo que no puede hacer —ni esto ni nada que
        corra en el navegador— es impedir que alguien con conocimientos edite el código del
        marcador y le saque la verificación. Para eso haría falta que la parte que sabe
        manejar el portal viva en el servidor y se descargue en cada uso.
      </p>
    </div>
  )
}
