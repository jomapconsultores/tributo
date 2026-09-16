// ------------------------------------------------------------
// Desarrollado por Marco Antonio Posligua San Martín
// ------------------------------------------------------------
//
// Corre EN EL PORTAL DEL SRI, en dos aplicaciones:
//
//   · sri-declaraciones-web-internet — el formulario en línea de IVA, ICE y
//     retenciones (103). Recorre Período fiscal -> Preguntas, carga el archivo
//     que armó el sistema con la CARGA POR ARCHIVO del propio formulario y
//     comprueba en el paso Formulario que cada valor quedó en su casillero.
//
//   · rig — la recepción de anexos (ICE / PVP). Abre "Carga de archivo xml" y
//     le entrega el ZIP.
//
// Y ahí SE DETIENE. No guarda, no envía, no toca "Aceptar": presentar una
// declaración o un anexo tiene consecuencias legales y lo hace una persona que
// revisó lo que quedó en pantalla. Nada de este archivo busca esos botones.
//
// No hace falta inyectar código en la página, a diferencia del enviador de la
// devolución: todo lo que se usa acá son clicks y eventos del DOM, que los
// componentes de PrimeFaces escuchan igual vengan de donde vengan.

const VIGENCIA_MINUTOS = 30;
const RUTA_DECLARACIONES = '/sri-declaraciones-web-internet/';
const RUTA_ANEXOS = '/rig/';

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Espera a que `fn` devuelva algo verdadero. Los pasos del portal son AJAX: el
// botón responde en el acto pero la sección nueva llega segundos después.
async function esperar(fn, { ms = 30000, cada = 300 } = {}) {
  const hasta = Date.now() + ms;
  while (Date.now() < hasta) {
    let v = null;
    try { v = fn(); } catch (e) { v = null; }
    if (v) return v;
    if (panel.detenido) throw new Error('Detenido a pedido.');
    await dormir(cada);
  }
  return null;
}

const soloDigitos = (s) => String(s || '').replace(/\D/g, '');
const visible = (el) => !!(el && (el.offsetParent || el.getClientRects().length));
const porId = (id) => document.getElementById(id);

// Lo que el portal reclama. Si un paso no avanza, la razón casi siempre está
// en uno de estos contenedores, y mostrarla ahorra adivinar.
//
// El diálogo de espera ("Espere por favor") también es un .ui-dialog visible, y
// aparece en cada paso: contarlo como reclamo cortaba el recorrido justo cuando
// el portal estaba avanzando (visto en la prueba real del 2026-09-16).
const ES_ESPERA = /^(espere|procesando|cargando)/i;
const esperandoAlPortal = () => [...document.querySelectorAll('.ui-dialog[aria-hidden="false"] .ui-dialog-content')]
  .filter(visible)
  .some((m) => ES_ESPERA.test((m.innerText || '').trim()));

function mensajesDelPortal() {
  const sel = '.ui-messages-error, .ui-message-error, .ui-growl-message, .ui-messages-warn, ' +
    '.ui-dialog[aria-hidden="false"] .ui-dialog-content';
  return [...document.querySelectorAll(sel)]
    .filter(visible)
    .map((m) => (m.innerText || '').replace(/\s+/g, ' ').trim())
    .filter((t) => t && !ES_ESPERA.test(t));
}

// ── Panel ───────────────────────────────────────────────────────────────────
// En un shadow root para que los estilos del portal no lo desarmen.
const panel = {
  raiz: null,
  lista: null,
  titulo: null,
  detenido: false,
  abrir(titulo) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const sombra = host.attachShadow({ mode: 'open' });
    sombra.innerHTML = `
      <style>
        .caja{font:13px/1.45 system-ui,Segoe UI,Arial,sans-serif;width:380px;max-height:70vh;overflow:auto;
          background:#fff;color:#1d2733;border:2px solid #1f7a4d;border-radius:10px;box-shadow:0 8px 28px #0004}
        .cab{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#1f7a4d;color:#fff;font-weight:600}
        .cab span{flex:1}
        .cab button{background:#fff2;border:0;color:#fff;border-radius:6px;padding:3px 8px;cursor:pointer}
        ul{margin:0;padding:8px 12px 10px 28px}
        li{margin:3px 0}
        li.ok{color:#1f7a4d} li.error{color:#b42318;font-weight:600} li.aviso{color:#9a6700}
        li.fin{list-style:none;margin:8px 0 0 -16px;padding:8px 10px;border-radius:8px;background:#ecf7f1;color:#1d2733;font-weight:600}
        li.fin.error{background:#fdecea;color:#b42318}
        small{display:block;font-weight:400;color:#475467;margin-top:2px}
      </style>
      <div class="caja">
        <div class="cab"><span></span><button class="parar">Detener</button><button class="cerrar">✕</button></div>
        <ul></ul>
      </div>`;
    this.titulo = sombra.querySelector('.cab span');
    this.lista = sombra.querySelector('ul');
    this.titulo.textContent = titulo;
    sombra.querySelector('.parar').onclick = () => { this.detenido = true; };
    sombra.querySelector('.cerrar').onclick = () => host.remove();
    (document.body || document.documentElement).appendChild(host);
    this.raiz = host;
  },
  linea(texto, clase = '', detalle = '') {
    const li = document.createElement('li');
    if (clase) li.className = clase;
    li.textContent = texto;
    if (detalle) {
      const s = document.createElement('small');
      s.textContent = detalle;
      li.appendChild(s);
    }
    this.lista.appendChild(li);
    li.scrollIntoView({ block: 'nearest' });
    return li;
  },
};

class Parada extends Error {}
const parar = (texto) => { throw new Parada(texto); };

// ── Declaraciones ───────────────────────────────────────────────────────────

// La identificación que muestra el paso actual. El encabezado del portal
// también trae el RUC, pero el del formulario es el que va en la declaración.
function rucEnPantalla() {
  const txt = document.body ? document.body.innerText : '';
  const m = txt.match(/Identificaci[oó]n:\s*(\d{10,13})/i) || txt.match(/\b(\d{13})\b/);
  return m ? m[1] : '';
}

async function elegirObligacion(codigo) {
  const som = porId('frmFlujoDeclaracion:somObligacion');
  const panelOpciones = porId('frmFlujoDeclaracion:somObligacion_panel');
  if (!som || !panelOpciones) parar('No encontré el combo «Obligación» del portal.');
  const opcion = [...panelOpciones.querySelectorAll('li')]
    .find((li) => new RegExp('^' + codigo + '\\b').test(li.textContent.trim()));
  if (!opcion) {
    const hay = [...panelOpciones.querySelectorAll('li')].map((li) => li.textContent.trim())
      .filter((t) => !/^Seleccione/i.test(t));
    parar(`Este contribuyente no tiene la obligación ${codigo} en el SRI.` +
      (hay.length ? ` Tiene: ${hay.join(' · ')}` : ''));
  }
  // Abriendo el desplegable y tocando la opción: es el único camino que el
  // servidor registra (ver docs/devolucion-iva-portal-sri.md, regla 1quater).
  som.querySelector('.ui-selectonemenu-trigger').click();
  await dormir(400);
  opcion.click();
  const periodo = await esperar(() => porId('frmFlujoDeclaracion:calPeriodo'), { ms: 15000 });
  if (!periodo) parar('El portal no mostró el período después de elegir la obligación.');
  return periodo;
}

async function elegirMes(input, anio, mes) {
  const esperado = String(mes).padStart(2, '0') + '/' + anio;
  if (input.value === esperado) return true;
  input.focus();
  input.click();
  const mp = await esperar(() => [...document.querySelectorAll('.month-picker')].find(visible), { ms: 5000 });
  if (!mp) return false;
  for (let i = 0; i < 40; i++) {
    const t = parseInt((mp.querySelector('.month-picker-title') || {}).textContent, 10);
    if (t === anio) break;
    const flecha = mp.querySelector(t > anio ? '.month-picker-previous a' : '.month-picker-next a');
    if (!flecha || !t) return false;
    flecha.click();
    await dormir(250);
  }
  const boton = mp.querySelector('a.button-' + mes);
  if (!boton) return false;
  boton.click();
  return !!(await esperar(() => input.value === esperado, { ms: 4000 }));
}

// La celda del número de casillero está justo antes de la del campo. Así se
// armó la tabla del sistema, y así se comprueba que el SRI no la cambió.
function casilleroDelCampo(campo) {
  let celda = campo;
  while (celda.parentElement && !/fila/.test(celda.className || '')) celda = celda.parentElement;
  const previa = celda.previousElementSibling;
  return previa ? (previa.innerText || '').trim() : '';
}

const aNumero = (s) => {
  const limpio = String(s || '').replace(/[^\d.,-]/g, '');
  // "1,234.56" y "1234.56" son lo mismo; el portal usa punto decimal.
  return parseFloat(limpio.replace(/,/g, '')) || 0;
};

async function cargarDeclaracion(carga) {
  panel.abrir(`Declaración ${carga.tipo} · ${carga.periodo.etiqueta || ''}`);
  panel.linea(`${carga.contribuyente.nombre} (${carga.contribuyente.identificacion})`);

  const ruc = await esperar(rucEnPantalla, { ms: 20000 });
  if (!ruc) parar('No pude leer el RUC con el que se entró al portal.');
  if (soloDigitos(ruc) !== soloDigitos(carga.contribuyente.identificacion)) {
    parar(`El portal está abierto con ${ruc}, no con ${carga.contribuyente.identificacion}. ` +
      'Cierra la sesión, entra con el RUC correcto y vuelve a tocar «Cargar en el SRI» en el sistema.');
  }
  panel.linea('RUC del portal coincide', 'ok');

  // 1) Período fiscal. Puede que el usuario ya haya avanzado a mano: se retoma
  // desde donde esté.
  let aMano = false;
  if (!porId('archivoInput')) {
    const periodo = await elegirObligacion(carga.obligacion);
    panel.linea(`Obligación ${carga.obligacion} elegida`, 'ok');
    const semestral = carga.periodo.periodicidad === 'semestral';
    const puesto = !semestral && await elegirMes(periodo, carga.periodo.anio, carga.periodo.mes);
    if (puesto) {
      panel.linea(`Período ${periodo.value}`, 'ok');
      porId('frmFlujoDeclaracion:btnObligacionSiguiente').click();
    } else {
      // El selector del semestre no se recorrió todavía en el portal, y un mes
      // cerrado puede no ofrecerse: mejor que lo elija una persona y seguir.
      aMano = true;
      panel.linea(
        semestral
          ? `Elige tú el semestre ${carga.periodo.semestre} de ${carga.periodo.anio} y toca «Siguiente».`
          : `Elige tú el período ${String(carga.periodo.mes).padStart(2, '0')}/${carga.periodo.anio} y toca «Siguiente».`,
        'aviso', 'Sigo solo en cuanto aparezca el paso Preguntas.');
    }
  }

  // Con el período puesto a mano, los reclamos del portal son para la persona
  // que lo está eligiendo ("Respuesta requerida"…): no cortan la espera.
  const archivo = await esperar(
    () => porId('archivoInput') || (!aMano && mensajesDelPortal().length && 'mensaje'),
    { ms: aMano ? 10 * 60000 : 30000, cada: 500 });
  if (archivo === 'mensaje') parar('El portal no avanzó: ' + mensajesDelPortal().join(' · '));
  if (!archivo) parar('El portal no llegó al paso Preguntas.');

  const tipoDecl = ((document.body.innerText || '').match(/Tipo declaraci[oó]n:\s*(\S+)/i) || [])[1];
  if (tipoDecl) {
    panel.linea(`Tipo de declaración: ${tipoDecl}`, /ORIGINAL/i.test(tipoDecl) ? 'ok' : 'aviso',
      /ORIGINAL/i.test(tipoDecl) ? '' : 'Ya hay una declaración de este período: esta la reemplazaría.');
  }

  // 2) La carga por archivo del propio formulario.
  const contenido = JSON.stringify(carga.archivo.contenido);
  const dt = new DataTransfer();
  dt.items.add(new File([contenido], carga.archivo.nombre, { type: 'application/json' }));
  archivo.files = dt.files;
  archivo.dispatchEvent(new Event('change', { bubbles: true }));
  panel.linea(`Archivo cargado (${carga.casilleros.length} casilleros)`, 'ok');

  const primero = carga.casilleros[0];
  const llego = await esperar(
    () => porId('concepto' + primero.concepto) || (mensajesDelPortal().length && 'mensaje'),
    { ms: 60000, cada: 500 });
  if (llego === 'mensaje') parar('El portal rechazó el archivo: ' + mensajesDelPortal().join(' · '));
  if (!llego) parar('El formulario no se abrió después de cargar el archivo.');
  // El formulario escribe los valores al terminar de pintarse.
  await dormir(1500);

  // 3) Comprobar casillero por casillero.
  const problemas = [];
  for (const c of carga.casilleros) {
    const campo = porId('concepto' + c.concepto);
    if (!campo) { problemas.push(`${c.casillero}: el formulario no tiene ese campo`); continue; }
    const junto = casilleroDelCampo(campo);
    if (junto && junto !== c.casillero) {
      problemas.push(`${c.casillero}: el campo está junto al casillero ${junto} (el SRI cambió el formulario)`);
      continue;
    }
    if (Math.abs(aNumero(campo.value) - c.valor) > 0.005) {
      problemas.push(`${c.casillero}: quedó «${campo.value}», debía ser ${c.valor.toFixed(2)}`);
      continue;
    }
    // Como si se hubiera escrito a mano: que el formulario recalcule sus totales.
    for (const ev of ['input', 'change', 'blur']) campo.dispatchEvent(new Event(ev, { bubbles: true }));
  }
  if (problemas.length) {
    panel.linea(`${problemas.length} casillero(s) no quedaron bien`, 'error', problemas.join(' · '));
  } else {
    panel.linea(`Los ${carga.casilleros.length} casilleros quedaron con su valor`, 'ok');
  }

  for (const n of carga.no_trasladados || []) {
    panel.linea(`Llenar a mano${n.codigo ? ' ' + n.codigo : ''}: ${Number(n.valor).toFixed(2)}`, 'aviso',
      [n.descripcion, n.motivo].filter(Boolean).join(' — '));
  }
  panel.linea(
    problemas.length
      ? 'Revisa los casilleros marcados antes de seguir. No presenté nada.'
      : 'Listo. Revisa el formulario y preséntalo tú en el portal. No presenté nada.',
    'fin' + (problemas.length ? ' error' : ''));
}

// ── Anexos ──────────────────────────────────────────────────────────────────

function base64ABytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function cargarAnexo(carga) {
  panel.abrir(`Anexo ${carga.tipo} · ${String(carga.periodo.mes).padStart(2, '0')}/${carga.periodo.anio}`);
  panel.linea(`${carga.contribuyente.nombre} (${carga.contribuyente.identificacion})`);

  // En esta aplicación el RUC solo está en el encabezado del portal.
  const ruc = await esperar(() => ((document.body.innerText || '').match(/\b(\d{13})\b/) || [])[1],
    { ms: 20000 });
  if (!ruc) parar('No pude leer el RUC con el que se entró al portal.');
  if (ruc !== soloDigitos(carga.contribuyente.identificacion)) {
    parar(`El portal está abierto con ${ruc}, no con ${carga.contribuyente.identificacion}. ` +
      'Entra con el RUC correcto y vuelve a tocar «Cargar en el SRI» en el sistema.');
  }
  panel.linea('RUC del portal coincide', 'ok');

  let input = document.querySelector('input[type=file][id$="anexosSubir_input"]');
  if (!input) parar('No encontré la carga de archivo en esta página del SRI.');
  if (!visible(input.closest('.ui-accordion-content') || input)) {
    const cabecera = [...document.querySelectorAll('.ui-accordion-header')]
      .find((h) => /Carga de archivo/i.test(h.textContent));
    if (cabecera) cabecera.click();
    await esperar(() => visible(input.closest('.ui-accordion-content')), { ms: 5000 });
  }

  const zip = new File([base64ABytes(carga.archivo.base64)], carga.archivo.nombre, { type: 'application/zip' });
  const dt = new DataTransfer();
  dt.items.add(zip);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  panel.linea(`ZIP entregado al portal (${carga.archivo.nombre})`, 'ok',
    'El SRI lo sube y lo valida en el acto; el envío es recién con «Aceptar».');

  // Mientras valida muestra un diálogo de espera; lo que contesta aparece en
  // los paneles que la carga actualiza.
  await dormir(1500);
  await esperar(() => !esperandoAlPortal(), { ms: 120000, cada: 700 });
  await dormir(800);
  const respuesta = [
    ...mensajesDelPortal(),
    ...['messagesText1', 'pnlDatosContribuyente', 'outPnlErrores']
      .map((id) => document.querySelector(`[id$="${id}"]`))
      .filter(visible)
      .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim()),
  ].filter(Boolean);
  const hayError = respuesta.some((t) => /error|rechaz|inv[aá]lid|no cumple/i.test(t));
  if (respuesta.length) panel.linea('Respuesta del SRI', hayError ? 'error' : 'ok', respuesta.join(' · '));
  panel.linea(
    hayError
      ? 'El SRI observó el archivo: corrígelo en el sistema y vuelve a cargarlo. No envié nada.'
      : 'Revisa los datos que muestra el SRI y toca «Aceptar» en el portal para enviarlo. No lo envié.',
    'fin' + (hayError ? ' error' : ''));
}

// ── Arranque ────────────────────────────────────────────────────────────────

function cargaParaEstaPagina(carga) {
  const ruta = location.pathname;
  if (carga.clase === 'declaracion' && ruta.indexOf(RUTA_DECLARACIONES) === 0) {
    const grupo = porId('frmFlujoDeclaracion:grupoObligacion');
    return !!grupo && grupo.value === carga.grupo;
  }
  if (carga.clase === 'anexo' && ruta.indexOf(RUTA_ANEXOS) === 0) {
    return new URLSearchParams(location.search).get('codOperativo') === carga.tipo;
  }
  return false;
}

async function arrancar() {
  // La página del formulario pinta su form por partes; se le da un momento.
  await dormir(1200);
  chrome.storage.local.get('carga_sri', async ({ carga_sri }) => {
    if (!carga_sri || !carga_sri.carga) return;
    if ((Date.now() - (carga_sri.cuando || 0)) / 60000 > VIGENCIA_MINUTOS) {
      chrome.storage.local.remove('carga_sri');
      return;
    }
    const carga = carga_sri.carga;
    // Otra aplicación del portal (u otro formulario): la carga sigue esperando
    // a la que le toca, no se consume acá.
    if (!cargaParaEstaPagina(carga)) return;
    // Se consume UNA vez: volver a esta página más tarde no puede repetirla.
    chrome.storage.local.remove('carga_sri');
    try {
      if (carga.clase === 'declaracion') await cargarDeclaracion(carga);
      else await cargarAnexo(carga);
    } catch (e) {
      if (!panel.raiz) panel.abrir('Carga al SRI');
      panel.linea(e instanceof Parada ? e.message : 'Se cortó: ' + (e && e.message), 'fin error');
    }
  });
}

if (document.readyState === 'complete') arrancar();
else window.addEventListener('load', arrancar);
