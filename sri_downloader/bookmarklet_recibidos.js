/* ------------------------------------------------------------
 * Desarrollado por Marco Antonio Posligua San Martín
 * ------------------------------------------------------------
 *
 * BOOKMARKLET — Bajador-GASTOS: comprobantes RECIBIDOS del SRI (mes o semestre)
 * ============================================================================
 *
 * QUÉ HACE: estando en el SRI, en "Facturación Electrónica > Comprobantes
 * electrónicos recibidos" (ya logueado), abre un PANEL CON BOTONES que pregunta:
 *   1) Año   < 2026 >  (se mueve entre los años que ofrece el combo del portal)
 *      + casilla "bajar también el XML de cada comprobante".
 *   2) ¿Qué bajar?:  GASTOS (facturas de compra) · RETENCIONES · AMBOS.
 *   3) ¿Período?:    Por MES  o  Por SEMESTRE.
 *   4) Mes (Ene…Dic)  o  Semestre (1ro Ene-Jun / 2do Jul-Dic).
 * Después recorre MES por MES (y por cada tipo elegido) llenando el formulario
 * del portal — año / mes / día "Todos" / tipo de comprobante — dándole Consultar,
 * paginando la grilla entera y, de cada fila:
 *   - junta la CLAVE DE ACCESO (49 díg);
 *   - si la casilla está marcada, dispara la descarga del XML de esa fila (y si
 *     la fila no ofrece XML, el PDF / RIDE, que es lo único que hay para algunos
 *     emisores).
 * Al terminar baja UN TXT POR TIPO, listo para subir en el módulo que corresponde:
 *   gastos_<RUC>_<período>.txt       -> Gastos > "Subir reporte (TXT)"
 *   retenciones_<RUC>_<período>.txt  -> Retenciones > "Subir reporte (TXT)"
 * (el backend baja los XML por SOAP con esas claves: POST /api/invoices/process-txt
 * y POST /api/retentions/process-txt). Son archivos SEPARADOS a propósito: cada
 * módulo tiene su propio parser y mezclarlos daría "errores" al subir.
 *
 * POR QUÉ GASTOS = SOLO FACTURAS: el parser de Gastos lee infoFactura. Las notas
 * de crédito/débito y las liquidaciones de compra no las interpreta, así que
 * bajarlas solo ensuciaría la carga. Retención va aparte (tipo 6) porque tiene su
 * propio módulo.
 *
 * POR QUÉ UN BOOKMARKLET Y NO EL SERVIDOR: el portal fuerza login (SSO) en cada
 * navegación nueva. Pero una vez DENTRO del formulario, Consultar es un ajax de
 * PrimeFaces que no recarga la página: el marcador corre en la sesión del usuario.
 *
 * IDs reales del portal (los mismos que usa el scraper core/comprobantes.py):
 *   frmPrincipal:ano ..................... combo Año
 *   frmPrincipal:mes ..................... combo Mes
 *   frmPrincipal:dia ..................... combo Día (0 = Todos)
 *   frmPrincipal:cmbTipoComprobante ...... 1 Factura · 2 Liquidación · 3 N/Crédito
 *                                          4 N/Débito · 6 Retención
 *   frmPrincipal:btnConsultar ............ Consultar
 * Todo se busca primero por ID exacto y, si el SRI renombra el form, por el
 * SUFIJO del id (select[id$=":mes"]) — así un cambio de prefijo no lo rompe.
 * OJO: los combos se vuelven a pedir en CADA uso y nunca se guardan en una
 * variable de arriba: JSF re-renderea mes/día cuando cambia el año y la
 * referencia vieja queda huérfana (apunta a un nodo que ya no está en la página).
 *
 * NOTA: a propósito no se usa el carácter de porcentaje en el código — el
 * bookmarklet viaja como URL "javascript:" y ahí ese carácter se lee como escape.
 *
 * DÓNDE VIVE LA COPIA QUE SE DESPACHA: frontend/src/utils/bajador-gastos.bookmarklet.txt
 * (misma lógica, minificada). La app la ofrece como botón arrastrable en el
 * Sidebar (Gastos > "Bajador-GASTOS"). Si tocás este archivo, regenerá ese .txt:
 *   node scripts/build_bookmarklets.mjs
 */

// ---- Fuente legible (mantener/editar acá; el .txt es esta misma, minificada) ----
(() => {
  const ID = 'sri_bajador_gastos';
  const $ = (id) => document.getElementById(id);

  // Los controles se buscan SIEMPRE en el momento de usarlos (ver cabecera).
  const ctrl = (id, sufijo, tag) =>
    $(id) || document.querySelector((tag || 'select') + '[id$="' + sufijo + '"]');
  const cbAnio = () => ctrl('frmPrincipal:ano', ':ano');
  const cbMes = () => ctrl('frmPrincipal:mes', ':mes');
  const cbDia = () => ctrl('frmPrincipal:dia', ':dia');
  const cbTipo = () => ctrl('frmPrincipal:cmbTipoComprobante', ':cmbTipoComprobante');
  const btnConsultar = () =>
    $('frmPrincipal:btnConsultar') ||
    document.querySelector('input[id$=":btnConsultar"],button[id$=":btnConsultar"]');

  // Chrome FRENA setTimeout en las pestañas que no están a la vista (hasta una vez
  // por minuto): con eso el bajador parecía colgado apenas el usuario se iba a otra
  // pestaña. Los temporizadores de un Web Worker NO sufren ese freno, así que las
  // esperas salen del worker; solo si no se puede crear (CSP) se cae a setTimeout.
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

  if (!cbAnio() || !cbMes() || !btnConsultar()) {
    // El mensaje se arma con join en tiempo de ejecución a propósito: si se
    // concatenaran los saltos de línea, el minificador los volvería saltos REALES
    // dentro de un template literal y el bookmarklet (que viaja como URL de una
    // sola línea) quedaría partido.
    alert([
      'Primero abrí la consulta:',
      '',
      'SRI en línea > Facturación Electrónica > Comprobantes electrónicos RECIBIDOS.',
      '',
      'Cuando veas el formulario (Año / Mes / Tipo de comprobante / Consultar),',
      'volvé a tocar el marcador.',
    ].join(String.fromCharCode(10)));
    return;
  }
  const anterior = $(ID);
  if (anterior) anterior.remove();

  const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const NOMBRE_MES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

  // Cada tipo produce su propio TXT, porque cada uno se sube en otro módulo.
  const TIPOS = {
    gastos: { valor: '1', re: /factura/i, titulo: 'Facturas de compra', archivo: 'gastos', modulo: 'Gastos' },
    retenciones: { valor: '6', re: /retenc/i, titulo: 'Retenciones', archivo: 'retenciones', modulo: 'Retenciones' },
  };

  const ESPERA_XML = 1200;   // pausa entre descargas de archivo, para no ahogar al portal

  // El RUC solo se usa para nombrar los TXT; si el portal no lo muestra, se omite.
  const rucVisible = () => {
    const campo = $('frmPrincipal:txtParametro') || document.querySelector('input[id$=":txtParametro"]');
    if (campo && campo.value) return campo.value.trim();
    const m = (document.body.innerText || '').match(/\b\d{13}\b/);
    return m ? m[0] : '';
  };
  const RUC = rucVisible();

  // Años que ofrece el combo del portal: las flechas < > se mueven ahí adentro,
  // así nunca se pide un año que el SRI no acepta.
  const aniosDisponibles = () => {
    const sel = cbAnio();
    const res = [];
    if (sel) {
      [...sel.options].forEach((o) => {
        const n = parseInt(o.value, 10);
        if (n > 1900 && res.indexOf(n) < 0) res.push(n);
      });
    }
    res.sort((a, b) => a - b);
    return res.length ? res : [new Date().getFullYear()];
  };
  const ANIOS = aniosDisponibles();
  const hoy = new Date();
  let anio = ANIOS.indexOf(hoy.getFullYear()) >= 0 ? hoy.getFullYear() : ANIOS[ANIOS.length - 1];
  let cancelado = false;
  let bajarXml = true;       // además del TXT de claves, bajar el archivo de cada fila
  let quiere = ['gastos'];   // qué tipos se van a recorrer

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
  cabecera.appendChild(el('span', '', 'Bajador-GASTOS (SRI)'));
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

  // --- Formulario del portal -----------------------------------------------

  // El overlay "Espere por favor" es la señal real de que el ajax sigue corriendo.
  // En esta pantalla puede llamarse distinto que en la de emitidos, así que se
  // aceptan las tres formas que usa PrimeFaces.
  const overlayVisible = () => {
    const cands = [$('dlgpopStatusPrime')].concat(
      [...document.querySelectorAll('.ui-blockui,.ui-widget-overlay,[id$="StatusPrime"]')]);
    return cands.some((d) => d && !d.classList.contains('ui-overlay-hidden') && d.offsetParent !== null);
  };
  // Si el overlay nunca aparece (pantalla sin blocker), la primera espera corta
  // igual da tiempo al ajax; por eso el tope de "que aparezca" es chico.
  const esperarSri = async (maxAparecer) => {
    const t0 = Date.now();
    while (!overlayVisible() && Date.now() - t0 < (maxAparecer || 1500)) await sleep(80);
    while (overlayVisible() && Date.now() - t0 < 40000) await sleep(120);
    await sleep(450);   // pintar la grilla
  };

  // Elige una opción por valor y, si el SRI cambió los valores, por el texto.
  const elegir = async (sel, valor, re) => {
    if (!sel) return false;
    let opcion = [...sel.options].find((o) => String(o.value) === String(valor));
    if (!opcion && re) opcion = [...sel.options].find((o) => re.test(o.textContent || ''));
    if (!opcion) return false;
    if (String(sel.value) !== String(opcion.value)) {
      sel.value = opcion.value;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await esperarSri(900);          // año y mes re-renderean los combos de abajo
    }
    return true;
  };

  const sinDatos = () => {
    const zonas = [$('formMessages:messages')].concat(
      [...document.querySelectorAll('.ui-messages,.ui-growl-item,[id$="messages"]')]);
    return zonas.some((z) => z && /no existen datos|no se encontraron/i.test(z.innerText || ''));
  };

  const zonaGrilla = () =>
    $('frmPrincipal:panelListaComprobantes') ||
    document.querySelector('[id$="panelListaComprobantes"],[id$="tablaCompRecibidos"]') ||
    document.body;

  // Celda por celda: el innerText del panel pega el secuencial con la clave y el
  // regex de 49 dígitos agarraría una ventana corrida.
  const juntarClaves = (claves) => {
    let nuevas = 0;
    zonaGrilla().querySelectorAll('td').forEach((td) => {
      const m = (td.textContent || '').match(/\d{49}/);
      if (m && !claves.has(m[0])) { claves.add(m[0]); nuevas++; }
    });
    return nuevas;
  };

  // Menos consultas = menos páginas: se deja la grilla en el máximo de filas.
  const maximizarFilas = async () => {
    const sel = document.querySelector('.ui-paginator-rpp-options');
    if (!sel || !sel.options) return;
    let mejor = null, max = 0;
    [...sel.options].forEach((o) => {
      const v = parseInt(o.value, 10) || 0;
      if (v > max) { max = v; mejor = o.value; }
    });
    if (mejor && String(sel.value) !== String(mejor)) {
      sel.value = mejor;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await esperarSri();
    }
  };

  const btnSiguientePagina = () =>
    zonaGrilla().querySelector('.ui-paginator-next:not(.ui-state-disabled)') ||
    document.querySelector('.ui-paginator-next:not(.ui-state-disabled)');

  // --- Descarga del archivo de cada fila -----------------------------------
  // El TXT de claves alcanza para lo que el web service del SRI devuelve, pero hay
  // emisores cuyos comprobantes solo se consiguen desde la propia grilla. Por eso,
  // además de juntar la clave, se dispara la descarga fila por fila, probando las
  // dos formas que usa el portal: un control directo con "xml" en title/alt/id/
  // onclick/href/texto, o un menú por fila que hay que abrir para elegir "XML".
  const disparar = (e) => {
    ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((t) => {
      try {
        e.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      } catch (err) { /* algún navegador puede rechazar el evento sintético */ }
    });
  };

  const filasConClave = () => [...zonaGrilla().querySelectorAll('tr')]
    .filter((tr) => /\d{49}/.test(tr.textContent || ''));

  const FORMATOS = [
    { clave: 'xml', re: /xml/i, items: ['XML'] },
    { clave: 'pdf', re: /pdf|ride/i, items: ['PDF', 'RIDE'] },
  ];

  const senas = (e) => (e.getAttribute('title') || '') + ' ' + (e.getAttribute('alt') || '') + ' ' +
    (e.id || '') + ' ' + (e.getAttribute('onclick') || '') + ' ' + (e.getAttribute('href') || '') + ' ' +
    (e.textContent || '');

  const controlDe = (tr, re) =>
    [...tr.querySelectorAll('a,button,img,input,span,[onclick]')].find((e) => re.test(senas(e)));

  const abrirMenuFila = (tr) => {
    const cand = tr.querySelectorAll(
      'button,a[onclick],[class*="caret"],[class*="arrow"],[class*="trigger"],[class*="dropdown"],[class*="menu"]');
    const celdas = tr.querySelectorAll('td');
    const destino = cand.length ? cand[cand.length - 1] : (celdas.length ? celdas[celdas.length - 1] : null);
    if (!destino) return false;
    disparar(destino);
    return true;
  };

  const clickItemMenu = (nombres) => {
    const items = [...document.querySelectorAll('a,span,li,button,[role="menuitem"],.ui-menuitem-link')]
      .filter((e) => nombres.indexOf((e.textContent || '').trim().toUpperCase()) >= 0 && e.offsetParent !== null);
    if (!items.length) return false;
    const it = items[items.length - 1];
    disparar(it);
    const a = it.closest ? it.closest('a') : null;
    if (a && a !== it) disparar(a);
    return true;
  };

  // Devuelve 'xml', 'pdf' o null (null = esa fila no ofrecía ninguno de los dos).
  const bajarDeFila = async (tr) => {
    for (const f of FORMATOS) {
      const c = controlDe(tr, f.re);
      if (c) {
        disparar((c.closest && c.closest('a,button,[onclick]')) || c);
        await sleep(ESPERA_XML);
        return f.clave;
      }
    }
    if (abrirMenuFila(tr)) {
      await sleep(700);
      for (const f of FORMATOS) {
        if (clickItemMenu(f.items)) { await sleep(ESPERA_XML); return f.clave; }
      }
      // No estaba ninguno: cerrar el menú para que no tape la fila siguiente.
      try {
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      } catch (e) { /* nada */ }
    }
    return null;
  };

  // --- Una consulta = un mes y un tipo -------------------------------------
  const consultarMes = async (mes, tipo, claves, cont) => {
    if (!await elegir(cbAnio(), anio, new RegExp('^\\s*' + anio + '\\s*$'))) {
      throw new Error('El combo Año no tiene ' + anio);
    }
    if (!await elegir(cbMes(), mes, new RegExp('^\\s*' + NOMBRE_MES[mes - 1], 'i'))) {
      throw new Error('El combo Mes no tiene ' + NOMBRE_MES[mes - 1]);
    }
    await elegir(cbDia(), '0', /todos/i);        // el día "Todos" trae el mes entero
    if (!await elegir(cbTipo(), tipo.valor, tipo.re)) {
      throw new Error('El combo Tipo de comprobante no tiene ' + tipo.titulo);
    }
    const btn = btnConsultar();
    if (!btn) throw new Error('No encontré el botón Consultar');
    btn.click();
    await esperarSri(3000);
    if (sinDatos()) return 0;
    await maximizarFilas();
    let nuevas = 0;
    for (let pag = 0; pag < 100 && !cancelado; pag++) {   // todas las páginas del mes
      nuevas += juntarClaves(claves);
      if (bajarXml) {
        for (const tr of filasConClave()) {
          if (cancelado) break;
          const que = await bajarDeFila(tr);
          if (que === 'xml') {
            cont.xmlOk++;
            if (tr.style) tr.style.outline = '2px solid #1e6b33';
          } else if (que === 'pdf') {
            cont.pdfOk++;
            if (tr.style) tr.style.outline = '2px solid #8b6b1e';
          } else {
            cont.fallo++;
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
  const bajarArchivo = (contenido, nombre, tipoMime) => {
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([contenido], { type: tipoMime }));
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const correr = async (meses, etiqueta) => {
    cancelado = false;
    limpiar();
    linea(etiqueta + ' ' + anio + ' — ' + quiere.map((k) => TIPOS[k].titulo).join(' + '),
      'font-weight:700;color:#1e6b33;margin-bottom:6px');
    const estado = el('div', 'margin:6px 0;font-weight:600');
    const detalle = el('div', 'margin:4px 0;color:#555;font-size:12px');
    cuerpo.appendChild(estado);
    cuerpo.appendChild(detalle);
    const btnCancelar = boton('Cancelar', () => { cancelado = true; estado.textContent = 'Cancelando…'; },
      'padding:8px 10px;margin:6px 3px;border:1px solid #d9a9a9;border-radius:6px;' +
      'background:#f6eaea;color:#8b1e1e;font-weight:600;cursor:pointer');
    cuerpo.appendChild(btnCancelar);

    const porTipo = {};       // clave del tipo -> Set de claves de acceso
    const cont = { xmlOk: 0, pdfOk: 0, fallo: 0, diag: '' };
    const fallas = [];
    let conDatos = 0, sinD = 0;
    const total = meses.length * quiere.length;
    let paso = 0;
    const t0 = Date.now();

    for (const k of quiere) {
      const tipo = TIPOS[k];
      const claves = porTipo[k] || (porTipo[k] = new Set());
      for (const m of meses) {
        if (cancelado) break;
        paso++;
        estado.textContent = tipo.titulo + ' — ' + NOMBRE_MES[m - 1] + '   (' + paso + ' de ' + total + ')';
        detalle.textContent = Object.keys(porTipo)
          .map((x) => porTipo[x].size + ' ' + TIPOS[x].archivo).join(' · ') +
          (bajarXml ? ' · ' + cont.xmlOk + ' XML' + (cont.pdfOk ? ' · ' + cont.pdfOk + ' PDF' : '') : '');
        document.title = NOMBRE_MES[m - 1] + ' - ' + claves.size + ' claves';
        try {
          if (await consultarMes(m, tipo, claves, cont) > 0) conDatos++; else sinD++;
        } catch (e) {
          fallas.push(NOMBRE_MES[m - 1] + ' (' + tipo.archivo + '): ' + (e && e.message ? e.message : e));
        }
      }
      if (cancelado) break;
    }

    document.title = 'SRI';
    btnCancelar.remove();
    const seg = Math.round((Date.now() - t0) / 1000);
    limpiar();
    linea((cancelado ? 'Cancelado — ' : 'Listo — ') + etiqueta + ' ' + anio,
      'font-weight:700;color:#1e6b33;margin-bottom:6px');
    const bajados = [];      // módulos que quedaron con TXT, para el consejo final
    for (const k of Object.keys(porTipo)) {
      const claves = porTipo[k];
      linea(TIPOS[k].titulo + ': ' + claves.size + ' comprobantes');
      if (!claves.size) continue;
      bajados.push(TIPOS[k].modulo);
      const nombre = TIPOS[k].archivo + '_' + (RUC ? RUC + '_' : '') +
        etiqueta.replace(/[^A-Za-z0-9]+/g, '') + '_' + anio + '.txt';
      bajarArchivo([...claves].join('\n') + '\n', nombre, 'text/plain');
      linea('Se descargó ' + nombre, 'margin:2px 0 6px;color:#1e6b33;font-weight:600');
    }
    if (bajarXml) {
      linea('Archivos bajados: ' + cont.xmlOk + ' XML' +
        (cont.pdfOk ? ' · ' + cont.pdfOk + ' PDF (RIDE)' : '') +
        (cont.fallo ? ' · sin XML ni PDF: ' + cont.fallo : ''));
    }
    linea('Consultas con datos: ' + conDatos + ' · sin datos: ' + sinD);
    linea('Duración: ' + seg + ' s');
    if (bajados.length) {
      linea('Subí el TXT en ' + bajados.join(' y en ') +
        ' > "Subir reporte (TXT)": el sistema baja los XML solo.',
        'margin:6px 0;color:#555;font-size:12px');
      if (cont.xmlOk || cont.pdfOk) {
        linea('Los XML/PDF quedaron en tu carpeta de Descargas: sirven para completar lo que el ' +
          'web service del SRI no devuelva.', 'margin:2px 0;color:#555;font-size:12px');
      }
    } else {
      linea('No se encontró ningún comprobante en ese período.',
        'margin:6px 0;color:#8b1e1e;font-weight:600');
    }
    fallas.forEach((f) => linea('⚠ ' + f, 'margin:2px 0;color:#8b1e1e;font-size:12px'));
    // Si hubo filas sin control de XML, se baja una para poder ajustar el selector.
    if (cont.diag) {
      bajarArchivo(cont.diag, 'DIAG_fila_recibida.html', 'text/html');
      linea('Bajé DIAG_fila_recibida.html: pasámelo y con eso ajusto el botón de XML.',
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
    const mover = (paso) => {
      const i = ANIOS.indexOf(anio) + paso;
      if (i < 0 || i >= ANIOS.length) return;    // solo años que el portal ofrece
      anio = ANIOS[i];
      texto.textContent = String(anio);
    };
    fila.appendChild(boton('<', () => mover(-1), chico));
    fila.appendChild(texto);
    fila.appendChild(boton('>', () => mover(1), chico));
    return fila;
  }

  // Casilla "bajar también los XML". Va como control propio (no un botón) porque
  // es una opción del período, no un paso: se deja marcada y se sigue eligiendo.
  function filaXml() {
    const fila = el('label', 'display:flex;align-items:center;gap:6px;margin:8px 0;cursor:pointer');
    const chk = el('input');
    chk.type = 'checkbox';
    chk.checked = bajarXml;
    chk.onchange = () => { bajarXml = chk.checked; };
    fila.appendChild(chk);
    fila.appendChild(el('span', 'font-size:12px;color:#333',
      'Bajar también el archivo de cada comprobante: XML, o PDF si no hay XML (más lento)'));
    return fila;
  }

  function pantallaInicio() {
    limpiar();
    if (RUC) linea('RUC: ' + RUC, 'margin:0 0 6px;color:#555;font-size:12px');
    linea('Año', 'font-weight:600');
    cuerpo.appendChild(filaAnio());
    cuerpo.appendChild(filaXml());
    linea('¿Qué querés bajar?', 'font-weight:600;margin-top:8px');
    const ancho = CSS_BTN + ';display:block;width:300px;box-sizing:border-box;text-align:center';
    const elegirTipos = (lista) => { quiere = lista; pantallaPeriodo(); };
    cuerpo.appendChild(boton('GASTOS   (facturas de compra)', () => elegirTipos(['gastos']), ancho));
    cuerpo.appendChild(boton('RETENCIONES', () => elegirTipos(['retenciones']), ancho));
    cuerpo.appendChild(boton('AMBOS   (gastos + retenciones)', () => elegirTipos(['gastos', 'retenciones']), ancho));
    linea('Recorre el período mes por mes: baja un TXT de claves por cada tipo (para subir en ' +
      'Gastos y en Retenciones) y, si está marcada la casilla, el archivo de cada comprobante.',
      'margin-top:8px;color:#555;font-size:12px');
    linea('Si Chrome pregunta si permitir "descargar varios archivos", dale PERMITIR.',
      'margin-top:4px;color:#555;font-size:12px');
    linea(worker
      ? 'Podés seguir trabajando en otras pestañas: sigue corriendo igual. No cierres ESTA.'
      : 'Dejá esta pestaña A LA VISTA mientras corre (si no, Chrome frena los tiempos).',
      'margin-top:4px;color:#8b6b1e;font-size:12px');
  }

  function pantallaPeriodo() {
    limpiar();
    linea(quiere.map((k) => TIPOS[k].titulo).join(' + ') + ' — ' + anio,
      'font-weight:700;color:#1e6b33;margin-bottom:6px');
    linea('¿Por qué período?', 'font-weight:600');
    const fila = el('div', 'display:flex');
    fila.appendChild(boton('Por MES', pantallaMeses, CSS_BTN + ';flex:1'));
    fila.appendChild(boton('Por SEMESTRE', pantallaSemestres, CSS_BTN + ';flex:1'));
    cuerpo.appendChild(fila);
    cuerpo.appendChild(boton('Volver', pantallaInicio, CSS_GRIS));
  }

  function pantallaMeses() {
    limpiar();
    linea('Elegí el MES de ' + anio, 'font-weight:600;margin-bottom:4px');
    const grilla = el('div', 'display:grid;grid-template-columns:repeat(4,1fr);gap:2px');
    MESES.forEach((nombre, i) => {
      grilla.appendChild(boton(nombre, () => correr([i + 1], nombre), CSS_BTN + ';margin:0'));
    });
    cuerpo.appendChild(grilla);
    cuerpo.appendChild(boton('Volver', pantallaPeriodo, CSS_GRIS));
  }

  function pantallaSemestres() {
    limpiar();
    linea('Elegí el SEMESTRE de ' + anio, 'font-weight:600;margin-bottom:4px');
    // ancho fijo en px (no se usa porcentaje: el bookmarklet viaja como URL javascript:)
    const ancho = CSS_BTN + ';display:block;width:300px;box-sizing:border-box;text-align:center';
    cuerpo.appendChild(boton('1er semestre   (Ene - Jun)', () => correr([1, 2, 3, 4, 5, 6], '1er semestre'), ancho));
    cuerpo.appendChild(boton('2do semestre   (Jul - Dic)', () => correr([7, 8, 9, 10, 11, 12], '2do semestre'), ancho));
    cuerpo.appendChild(boton('Volver', pantallaPeriodo, CSS_GRIS));
  }

  pantallaInicio();
})();
