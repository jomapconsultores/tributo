import { useEffect, useState } from 'react'
import { bajadoresAPI } from '../services/api'
import { conPermiso, publicarLlave, sinPrefijo } from '../utils/permisoBajadores'
import {
  BAJADOR_GASTOS_HREF, SRI_RECIBIDOS_URL,
} from '../utils/bajadorGastos'
import {
  BAJADOR_EMITIDOS_HREF, SRI_EMITIDOS_URL,
} from '../utils/bajadorEmitidos'
import {
  ENVIADOR_DEVOLUCION_HREF, SRI_DEVOLUCION_URL,
} from '../utils/enviadorDevolucion'
import './BajadorSRI.css'

/**
 * Panel para llevar un bajador/enviador al portal del SRI.
 *
 * Estos scripts NO pueden correr desde la app: el portal fuerza login (SSO) en
 * cada navegación, así que tienen que ejecutarse DENTRO de la sesión del usuario.
 * Hay dos formas de llevarlos y acá están las dos, porque arrastrar a marcadores
 * no siempre se puede (barra oculta, equipo ajeno, navegador con restricciones):
 *
 *   1. INSTALAR: arrastrar el botón a la barra de marcadores (una sola vez).
 *   2. PEGAR: copiar el script y pegarlo en la consola del SRI (F12 → Console).
 *      Se copia SIN el prefijo "javascript:" porque Chrome lo borra al pegar en
 *      la barra de direcciones; en la consola, además, la primera vez hay que
 *      escribir "allow pasting" para que deje pegar.
 */

const BAJADORES = {
  gastos: {
    titulo: '📥 Bajador-GASTOS (SRI)',
    href: BAJADOR_GASTOS_HREF,
    url: SRI_RECIBIDOS_URL,
    donde: 'Facturación Electrónica → Comprobantes electrónicos RECIBIDOS (hasta ver el formulario con Año / Mes / Tipo de comprobante y el botón Consultar).',
    hace: [
      'Pregunta el año y si bajar también el archivo de cada comprobante.',
      'Pregunta QUÉ bajar: GASTOS (facturas de compra), RETENCIONES o AMBOS.',
      'Pregunta el PERÍODO: por mes (Ene…Dic) o por semestre (1ro o 2do).',
      'Recorre mes por mes y baja un TXT de claves POR TIPO: gastos_… y retenciones_…',
    ],
    despues: 'Subí cada TXT en SU módulo → "Subir reporte (TXT)": gastos_… en Gastos y retenciones_… en Retenciones.',
  },
  emitidos: {
    titulo: '📥 Bajador-INGRESOS (SRI)',
    href: BAJADOR_EMITIDOS_HREF,
    url: SRI_EMITIDOS_URL,
    donde: 'Facturación Electrónica → Comprobantes electrónicos EMITIDOS (hasta ver el formulario con Fecha de emisión y el botón Consultar).',
    hace: [
      'Pregunta el año y si bajar también el archivo de cada factura.',
      'Pregunta el PERÍODO: por mes o por semestre.',
      'Recorre día por día y baja el XML (o el PDF/RIDE) de cada factura y un TXT con las claves.',
    ],
    despues: 'Arrastrá los XML/PDF a Ingresos IVA, o subí el TXT con "Subir reporte (TXT)".',
  },
  devolucion: {
    titulo: '📤 Enviador-DEVOLUCIÓN (SRI)',
    href: ENVIADOR_DEVOLUCION_HREF,
    url: SRI_DEVOLUCION_URL,
    donde: 'Devoluciones (TAX refund) → Devolución de IVA, hasta "Ingresar facturas electrónicas" (la pantalla con Año, Período y Buscar).',
    hace: [
      'Carga el paquete de la solicitud que la app dejó copiado (botón "Enviar al SRI").',
      'Consulta el período en el portal y recorre la grilla: marca cada comprobante de la solicitud, le pone el tipo de gasto y ajusta el IVA solicitado si el mes pasa el tope.',
      'Avisa qué comprobantes tuyos el SRI no lista (esos no se pueden presentar) y cuáles del portal quedaron fuera.',
      'Procesa y guarda la selección, y deja el envío definitivo detrás de una confirmación aparte.',
      'Al terminar copia la constancia del portal para pegarla en la app.',
    ],
    despues: 'Volvé a la app, tocá "Pegar constancia del enviador" en la ventana de envío y guardá la solicitud como PRESENTADA.',
  },
}

async function copiar(texto) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(texto)
      return true
    }
  } catch { /* seguimos con el método viejo */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = texto
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

// Qué llave pedir según el marcador: la autorización se da por bajador.
const CUAL = { gastos: 'gastos', emitidos: 'emitidos', devolucion: 'devolucion' }

export default function BajadorSRI({ which = 'gastos', onClose }) {
  const b = BAJADORES[which] || BAJADORES.gastos
  const [copiado, setCopiado] = useState('')   // 'codigo' | 'marcador' | 'error'

  // El marcador se genera CON la llave de quien lo baja. Sin autorización no se
  // entrega el script: el panel lo dice y no muestra nada que copiar. Es lo que
  // hace que el bajador sea de quien tiene permiso y no de quien lo consiga.
  const [permiso, setPermiso] = useState(null)   // null = pidiendo
  const [negado, setNegado] = useState('')
  useEffect(() => {
    let vigente = true
    setPermiso(null)
    setNegado('')
    bajadoresAPI.miLlave(CUAL[which] || 'todos')
      .then((r) => {
        if (!vigente) return
        setPermiso(r.data)
        publicarLlave(r.data?.llave)
      })
      .catch((e) => {
        if (!vigente) return
        setPermiso(false)
        setNegado(e.response?.data?.detail ||
          'No estás autorizado a usar los bajadores del SRI.')
      })
    return () => { vigente = false }
  }, [which])

  const href = permiso ? conPermiso(b.href, permiso.llave) : ''
  const codigo = href ? sinPrefijo(href) : ''

  const onCopiar = async (que) => {
    if (!href) return
    const ok = await copiar(que === 'codigo' ? codigo : href)
    setCopiado(ok ? que : 'error')
    if (ok) setTimeout(() => setCopiado(''), 2500)
  }

  const fijarHref = (el) => { if (el && href) el.setAttribute('href', href) }

  // El panel tiene dos tamaños: la guía completa cuando hay permiso, y una
  // tarjeta corta cuando no lo hay o todavía se está comprobando. Sin llave, el
  // instructivo no sirve para nada —no hay script que copiar— y mostrarlo dejaba
  // una ventana larguísima con la negativa perdida arriba.
  const corto = !permiso

  return (
    <div className="bsri-bg" onClick={onClose}>
      <div className={corto ? 'bsri-modal corto' : 'bsri-modal'} onClick={(e) => e.stopPropagation()}>
        <div className="bsri-head">
          <strong>{b.titulo}</strong>
          <button className="bsri-x" onClick={onClose} title="Cerrar">✕</button>
        </div>

        <div className="bsri-body">
          {permiso === null && (
            <p className="bsri-intro">Comprobando tu permiso de uso…</p>
          )}
          {permiso === false && (
            <div className="bsri-negado">
              <p className="bsri-negado-tit">🔒 Este bajador no es de uso libre</p>
              <p className="bsri-negado-txt">{negado}</p>
              <p className="bsri-nota">
                La autorización se da de a una persona, desde el sistema, y queda atada a
                una sola máquina. Si te corresponde tenerlo, pedilo al administrador.
              </p>
              <div className="bsri-acciones">
                <button className="bsri-btn primary" onClick={onClose}>Entendido</button>
              </div>
            </div>
          )}
          {permiso && (
          <>
          {/* El permiso dura un plazo. Avisar antes evita que se corte el
              trabajo en mitad de una declaración: con quince días de margen da
              tiempo a pedir la renovación sin apuro. */}
          {permiso.dias_restantes != null && permiso.dias_restantes <= 15 && (
            <p className={permiso.dias_restantes <= 3 ? 'bsri-vence urgente' : 'bsri-vence'}>
              ⌛ Tu autorización vence {permiso.dias_restantes <= 0 ? 'hoy'
                : permiso.dias_restantes === 1 ? 'mañana'
                : `en ${permiso.dias_restantes} días`}
              {permiso.vence_at
                ? ` (${new Date(permiso.vence_at).toLocaleDateString('es-EC', { dateStyle: 'medium' })})`
                : ''}.
              {' '}Pedile al administrador que te la renueve: el marcador que ya tenés
              sigue sirviendo, no hay que volver a bajarlo.
            </p>
          )}
          {permiso.equipo_activado && (
            <p className="bsri-nota">
              🔒 Tu permiso ya está activado en un equipo{permiso.equipo ? ` (${permiso.equipo})` : ''}.
              En otra máquina no va a funcionar hasta que lo liberen.
            </p>
          )}
          <p className="bsri-intro">
            El portal del SRI pide iniciar sesión en cada navegación, así que esto corre
            <strong> dentro de tu sesión</strong>, no desde el sistema. Llevalo de una de estas dos formas:
          </p>

          <section className="bsri-via">
            <h4>1 · Pegarlo en el SRI (lo más directo)</h4>
            <ol className="bsri-pasos">
              <li>Abrí el SRI y andá a: <em>{b.donde}</em></li>
              <li>Copiá el script con el botón de abajo.</li>
              <li>En esa pestaña abrí la consola: <kbd>F12</kbd> → pestaña <b>Console</b>.
                  (La primera vez Chrome pide escribir <code>allow pasting</code> y dar Enter.)</li>
              <li>Pegá con <kbd>Ctrl</kbd>+<kbd>V</kbd> y dale <kbd>Enter</kbd>: se abre el panel.</li>
            </ol>
            <div className="bsri-acciones">
              <button className="bsri-btn primary" onClick={() => onCopiar('codigo')}>
                {copiado === 'codigo' ? '✔ Copiado' : '📋 Copiar el script'}
              </button>
              <button className="bsri-btn" onClick={() => window.open(b.url, '_blank', 'noopener')}>
                🔗 Abrir el SRI
              </button>
            </div>
            <p className="bsri-nota">
              Ojo: pegarlo en la <b>barra de direcciones</b> no sirve — Chrome borra el
              <code> javascript:</code> del principio. Por eso va en la consola.
            </p>
          </section>

          <section className="bsri-via">
            <h4>2 · Instalarlo como marcador (una sola vez)</h4>
            <p className="bsri-parrafo">
              Mostrá la barra de marcadores (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>) y
              <strong> arrastrá</strong> este botón hasta ella. Después alcanza con tocarlo estando en el SRI.
            </p>
            <a
              ref={fijarHref}
              className="bsri-drag"
              draggable="true"
              onClick={(e) => e.preventDefault()}
              title="Arrastralo a tu barra de marcadores"
            >
              {b.titulo}
            </a>
            <div className="bsri-acciones">
              <button className="bsri-btn" onClick={() => onCopiar('marcador')}>
                {copiado === 'marcador' ? '✔ Copiado' : '📋 Copiar la dirección del marcador'}
              </button>
            </div>
            <p className="bsri-nota">
              Si preferís crearlo a mano: marcadores → agregar → pegá eso en el campo <b>URL</b>.
            </p>
          </section>

          <section className="bsri-que">
            <h4>Qué hace cuando lo ejecutás</h4>
            <ul>{b.hace.map((h, i) => <li key={i}>{h}</li>)}</ul>
            <p className="bsri-despues">➜ {b.despues}</p>
          </section>

          {copiado === 'error' && (
            <p className="bsri-error">
              No se pudo copiar automáticamente. Abrí la consola del navegador en esta página,
              o instalalo arrastrando el botón.
            </p>
          )}
          </>
          )}
        </div>
      </div>
    </div>
  )
}
