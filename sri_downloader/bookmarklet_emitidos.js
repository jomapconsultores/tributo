/* ------------------------------------------------------------
 * Desarrollado por Marco Antonio Posligua San Martín
 * ------------------------------------------------------------
 *
 * BOOKMARKLET — Bajar Comprobantes EMITIDOS del SRI (por MES o por SEMESTRE)
 * ==========================================================================
 *
 * QUÉ HACE: estando en el SRI, en "Facturación Electrónica > Comprobantes
 * electrónicos emitidos" (ya logueado), abre un PANEL CON BOTONES para elegir el
 * período, lo recorre día por día y de cada factura emitida:
 *   - junta la CLAVE DE ACCESO (49 díg) -> descarga un TXT al final (formato que
 *     acepta POST /api/sales-iva/process-txt del backend, que baja los XML por SOAP);
 *   - dispara la descarga del XML desde la propia grilla del portal (casilla
 *     marcada por defecto). Esto es lo único que sirve para las emitidas por el
 *     FACTURADOR del SRI: para esas el web service contesta numeroComprobantes=0,
 *     así que el TXT no alcanza. Los XML se suben en Ingresos IVA > "Subir XML".
 *
 * INTERFAZ (sin prompts de texto):
 *   1) Año   < 2026 >  +  casilla "bajar también los XML"
 *   2) "Por MES"  o  "Por SEMESTRE"
 *   3) Mes (Ene…Dic)  o  Semestre (1ro Ene-Jun / 2do Jul-Dic)
 *   4) Progreso día por día, con Cancelar.
 *
 * SI NO ENCUENTRA EL BOTÓN DE XML en una fila, guarda esa fila y al terminar baja
 * DIAG_fila_emitida.html para poder ajustar el selector con el HTML real (todavía
 * no se pudo ver una grilla CON facturas: el contribuyente de prueba no emitió
 * ninguna en 2026, se barrieron los 205 días del año).
 *
 * POR QUÉ ASÍ: el portal del SRI fuerza login en cada navegación nueva, así que NO
 * se puede automatizar desde afuera. Pero una vez DENTRO del formulario, "Consultar"
 * es un ajax de PrimeFaces que no recarga la página — un bookmarklet recorre las
 * fechas sin romperse. El SRI solo muestra las emitidas del RUC logueado. Fecha < hoy.
 *
 * IDs reales del portal (verificados en vivo, jul-2026):
 *   frmPrincipal:txtParametro ............ RUC del contribuyente autenticado
 *   frmPrincipal:calendarFechaDesde_input  Fecha emisión (dd/mm/aaaa)
 *   frmPrincipal:btnConsultar ............ Botón Consultar
 *   frmPrincipal:panelListaComprobantes .. Panel donde se pinta la grilla
 *   formMessages:messages ................ Avisos ("No existen datos…") — ¡va APARTE!
 *   dlgpopStatusPrime .................... Overlay bloqueante "Espere por favor"
 * Los combos Estado autorización / Tipo de comprobante NO se tocan: se respeta lo
 * que el usuario haya dejado elegido en el formulario.
 *
 * TRES COSAS QUE ANTES FALLABAN Y ACÁ ESTÁN RESUELTAS:
 *   a) "No existen datos" NO aparece dentro de panelListaComprobantes (que queda
 *      vacío), sale en formMessages:messages. Buscarlo en el panel daba falsos
 *      "hay datos" y contaba mal los días.
 *   b) Esperar un tiempo fijo (2,3 s) no alcanza: en vivo la primera consulta tardó
 *      7,4 s y las siguientes ~2 s. Ahora se espera a que el overlay
 *      dlgpopStatusPrime se oculte (clase ui-overlay-hidden) — la señal real de
 *      "ya respondió" — así no se saltean facturas.
 *   c) La clave se extrae CELDA por celda (td) y NO por innerText del panel: el
 *      innerText concatena el secuencial con la clave y el regex \d{49} agarra una
 *      ventana errónea.
 *
 * NOTA: a propósito no se usa el carácter de porcentaje en el código — el
 * bookmarklet viaja como URL "javascript:" y ahí ese carácter se lee como escape.
 *
 * DÓNDE VIVE LA COPIA QUE SE DESPACHA: frontend/src/utils/bajador-emitidos.bookmarklet.txt
 * (misma lógica, minificada con esbuild). La app la ofrece como botón arrastrable en
 * Ingresos IVA y en el Sidebar (Ingresos IVA > "Bajar EMITIDAS por fecha").
 * Si tocás este archivo, regenerá ese .txt:
 *   node_modules/.bin/esbuild --minify sri_downloader/bookmarklet_emitidos.js
 */

// ---- Fuente legible (mantener/editar acá; el .txt es esta misma, minificada) ----
(() => {
  const ID = 'sri_bajador_emitidos';
  const $ = (id) => document.getElementById(id);

  // Chrome FRENA setTimeout en las pestañas que no están a la vista (hasta una vez
  // por minuto). Con eso el bajador parecía colgado en "Día 1 de 23" apenas el
  // usuario se iba a otra pestaña. Los temporizadores de un Web Worker NO sufren ese
  // freno — medido en vivo sobre el portal: se pidieron 150 ms y llegó en 171 ms con
  // document.hidden = true. Por eso las esperas salen del worker, y solo si el worker
  // no se puede crear (CSP) se cae de nuevo a setTimeout.
  let worker = null;
  const pendientes = new Map();
  let idSleep = 0;
  try {
    const fuente = 'onmessage=function(e){setTimeout(function(){postMessage(e.data.id)},e.data.ms)}';
    worker = new Worker(URL.createObjectURL(new Blob([fuente], { type: 'text/javascript' })));
    worker.onmessage = (e) => {
      const r = pendientes.get(e.data);
      if (r) { pendientes.delete(e.data); r(); }
    };
  } catch (e) {
    worker = null;
  }
  const sleep = (ms) => new Promise((r) => {
    if (!worker) { setTimeout(r, ms); return; }
    const id = ++idSleep;
    pendientes.set(id, r);
    worker.postMessage({ id, ms });
  });

  const di = $('frmPrincipal:calendarFechaDesde_input');
  const btnConsultar = $('frmPrincipal:btnConsultar');
  if (!di || !btnConsultar) {
    // El mensaje se arma con join en tiempo de ejecución a propósito: si se
    // concatenaran los saltos de línea, el minificador los volvería saltos REALES
    // dentro de un template literal y el bookmarklet (que viaja como URL de una
    // sola línea) quedaría partido.
    alert([
      'Primero abrí la consulta:',
      '',
      'SRI en línea > Facturación Electrónica > Comprobantes electrónicos EMITIDOS.',
      '',
      'Cuando veas el formulario (Fecha emisión / Consultar), volvé a tocar el marcador.',
    ].join(String.fromCharCode(10)));
    return;
  }
  const anterior = $(ID);
  if (anterior) anterior.remove();

  const RUC = (($('frmPrincipal:txtParametro') || {}).value || '').trim();
  const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);

  const ESPERA_XML = 1200;   // pausa entre descargas de XML, para no ahogar al portal

  let anio = hoy.getFullYear();
  let cancelado = false;
  let bajarXml = true;       // además del TXT de claves, bajar el XML de cada fila

  // --- Panel flotante ------------------------------------------------------
  const el = (tag, css, txt) => {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (txt !== undefined) e.textContent = txt;
    return e;
  };
  const CSS_BTN = 'padding:8px 10px;margin:3px;border:1px solid #a9d3b3;border-radius:6px;' +
    'background:#eaf6ec;color:#1e6b33;font-weight:600;font-size:13px;cursor:pointer';
  const CSS_GRIS = 'padding:6px 10px;margin:8px 3px 0;border:1px solid #ccc;border-radius:6px;' +
    'background:#f5f5f5;color:#333;cursor:pointer';
  const boton = (txt, fn, css) => {
    const b = el('button', css || CSS_BTN, txt);
    b.onclick = fn;
    return b;
  };

  const caja = el('div', 'position:fixed;top:80px;right:20px;z-index:2147483647;width:330px;' +
    'background:#fff;border:2px solid #1e6b33;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.35);' +
    'font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#222;overflow:hidden');
  caja.id = ID;
  const cabecera = el('div', 'background:#1e6b33;color:#fff;padding:8px 10px;font-weight:700;' +
    'display:flex;justify-content:space-between;align-items:center');
  cabecera.appendChild(el('span', '', 'Bajar EMITIDAS del SRI'));
  cabecera.appendChild(boton('X', () => {
    cancelado = true;
    if (worker) worker.terminate();
    caja.remove();
    document.title = 'SRI';
  },
    'background:transparent;color:#fff;border:0;font-weight:700;font-size:15px;cursor:pointer'));
  const cuerpo = el('div', 'padding:10px');
  caja.appendChild(cabecera);
  caja.appendChild(cuerpo);
  document.body.appendChild(caja);

  const limpiar = () => { cuerpo.textContent = ''; };
  const linea = (txt, css) => cuerpo.appendChild(el('div', css || 'margin:4px 0;color:#555', txt));

  // --- Consulta al portal --------------------------------------------------

  // El overlay "Espere por favor" es la señal real de que el ajax sigue corriendo.
  const overlayOculto = () => {
    const d = $('dlgpopStatusPrime');
    return !d || d.classList.contains('ui-overlay-hidden') || d.offsetParent === null;
  };
  const esperarSri = async () => {
    const t0 = Date.now();
    while (overlayOculto() && Date.now() - t0 < 3000) await sleep(80);     // que aparezca
    while (!overlayOculto() && Date.now() - t0 < 30000) await sleep(120);  // que termine
    await sleep(350);                                                      // pintar la grilla
  };

  const sinDatos = () => {
    const m = $('formMessages:messages');
    return !!m && /no existen datos/i.test(m.innerText || '');
  };

  // Celda por celda: el innerText del panel pega el secuencial con la clave.
  const juntarClaves = (claves) => {
    const zona = $('frmPrincipal:panelListaComprobantes') || document.body;
    let nuevas = 0;
    zona.querySelectorAll('td').forEach((td) => {
      const m = (td.textContent || '').match(/\d{49}/);
      if (m && !claves.has(m[0])) { claves.add(m[0]); nuevas++; }
    });
    return nuevas;
  };

  const btnSiguientePagina = () => {
    const zona = $('frmPrincipal:panelListaComprobantes') || document;
    return zona.querySelector('.ui-paginator-next:not(.ui-state-disabled)');
  };

  // --- Descarga del XML de cada fila ---------------------------------------
  // El TXT de claves sirve para las facturas que el web service del SRI devuelve,
  // pero las emitidas por el FACTURADOR del SRI no vienen por ahí (el WS contesta
  // numeroComprobantes=0). Para esas, el único XML posible es el que baja la propia
  // grilla del portal. Por eso acá, además de juntar la clave, se dispara la
  // descarga del XML fila por fila, probando las dos formas que usa el portal:
  // un control directo con "xml" en title/alt/id/onclick/href/texto, o un menú por
  // fila que hay que abrir para recién ahí elegir "XML".
  const disparar = (el) => {
    ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((t) => {
      try {
        el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      } catch (e) { /* algún navegador puede rechazar el evento sintético */ }
    });
  };

  const filasConClave = () => {
    const zona = $('frmPrincipal:panelListaComprobantes') || document.body;
    return [...zona.querySelectorAll('tr')].filter((tr) => /\d{49}/.test(tr.textContent || ''));
  };

  const controlXml = (tr) => [...tr.querySelectorAll('a,button,img,input,span,[onclick]')].find((e) => /xml/i.test(
    (e.getAttribute('title') || '') + ' ' + (e.getAttribute('alt') || '') + ' ' + (e.id || '') + ' ' +
    (e.getAttribute('onclick') || '') + ' ' + (e.getAttribute('href') || '') + ' ' + (e.textContent || '')));

  const abrirMenuFila = (tr) => {
    const cand = tr.querySelectorAll(
      'button,a[onclick],[class*="caret"],[class*="arrow"],[class*="trigger"],[class*="dropdown"],[class*="menu"]');
    const celdas = tr.querySelectorAll('td');
    const destino = cand.length ? cand[cand.length - 1] : (celdas.length ? celdas[celdas.length - 1] : null);
    if (!destino) return false;
    disparar(destino);
    return true;
  };

  const clickItemXml = () => {
    const items = [...document.querySelectorAll('a,span,li,button,[role="menuitem"],.ui-menuitem-link')]
      .filter((e) => (e.textContent || '').trim().toUpperCase() === 'XML' && e.offsetParent !== null);
    if (!items.length) return false;
    const it = items[items.length - 1];
    disparar(it);
    const a = it.closest ? it.closest('a') : null;
    if (a && a !== it) disparar(a);
    return true;
  };

  const bajarXmlDeFila = async (tr) => {
    const c = controlXml(tr);
    if (c) {
      disparar((c.closest && c.closest('a,button,[onclick]')) || c);
      await sleep(ESPERA_XML);
      return true;
    }
    if (abrirMenuFila(tr)) {
      await sleep(700);
      if (clickItemXml()) { await sleep(ESPERA_XML); return true; }
    }
    return false;
  };

  const consultarDia = async (fecha, claves, cont) => {
    di.value = fecha;
    di.dispatchEvent(new Event('input', { bubbles: true }));
    di.dispatchEvent(new Event('change', { bubbles: true }));
    btnConsultar.click();
    await esperarSri();
    if (sinDatos()) return 0;
    let nuevas = 0;
    for (let pag = 0; pag < 100 && !cancelado; pag++) {   // todas las páginas del día
      nuevas += juntarClaves(claves);
      if (bajarXml) {
        for (const tr of filasConClave()) {
          if (cancelado) break;
          if (await bajarXmlDeFila(tr)) {
            cont.xmlOk++;
            if (tr.style) tr.style.outline = '2px solid #1e6b33';
          } else {
            cont.xmlFallo++;
            if (!cont.diag) cont.diag = tr.outerHTML;   // para ajustar el selector
          }
        }
      }
      const nx = btnSiguientePagina();
      if (!nx) break;
      nx.click();
      await esperarSri();
    }
    return nuevas;
  };

  // --- Corrida -------------------------------------------------------------
  const bajarArchivo = (contenido, nombre, tipo) => {
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([contenido], { type: tipo }));
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const correr = async (meses, etiqueta) => {
    cancelado = false;
    const dias = [];
    for (const m of meses) {
      const n = new Date(anio, m, 0).getDate();
      for (let d = 1; d <= n; d++) {
        const f = new Date(anio, m - 1, d); f.setHours(0, 0, 0, 0);
        if (f >= hoy) continue;   // el SRI no devuelve el día en curso ni el futuro
        dias.push(String(d).padStart(2, '0') + '/' + String(m).padStart(2, '0') + '/' + anio);
      }
    }
    limpiar();
    linea(etiqueta + ' ' + anio, 'font-weight:700;color:#1e6b33;margin-bottom:6px');
    if (!dias.length) {
      linea('Ese período no tiene días anteriores a hoy.');
      cuerpo.appendChild(boton('Volver', pantallaInicio, CSS_GRIS));
      return;
    }
    const estado = el('div', 'margin:6px 0;font-weight:600');
    const detalle = el('div', 'margin:4px 0;color:#555;font-size:12px');
    cuerpo.appendChild(estado);
    cuerpo.appendChild(detalle);
    const btnCancelar = boton('Cancelar', () => { cancelado = true; estado.textContent = 'Cancelando…'; },
      'padding:8px 10px;margin:6px 3px;border:1px solid #d9a9a9;border-radius:6px;' +
      'background:#f6eaea;color:#8b1e1e;font-weight:600;cursor:pointer');
    cuerpo.appendChild(btnCancelar);

    const claves = new Set();
    const cont = { xmlOk: 0, xmlFallo: 0, diag: '' };
    let conDatos = 0, sinD = 0, errores = 0;
    const t0 = Date.now();
    for (let i = 0; i < dias.length && !cancelado; i++) {
      estado.textContent = 'Día ' + (i + 1) + ' de ' + dias.length + '   (' + dias[i] + ')';
      detalle.textContent = claves.size + ' claves · ' + conDatos + ' días con datos' +
        (bajarXml ? ' · ' + cont.xmlOk + ' XML' : '');
      document.title = dias[i] + ' - ' + claves.size + ' claves';
      try {
        if (await consultarDia(dias[i], claves, cont) > 0) conDatos++; else sinD++;
      } catch (e) {
        errores++;
      }
    }
    document.title = 'SRI';
    btnCancelar.remove();
    const seg = Math.round((Date.now() - t0) / 1000);
    limpiar();
    linea((cancelado ? 'Cancelado — ' : 'Listo — ') + etiqueta + ' ' + anio,
      'font-weight:700;color:#1e6b33;margin-bottom:6px');
    linea('Claves de acceso: ' + claves.size);
    if (bajarXml) linea('XML descargados: ' + cont.xmlOk + (cont.xmlFallo ? ' · sin botón de XML: ' + cont.xmlFallo : ''));
    linea('Días con datos: ' + conDatos + ' · sin datos: ' + sinD + (errores ? ' · con error: ' + errores : ''));
    linea('Duración: ' + seg + ' s');
    if (claves.size) {
      const nombre = 'emitidos_' + (RUC ? RUC + '_' : '') +
        etiqueta.replace(/[^A-Za-z0-9]+/g, '') + '_' + anio + '.txt';
      bajarArchivo([...claves].join('\n') + '\n', nombre, 'text/plain');
      linea('Se descargó ' + nombre, 'margin:6px 0;color:#1e6b33;font-weight:600');
      linea(cont.xmlOk
        ? 'Los XML quedaron en tu carpeta de Descargas: subilos en Ingresos IVA > "Subir XML". El TXT sirve para completar con las que no bajaron.'
        : 'Subilo en Ingresos IVA > "Subir reporte (TXT)": el sistema baja los XML solo.',
        'margin:4px 0;color:#555;font-size:12px');
    } else {
      linea('No se encontró ninguna clave en ese período.', 'margin:6px 0;color:#8b1e1e;font-weight:600');
    }
    // Si hubo filas sin control de XML, se baja una para poder ajustar el selector.
    if (cont.diag) {
      bajarArchivo(cont.diag, 'DIAG_fila_emitida.html', 'text/html');
      linea('Bajé DIAG_fila_emitida.html: pasámelo y con eso ajusto el botón de XML.',
        'margin:6px 0;color:#8b6b1e;font-size:12px');
    }
    cuerpo.appendChild(boton('Bajar otro período', pantallaInicio, CSS_GRIS));
  };

  // --- Pantallas -----------------------------------------------------------
  function filaAnio() {
    const fila = el('div', 'display:flex;align-items:center;justify-content:center;margin:6px 0');
    const texto = el('span', 'font-size:17px;font-weight:700;min-width:60px;text-align:center', String(anio));
    const chico = 'padding:4px 12px;margin:0 6px;border:1px solid #ccc;border-radius:6px;' +
      'background:#f5f5f5;color:#333;cursor:pointer;font-weight:700';
    fila.appendChild(boton('<', () => { anio--; texto.textContent = String(anio); }, chico));
    fila.appendChild(texto);
    fila.appendChild(boton('>', () => { anio++; texto.textContent = String(anio); }, chico));
    return fila;
  }

  // Casilla "bajar también los XML". Va como control propio (no un botón) porque
  // es una opción del período, no un paso: se deja marcada y se elige mes/semestre.
  function filaXml() {
    const fila = el('label', 'display:flex;align-items:center;gap:6px;margin:8px 0;cursor:pointer');
    const chk = el('input');
    chk.type = 'checkbox';
    chk.checked = bajarXml;
    chk.onchange = () => { bajarXml = chk.checked; };
    fila.appendChild(chk);
    fila.appendChild(el('span', 'font-size:12px;color:#333',
      'Bajar también los XML de cada factura (más lento)'));
    return fila;
  }

  function pantallaInicio() {
    limpiar();
    if (RUC) linea('RUC: ' + RUC, 'margin:0 0 6px;color:#555;font-size:12px');
    linea('Año', 'font-weight:600');
    cuerpo.appendChild(filaAnio());
    cuerpo.appendChild(filaXml());
    linea('¿Qué querés bajar?', 'font-weight:600;margin-top:8px');
    const fila = el('div', 'display:flex');
    fila.appendChild(boton('Por MES', pantallaMeses, CSS_BTN + ';flex:1'));
    fila.appendChild(boton('Por SEMESTRE', pantallaSemestres, CSS_BTN + ';flex:1'));
    cuerpo.appendChild(fila);
    linea('Recorre el período día por día: descarga un TXT con las claves de acceso y, si está marcada la casilla, el XML de cada factura.',
      'margin-top:8px;color:#555;font-size:12px');
    linea('Si Chrome pregunta si permitir "descargar varios archivos", dale PERMITIR.',
      'margin-top:4px;color:#555;font-size:12px');
    linea(worker
      ? 'Podés seguir trabajando en otras pestañas: sigue corriendo igual. No cierres ESTA.'
      : 'Dejá esta pestaña A LA VISTA mientras corre (si no, Chrome frena los tiempos).',
      'margin-top:4px;color:#8b6b1e;font-size:12px');
  }

  function pantallaMeses() {
    limpiar();
    linea('Elegí el MES de ' + anio, 'font-weight:600;margin-bottom:4px');
    const grilla = el('div', 'display:grid;grid-template-columns:repeat(4,1fr);gap:2px');
    MESES.forEach((nombre, i) => {
      grilla.appendChild(boton(nombre, () => correr([i + 1], nombre), CSS_BTN + ';margin:0'));
    });
    cuerpo.appendChild(grilla);
    cuerpo.appendChild(boton('Volver', pantallaInicio, CSS_GRIS));
  }

  function pantallaSemestres() {
    limpiar();
    linea('Elegí el SEMESTRE de ' + anio, 'font-weight:600;margin-bottom:4px');
    // ancho fijo en px (no se usa porcentaje: el bookmarklet viaja como URL javascript:)
    const ancho = CSS_BTN + ';display:block;width:300px;box-sizing:border-box;text-align:center';
    cuerpo.appendChild(boton('1er semestre   (Ene - Jun)', () => correr([1, 2, 3, 4, 5, 6], '1er semestre'), ancho));
    cuerpo.appendChild(boton('2do semestre   (Jul - Dic)', () => correr([7, 8, 9, 10, 11, 12], '2do semestre'), ancho));
    cuerpo.appendChild(boton('Volver', pantallaInicio, CSS_GRIS));
  }

  pantallaInicio();
})();
