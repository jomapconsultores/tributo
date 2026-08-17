// ARCHIVO GENERADO — no editar acá.
// Sale de sri_downloader/bookmarklet_devolucion.js con:
//     node scripts/build_bookmarklets.mjs
// Es el mismo enviador que usa el marcador; la extensión solo lo inyecta.
/* ------------------------------------------------------------
 * Desarrollado por Marco Antonio Posligua San Martín
 * ------------------------------------------------------------
 *
 * BOOKMARKLET — Enviador-DEVOLUCIÓN: lleva la solicitud de devolución de IVA
 * (adultos mayores / discapacidad) al portal del SRI.
 * ============================================================================
 *
 * POR QUÉ UN MARCADOR Y NO EL SERVIDOR: el portal del SRI fuerza el login (SSO
 * tuportal) en cada navegación nueva, así que desde el backend no se puede
 * entrar. El envío ocurre en la sesión del propio contribuyente; este marcador
 * corre ahí y trabaja con el paquete que la app deja en el portapapeles.
 *
 * CÓMO VIAJAN LOS DATOS: en la app, "📤 Enviar al SRI" copia el paquete de la
 * solicitud (JSON: contribuyente, período, montos por mes y cada comprobante con
 * su clave de acceso y su tipo de gasto). Acá se pega y el panel guía el ingreso:
 *   - lista de comprobantes con casilla, para ir marcando lo ya ingresado
 *     (el avance se guarda en localStorage: se puede cerrar y seguir después);
 *   - "copiar clave" por fila, para pegarla en el formulario sin tipear 49 dígitos;
 *   - "copiar TODAS las claves" y "bajar TXT", cuando el portal acepta la lista;
 *   - "bajar CSV", para el anexo cuando pide el detalle en archivo.
 *
 * COMPARAR CON EL PORTAL: en la pantalla de "Facturas electrónicas" recorre mes a
 * mes la solicitud, la consulta en el portal y avisa qué comprobantes tuyos el SRI
 * no muestra. Es la revisión que hay que hacer ANTES de presentar: si el SRI no ve
 * un comprobante, no lo va a devolver por más que esté marcado en el sistema.
 *
 * Los controles de esa pantalla se buscan por ETIQUETA y por CONTENIDO de las
 * opciones, no por id: el portal los renombra cada tanto y un id fijo deja el
 * marcador inservible sin decir por qué. Si aun así no los encuentra, el panel
 * ofrece "¿Por qué no puedo comparar?", que copia un diagnóstico de lo que ve.
 *
 * NOTA: a propósito no se usa el carácter de porcentaje en el código — el
 * bookmarklet viaja como URL "javascript:" y ahí ese carácter se lee como escape.
 *
 * DÓNDE VIVE LA COPIA QUE SE DESPACHA:
 *   frontend/src/utils/enviador-devolucion.bookmarklet.txt
 * Si tocás este archivo, regenerá ese .txt:  node scripts/build_bookmarklets.mjs
 */

// ---- Fuente legible (mantener/editar acá; el .txt es esta misma, minificada) ----
(async () => {
  const ID = 'jomap-enviador-devolucion';
  const previo = document.getElementById(ID);
  if (previo) { previo.remove(); return; }

  const el = (tag, css, txt) => {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (txt !== undefined) e.textContent = txt;
    return e;
  };
  const CSS_BTN = 'padding:7px 9px;margin:3px;border:1px solid #a9d3b3;border-radius:6px;' +
    'background:#eaf6ec;color:#1e6b33;font-weight:600;font-size:12px;cursor:pointer';
  const CSS_GRIS = 'padding:6px 9px;margin:3px;border:1px solid #ccc;border-radius:6px;' +
    'background:#f5f5f5;color:#333;font-size:12px;cursor:pointer';
  const boton = (txt, fn, css) => {
    const b = el('button', css || CSS_BTN, txt);
    b.onclick = fn;
    return b;
  };
  const money = (n) => '$' + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);

  const caja = el('div', 'position:fixed;top:60px;right:20px;z-index:2147483647;width:430px;' +
    'max-height:82vh;background:#fff;border:2px solid #1e6b33;border-radius:10px;' +
    'box-shadow:0 8px 24px rgba(0,0,0,.35);font-family:Arial,Helvetica,sans-serif;' +
    'font-size:13px;color:#222;display:flex;flex-direction:column;overflow:hidden');
  caja.id = ID;
  const cabecera = el('div', 'background:#1e6b33;color:#fff;padding:8px 10px;font-weight:700;' +
    'display:flex;justify-content:space-between;align-items:center');
  cabecera.appendChild(el('span', '', 'Enviador-DEVOLUCION IVA'));
  cabecera.appendChild(boton('X', () => caja.remove(),
    'background:transparent;color:#fff;border:0;font-weight:700;font-size:15px;cursor:pointer'));
  const cuerpo = el('div', 'padding:10px;overflow:auto');
  caja.appendChild(cabecera);
  caja.appendChild(cuerpo);
  document.body.appendChild(caja);

  const limpiar = () => { cuerpo.textContent = ''; };
  const linea = (txt, css) => cuerpo.appendChild(el('div', css || 'margin:4px 0;color:#555', txt));

  const copiar = async (texto, boton) => {
    let ok = true;
    try {
      await navigator.clipboard.writeText(texto);
    } catch (e) {
      const ta = el('textarea', 'position:fixed;opacity:0');
      ta.value = texto;
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
    }
    if (boton) {
      const antes = boton.textContent;
      boton.textContent = ok ? 'copiado' : 'no se pudo';
      setTimeout(() => { boton.textContent = antes; }, 1200);
    }
    return ok;
  };

  // El diagnóstico va A LA PANTALLA, no solo al portapapeles: en el portal la
  // escritura al portapapeles falla seguido —permisos, foco, la propia página—
  // y entonces el botón "copiar" deja sin nada que pegar justo cuando lo que
  // hace falta es mandar lo que se ve. Con el texto a la vista, una captura de
  // pantalla alcanza.
  const mostrarTexto = (titulo, texto) => {
    limpiar();
    linea(titulo, 'font-weight:700;color:#1e6b33;margin-bottom:6px');
    const ta = el('textarea', 'width:400px;height:250px;font-family:monospace;font-size:10px;' +
      'line-height:1.35;border:1px solid #bbb;border-radius:6px;padding:6px');
    ta.value = texto;
    ta.readOnly = true;
    cuerpo.appendChild(ta);
    cuerpo.appendChild(boton('Copiar', function () { copiar(texto, this); }));
    cuerpo.appendChild(boton('Volver', pintar, CSS_GRIS));
    linea('Si el copiar no anda, mandá una captura de este recuadro.',
      'margin:6px 0;color:#777;font-size:11px');
    ta.focus();
    ta.select();
  };

  const bajarArchivo = (nombre, contenido, tipo) => {
    const blob = new Blob([contenido], { type: (tipo || 'text/plain') + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  // --- 1) Traer el paquete que la app dejó en el portapapeles ---------------
  const valido = (p) => p && p.items && p.contribuyente && p.periodo;

  // La solicitud puede llegar por dos caminos: el portapapeles (marcador) o
  // dejada en la página por la extensión, que la recibe de la app y no depende
  // de permisos de portapapeles. Se mira primero la inyectada.
  // Quién está abierto en el sistema. Lo publica la pantalla de devoluciones, así
  // que solo existe cuando el marcador se toca DENTRO de la app.
  const contextoDeLaApp = () => {
    const c = window.__jomapDevolucionContexto;
    return (c && c.identificacion) ? c : null;
  };
  // Lo que el portapapeles trae no es de fiar: ahí queda la solicitud del último
  // "Enviar al SRI", de cualquier contribuyente y de cualquier día. Si el sistema
  // dice a quién tiene abierto y no es el mismo, se descarta —se veía el panel de
  // un contribuyente con la solicitud, los comprobantes y los montos de otro—.
  let avisoDePaquete = '';
  const esDeOtro = (p) => {
    const ctx = contextoDeLaApp();
    if (!ctx || !p || !p.contribuyente) return false;
    const mio = String(p.contribuyente.identificacion || '').trim();
    return !!mio && mio !== String(ctx.identificacion).trim();
  };

  const leerDelPortapapeles = async () => {
    const inyectada = window.__jomapDevolucionPaquete;
    if (valido(inyectada) && !esDeOtro(inyectada)) return inyectada;
    try {
      const txt = await navigator.clipboard.readText();
      const p = JSON.parse(txt);
      if (!valido(p)) return null;
      if (esDeOtro(p)) {
        const ctx = contextoDeLaApp();
        avisoDePaquete = 'Lo que hay copiado es la solicitud de ' +
          (p.contribuyente.nombre || p.contribuyente.identificacion) +
          ', y en el sistema está abierto ' + (ctx.nombre || ctx.identificacion) +
          '. No se carga: sería trabajar con los datos de otro contribuyente. ' +
          'Abrí la solicitud de ' + (ctx.nombre || ctx.identificacion) +
          ' y tocá "Enviar al SRI".';
        return null;
      }
      return p;
    } catch (e) {
      return null;
    }
  };

  const pedirPegado = () => new Promise((resolve) => {
    limpiar();
    linea('Pegá acá el paquete de la solicitud (en la app: boton "Enviar al SRI",' +
      ' que lo deja copiado) y tocá Cargar.', 'margin:4px 0;color:#333;line-height:1.4');
    const ta = el('textarea', 'width:400px;height:110px;font-family:monospace;font-size:11px;' +
      'border:1px solid #bbb;border-radius:6px;padding:6px');
    ta.placeholder = 'Ctrl+V acá';
    cuerpo.appendChild(ta);
    const aviso = el('div', 'color:#b00;margin:4px 0;min-height:16px');
    cuerpo.appendChild(aviso);
    cuerpo.appendChild(boton('Cargar solicitud', () => {
      let p = null;
      try { p = JSON.parse(ta.value.trim()); } catch (e) { p = null; }
      if (!valido(p)) { aviso.textContent = 'Eso no es el paquete de una solicitud.'; return; }
      // Pegar a mano no puede saltarse la comprobación: es el mismo error, con
      // un paso más.
      if (esDeOtro(p)) {
        const ctx = contextoDeLaApp();
        aviso.textContent = 'Esa solicitud es de ' +
          (p.contribuyente.nombre || p.contribuyente.identificacion) +
          ' y acá está abierto ' + (ctx.nombre || ctx.identificacion) + '.';
        return;
      }
      resolve(p);
    }));
    cuerpo.appendChild(boton('Volver', () => resolve(null), CSS_GRIS));
    ta.focus();
  });

  limpiar();
  linea('Leyendo el paquete de la solicitud...');
  // Puede quedar en null y está bien: TRAER la grilla al sistema es el primer
  // paso del trámite y ocurre antes de que el sistema tenga solicitud alguna.
  let paquete = await leerDelPortapapeles();

  // --- 2) Avance guardado (se puede cerrar el panel y seguir después) -------
  let CLAVE_LS = 'jomapDevIva:sin-id';
  const leerMarcas = () => {
    try { return new Set(JSON.parse(localStorage.getItem(CLAVE_LS)) || []); }
    catch (e) { return new Set(); }
  };
  const guardarMarcas = (set) => {
    try { localStorage.setItem(CLAVE_LS, JSON.stringify([...set])); } catch (e) { /* sin espacio */ }
  };
  let marcadas = new Set();

  // --- 3) Panel de trabajo --------------------------------------------------
  let items = [];
  let claves = [];
  let nombreBase = '';

  const adoptarPaquete = (p) => {
    paquete = p;
    items = p.items || [];
    claves = items.map((i) => i.clave_acceso).filter(Boolean);
    nombreBase = 'DevolucionIVA_' + (p.contribuyente.identificacion || '') + '_' +
      (p.periodo.anio || '') + '-' + String(p.periodo.mes || '').padStart(2, '0');
    CLAVE_LS = 'jomapDevIva:' + (p.solicitud_id || 'sin-id');
    marcadas = leerMarcas();
  };
  if (paquete) adoptarPaquete(paquete);

  // Quién abrió el portal, según su propia cabecera. El SRI la escribe así:
  // "Servicios en Línea ⋮ 0400533824001 CORAL LIDIA MAGOLA" —el número primero y
  // el nombre enseguida, en mayúsculas—. El nombre se toma por palabras
  // completas en mayúscula, que es lo que corta antes de "Perfil".
  const quienEstaEnElPortal = () => {
    const cab = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400);
    const m = /\b(\d{10}(?:\d{3})?)\b[\s.:-]*([A-ZÁÉÍÓÚÑ]{2,}(?: [A-ZÁÉÍÓÚÑ]{2,})*)?/.exec(cab);
    if (!m) return null;
    return { identificacion: m[1], nombre: (m[2] || '').trim() };
  };

  // Identificación del contribuyente segun la propia pantalla del SRI: sirve
  // para que el sistema no cargue los comprobantes de uno en la ficha de otro.
  const identificacionEnPantalla = () => (quienEstaEnElPortal() || {}).identificacion || '';

  // En qué aplicación está parado el portal. Las dos entradas viven bajo el
  // mismo contexto `devolucionTerceraEdad-internet`, así que discapacidad se
  // pregunta PRIMERO: su ruta también contiene "TerceraEdad".
  const seccionDelPortal = () => {
    const ruta = String(location.pathname || '');
    if (/personasDiscapacidad/i.test(ruta)) return 'discapacidad';
    if (/terceraEdad/i.test(ruta)) return 'tercera_edad';
    const t = norm((document.body.innerText || '').slice(0, 600));
    if (/discapacidad/.test(t)) return 'discapacidad';
    if (/adultos mayores/.test(t)) return 'tercera_edad';
    return '';
  };
  const NOMBRE_SECCION = {
    discapacidad: 'Personas con discapacidad',
    tercera_edad: 'Adultos mayores',
  };

  // Lo que impide presentar. Son dos desacuerdos y los dos terminan igual de
  // mal: la solicitud es de otra persona, o el portal está abierto en la otra
  // sección. El primero aparece solo cuando el paquete no llegó y el marcador
  // leyó del portapapeles la solicitud ANTERIOR: así es como el nombre de otro
  // contribuyente termina en el panel sin que nadie lo note.
  //
  // Si el portal no dice quién es —una pantalla intermedia, otra maqueta—, no se
  // bloquea: no hay dato con qué contradecir, y frenar por no saber sería frenar
  // siempre.
  const desacuerdoConElPortal = () => {
    if (!paquete) return null;
    const quien = quienEstaEnElPortal();
    const mio = String(paquete.contribuyente.identificacion || '').trim();
    if (quien && mio && quien.identificacion !== mio) {
      return {
        motivo: 'La solicitud es de un contribuyente y el portal está abierto con otro.',
        detalles: [
          'Solicitud: ' + paquete.contribuyente.nombre + '  (' + mio + ')',
          'Portal: ' + (quien.nombre || 'sin nombre a la vista') + '  (' + quien.identificacion + ')',
          'Entrá al portal con el contribuyente de la solicitud, o mandá desde el ' +
          'sistema la solicitud de ' + (quien.nombre || quien.identificacion) + '.',
        ],
      };
    }
    const seccion = seccionDelPortal();
    const mia = paquete.beneficiario.tipo === 'discapacidad' ? 'discapacidad' : 'tercera_edad';
    if (seccion && seccion !== mia) {
      return {
        motivo: 'El portal está abierto en la sección que no le corresponde a esta solicitud.',
        detalles: [
          'Solicitud: ' + NOMBRE_SECCION[mia],
          'Portal: ' + NOMBRE_SECCION[seccion],
          'Entrá por Devoluciones (TAX refund) → Devolución de IVA - ' + NOMBRE_SECCION[mia] +
          ' y volvé a tocar. Desde acá no puedo cambiar de sección: el menú del ' +
          'portal, tocado desde código, tira la sesión.',
        ],
      };
    }
    return null;
  };

  const pintar = () => {
    limpiar();
    if (!paquete) return pintarSinSolicitud();

    // Cabecera de datos
    const info = el('div', 'background:#f3f8f4;border:1px solid #cfe3d4;border-radius:8px;padding:8px;line-height:1.5');
    info.appendChild(el('div', 'font-weight:700;color:#1e6b33',
      paquete.contribuyente.nombre + ' (' + paquete.contribuyente.identificacion + ')'));
    info.appendChild(el('div', '', 'Periodo: ' + (paquete.periodo.etiqueta || '')));
    info.appendChild(el('div', '', 'Beneficiario: ' +
      (paquete.beneficiario.tipo === 'discapacidad'
        ? 'Discapacidad ' + (paquete.beneficiario.porcentaje_discapacidad || '') + ' por ciento'
        : 'Adulto mayor')));
    info.appendChild(el('div', 'font-weight:700',
      'IVA a solicitar: ' + money(paquete.totales.solicitado) +
      '  (IVA marcado ' + money(paquete.totales.iva) + ' · tope ' + money(paquete.totales.tope) + ')'));
    cuerpo.appendChild(info);

    // Y quién abrió el portal, que es lo que el panel nunca mostraba: se veía
    // solo el nombre que venía en el paquete, viniera de donde viniera.
    const quien = quienEstaEnElPortal();
    const desacuerdo = desacuerdoConElPortal();
    if (quien) {
      linea('En el portal: ' + (quien.nombre || 'sin nombre a la vista') +
        ' (' + quien.identificacion + ')' +
        (seccionDelPortal() ? ' · ' + NOMBRE_SECCION[seccionDelPortal()] : ''),
        'margin:6px 0;font-size:11px;color:' + (desacuerdo ? '#8b1e1e' : '#1e6b33'));
    }
    if (desacuerdo) {
      linea('⚠ ' + desacuerdo.motivo + ' No se puede presentar así.',
        'margin:4px 0;padding:6px;border:1px solid #e0b4b4;border-radius:6px;' +
        'background:#fff5f5;color:#8b1e1e;line-height:1.45');
    }

    // Desglose por mes (períodos semestrales: un tope por cada mes)
    const meses = paquete.detalle_meses || [];
    if (meses.length > 1) {
      const NOMBRES = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
        'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
      const t = el('table', 'width:405px;margin:8px 0;border-collapse:collapse;font-size:11px');
      const thead = el('tr', 'background:#eaf6ec');
      ['Mes', 'Compr.', 'IVA', 'Tope', 'A solicitar'].forEach((h) => {
        const th = el('th', 'border:1px solid #cfe3d4;padding:3px', h);
        thead.appendChild(th);
      });
      t.appendChild(thead);
      meses.forEach((d) => {
        const tr = el('tr', d.excedente > 0 ? 'background:#fff7e6' : '');
        [NOMBRES[d.mes] || d.mes, d.comprobantes, money(d.iva), money(d.tope), money(d.solicitar)]
          .forEach((v, i) => tr.appendChild(el('td',
            'border:1px solid #e2e8e4;padding:3px;text-align:' + (i === 0 ? 'left' : 'right'), String(v))));
        t.appendChild(tr);
      });
      cuerpo.appendChild(t);
    }

    // Acciones sobre el lote entero
    const acciones = el('div', 'margin:6px 0;display:flex;flex-wrap:wrap');
    acciones.appendChild(boton('Copiar TODAS las claves', function () {
      copiar(claves.join('\n'), this);
    }));
    acciones.appendChild(boton('Bajar TXT de claves', () => {
      bajarArchivo(nombreBase + '_claves.txt', claves.join('\n'), 'text/plain');
    }, CSS_GRIS));
    acciones.appendChild(boton('Bajar CSV (anexo)', () => {
      const filas = [['fecha', 'clave_acceso', 'ruc_proveedor', 'proveedor', 'tipo_gasto', 'base', 'iva', 'total']];
      items.forEach((i) => filas.push([i.fecha, i.clave_acceso, i.ruc_proveedor,
        String(i.proveedor || '').replace(/;/g, ' '), i.rubro_label || i.rubro, i.base, i.iva, i.total]));
      bajarArchivo(nombreBase + '_detalle.csv', filas.map((f) => f.join(';')).join('\n'), 'text/csv');
    }, CSS_GRIS));
    // Comparar contra el portal. Solo tiene sentido en la pantalla que trae los
    // combos Año/Periodo y el botón Buscar; en cualquier otra página no habría
    // dónde consultar, así que ahí se ofrece el diagnóstico —qué ve el marcador
    // y qué no— en vez de un botón que fallaría sin explicar por qué.
    if (hayFormulario() || enlaceIngresarFacturas()) {
      acciones.appendChild(boton('Llenar y presentar en el portal', elegirMes,
        'padding:8px 10px;margin:3px;border:1px solid #1e6b33;border-radius:6px;' +
        'background:#1e6b33;color:#fff;font-weight:700;font-size:12px;cursor:pointer'));
      acciones.appendChild(boton('Traer comprobantes al sistema',
        () => elegirAnioYMes(traerComprobantes), CSS_GRIS));
      acciones.appendChild(boton('Comparar con el portal', compararConElPortal, CSS_GRIS));
      acciones.appendChild(boton('Ver diagnostico',
        () => mostrarTexto('Diagnostico del portal', diagnostico()), CSS_GRIS));
    } else {
      acciones.appendChild(boton('¿Por qué no puedo comparar?',
        () => mostrarTexto('Diagnostico del portal', diagnostico()), CSS_GRIS));
    }
    cuerpo.appendChild(acciones);

    // Progreso
    const hechas = items.filter((i) => marcadas.has(i.clave_acceso)).length;
    const prog = el('div', 'margin:4px 0;font-weight:700;color:' + (hechas === items.length ? '#1e6b33' : '#8b6b1e'),
      'Ingresados en el portal: ' + hechas + ' de ' + items.length);
    cuerpo.appendChild(prog);
    cuerpo.appendChild(boton('Reiniciar marcas', () => {
      marcadas = new Set();
      guardarMarcas(marcadas);
      pintar();
    }, CSS_GRIS));

    // Lista de comprobantes
    const lista = el('div', 'margin-top:6px;max-height:34vh;overflow:auto;border:1px solid #e2e8e4;border-radius:6px');
    items.forEach((i) => {
      const fila = el('div', 'display:flex;align-items:center;gap:6px;padding:4px 6px;' +
        'border-bottom:1px solid #f0f3f1;' + (marcadas.has(i.clave_acceso) ? 'background:#f3f8f4' : ''));
      const chk = el('input');
      chk.type = 'checkbox';
      chk.checked = marcadas.has(i.clave_acceso);
      chk.onchange = () => {
        if (chk.checked) marcadas.add(i.clave_acceso); else marcadas.delete(i.clave_acceso);
        guardarMarcas(marcadas);
        pintar();
      };
      fila.appendChild(chk);
      const txt = el('div', 'flex:1;min-width:0;line-height:1.3');
      txt.appendChild(el('div', 'font-size:11px;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis',
        (i.fecha || '') + '  ' + (i.proveedor || '')));
      txt.appendChild(el('div', 'font-size:10px;color:#777',
        (i.rubro_label || i.rubro || '') + '  ·  IVA ' + money(i.iva)));
      fila.appendChild(txt);
      fila.appendChild(boton('copiar clave', function () { copiar(i.clave_acceso, this); },
        'padding:4px 6px;border:1px solid #cfe3d4;border-radius:5px;background:#fff;' +
        'color:#1e6b33;font-size:11px;cursor:pointer'));
      lista.appendChild(fila);
    });
    cuerpo.appendChild(lista);

    linea('Marcá cada comprobante cuando lo hayas ingresado: el avance queda guardado ' +
      'aunque cierres el panel.', 'margin:6px 0 0;color:#777;font-size:11px;line-height:1.4');
  };

  // --- El formulario del portal --------------------------------------------
  // Pantalla "Devolución de IVA personas adultos mayores > Facturas electrónicas":
  // combos Año solicitado / Periodo solicitado y botón Buscar. Los controles se
  // buscan por ETIQUETA y por CONTENIDO de las opciones, no por id: el portal los
  // renombra cada tanto y un id fijo deja el marcador inservible sin decir por qué.
  const visibles = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null);

  const etiquetaDe = (e) => {
    let t = '';
    if (e.id) {
      const lab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(e.id) : e.id) + '"]');
      if (lab) t += ' ' + (lab.textContent || '');
    }
    const cont = e.closest ? e.closest('label,td,div') : null;
    if (cont) t += ' ' + (cont.textContent || '').slice(0, 90);
    const celda = e.closest ? e.closest('td') : null;
    if (celda && celda.previousElementSibling) t += ' ' + (celda.previousElementSibling.textContent || '');
    return t.toLowerCase();
  };

  const opciones = (s) => [...s.options].map((o) => (o.textContent || '').trim());

  // Etiqueta PROPIA del control: la asociada por "for", la celda de al lado o el
  // label que lo envuelve. Sin el texto del contenedor, que es de todos: si Año y
  // Periodo cuelgan del mismo div, buscar "periodo" devuelve el combo de Año
  // —el primero cuyo contenedor menciona la palabra— y el llenado se cae ahí.
  const etiquetaPropia = (e) => {
    let t = '';
    if (e.id) {
      const lab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(e.id) : e.id) + '"]');
      if (lab) t += ' ' + (lab.textContent || '');
    }
    const celda = e.closest ? e.closest('td') : null;
    if (celda && celda.previousElementSibling) t += ' ' + (celda.previousElementSibling.textContent || '');
    const env = e.closest ? e.closest('label') : null;
    if (env) t += ' ' + (env.textContent || '');
    return t.toLowerCase();
  };

  const buscarSelect = (reEtiqueta, cumpleOpciones) => {
    const lista = visibles('select');
    return lista.find((s) => reEtiqueta.test(etiquetaPropia(s))) ||
      lista.find((s) => cumpleOpciones(opciones(s))) ||
      lista.find((s) => reEtiqueta.test(etiquetaDe(s))) || null;
  };

  const cbAnio = () => buscarSelect(/a(ñ|n)o/, (ops) => ops.filter((o) => /^(19|20)\d\d$/.test(o)).length >= 2);
  const cbPeriodo = () => buscarSelect(/per[ií]odo/,
    (ops) => /ene|enero/i.test(ops.join(' ')) && /dic|diciembre/i.test(ops.join(' ')));
  const btnBuscar = () => visibles('button,input[type="submit"],input[type="button"]')
    .find((b) => /^(buscar|consultar)$/i.test(((b.value || b.textContent) || '').trim())) || null;

  const hayFormulario = () => !!(cbAnio() && cbPeriodo() && btnBuscar());

  const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

  // El acordeon "Ingresar facturas electronicas" es un commandLink, no un boton:
  // si el panel se abre en el menu de dos pasos, hay que entrar por ahi para que
  // aparezcan los combos. (Verificado en el portal el 2026-08-11.)
  const enlaceIngresarFacturas = () => visibles('a').find((a) =>
    /ingresar facturas electr/i.test((a.textContent || '').trim())) || null;

  // --- El asistente, desde el principio -------------------------------------
  //
  // Antes de la grilla hay tres pantallas: el aviso legal, la cuenta bancaria
  // donde se acredita la devolución, y el menú de dos pasos. El marcador daba
  // por hecho que ya estaban pasadas a mano y, si no, decía "entrá primero a
  // Ingresar facturas electrónicas". Ahora las camina solo.
  //
  // Cada pantalla se reconoce por su TEXTO: los ids del asistente son `j_idt`
  // autogenerados y cambian entre versiones del portal.
  const textoPantalla = () => norm((document.body.innerText || '').slice(0, 4000));

  const sesionCaducada = () => /sesion ha expirado|sesion caducada/.test(textoPantalla());

  // Las cuentas bancarias que ofrece el paso del convenio de débito.
  const radiosDeCuenta = () => visibles('[id*="tblConvenios"] .ui-radiobutton-box');
  const cuentaYaMarcada = () => radiosDeCuenta().some((r) => r.classList.contains('ui-state-active'));

  const llegarAlIngreso = async (paso) => {
    const decir = paso || (() => {});
    for (let vuelta = 0; vuelta < 8; vuelta++) {
      if (hayFormulario()) return { ok: true };
      if (sesionCaducada()) {
        return { ok: false, motivo: 'el portal dice que la sesión expiró. Iniciá sesión de nuevo y ' +
          'entrá a Devoluciones (TAX refund) → Devolución de IVA.' };
      }

      // El menú de dos pasos: es la pantalla más cercana al trabajo.
      const link = enlaceIngresarFacturas();
      if (link) {
        decir('Entrando a "Ingresar facturas electrónicas"…');
        clickReal(link);
        await esperarPortal();
        await esperar(hayFormulario, 8000);
        continue;
      }

      // La cuenta bancaria de acreditación. Con una sola, se marca; con varias
      // NO se elige: a qué cuenta entra la plata es del contribuyente, no del
      // marcador.
      const cuentas = radiosDeCuenta();
      if (cuentas.length) {
        if (!cuentaYaMarcada()) {
          if (cuentas.length > 1) {
            return { ok: false, motivo: 'el portal ofrece ' + cuentas.length + ' cuentas bancarias ' +
              'para acreditar la devolución. Elegí vos cuál y tocá Aceptar; después volvé a ' +
              'tocar el marcador. No la elijo yo: es a dónde entra la plata.' };
          }
          decir('Marcando la cuenta bancaria (es la única)…');
          clickReal(cuentas[0]);
          await esperarPortal();
        }
        const ok = botonPorTexto(/^aceptar$/) || botonPorTexto(/aceptar/);
        if (!ok) return { ok: false, motivo: 'no encontré el botón "Aceptar" de la cuenta bancaria.' };
        decir('Aceptando la cuenta bancaria…');
        clickReal(ok);
        await esperarPortal();
        continue;
      }

      // El aviso legal. Se exige reconocer su texto para no tocar el "Aceptar"
      // de cualquier otro cartel que el portal tenga abierto.
      const t = textoPantalla();
      const esAviso = /primera necesidad|tramite de devolucion|establecimientos|devolucion automatica/.test(t);
      const aceptar = botonPorTexto(/^aceptar$/) || botonPorTexto(/^continuar$/);
      if (esAviso && aceptar) {
        decir('Aceptando el aviso del portal…');
        clickReal(aceptar);
        await esperarPortal();
        continue;
      }

      return { ok: false, motivo: 'no reconozco esta pantalla del portal. Entrá a mano hasta ' +
        '"Ingresar facturas electrónicas" y volvé a tocar el marcador.' };
    }
    return hayFormulario() ? { ok: true }
      : { ok: false, motivo: 'no pude llegar a "Ingresar facturas electrónicas".' };
  };

  const elegir = (sel, valor, re) => {
    if (!sel) return false;
    let op = [...sel.options].find((o) => String(o.value) === String(valor));
    if (!op && re) op = [...sel.options].find((o) => re.test((o.textContent || '').trim()));
    if (!op) return false;
    if (String(sel.value) !== String(op.value)) {
      sel.value = op.value;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  };

  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

  // Claves de acceso que el portal muestra (49 dígitos, delimitados y fuera de los
  // combos: un combo con muchas opciones numéricas concatena más de 49 dígitos).
  const clavesEnPantalla = () => {
    const encontradas = new Set();
    document.querySelectorAll('td').forEach((td) => {
      if (td.querySelector('select,input,textarea,option')) return;
      const m = (td.textContent || '').match(/(?:^|\D)(\d{49})(?:\D|$)/);
      if (m) encontradas.add(m[1]);
    });
    return encontradas;
  };

  const mesDeFecha = (f) => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(f || '').trim());
    return m ? parseInt(m[2], 10) : null;
  };

  // Compara, mes a mes, lo que el portal ya tiene contra la solicitud guardada.
  // Es la comprobación que hay que hacer antes de presentar: si el SRI no ve un
  // comprobante, no lo va a devolver por más que esté marcado en el sistema.
  const compararConElPortal = async () => {
    limpiar();
    linea('Comparando con el portal', 'font-weight:700;color:#1e6b33;margin-bottom:6px');
    const estado = el('div', 'margin:6px 0;font-weight:600');
    cuerpo.appendChild(estado);

    const meses = (paquete.detalle_meses || []).map((d) => d.mes);
    const lista = meses.length ? meses : [paquete.periodo.mes];
    const anio = paquete.periodo.anio;
    const resultado = [];

    for (const mes of lista) {
      estado.textContent = 'Consultando ' + (MESES[mes - 1] || mes) + ' ' + anio + '…';
      if (!elegir(cbAnio(), anio, new RegExp('^\\s*' + anio + '\\s*$'))) {
        resultado.push({ mes, error: 'el combo Año no tiene ' + anio });
        continue;
      }
      if (!elegir(cbPeriodo(), mes, new RegExp('^\\s*' + MESES[mes - 1], 'i'))) {
        resultado.push({ mes, error: 'el combo Periodo no tiene ' + MESES[mes - 1] });
        continue;
      }
      const b = btnBuscar();
      if (!b) { resultado.push({ mes, error: 'no encontré el botón Buscar' }); continue; }
      b.click();
      await dormir(3500);                     // el portal responde por ajax
      const enPortal = clavesEnPantalla();
      const mios = items.filter((i) => mesDeFecha(i.fecha) === mes);
      const faltan = mios.filter((i) => !enPortal.has(i.clave_acceso));
      resultado.push({ mes, portal: enPortal.size, mios: mios.length, faltan });
    }

    limpiar();
    linea('Tu solicitud contra el portal', 'font-weight:700;color:#1e6b33;margin-bottom:6px');
    let faltantes = 0;
    resultado.forEach((r) => {
      if (r.error) {
        linea('⚠ ' + (MESES[r.mes - 1] || r.mes) + ': ' + r.error, 'margin:3px 0;color:#8b1e1e');
        return;
      }
      faltantes += r.faltan.length;
      const ok = r.faltan.length === 0;
      linea((MESES[r.mes - 1] || r.mes) + ': el portal muestra ' + r.portal +
        ' · en tu solicitud ' + r.mios + (ok ? '  ✔' : '  · faltan ' + r.faltan.length),
        'margin:3px 0;color:' + (ok ? '#1e6b33' : '#8b6b1e'));
      r.faltan.slice(0, 8).forEach((i) => {
        linea('   · ' + (i.fecha || '') + '  ' + (i.proveedor || '') + '  ' + money(i.iva),
          'margin:1px 0;color:#8b1e1e;font-size:11px');
      });
    });
    linea(faltantes === 0
      ? 'Todos los comprobantes de tu solicitud están en el portal: podés presentarla.'
      : 'Hay ' + faltantes + ' comprobante(s) de tu solicitud que el portal no muestra en ese ' +
        'período. Revisá la fecha, o que el SRI ya los tenga.',
      'margin:8px 0;font-weight:600;color:' + (faltantes === 0 ? '#1e6b33' : '#8b6b1e'));
    cuerpo.appendChild(boton('Volver', pintar, CSS_GRIS));
  };

  // ==========================================================================
  // LLENADO Y PRESENTACIÓN AUTOMÁTICOS
  // ==========================================================================
  // El portal ya no pide cargar comprobante por comprobante: muestra su propio
  // listado filtrado y pide marcar, elegir el tipo de gasto y confirmar montos.
  // Eso es lo que se automatiza acá, con la solicitud ya armada en el sistema.
  //
  // Reglas del portal que condicionan el orden (verificadas 2026-08-06):
  //   · "IVA solicitado" y "Tipo de gasto" nacen deshabilitados y se habilitan
  //     al marcar la fila; hay que esperar el ajax entre una cosa y la otra.
  //   · Al marcar, el portal auto-rellena el IVA con el monto completo: solo se
  //     corrige cuando el mes pasa el tope.
  //   · Las filas se casan por SERIE (003-301-000089145), no por clave.
  //   · El período es MENSUAL: un semestral son seis solicitudes, una por mes.
  //
  // Nada de esto toca ids autogenerados (j_idt…): se busca por texto, por la
  // forma de la fila y por el patrón de la serie.

  // Marcas de acento sueltas (U+0300..U+036F). Se arma con fromCharCode y no como
  // literal: un combinante suelto en el codigo se pega al corchete anterior y hay
  // editores y portapapeles que lo normalizan, dejando el marcador roto sin aviso.
  const RE_TILDES = new RegExp('[' + String.fromCharCode(768) + '-' + String.fromCharCode(879) + ']', 'g');
  const sinTildes = (s) => String(s || '').normalize('NFD').replace(RE_TILDES, '');
  const norm = (s) => sinTildes(s).toLowerCase().replace(/\s+/g, ' ').trim();
  const RE_SERIE = /\d{3}-\d{3}-\d{9}/;

  const disparar = (e, tipo) => e.dispatchEvent(new Event(tipo, { bubbles: true }));
  const clickReal = (e) => {
    ['mousedown', 'mouseup', 'click'].forEach((t) => {
      e.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    });
  };

  const esperar = async (cond, ms) => {
    const fin = Date.now() + (ms || 15000);
    while (Date.now() < fin) {
      let ok = false;
      try { ok = !!cond(); } catch (e) { ok = false; }
      if (ok) return true;
      await dormir(200);
    }
    return false;
  };

  // El portal tapa la pantalla con "Espere por favor" mientras va el ajax.
  const ocupado = () => {
    if (window.jQuery && window.jQuery.active > 0) return true;
    const tapas = [...document.querySelectorAll('.ui-blockui,.ui-widget-overlay,.ui-dialog')];
    return tapas.some((t) => t.offsetParent !== null &&
      (t.classList.contains('ui-blockui') || /espere/i.test(t.textContent || '')));
  };
  const esperarPortal = async (ms) => {
    await dormir(300);
    return esperar(() => !ocupado(), ms || 25000);
  };

  const botonPorTexto = (re) => visibles('button,input[type="submit"],input[type="button"],a')
    .find((b) => re.test(norm((b.value || b.textContent) || ''))) || null;

  // --- Lo que el portal RECLAMA -------------------------------------------
  // El marcador no leía esto nunca: tocaba "Procesar", esperaba el ajax y
  // seguía. Si el SRI rechazaba la selección —el caso conocido es el tipo de
  // gasto que se pinta en el combo pero no llega al servidor—, el panel pintaba
  // igual "Selección guardada" y el recorrido continuaba como si nada. El
  // resultado era el peor posible: nada procesado y el sistema diciendo que sí.
  //
  // PrimeFaces pinta sus errores con clases propias, pero no todas las
  // versiones del portal las usan, así que además se reconoce el reclamo por su
  // texto, que es fijo. Solo se miran ERRORES: un aviso informativo no puede
  // frenar un trámite.
  // La entrada al segundo paso del menú. Vive acá arriba porque se la espera en
  // dos momentos: al guardar la selección y al buscar por dónde seguir.
  const buscarEnvio = () => visibles('a,button,input[type="button"],input[type="submit"]')
    .find((e) => /envio de solicitud/.test(norm((e.value || e.textContent) || ''))) || null;

  const RE_QUEJA_SRI = /no detalla el tipo de gasto|la factura solicitada|no se pudo procesar|debe seleccionar/i;
  const quejasDelPortal = () => {
    const textoDe = (n) => (n.innerText || n.textContent || '').trim().replace(/\s+/g, ' ');
    const marcadas = visibles('.ui-messages-error,.ui-message-error,.ui-growl-message-error,' +
      '.ui-messages-error-detail,.ui-messages-error-summary')
      .map(textoDe).filter(Boolean);
    const porTexto = visibles('.ui-messages,.ui-growl-item,.ui-message')
      .map(textoDe).filter((t) => t && RE_QUEJA_SRI.test(t)).map((t) => t.slice(0, 300));
    return [...new Set([...marcadas, ...porTexto])];
  };

  // Una fila de la grilla es la que trae una serie de comprobante en alguna celda.
  const filasGrilla = () => {
    const filas = [];
    [...document.querySelectorAll('tr')].forEach((tr) => {
      if (tr.offsetParent === null || !tr.cells || !tr.cells.length) return;
      let serie = '';
      [...tr.cells].forEach((td) => {
        if (serie) return;
        const m = RE_SERIE.exec(td.textContent || '');
        if (m) serie = m[0];
      });
      if (!serie) return;
      filas.push({ tr, serie });
    });
    return filas;
  };

  const filaPorSerie = (s) => filasGrilla().find((f) => f.serie === s) || null;

  // Marcada: el portal lo dice de más de una manera según la versión —la caja
  // del widget en activo, el icono de tilde, la fila resaltada o el checkbox
  // nativo—. Se miran todas: leer una sola deja el script creyendo que no marcó
  // algo que sí quedó marcado, y entonces lo vuelve a tocar y lo desmarca.
  const marcada = (f) => {
    const caja = f.tr.querySelector('.ui-chkbox-box');
    if (caja && (caja.classList.contains('ui-state-active') ||
      caja.querySelector('.ui-icon-check'))) return true;
    if (f.tr.classList.contains('ui-state-highlight')) return true;
    const i = f.tr.querySelector('input[type="checkbox"]');
    return !!(i && i.checked);
  };

  const escId = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);

  // Formas de tocar la casilla, de la más fiel a la menos. El portal la dibuja
  // como widget —un div .ui-chkbox-box con el checkbox nativo escondido detrás—
  // y, según la versión, escucha el click en uno o en el otro. Probar una sola
  // forma es lo que hace que el recorrido no marque nada sin poder decir por qué.
  // Cada una recibe la fila del momento: el ajax repinta y el nodo viejo queda
  // huérfano, así que clickear ahí es tocar algo que ya no está en la pantalla.
  const FORMAS_DE_MARCAR = [
    { como: 'la casilla del portal', donde: (tr) => tr.querySelector('.ui-chkbox-box') },
    { como: 'el checkbox interno', nativo: true,
      donde: (tr) => tr.querySelector('input[type="checkbox"]') },
    { como: 'la etiqueta de la casilla',
      donde: (tr) => {
        const i = tr.querySelector('input[type="checkbox"]');
        return i && i.id ? document.querySelector('label[for="' + escId(i.id) + '"]') : null;
      } },
  ];

  // Marcar dispara un ajax que REPINTA la fila, así que la confirmación tiene
  // que leerse sobre el nodo nuevo: mirando el viejo la casilla siempre parece
  // sin marcar y se pierde el comprobante creyendo que falló.
  // La forma que el portal aceptó la primera vez se prueba primero en todas las
  // demás: sin esto, cada fila vuelve a pagar los segundos del intento que ya se
  // sabe que no sirve, y veinte comprobantes se hacen eternos.
  let formaQueSirve = '';

  // Cómo está la fila PARA EL PORTAL: 0 sin marcar, 1 marcada pero sin el ajax
  // que habilita sus controles, 2 marcada y lista para llenar.
  //
  // El 1 es el estado traicionero. La casilla se pone en activo al toque, y el
  // checkbox interno se marca solo con el click aunque el portal no lo escuche:
  // dar eso por bueno deja filas marcadas sin tipo de gasto —que el portal no
  // procesa— o, peor, filas que el portal nunca registró. Lo único que prueba
  // que la marca llegó es que "IVA solicitado" y "Tipo de gasto" se habiliten.
  const estadoFila = (serie) => {
    const h = filaPorSerie(serie);
    if (!h || !marcada(h)) return 0;
    const s = comboDeFila(h);
    return (!s || !s.disabled) ? 2 : 1;
  };

  const marcar = async (f, avisar) => {
    const serie = f.serie;
    if (estadoFila(serie) === 2) return '';
    let probadas = 0;
    const orden = FORMAS_DE_MARCAR.filter((x) => x.como === formaQueSirve)
      .concat(FORMAS_DE_MARCAR.filter((x) => x.como !== formaQueSirve));
    for (const forma of orden) {
      // Releer antes de insistir: si la forma anterior funcionó y el portal
      // tardó en repintar, volver a tocar la casilla la desmarcaría.
      if (estadoFila(serie) === 2) return '';
      const g = filaPorSerie(serie) || f;
      const nodo = forma.donde(g.tr);
      if (!nodo) continue;
      probadas += 1;
      if (avisar && probadas > 1) avisar('probando con ' + forma.como);
      if (forma.nativo) nodo.click(); else clickReal(nodo);
      if (!(await esperarPortal(12000)) && avisar) {
        avisar('el portal sigue en "Espere por favor"');
      }
      if (await esperar(() => estadoFila(serie) === 2, 8000)) {
        formaQueSirve = forma.como;
        return '';
      }
      if (!filaPorSerie(serie)) return 'la fila desapareció de la grilla al marcarla';
      // Marcada a medias: no se prueba otra forma —volver a tocarla la
      // desmarcaría— y se informa, que es lo que permite darse cuenta a tiempo.
      if (estadoFila(serie) === 1) {
        return 'la casilla quedó marcada pero el portal no habilitó la fila';
      }
    }
    return probadas
      ? 'la casilla no responde (probé ' + probadas + ' forma(s) de tocarla)'
      : 'la fila no trae casilla que tocar';
  };

  // El combo del tipo de gasto de la fila. El portal lo renderiza como un select
  // oculto dentro del widget, así que no se filtra por visibilidad.
  const comboDeFila = (f) => f.tr.querySelector('select');

  // Lo que el portal MUESTRA en el combo de la fila. Es el único testigo de que
  // el tipo de gasto entró: el <select> de abajo se puede cambiar por código sin
  // que el portal se entere de nada.
  const etiquetaDelCombo = (tr) => {
    const lab = tr.querySelector('.ui-selectonemenu-label');
    return lab ? norm(lab.textContent) : '';
  };

  // El desplegable de ESTA fila. Cada combo tiene el suyo, con id propio
  // (…cmbTipoGasto_panel) y colgado del body, no de la fila. Buscar "el panel
  // visible" agarra el de otra fila: se vio en el portal con cuatro abiertos a
  // la vez, y los clicks caían en el equivocado.
  const panelDelCombo = (sel) =>
    (sel && sel.id) ? document.getElementById(sel.id.replace(/_input$/, '') + '_panel') : null;

  const cerrarDesplegables = () => {
    [...document.querySelectorAll('.ui-selectonemenu-panel')]
      .filter((p) => p.offsetParent !== null)
      .forEach((p) => { p.style.display = 'none'; });
  };

  // Desacuerdos entre el catálogo que traemos y el que ofrece el portal. Se
  // juntan acá y se vuelcan al final del mes: son la evidencia de que las dos
  // entradas —adultos mayores y discapacidad— no comparten catálogo.
  const avisosDelCatalogo = [];

  // La entrada de discapacidad corta ANTES de la grilla cuando el MSP no tiene
  // un registro vigente: el portal manda a acercarse al Ministerio de Salud
  // Pública (o al MDT/MIES si es sustituto). Sin reconocer ese texto, el
  // marcador informaba "no encontré el botón Buscar", que manda a buscar el
  // problema donde no está —en el marcador, no en el registro—.
  const RE_SIN_REGISTRO = /ministerio de salud publica|ministerio de trabajo|ministerio de inclusion economica|carne de discapacidad|no registra discapacidad|sin registro de discapacidad/;
  const avisoDeRegistro = () => {
    const t = norm((document.body.innerText || '').slice(0, 3000));
    if (!RE_SIN_REGISTRO.test(t)) return '';
    return 'el portal no reconoce un registro de discapacidad vigente para este ' +
      'contribuyente. Eso se resuelve en el MSP —o en el MDT/MIES si es sustituto—, ' +
      'no acá: sin registro, la aplicación no llega ni a mostrar la grilla.';
  };

  // Elegir el tipo de gasto ABRIENDO EL DESPLEGABLE Y TOCANDO LA OPCIÓN, como
  // lo haría una persona. Es el único camino que el portal reconoce.
  //
  // Verificado contra el portal real el 2026-08-12, con la solicitud de julio:
  //   · `select.value = '4'` + change  -> el combo sigue en "Seleccione".
  //   · `PF(widget).selectValue('4')`  -> el combo MUESTRA "alimentación"…
  //     pero al procesar, el portal responde "La factura solicitada
  //     003-104-000055796 no detalla el tipo de gasto". O sea que la etiqueta
  //     se pinta y el dato no llega: el servidor nunca se entera.
  //   · click en el <li> del desplegable -> el portal PROCESA sin quejarse.
  // Por eso la comprobación tampoco puede ser el `value` ni la etiqueta a secas:
  // lo que vale es haber pasado por el desplegable.
  //
  // Y el desplegable se busca POR ID: son paneles colgados del body, uno por
  // fila, y pueden quedar varios abiertos a la vez. Tomar "el visible" hace que
  // el click caiga en la fila equivocada.
  const ponerTipoGasto = async (f, codigo, etiqueta) => {
    // Siempre contra la fila del momento: esperar sobre el nodo que se recibió
    // es esperar a un huérfano —el repintado ya lo reemplazó— y ese nunca se
    // habilita, así que se gastan los ocho segundos y se escribe en el aire.
    const vivo = () => comboDeFila(filaPorSerie(f.serie) || f);
    await esperar(() => { const s = vivo(); return !!s && !s.disabled; }, 8000);
    const sel = vivo();
    if (!sel) return 'no hay combo de tipo de gasto en la fila';
    if (sel.disabled) return 'el combo de tipo de gasto sigue deshabilitado';
    const ops = [...sel.options];
    // La ETIQUETA manda sobre el código. Los códigos (1..5) son los del catálogo
    // de adultos mayores; en la entrada de discapacidad **no están verificados**,
    // y si allá el 4 no fuera "alimentación", elegir por código pondría un tipo
    // de gasto equivocado sin que nadie se entere —el combo mostraría el nombre
    // que el portal quisiera y el trámite saldría mal—. El nombre del gasto, en
    // cambio, es el mismo dato en las dos entradas.
    const porEtiqueta = etiqueta
      ? ops.find((o) => norm(o.textContent) === norm(etiqueta)) ||
        ops.find((o) => norm(o.textContent).indexOf(norm(etiqueta)) >= 0)
      : null;
    const porCodigo = codigo ? ops.find((o) => String(o.value) === String(codigo)) : null;
    const op = porEtiqueta || porCodigo;
    if (!op) return 'el combo no tiene la opcion ' + (etiqueta || codigo);
    // Que el código y la etiqueta lleven a opciones distintas es exactamente lo
    // que falta saber de la grilla de discapacidad: se anota, no se calla.
    if (porEtiqueta && porCodigo && porEtiqueta !== porCodigo) {
      const dicho = 'el código ' + codigo + ' del combo no es "' + norm(etiqueta) + '" sino "' +
        norm(porCodigo.textContent) + '": se fue por la etiqueta';
      if (avisosDelCatalogo.indexOf(dicho) < 0) avisosDelCatalogo.push(dicho);
    }
    const buscada = norm(op.textContent);

    // Tres intentos por el desplegable: entre el ajax de la marca y el
    // repintado de la fila, el primer toque a veces se pierde.
    let fila = filaPorSerie(f.serie) || f;
    for (let intento = 0; intento < 3; intento++) {
      const combo = comboDeFila(fila) || sel;
      const panel = panelDelCombo(combo);
      const widget = fila.tr.querySelector('.ui-selectonemenu');
      if (!panel || !widget) break;          // no es un widget: se hace a mano
      cerrarDesplegables();                  // que no queden abiertos de otras filas
      const abridor = widget.querySelector('.ui-selectonemenu-trigger') ||
        widget.querySelector('.ui-selectonemenu-label');
      if (!abridor) break;
      clickReal(abridor);
      if (!(await esperar(() => panel.offsetParent !== null, 4000))) continue;
      const opcion = [...panel.querySelectorAll('li')]
        .find((li) => norm(li.textContent) === buscada);
      if (!opcion) return 'el desplegable no ofrece ' + buscada;
      clickReal(opcion);
      const ok = await esperar(() => {
        const g = filaPorSerie(f.serie);
        return !!g && etiquetaDelCombo(g.tr) === buscada;
      }, 8000);
      cerrarDesplegables();
      if (ok) return '';
      fila = filaPorSerie(f.serie) || fila;
    }

    // Sin desplegable (o no lo tomó): a mano, que es lo que funciona en
    // versiones viejas del portal donde el combo es un <select> común.
    const sel2 = comboDeFila(fila) || sel;
    sel2.value = op.value;
    disparar(sel2, 'input');
    disparar(sel2, 'change');
    if (window.jQuery) { try { window.jQuery(sel2).trigger('change'); } catch (e) { /* sin jQuery */ } }
    await esperarPortal();

    fila = filaPorSerie(f.serie) || f;
    const ahora = comboDeFila(fila);
    const etiquetaOk = etiquetaDelCombo(fila.tr) === buscada;
    const valorOk = ahora && String(ahora.value) === String(op.value);
    // Si hay etiqueta visible, manda ella: el value puede estar puesto y el
    // portal no haberse enterado, que es exactamente el error que se corrigió.
    if (etiquetaDelCombo(fila.tr)) return etiquetaOk ? '' : 'el portal no aceptó el tipo de gasto';
    return valorOk ? '' : 'el portal no aceptó el tipo de gasto';
  };

  // Campo "IVA solicitado" de la fila: es el único editable de texto que queda.
  const montoDeFila = (f) => [...f.tr.querySelectorAll('input[type="text"],input:not([type])')]
    .find((i) => i.offsetParent !== null && !i.readOnly) || null;

  const leerNumero = (txt) => {
    const s = String(txt || '').replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  };

  const ponerMonto = async (f, valor) => {
    const vivo = () => montoDeFila(filaPorSerie(f.serie) || f);
    await esperar(() => { const i = vivo(); return !!i && !i.disabled; }, 8000);
    const inp = vivo();
    if (!inp) return 'no hay campo de IVA solicitado en la fila';
    if (inp.disabled) return 'el campo de IVA solicitado sigue deshabilitado';
    const actual = leerNumero(inp.value);
    if (actual !== null && Math.abs(actual - valor) < 0.005) return '';   // ya lo puso el portal
    inp.focus();
    inp.value = valor.toFixed(2);
    disparar(inp, 'input');
    disparar(inp, 'change');
    if (window.jQuery) { try { window.jQuery(inp).trigger('change'); } catch (e) { /* sin jQuery */ } }
    inp.blur();
    await esperarPortal();
    return '';
  };

  // El paginador dice "(2 of 2)" cuando ya no hay más: se le cree a eso además
  // de a la clase de deshabilitado, porque si el botón queda habilitado en la
  // última página se le clickea al pedo y el recorrido termina avisando que
  // "quedaron comprobantes sin revisar" cuando en realidad no faltaba ninguno.
  const botonSiguientePagina = () => {
    const p = paginaActual();
    if (p && p.pagina >= p.de) return null;
    return [...document.querySelectorAll('.ui-paginator-next')]
      .find((e) => e.offsetParent !== null && !e.classList.contains('ui-state-disabled')) || null;
  };

  // Volver a la PRIMERA página antes de leer nada.
  //
  // Buscar no reinicia el paginador: la grilla se queda en la página en la que
  // estaba de la consulta anterior. Como el recorrido va hacia adelante, si
  // quedó en la última se lee un puñado de filas y el resto se informa como
  // "no está en el portal", que es falso. (Verificado en el portal el
  // 2026-08-11: tras una búsqueda nueva seguía en la página 3 de 3.)
  // "(3 of 3)" del paginador -> en qué página quedó la grilla.
  const paginaActual = () => {
    const t = ((document.querySelector('.ui-paginator-current') || {}).textContent || '');
    const m = /\((\d+)\s*(?:of|de)\s*(\d+)\)/i.exec(t);
    return m ? { pagina: parseInt(m[1], 10), de: parseInt(m[2], 10) } : null;
  };

  const irAPrimeraPagina = async () => {
    for (let i = 0; i < 6; i++) {
      const p = paginaActual();
      if (!p || p.pagina <= 1) return true;
      const primera = [...document.querySelectorAll('.ui-paginator-first,.ui-paginator-page')]
        .find((e) => e.offsetParent !== null && !e.classList.contains('ui-state-disabled') &&
          (e.classList.contains('ui-paginator-first') || (e.textContent || '').trim() === '1'));
      if (!primera) return false;
      const antes = filasGrilla().map((x) => x.serie).join('|');
      clickReal(primera);
      await esperarPortal();
      await esperar(() => filasGrilla().map((x) => x.serie).join('|') !== antes, 8000);
    }
    const p = paginaActual();
    return !p || p.pagina <= 1;
  };

  // Consulta un mes y deja la grilla en pantalla.
  //
  // OJO con el orden: el combo "Periodo solicitado" NACE VACIO —una sola opcion,
  // "Seleccione un periodo"— y el portal lo llena por ajax recien cuando se
  // elige el año. Llenar los dos seguidos falla siempre. (Verificado en el
  // portal el 2026-08-11.) Los meses vienen con value = numero de mes y solo
  // hasta el ultimo mes CERRADO.
  //
  // `avisar` va contando cada paso: entre uno y otro el portal se toma sus
  // segundos, y un panel quieto no se distingue de uno colgado.
  const consultarPeriodo = async (mes, anio, avisar) => {
    const contar = (t) => { if (avisar) avisar(t); };
    if (!hayFormulario()) {
      await pasarPantallasPrevias(contar);
      const link = enlaceIngresarFacturas();
      if (!link) return 'no encontré la pantalla de facturas electrónicas: entrá por ' +
        'Devolución de IVA y abrí "Ingresar facturas electrónicas"';
      contar('Abriendo "Ingresar facturas electrónicas"…');
      link.click();
      await esperarPortal();
      await esperar(hayFormulario, 15000);
      if (!hayFormulario()) return 'no se abrió "Ingresar facturas electrónicas"';
    }
    contar('Eligiendo el año ' + anio + '…');
    if (!elegir(cbAnio(), anio, new RegExp('^\\s*' + anio + '\\s*$'))) {
      return 'el combo Año no tiene ' + anio;
    }
    await esperarPortal();
    contar('Esperando que el portal cargue los meses…');
    const reMes = new RegExp('^\\s*' + MESES[mes - 1], 'i');
    const ofreceElMes = () => {
      const c = cbPeriodo();
      return !!c && [...c.options].some((o) => String(o.value) === String(mes) ||
        reMes.test((o.textContent || '').trim()));
    };
    let hayMes = await esperar(ofreceElMes, 15000);
    if (!hayMes) {
      // Segundo mes de un período: el año YA estaba elegido, así que elegirlo de
      // nuevo no cambia nada y el portal no vuelve a cargar los meses —el combo
      // de período queda vacío y parece que el mes no existiera—. Se le avisa
      // igual, aunque el valor no haya cambiado.
      contar('Pidiendo de nuevo los meses de ' + anio + '…');
      const cA = cbAnio();
      if (cA) {
        disparar(cA, 'input');
        disparar(cA, 'change');
        if (window.jQuery) { try { window.jQuery(cA).trigger('change'); } catch (e) { /* sin jQuery */ } }
        await esperarPortal();
        hayMes = await esperar(ofreceElMes, 15000);
      }
    }
    if (!hayMes) {
      return 'el portal no ofrece ' + MESES[mes - 1] + ' ' + anio +
        ' (solo lista meses ya cerrados)';
    }
    contar('Eligiendo ' + MESES[mes - 1] + '…');
    if (!elegir(cbPeriodo(), mes, reMes)) return 'no pude elegir ' + MESES[mes - 1];
    await esperarPortal();
    const b = btnBuscar();
    if (!b) return 'no encontré el botón Buscar';
    contar('Buscando los comprobantes…');
    b.click();
    await esperarPortal();
    await esperar(() => filasGrilla().length > 0, 15000);

    // Buscar NO reinicia el paginador: la grilla se queda en la página de la
    // consulta anterior. Y cuando eso pasa, el paginador deja de responder
    // —verificado el 2026-08-11: ni "primera", ni el número de página, ni
    // cambiar "filas por página" hacen nada—, así que no hay forma de volver
    // desde el script. Leer igual daría una solicitud incompleta sin avisar,
    // que es lo peor que puede pasar acá: se corta y se explica la salida, que
    // según el propio portal es volver a entrar por el menú (nunca recargar).
    if (!(await irAPrimeraPagina())) {
      const p = paginaActual();
      return 'la grilla quedó en la página ' + (p ? p.pagina + ' de ' + p.de : '?') +
        ' de una consulta anterior y el portal no la devuelve a la primera. ' +
        'Volvé a entrar por el menú lateral (Devoluciones → Devolución de IVA), ' +
        'sin recargar la página, y corré esto de nuevo.';
    }
    return '';
  };

  // Las pantallas que el portal pone ANTES de las facturas: el aviso legal y la
  // cuenta bancaria de acreditación. Son dos "Aceptar" que hasta ahora había que
  // dar a mano, y sin ellos el marcador no encontraba nada y se quejaba de que
  // no estaba la pantalla de facturas.
  //
  // Lo que NO se toca es el menú lateral: entrar por ahí desde código rebota a
  // Keycloak y tira la sesión (verificado el 2026-08-11). Abrir la aplicación
  // sigue siendo del usuario; de ahí en adelante, esto se encarga.
  const pasarPantallasPrevias = async (avisar) => {
    for (let vuelta = 0; vuelta < 4; vuelta++) {
      if (hayFormulario() || enlaceIngresarFacturas()) return true;
      const texto = norm(document.body.innerText || '');
      const aceptar = visibles('button,input[type="submit"],input[type="button"],a')
        .find((b) => /^aceptar$/.test(norm((b.value || b.textContent) || '')));
      if (!aceptar) return false;
      // La pantalla de la cuenta pide elegirla antes de aceptar; si ninguna está
      // marcada se toma la primera, que es lo que hace el usuario cuando tiene
      // una sola cuenta registrada.
      const radios = visibles('input[type="radio"],.ui-radiobutton-box');
      if (/cuenta/.test(texto) && radios.length) {
        const marcado = radios.some((r) => r.checked ||
          (r.classList && r.classList.contains('ui-state-active')));
        if (!marcado) {
          if (avisar) avisar('Eligiendo la cuenta bancaria…');
          clickReal(radios[0]);
          await esperarPortal();
        }
      } else if (avisar) {
        avisar('Aceptando el aviso del portal…');
      }
      clickReal(aceptar);
      await esperarPortal();
      await esperar(() => hayFormulario() || !!enlaceIngresarFacturas(), 8000);
    }
    return hayFormulario() || !!enlaceIngresarFacturas();
  };

  // Vuelve al menú de dos pasos para encarar otro mes. Es el botón del propio
  // portal ("Volver menú principal"), no el menú lateral: ese sí tira la sesión.
  const volverAlMenu = async () => {
    const b = botonPorTexto(/volver men/);
    if (!b) return false;
    clickReal(b);
    await esperarPortal();
    // Se espera el MENÚ, no "menú o formulario": justo después del click el
    // formulario sigue en pantalla y esa condición se cumplía sola. El mes
    // siguiente arrancaba sobre una pantalla que se estaba yendo, y terminaba
    // esperando meses en un combo que ya no existía.
    return esperar(() => !!enlaceIngresarFacturas() && !hayFormulario(), 12000);
  };

  // La fecha del portal viene ISO (2026-07-01); el sistema trabaja en dd/mm/aaaa.
  const fechaDePortal = (t) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(t || '').trim());
    return m ? m[3] + '/' + m[2] + '/' + m[1] : String(t || '').trim();
  };

  // Lee la grilla entera, pagina por pagina. Es el listado que el SRI reconoce:
  // proveedor, serie, fecha y monto IVA (la base imponible no la muestra).
  const leerGrilla = async (avisar) => {
    const filas = [];
    const vistas = new Set();
    for (let p = 1; p <= 40; p++) {
      if (avisar) avisar('Página ' + p + '…');
      filasGrilla().forEach((f) => {
        if (vistas.has(f.serie)) return;
        vistas.add(f.serie);
        const celdas = [...f.tr.cells].map((td) => (td.textContent || '').trim().replace(/\s+/g, ' '));
        // El IVA es la ultima celda con pinta de importe ANTES de los controles:
        // se toma la primera columna numerica posterior a la fecha.
        let fecha = '', iva = null;
        celdas.forEach((c, i) => {
          if (!fecha && /^\d{4}-\d{2}-\d{2}$|^\d{2}\/\d{2}\/\d{4}$/.test(c)) fecha = c;
          else if (fecha && iva === null && /^\d+([.,]\d+)?$/.test(c)) iva = leerNumero(c);
        });
        const prov = celdas.find((c, i) => i > 0 && c.length > 6 && !/^\d/.test(c) &&
          !/^factura/i.test(c) && !/^ride$/i.test(c)) || '';
        filas.push({ serie: f.serie, fecha: fechaDePortal(fecha), proveedor: prov, iva: iva || 0 });
      });
      const sig = botonSiguientePagina();
      if (!sig) break;
      const antes = filasGrilla().map((x) => x.serie).join('|');
      clickReal(sig);
      await esperarPortal();
      // Igual que al llenar: se comprueba que la página cambió de verdad, o el
      // recorrido se quedaría releyendo la misma y faltarían comprobantes.
      if (!(await esperar(() => filasGrilla().map((x) => x.serie).join('|') !== antes, 10000))) break;
    }
    return filas;
  };

  // --- Traer la grilla al sistema ------------------------------------------
  // El SRI ya no pide cargar facturas: muestra el listado que califica y el
  // tramite es marcar, clasificar y enviar. Asi que el listado se lleva al
  // sistema, que es donde se decide el tipo de gasto y se controla el tope.
  const traerComprobantes = async (mes, anio) => {
    limpiar();
    linea('Trayendo los comprobantes del portal',
      'font-weight:700;color:#1e6b33;margin-bottom:4px');
    const est = el('div', 'margin:6px 0;color:#555');
    cuerpo.appendChild(est);
    est.textContent = 'Consultando ' + (MESES[mes - 1] || mes) + ' ' + anio + '…';
    const err = await consultarPeriodo(mes, anio, (t) => { est.textContent = t; });
    if (err) {
      linea('✖ ' + err, 'color:#8b1e1e;font-weight:700');
      cuerpo.appendChild(boton('Volver', pintar, CSS_GRIS));
      cuerpo.appendChild(boton('Ver diagnostico',
        () => mostrarTexto('Diagnostico del portal', diagnostico()), CSS_GRIS));
      return;
    }
    const filas = await leerGrilla((t) => { est.textContent = t; });
    if (!filas.length) {
      limpiar();
      linea('El portal no muestra comprobantes en ' + (MESES[mes - 1] || mes) + ' ' + anio + '.',
        'color:#8b6b1e;font-weight:600');
      linea('Solo lista bienes y servicios de primera necesidad de establecimientos ' +
        'verificados, y deja fuera las facturas con devolución automática total.',
        'color:#777;font-size:11px;line-height:1.4');
      cuerpo.appendChild(boton('Volver', pintar, CSS_GRIS));
      return;
    }
    const total = filas.reduce((s, f) => s + (Number(f.iva) || 0), 0);
    const bulto = {
      tipo: 'devolucion-iva-portal',
      identificacion: (paquete && paquete.contribuyente.identificacion) || identificacionEnPantalla(),
      mes, anio,
      filas,
    };
    limpiar();
    linea('Listos para el sistema', 'font-weight:700;color:#1e6b33;margin-bottom:4px');
    linea(filas.length + ' comprobante(s) de ' + (MESES[mes - 1] || mes) + ' ' + anio +
      '  ·  IVA ' + money(total), 'font-weight:600;color:#333');
    cuerpo.appendChild(boton('Copiar para el sistema', function () {
      copiar(JSON.stringify(bulto), this);
    }));
    linea('En el sistema, entrá a Devolución IVA y tocá "📥 Pegar comprobantes del portal". ' +
      'Ahí marcás, clasificás y se controla el tope del mes; después volvés acá a presentar.',
      'margin:6px 0;color:#777;font-size:11px;line-height:1.45');
    const lista = el('div', 'margin-top:6px;max-height:30vh;overflow:auto;border:1px solid #e2e8e4;border-radius:6px');
    filas.forEach((f) => {
      const fila = el('div', 'padding:3px 6px;border-bottom:1px solid #f0f3f1;font-size:11px;color:#444');
      fila.textContent = f.fecha + '  ' + f.serie + '  ' + money(f.iva) + '  ' +
        String(f.proveedor || '').slice(0, 30);
      lista.appendChild(fila);
    });
    cuerpo.appendChild(lista);
    cuerpo.appendChild(boton('Volver', pintar, CSS_GRIS));
  };

  // --- El recorrido completo ------------------------------------------------
  const llenarYEnviar = async (mes, hastaElFinal, enSerie) => {
    limpiar();
    linea('Llenando el portal', 'font-weight:700;color:#1e6b33;margin-bottom:4px');
    const bitacora = el('div', 'margin:6px 0;max-height:40vh;overflow:auto;line-height:1.5');
    cuerpo.appendChild(bitacora);
    // Devuelve la línea para poder reescribirla: cada comprobante se anuncia
    // ANTES de tocarlo y la misma línea se cierra con el resultado. Sin eso, el
    // panel se queda mudo los segundos que el portal se toma por fila y no hay
    // cómo distinguir "trabajando" de "colgado".
    const paso = (txt, css) => {
      const d = el('div', css || 'color:#555', txt);
      bitacora.appendChild(d);
      bitacora.scrollTop = bitacora.scrollHeight;
      return d;
    };
    // Devuelve el fallo además de pintarlo: cuando se recorren varios meses, el
    // que llama necesita saber que este se cortó para no seguir a ciegas.
    const fallar = (txt) => {
      paso('✖ ' + txt, 'color:#8b1e1e;font-weight:700');
      // Si el portal está diciendo que falta el registro de discapacidad, eso
      // explica el fallo mejor que cualquier cosa que diga el marcador.
      const reg = avisoDeRegistro();
      if (reg) paso('→ ' + reg, 'color:#8b6b1e;line-height:1.45');
      cuerpo.appendChild(boton('Volver', pintar, CSS_GRIS));
      // La bitácora va DENTRO del diagnóstico: lo que se intentó y lo que el
      // portal muestra son la misma historia, y así se manda de una sola vez.
      cuerpo.appendChild(boton('Ver diagnostico', () => mostrarTexto(
        'Diagnostico del portal',
        'LO QUE INTENTE' + String.fromCharCode(10) + (bitacora.innerText || '') +
        String.fromCharCode(10, 10) + 'LO QUE VEO' + String.fromCharCode(10) + diagnostico()
      ), CSS_GRIS));
      return { error: txt };
    };

    // Desde donde esté el portal hasta la pantalla de trabajo: aviso legal,
    // cuenta bancaria y menú de dos pasos, si hacen falta.
    if (!hayFormulario()) {
      paso('Abriéndome paso en el portal…');
      const camino = await llegarAlIngreso(paso);
      if (!camino.ok) return fallar(camino.motivo);
    }

    const anio = paquete.periodo.anio;
    const mios = items.filter((i) => (paquete.detalle_meses || []).length > 1
      ? mesDeFecha(i.fecha) === mes
      : true);
    const detalle = (paquete.detalle_meses || []).find((d) => d.mes === mes);
    const tope = detalle ? Number(detalle.tope) : Number(paquete.totales.tope || 0);
    let restante = tope > 0 ? tope : Infinity;

    const sinSerie = mios.filter((i) => !i.serie).length;
    if (sinSerie) {
      paso('⚠ ' + sinSerie + ' comprobante(s) de la solicitud no tienen la serie guardada: ' +
        'esos hay que marcarlos a mano. Se arreglan volviendo a guardar la solicitud en el sistema.',
        'color:#8b6b1e');
    }
    const porSerie = new Map();
    mios.forEach((i) => { if (i.serie) porSerie.set(i.serie.trim(), i); });

    // 1) Consultar el período en el portal
    const lConsulta = paso('Consultando ' + (MESES[mes - 1] || mes) + ' ' + anio + '…');
    const errConsulta = await consultarPeriodo(mes, anio, (t) => { lConsulta.textContent = t; });
    if (errConsulta) return fallar(errConsulta);
    lConsulta.textContent = (MESES[mes - 1] || mes) + ' ' + anio + ': grilla en pantalla';

    if (!filasGrilla().length) {
      return fallar('el portal no muestra ningún comprobante en ese período. Ojo: solo lista ' +
        'bienes y servicios de primera necesidad de establecimientos verificados, y deja fuera ' +
        'las facturas con devolución automática total.');
    }

    // 2) Marcar, tipificar y ajustar montos, página por página
    const hechas = [];
    const problemas = [];
    const ajenas = [];
    const vistas = new Set();
    let pagina = 1;
    let reintentos = 0;
    let seguidas = 0;      // marcas fallidas seguidas: si son todas, se corta
    while (pagina <= 40) {
      const filas = filasGrilla();
      paso('Página ' + pagina + ': ' + filas.length + ' comprobante(s) en pantalla');
      // Se recorre por SERIE y se vuelve a buscar la fila antes de cada paso: el
      // portal repinta la tabla en cada ajax y el nodo guardado queda huérfano
      // —se le siguen mandando clicks a algo que ya no está en la pantalla—.
      for (const serie of filas.map((x) => x.serie)) {
        if (vistas.has(serie)) continue;
        vistas.add(serie);
        const item = porSerie.get(serie);
        if (!item) { ajenas.push(serie); continue; }
        if (restante <= 0.005) {
          problemas.push(serie + ': se llegó al tope del mes, queda sin marcar');
          continue;
        }
        const lin = paso('  · ' + serie + ' — marcando…', 'color:#777;font-size:11px');
        let f = filaPorSerie(serie);
        const errMarca = f ? await marcar(f, (t) => {
          lin.textContent = '  · ' + serie + ' — ' + t + '…';
        }) : 'la fila ya no está en la grilla';
        if (errMarca) {
          // Que el portal no acepte una marca es un problema del comprobante;
          // que no acepte ninguna es un problema del recorrido, y entonces no
          // tiene sentido gastar diez segundos por fila en las veinte que
          // faltan: se corta acá y se explica, con el diagnóstico a mano.
          lin.textContent = '  ✖ ' + serie + ': ' + errMarca;
          lin.style.color = '#8b1e1e';
          problemas.push(serie + ': ' + errMarca);
          seguidas += 1;
          if (!hechas.length && seguidas >= 3) {
            return fallar('el portal no está aceptando las marcas: probé con ' + seguidas +
              ' comprobantes y ninguno quedó marcado. Marcalos a mano, o mandame el ' +
              'diagnóstico para ajustar el marcador a esta versión del portal.');
          }
          continue;
        }
        seguidas = 0;
        lin.textContent = '  · ' + serie + ' — poniendo el tipo de gasto…';
        f = filaPorSerie(serie) || f;
        const err = await ponerTipoGasto(f, item.rubro_sri, item.rubro_label);
        if (err) problemas.push(serie + ': ' + err);
        const pedir = Math.min(Number(item.iva) || 0, restante);
        lin.textContent = '  · ' + serie + ' — confirmando el monto…';
        f = filaPorSerie(serie) || f;
        const err2 = await ponerMonto(f, Math.round(pedir * 100) / 100);
        if (err2) problemas.push(serie + ': ' + err2);
        restante -= pedir;
        hechas.push({ serie, iva: pedir });
        // Marcado pero sin tipo de gasto no sirve: el portal no deja procesar la
        // selección. Se dice en la misma línea, no al final entre los avisos.
        const flojo = err || err2;
        lin.textContent = (flojo ? '  ⚠ ' : '  ✔ ') + serie + '  ' +
          (item.rubro_label || '') + '  ' + money(pedir) + (flojo ? '  — ' + flojo : '');
        lin.style.color = flojo ? '#8b6b1e' : '#1e6b33';
      }
      // Pasar de página, COMPROBANDO que pasó: marcar repinta la grilla entera
      // y el click en "siguiente" se puede perder en ese repintado. A ciegas,
      // el recorrido se queda en la misma página y los comprobantes de las
      // siguientes se informan como "no están en el portal", que es mentira.
      const sig = botonSiguientePagina();
      if (!sig) break;
      const antes = filas.map((x) => x.serie).join('|');
      clickReal(sig);
      await esperarPortal();
      const cambio = await esperar(
        () => filasGrilla().map((x) => x.serie).join('|') !== antes, 10000);
      if (!cambio) {
        if (reintentos >= 2) {
          problemas.push('el portal no pasó de la página ' + pagina +
            ': quedaron comprobantes sin revisar');
          break;
        }
        reintentos += 1;
        await dormir(1200);
        continue;
      }
      reintentos = 0;
      pagina += 1;
    }

    const faltan = mios.filter((i) => i.serie && !vistas.has(i.serie.trim()));
    const total = hechas.reduce((s, h) => s + h.iva, 0);

    paso('—', 'color:#ccc');
    paso('Marcados en el portal: ' + hechas.length + ' de ' + mios.length +
      '  ·  a solicitar ' + money(total), 'font-weight:700;color:#1e6b33');
    if (faltan.length) {
      paso('⚠ ' + faltan.length + ' comprobante(s) de tu solicitud no aparecen en la grilla ' +
        'del portal (no califican o el SRI todavía no los tiene): no se pueden presentar.',
        'color:#8b6b1e');
    }
    if (ajenas.length) {
      paso('· ' + ajenas.length + ' comprobante(s) que el portal lista no están en tu solicitud: ' +
        'quedan sin marcar.', 'color:#777;font-size:11px');
    }
    problemas.slice(0, 10).forEach((p) => paso('⚠ ' + p, 'color:#8b1e1e;font-size:11px'));
    // El catálogo del portal no coincidió con el nuestro: se dice, aunque el
    // trámite haya salido bien. Es el dato que hace falta para dar por verificada
    // la grilla de discapacidad.
    avisosDelCatalogo.forEach((a) => paso('⚠ catálogo del portal: ' + a,
      'color:#8b6b1e;font-size:11px'));

    if (!hechas.length) return fallar('no se pudo marcar ningún comprobante.');

    // 3) Procesar y guardar la selección (todavía no es el envío)
    const bProcesar = botonPorTexto(/procesar facturas/);
    if (!bProcesar) return fallar('no encontré el botón "Procesar facturas seleccionadas"');
    paso('Procesando la selección…');
    // Lo que ya estaba en pantalla no cuenta: interesa lo que el portal conteste
    // a ESTE click.
    const quejasPrevias = new Set(quejasDelPortal());
    const quejasNuevas = () => quejasDelPortal().filter((q) => !quejasPrevias.has(q));
    // Un reclamo del portal es la respuesta, y se corta el mes con el texto del
    // SRI a la vista. Seguir sería presentar una solicitud que el portal no
    // aceptó —y en un semestral, arrastrar el problema por los cinco meses que
    // faltan—. Lo marcado queda en el portal para revisarlo a mano.
    const siSeQueja = (donde) => {
      const qs = quejasNuevas();
      if (!qs.length) return null;
      qs.slice(0, 5).forEach((q) => paso('⚠ el portal dice: ' + q, 'color:#8b1e1e'));
      return fallar('el portal no aceptó ' + donde + ': ' + qs[0].slice(0, 160) +
        (qs.length > 1 ? ' (y ' + (qs.length - 1) + ' reclamo(s) más)' : '') +
        '. No se presentó nada.');
    };
    clickReal(bProcesar);
    await esperarPortal();
    // El portal contesta una de dos cosas: el detalle (con su botón de guardar) o
    // un reclamo. Se espera a que llegue CUALQUIERA de las dos en vez de mirar
    // una sola vez —el ajax tarda más que la tapa de "Espere por favor", así que
    // mirar apenas vuelve `esperarPortal` es mirar antes de que conteste, y por
    // ahí se colaba el rechazo sin que nadie lo viera—.
    await esperar(() => !!botonPorTexto(/guardar seleccion/) || quejasNuevas().length > 0, 12000);

    const rechazoProcesar = siSeQueja('la selección');
    if (rechazoProcesar) return rechazoProcesar;

    const bGuardar = botonPorTexto(/guardar seleccion/);
    if (!bGuardar) return fallar('no encontré el botón "Guardar selección realizada". Revisá el ' +
      'detalle en pantalla: puede que el portal esté pidiendo corregir algún monto.');
    paso('Guardando la selección…');
    clickReal(bGuardar);
    await esperarPortal();
    // Igual que arriba: o aparece por dónde seguir, o el portal se queja.
    await esperar(() => !!botonPorTexto(/cargar informacion/) || !!buscarEnvio() ||
      quejasNuevas().length > 0, 12000);

    const rechazoGuardar = siSeQueja('guardar la selección');
    if (rechazoGuardar) return rechazoGuardar;

    // Guardar deja la selección lista, pero el envío vive en la OTRA entrada del
    // menú de dos pasos: "Envío de solicitud". Sin entrar ahí, "Cargar
    // Información" no existe en la pantalla y el recorrido moría al final,
    // después de haber hecho todo el trabajo.
    if (!botonPorTexto(/cargar informacion/)) {
      // La entrada puede tardar en aparecer: guardar dispara su propio ajax.
      await esperar(() => !!buscarEnvio() || !!botonPorTexto(/cargar informacion/), 15000);
      const irAlEnvio = buscarEnvio();
      if (irAlEnvio) {
        paso('Abriendo "Envío de solicitud"…');
        clickReal(irAlEnvio);
        await esperarPortal();
        await esperar(() => !!botonPorTexto(/cargar informacion/), 15000);
      } else if (!botonPorTexto(/cargar informacion/)) {
        paso('⚠ no veo la entrada "Envío de solicitud". En pantalla hay: ' +
          visibles('a,button,input[type="button"],input[type="submit"]')
            .map((e) => ((e.value || e.textContent) || '').trim().slice(0, 24))
            .filter(Boolean).slice(0, 8).join(' · '), 'color:#8b6b1e;font-size:11px');
      }
    }

    // 4) El envío
    paso('Selección guardada.', 'font-weight:700;color:#1e6b33');
    if (!hastaElFinal) {
      confirmarEnvio(hechas.length, total, mes);
      return { ok: true, presentado: false, cuantos: hechas.length, total };
    }

    // Modo de una sola autorización: se dio ANTES de empezar, con contribuyente,
    // período, cantidad y monto a la vista, así que acá no se vuelve a preguntar
    // —preguntar dos veces por lo mismo no agrega control, agrega clicks—. Queda
    // en la bitácora qué se presentó, y enseguida la constancia del portal.
    const bEnviar = await esperar(() => botonPorTexto(/cargar informacion/), 12000)
      ? botonPorTexto(/cargar informacion/) : null;
    if (!bEnviar) return fallar('no encontré el botón "Cargar Información" para presentar. ' +
      'La selección quedó guardada: se puede presentar a mano desde "Envío de solicitud".');
    paso('Presentando la solicitud ante el SRI…', 'font-weight:700;color:#8b1e1e');
    clickReal(bEnviar);
    await esperarPortal(40000);
    await dormir(1500);
    const constancia = leerConstancia(hechas.length, total);
    // Sin la confirmación del SRI, lo que el portal haya reclamado es la única
    // pista de por qué. Viaja con la constancia para que llegue al resumen de
    // meses, donde si no se perdería.
    if (!constancia.mensaje) {
      const qs = quejasNuevas();
      if (qs.length) {
        constancia.quejas = qs.slice(0, 5);
        qs.slice(0, 3).forEach((q) => paso('⚠ el portal dice: ' + q, 'color:#8b1e1e'));
      }
    }
    // En una serie de meses no se pinta la constancia de cada uno: taparía el
    // recorrido del siguiente. Se devuelve y al final se muestran todas juntas.
    if (!enSerie) mostrarConstancia(hechas.length, total);
    return { ok: true, presentado: true, cuantos: hechas.length, total, constancia };
  };

  // Recorre TODOS los meses del período, uno por uno: el portal presenta una
  // solicitud por mes, así que un semestral son seis vueltas. Entre mes y mes se
  // vuelve por el botón del propio portal ("Volver menú principal"); el menú
  // lateral no se toca, que desde código tira la sesión.
  const presentarMeses = async (meses, hastaElFinal) => {
    // Quién abrió el portal manda por encima del paquete. Presentar la solicitud
    // de una persona dentro de la sesión de otra es declarar a nombre
    // equivocado, y no se deshace.
    const desacuerdo = desacuerdoConElPortal();
    if (desacuerdo) {
      limpiar();
      linea('No presento nada', 'font-weight:700;color:#8b1e1e;margin-bottom:6px');
      linea(desacuerdo.motivo, 'margin:4px 0;color:#333;line-height:1.5');
      desacuerdo.detalles.forEach((d) => linea(d, 'margin:3px 0;color:#555;line-height:1.45'));
      cuerpo.appendChild(boton('Volver', pintar, CSS_GRIS));
      return [];
    }
    const resultados = [];
    for (let i = 0; i < meses.length; i++) {
      if (i > 0 && !(await volverAlMenu())) {
        resultados.push({ mes: meses[i], error: 'no pude volver al menú para seguir con el mes siguiente' });
        break;
      }
      const r = await llenarYEnviar(meses[i], hastaElFinal, meses.length > 1) || {};
      resultados.push({ mes: meses[i], ...r });
      if (r.error) break;                 // seguir tras un fallo es acumular ruido
      if (!hastaElFinal) break;           // se detuvo a propósito: espera al usuario
    }
    if (meses.length > 1) resumenDeMeses(resultados);
    // Y avisarle a la app. Sin esto el trámite queda hecho en el SRI pero el
    // sistema sigue mostrando la solicitud en Borrador, porque marcarla como
    // presentada dependía de que alguien volviera a la pestaña de la app a pegar
    // la constancia a mano —y con el recorrido automático ya nadie vuelve—.
    avisarALaApp(constanciaDeMeses(resultados));
    return resultados;
  };

  // Una sola constancia para toda la solicitud. El portal presenta un mes por
  // vez, pero en el sistema un semestral es UNA solicitud: se suma lo que el SRI
  // aceptó en cada mes. Si algún mes no llegó a confirmar, el mensaje va vacío a
  // propósito: la app no debe dar por presentado lo que el portal no confirmó.
  const constanciaDeMeses = (resultados) => {
    const oks = (resultados || []).filter((r) => r && r.presentado && r.constancia);
    if (!oks.length) return null;
    const cs = oks.map((r) => r.constancia);
    const conFecha = cs.filter((x) => x.fecha_carga);
    const todosOk = cs.every((x) => x.mensaje) && !(resultados || []).some((r) => r && r.error);
    return {
      comprobantes: cs.reduce((s, x) => s + (Number(x.comprobantes) || 0), 0),
      monto: Math.round(cs.reduce((s, x) => s + (Number(x.monto) || 0), 0) * 100) / 100,
      fecha_carga: conFecha.length ? conFecha[conFecha.length - 1].fecha_carga : '',
      mensaje: todosOk
        ? 'Carga de archivo realizada exitosamente' +
          (cs.length > 1 ? ' (' + cs.length + ' meses)' : '')
        : '',
      meses: cs.length,
    };
  };

  // El canal de vuelta al sistema. Lo escucha la extensión (`contenido-sri.js`),
  // que lo guarda y se lo entrega a la app cuando el usuario vuelve a esa
  // pestaña. Sin extensión no escucha nadie y no pasa nada: queda el camino de
  // siempre, "Copiar constancia para la app" y pegarla.
  const avisarALaApp = (constancia) => {
    if (!constancia) return;
    try {
      // Destino '*' y no el origen propio: un postMessage dirigido a `window` lo
      // recibe ESA ventana y nadie más —los iframes no escuchan lo que se manda
      // al padre—, así que no filtra nada. Con el origen propio, además, no
      // llegaría nunca desde una página `file://` (ahí `origin` vale "null" y el
      // navegador rechaza el envío en silencio), que es como corre la prueba.
      window.postMessage({
        tipo: 'jomap-devolucion-constancia',
        solicitud_id: (paquete && paquete.solicitud_id) || null,
        constancia,
      }, '*');
    } catch (e) { /* el aviso es un extra: nunca puede tumbar el envío */ }
  };

  // Cómo terminó cada mes. Con varios meses, el panel del último tapa a los
  // anteriores: sin este resumen no habría manera de saber qué se presentó.
  const resumenDeMeses = (resultados) => {
    limpiar();
    const hubo = resultados.some((r) => r.error);
    linea(hubo ? 'Terminó con problemas' : 'Meses presentados',
      'font-weight:700;margin-bottom:6px;color:' + (hubo ? '#8b6b1e' : '#1e6b33'));
    let total = 0;
    resultados.forEach((r) => {
      const nombre = MESES[r.mes - 1] || r.mes;
      if (r.error) {
        linea('✖ ' + nombre + ': ' + r.error, 'margin:3px 0;color:#8b1e1e');
        return;
      }
      total += Number(r.total) || 0;
      linea((r.presentado ? '✔ ' : '· ') + nombre + ': ' + r.cuantos + ' comprobante(s) · ' +
        money(r.total) + (r.presentado ? '' : ' (llenado, sin presentar)'),
        'margin:3px 0;color:#1e6b33');
    });
    linea('Total presentado: ' + money(total), 'margin:8px 0;font-weight:700;color:#1e6b33');
    avisosDelCatalogo.forEach((a) => linea('⚠ catálogo del portal: ' + a,
      'color:#8b6b1e;font-size:11px;line-height:1.4'));
    const constancias = resultados.filter((r) => r.constancia).map((r) => r.constancia);
    if (constancias.length) {
      cuerpo.appendChild(boton('Copiar constancias para la app', function () {
        copiar(JSON.stringify(constancias.length === 1 ? constancias[0] : constancias), this);
      }));
    }
    cuerpo.appendChild(boton('Volver', pintar, CSS_GRIS));
  };

  // El envío es el acto definitivo (el portal advierte el art. 298 del COIP), así
  // que no se dispara solo: se pide un toque más, ya con los números a la vista.
  const confirmarEnvio = (cuantos, total, mes) => {
    const zona = el('div', 'margin:10px 0;padding:10px;border:2px solid #8b1e1e;border-radius:8px;background:#fff5f5');
    zona.appendChild(el('div', 'font-weight:700;color:#8b1e1e;margin-bottom:4px', 'Envío de la solicitud'));
    zona.appendChild(el('div', 'color:#555;line-height:1.5;font-size:12px',
      'Se van a presentar ' + cuantos + ' comprobante(s) por ' + money(total) + ' de ' +
      (MESES[mes - 1] || mes) + '. Al cargar la información la solicitud queda presentada ante el ' +
      'SRI y no se puede deshacer; el portal advierte el art. 298 del COIP.'));
    const acc = el('div', 'margin-top:6px');
    const bEnviar = boton('Cargar Informacion (definitivo)', async () => {
      bEnviar.disabled = true;
      bEnviar.textContent = 'Enviando…';
      const b = botonPorTexto(/cargar informacion/);
      if (!b) {
        bEnviar.textContent = 'no encontré el botón del portal';
        return;
      }
      clickReal(b);
      await esperarPortal(40000);
      await dormir(1200);
      mostrarConstancia(cuantos, total);
    }, 'padding:8px 10px;margin:3px;border:1px solid #8b1e1e;border-radius:6px;' +
       'background:#8b1e1e;color:#fff;font-weight:700;font-size:12px;cursor:pointer');
    acc.appendChild(boton('Revisar primero en el portal', () => { zona.remove(); }, CSS_GRIS));
    acc.appendChild(bEnviar);
    zona.appendChild(acc);
    cuerpo.appendChild(zona);
  };

  // Lo que el portal contesta al presentar. Se copia como paquete para pegarlo
  // en la app: es la constancia de lo que el SRI aceptó de verdad.
  const leerConstancia = (cuantos, total) => {
    const texto = document.body.innerText || '';
    const ok = /carga de archivo realizada exitosamente/i.test(sinTildes(texto));
    const mf = /(\d{2}[-/]\d{2}[-/]\d{4}[ ]+\d{2}:\d{2}(?::\d{2})?)/.exec(texto);
    const mt = /total[^\n]{0,40}?(\d[\d.,]*)/i.exec(texto);
    return {
      comprobantes: cuantos,
      monto: (mt && leerNumero(mt[1]) !== null) ? leerNumero(mt[1]) : Math.round(total * 100) / 100,
      fecha_carga: mf ? mf[1] : '',
      mensaje: ok ? 'Carga de archivo realizada exitosamente' : '',
    };
  };

  const mostrarConstancia = (cuantos, total) => {
    const constancia = leerConstancia(cuantos, total);
    const ok = !!constancia.mensaje;
    limpiar();
    linea(ok ? 'Solicitud presentada' : 'Terminó el envío',
      'font-weight:700;color:' + (ok ? '#1e6b33' : '#8b6b1e') + ';margin-bottom:6px');
    if (!ok) {
      linea('No encontré en la pantalla la confirmación "Carga de archivo realizada ' +
        'exitosamente". Revisá el portal antes de darla por presentada.', 'color:#8b6b1e');
      (constancia.quejas || []).forEach((q) => linea('⚠ el portal dice: ' + q, 'color:#8b1e1e'));
    }
    // Los desacuerdos de catálogo sobreviven a la constancia: la bitácora se
    // borra al pintarla, y este aviso hay que verlo justamente al final.
    avisosDelCatalogo.forEach((a) => linea('⚠ catálogo del portal: ' + a,
      'color:#8b6b1e;font-size:11px;line-height:1.4'));
    linea('Comprobantes: ' + constancia.comprobantes);
    linea('Total: ' + money(constancia.monto));
    if (constancia.fecha_carga) linea('Carga: ' + constancia.fecha_carga);
    cuerpo.appendChild(boton('Copiar constancia para la app', function () {
      copiar(JSON.stringify(constancia), this);
    }));
    linea('Pegala en el sistema con "Pegar constancia" en la ventana de envío: así queda ' +
      'guardado lo que el SRI aceptó, que no siempre es lo que se marcó.',
      'margin:6px 0;color:#777;font-size:11px;line-height:1.4');
    cuerpo.appendChild(boton('Volver', pintar, CSS_GRIS));
  };

  // Elegir año y mes con lo que el propio portal ofrece: los años del combo y,
  // recién después del ajax del año, los meses (que son solo los ya cerrados).
  const elegirAnioYMes = async (accion) => {
    limpiar();
    linea('¿Qué mes traigo?', 'font-weight:700;color:#1e6b33;margin-bottom:6px');
    const est = el('div', 'margin:4px 0;color:#555');
    cuerpo.appendChild(est);
    if (!hayFormulario()) {
      // Se camina el asistente entero —aviso legal, cuenta bancaria y menú— en
      // vez de mandar al usuario a hacerlo a mano.
      const camino = await llegarAlIngreso((t) => { est.textContent = t; });
      if (!camino.ok) {
        est.textContent = '✖ ' + camino.motivo;
        cuerpo.appendChild(boton('Ver diagnostico',
          () => mostrarTexto('Diagnostico del portal', diagnostico()), CSS_GRIS));
        cuerpo.appendChild(boton('Volver', pintar, CSS_GRIS));
        return;
      }
    }
    const cA = cbAnio();
    if (!cA) {
      est.textContent = '✖ No encontré el combo de Año en esta pantalla.';
      cuerpo.appendChild(boton('Ver diagnostico',
        () => mostrarTexto('Diagnostico del portal', diagnostico()), CSS_GRIS));
      cuerpo.appendChild(boton('Volver', pintar, CSS_GRIS));
      return;
    }
    est.textContent = 'Elegí el año:';
    const zonaA = el('div', 'margin:4px 0');
    cuerpo.appendChild(zonaA);
    const zonaM = el('div', 'margin:8px 0');
    cuerpo.appendChild(zonaM);
    [...cA.options]
      .filter((o) => /^(19|20)\d\d$/.test((o.textContent || '').trim()))
      .forEach((o) => {
        const anio = parseInt((o.textContent || '').trim(), 10);
        zonaA.appendChild(boton(String(anio), async () => {
          zonaM.textContent = '';
          zonaM.appendChild(el('div', 'color:#555', 'Cargando los meses de ' + anio + '…'));
          elegir(cbAnio(), anio, new RegExp('^\\s*' + anio + '\\s*$'));
          await esperarPortal();
          await esperar(() => cbPeriodo() && cbPeriodo().options.length > 1, 15000);
          const cP = cbPeriodo();
          zonaM.textContent = '';
          const ops = cP ? [...cP.options].filter((x) => /^[1-9]\d?$/.test(String(x.value))) : [];
          if (!ops.length) {
            zonaM.appendChild(el('div', 'color:#8b6b1e', 'El portal no ofrece meses para ' + anio + '.'));
            return;
          }
          zonaM.appendChild(el('div', 'color:#555;margin-bottom:4px', 'Elegí el mes:'));
          ops.forEach((x) => {
            const mes = parseInt(x.value, 10);
            zonaM.appendChild(boton((x.textContent || '').trim(), () => accion(mes, anio)));
          });
        }, CSS_GRIS));
      });
    cuerpo.appendChild(boton('Volver', pintar, CSS_GRIS));
  };

  // Sin solicitud cargada, lo único que se puede hacer —y lo primero del
  // trámite— es traer al sistema el listado que el SRI reconoce.
  const pintarSinSolicitud = () => {
    linea('Traer los comprobantes al sistema', 'font-weight:700;color:#1e6b33;margin-bottom:4px');
    linea('El SRI muestra los comprobantes que califican para la devolución. Traelos al ' +
      'sistema: ahí se marcan, se les pone el tipo de gasto y se controla el tope del mes. ' +
      'Después volvés acá con la solicitud y se presenta.',
      'margin:4px 0;color:#555;line-height:1.45');
    // Lo que se descartó por ser de otro contribuyente se dice: un panel vacío
    // sin explicación manda a buscar el problema a cualquier lado.
    if (avisoDePaquete) {
      linea('⚠ ' + avisoDePaquete,
        'margin:6px 0;padding:8px;border:1px solid #e0b4b4;border-radius:6px;' +
        'background:#fff5f5;color:#8b1e1e;line-height:1.45');
    }
    const ctx = contextoDeLaApp();
    if (ctx) {
      linea('Abierto en el sistema: ' + (ctx.nombre || '') + ' (' + ctx.identificacion + ')',
        'margin:6px 0;color:#1e6b33;font-weight:600');
    }
    const ident = identificacionEnPantalla();
    if (ident && !ctx) {
      linea('Contribuyente en pantalla: ' + ident, 'margin:6px 0;color:#1e6b33;font-weight:600');
    }
    cuerpo.appendChild(boton('Traer comprobantes al sistema', () => elegirAnioYMes(traerComprobantes)));
    linea('¿Ya tenés la solicitud armada en el sistema? Copiala con "Enviar al SRI" y:',
      'margin:10px 0 2px;color:#777;font-size:11px');
    cuerpo.appendChild(boton('Pegar el paquete de una solicitud', async () => {
      const p = await pedirPegado();
      if (p) adoptarPaquete(p);
      pintar();
    }, CSS_GRIS));
  };

  // La autorización, UNA sola vez y por adelantado.
  //
  // El recorrido entero —marcar, clasificar, procesar, guardar y presentar— corre
  // solo; lo que no corre solo es la decisión de presentar, que es un acto del
  // contribuyente y no se deshace. Así que se pide acá, antes de tocar el portal
  // y con los números delante, en vez de interrumpir al final: pedir permiso
  // cuando el trabajo ya está hecho no agrega control, agrega clicks.
  const autorizar = (meses) => {
    const detalles = meses.map((m) =>
      (paquete.detalle_meses || []).find((x) => x.mes === m) || {});
    const cuantos = detalles.reduce((s, d) => s + (d.comprobantes || 0), 0) || items.length;
    const monto = detalles.some((d) => d.solicitar != null)
      ? detalles.reduce((s, d) => s + (Number(d.solicitar) || 0), 0)
      : paquete.totales.solicitado;
    limpiar();
    linea(meses.length > 1 ? '¿Presento estas ' + meses.length + ' solicitudes?' : '¿Presento esta solicitud?',
      'font-weight:700;color:#1e6b33;margin-bottom:6px');
    const info = el('div', 'background:#f3f8f4;border:1px solid #cfe3d4;border-radius:8px;padding:8px;line-height:1.6');
    info.appendChild(el('div', 'font-weight:700', paquete.contribuyente.nombre));
    info.appendChild(el('div', '', 'RUC/cédula: ' + paquete.contribuyente.identificacion));
    info.appendChild(el('div', '', 'Período: ' + (paquete.periodo.etiqueta || '') +
      '  (' + meses.map((m) => MESES[m - 1] || m).join(', ') + ' ' + paquete.periodo.anio + ')'));
    info.appendChild(el('div', 'font-weight:700',
      cuantos + ' comprobante(s)  ·  ' + money(monto)));
    cuerpo.appendChild(info);
    if (meses.length > 1) {
      linea('El portal presenta UNA solicitud por mes, así que se van a hacer ' + meses.length +
        ' vueltas seguidas, una por cada mes del período.',
        'margin:6px 0;color:#555;line-height:1.5;font-size:12px');
    }
    linea('Al aceptar, el marcador hace TODO sin volver a preguntar: marca cada comprobante, ' +
      'le pone el tipo de gasto, procesa, guarda y presenta la solicitud ante el SRI. ' +
      'Presentar no se puede deshacer; el portal lo advierte con el art. 298 del COIP.',
      'margin:8px 0;color:#555;line-height:1.5;font-size:12px');
    cuerpo.appendChild(boton('Sí, presentar automáticamente', () => presentarMeses(meses, true),
      'padding:9px 12px;margin:3px;border:1px solid #8b1e1e;border-radius:6px;' +
      'background:#8b1e1e;color:#fff;font-weight:700;font-size:12px;cursor:pointer'));
    cuerpo.appendChild(boton('Solo llenar; me detengo antes de presentar',
      () => presentarMeses(meses.slice(0, 1), false), CSS_GRIS));
    cuerpo.appendChild(boton('Volver', pintar, CSS_GRIS));
  };

  // Los meses del período que tienen comprobantes. El portal presenta UNA
  // solicitud por mes, así que un semestral son seis vueltas: se recorren todas
  // sin preguntar mes por mes, que era lo que obligaba a repetir el trámite a
  // mano seis veces.
  const mesesDelPeriodo = () => {
    const conComprobantes = (paquete.detalle_meses || [])
      .filter((d) => d.comprobantes > 0).map((d) => d.mes);
    return conComprobantes.length ? conComprobantes : [paquete.periodo.mes];
  };

  const elegirMes = () => autorizar(mesesDelPeriodo());

  // Etiquetas, ids y clases de un nodo y sus hijos, sin una letra del contenido.
  const esqueleto = (nodo, nivel) => {
    const n = nivel || 0;
    if (n > 4) return '';
    const partes = [...nodo.children].map((h) => {
      const tag = h.tagName.toLowerCase() +
        (h.id ? '#' + h.id.split(':').pop() : '') +
        (h.className && typeof h.className === 'string'
          ? '.' + h.className.trim().split(/\s+/).slice(0, 3).join('.') : '');
      const dentro = esqueleto(h, n + 1);
      return tag + (dentro ? '(' + dentro + ')' : '');
    });
    return partes.join(' ');
  };

  // Diagnóstico: qué ve el marcador en esta pantalla, para ajustarlo sin adivinar.
  const diagnostico = () => {
    const p = [];
    p.push('URL: ' + location.href.split('?')[0]);
    p.push('Año: ' + (cbAnio() ? (cbAnio().id || '(sin id)') : 'NO ENCONTRADO'));
    p.push('Periodo: ' + (cbPeriodo() ? (cbPeriodo().id || '(sin id)') : 'NO ENCONTRADO'));
    p.push('Buscar: ' + (btnBuscar() ? (btnBuscar().id || '(sin id)') : 'NO ENCONTRADO'));
    p.push('Selects visibles:');
    visibles('select').forEach((s, i) => {
      p.push('  [' + i + '] id=' + (s.id || '-') + ' | ' + s.options.length + ' opciones: ' +
        opciones(s).slice(0, 4).join(' / '));
    });
    p.push('Botones visibles:');
    visibles('button,input[type="submit"],input[type="button"]').slice(0, 12).forEach((b, i) => {
      p.push('  [' + i + '] id=' + (b.id || '-') + ' | ' + (((b.value || b.textContent) || '').trim().slice(0, 30)));
    });
    // Anatomía de una fila: es lo que hace falta para saber por qué el portal no
    // acepta una marca. Va el ESQUELETO (etiquetas, ids y clases), no el texto:
    // alcanza para ajustar el marcador y no arrastra datos del contribuyente.
    const filas = filasGrilla();
    p.push('Filas de la grilla: ' + filas.length);
    if (filas.length) {
      const f = filas[0];
      p.push('Primera fila: serie ' + f.serie + ' | clases tr: ' + (f.tr.className || '-'));
      p.push('  marcada segun el marcador: ' + (marcada(f) ? 'si' : 'no'));
      FORMAS_DE_MARCAR.forEach((forma) => {
        const n = forma.donde(f.tr);
        p.push('  ' + forma.como + ': ' + (n
          ? n.tagName.toLowerCase() + ' id=' + (n.id || '-') + ' class=' + (n.className || '-')
          : 'NO ESTA'));
      });
      const sel = comboDeFila(f);
      p.push('  combo tipo de gasto: ' + (sel
        ? 'id=' + (sel.id || '-') + ' deshabilitado=' + sel.disabled + ' opciones=' + sel.options.length
        : 'NO ESTA'));
      // El catálogo entero, código por código. Es lo que hace falta para saber si
      // la entrada de discapacidad usa el mismo que la de adultos mayores, y son
      // etiquetas fijas del SRI: no arrastran nada del contribuyente.
      if (sel) {
        p.push('  catalogo del combo: ' + [...sel.options]
          .map((o) => (o.value || '-') + '=' + (o.textContent || '').trim())
          .join(' | '));
      }
      const inp = montoDeFila(f);
      p.push('  campo IVA solicitado: ' + (inp
        ? 'id=' + (inp.id || '-') + ' deshabilitado=' + inp.disabled : 'NO ESTA'));
      p.push('  esqueleto de la fila: ' + esqueleto(f.tr));
    }
    p.push('Paginador: ' + (paginaActual()
      ? paginaActual().pagina + ' de ' + paginaActual().de : 'sin paginador'));
    return p.join(String.fromCharCode(10));
  };

  // El panel se pinta al final: usa lo definido arriba.
  //
  // Y si la solicitud viene autorizada desde el sistema (`auto`), el recorrido
  // arranca solo: la persona ya dijo que sí, con contribuyente, período,
  // cantidad y monto delante, al tocar "Enviar al SRI". Volver a preguntar acá
  // sería pedir dos veces lo mismo. Un período semestral es la excepción —hay
  // que elegir qué mes se presenta— y ahí sí se muestra el panel.
  if (paquete && paquete.auto) {
    // Se pasan solas las pantallas previas (aviso legal y cuenta bancaria): el
    // usuario abrió la aplicación del SRI y de ahí en adelante es trabajo del
    // marcador, incluidos TODOS los meses del período.
    pasarPantallasPrevias().then((listo) => {
      if (listo) presentarMeses(mesesDelPeriodo(), true);
      else pintar();
    });
  } else {
    pintar();
  }
})();
