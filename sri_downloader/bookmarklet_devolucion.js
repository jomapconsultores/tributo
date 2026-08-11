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

  const leerDelPortapapeles = async () => {
    try {
      const txt = await navigator.clipboard.readText();
      const p = JSON.parse(txt);
      return valido(p) ? p : null;
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
      resolve(p);
    }));
    ta.focus();
  });

  limpiar();
  linea('Leyendo el paquete de la solicitud...');
  let paquete = await leerDelPortapapeles();
  if (!paquete) paquete = await pedirPegado();

  // --- 2) Avance guardado (se puede cerrar el panel y seguir después) -------
  const CLAVE_LS = 'jomapDevIva:' + (paquete.solicitud_id || 'sin-id');
  const leerMarcas = () => {
    try { return new Set(JSON.parse(localStorage.getItem(CLAVE_LS)) || []); }
    catch (e) { return new Set(); }
  };
  const guardarMarcas = (set) => {
    try { localStorage.setItem(CLAVE_LS, JSON.stringify([...set])); } catch (e) { /* sin espacio */ }
  };
  let marcadas = leerMarcas();

  // --- 3) Panel de trabajo --------------------------------------------------
  const items = paquete.items || [];
  const claves = items.map((i) => i.clave_acceso).filter(Boolean);
  const nombreBase = 'DevolucionIVA_' + (paquete.contribuyente.identificacion || '') + '_' +
    (paquete.periodo.anio || '') + '-' + String(paquete.periodo.mes || '').padStart(2, '0');

  const pintar = () => {
    limpiar();

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
    if (hayFormulario()) {
      acciones.appendChild(boton('Llenar y presentar en el portal', elegirMes,
        'padding:8px 10px;margin:3px;border:1px solid #1e6b33;border-radius:6px;' +
        'background:#1e6b33;color:#fff;font-weight:700;font-size:12px;cursor:pointer'));
      acciones.appendChild(boton('Comparar con el portal', compararConElPortal, CSS_GRIS));
    } else {
      acciones.appendChild(boton('¿Por qué no puedo comparar?', function () {
        copiar(diagnostico(), this);
      }, CSS_GRIS));
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
      filas.push({
        tr,
        serie,
        chk: tr.querySelector('.ui-chkbox-box') || tr.querySelector('input[type="checkbox"]'),
      });
    });
    return filas;
  };

  const filaPorSerie = (s) => filasGrilla().find((f) => f.serie === s) || null;

  const marcada = (f) => {
    const caja = f.tr.querySelector('.ui-chkbox-box');
    if (caja) return caja.classList.contains('ui-state-active');
    const i = f.tr.querySelector('input[type="checkbox"]');
    return !!(i && i.checked);
  };

  const marcar = async (f) => {
    if (marcada(f)) return true;
    if (!f.chk) return false;
    clickReal(f.chk);
    await esperarPortal();
    return esperar(() => marcada(f), 8000);
  };

  // El combo del tipo de gasto de la fila. El portal lo renderiza como un select
  // oculto dentro del widget, así que no se filtra por visibilidad.
  const comboDeFila = (f) => f.tr.querySelector('select');

  const ponerTipoGasto = async (f, codigo, etiqueta) => {
    const sel = comboDeFila(f);
    if (!sel) return 'no hay combo de tipo de gasto en la fila';
    await esperar(() => !sel.disabled, 8000);
    const ops = [...sel.options];
    let op = codigo ? ops.find((o) => String(o.value) === String(codigo)) : null;
    if (!op && etiqueta) op = ops.find((o) => norm(o.textContent) === norm(etiqueta));
    if (!op && etiqueta) op = ops.find((o) => norm(o.textContent).indexOf(norm(etiqueta)) >= 0);
    if (!op) return 'el combo no tiene la opcion ' + (etiqueta || codigo);
    sel.value = op.value;
    disparar(sel, 'input');
    disparar(sel, 'change');
    if (window.jQuery) { try { window.jQuery(sel).trigger('change'); } catch (e) { /* sin jQuery */ } }
    // El widget pinta la etiqueta aparte: si no se actualiza, el usuario ve
    // "Seleccione" con el valor ya puesto y no sabe si quedó.
    const w = sel.closest ? sel.closest('.ui-selectonemenu') : null;
    if (w) {
      const lab = w.querySelector('.ui-selectonemenu-label');
      if (lab) lab.textContent = (op.textContent || '').trim();
    }
    await esperarPortal();
    return String(sel.value) === String(op.value) ? '' : 'el portal no aceptó el tipo de gasto';
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
    const inp = montoDeFila(f);
    if (!inp) return 'no hay campo de IVA solicitado en la fila';
    await esperar(() => !inp.disabled, 8000);
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

  const botonSiguientePagina = () => [...document.querySelectorAll('.ui-paginator-next')]
    .find((e) => e.offsetParent !== null && !e.classList.contains('ui-state-disabled')) || null;

  // --- El recorrido completo ------------------------------------------------
  const llenarYEnviar = async (mes) => {
    limpiar();
    linea('Llenando el portal', 'font-weight:700;color:#1e6b33;margin-bottom:4px');
    const bitacora = el('div', 'margin:6px 0;max-height:40vh;overflow:auto;line-height:1.5');
    cuerpo.appendChild(bitacora);
    const paso = (txt, css) => {
      bitacora.appendChild(el('div', css || 'color:#555', txt));
      bitacora.scrollTop = bitacora.scrollHeight;
    };
    const fallar = (txt) => {
      paso('✖ ' + txt, 'color:#8b1e1e;font-weight:700');
      cuerpo.appendChild(boton('Volver', pintar, CSS_GRIS));
      cuerpo.appendChild(boton('Copiar diagnostico', function () { copiar(diagnostico(), this); }, CSS_GRIS));
    };

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
    paso('Consultando ' + (MESES[mes - 1] || mes) + ' ' + anio + '…');
    if (!elegir(cbAnio(), anio, new RegExp('^\\s*' + anio + '\\s*$'))) {
      return fallar('el combo Año no tiene ' + anio);
    }
    if (!elegir(cbPeriodo(), mes, new RegExp('^\\s*' + MESES[mes - 1], 'i'))) {
      return fallar('el combo Periodo no tiene ' + MESES[mes - 1]);
    }
    const bBuscar = btnBuscar();
    if (!bBuscar) return fallar('no encontré el botón Buscar');
    bBuscar.click();
    await esperarPortal();
    await esperar(() => filasGrilla().length > 0, 12000);

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
        let f = filaPorSerie(serie);
        if (!f || !(await marcar(f))) {
          problemas.push(serie + ': no se pudo marcar la casilla');
          continue;
        }
        f = filaPorSerie(serie) || f;
        const err = await ponerTipoGasto(f, item.rubro_sri, item.rubro_label);
        if (err) problemas.push(serie + ': ' + err);
        const pedir = Math.min(Number(item.iva) || 0, restante);
        f = filaPorSerie(serie) || f;
        const err2 = await ponerMonto(f, Math.round(pedir * 100) / 100);
        if (err2) problemas.push(serie + ': ' + err2);
        restante -= pedir;
        hechas.push({ serie, iva: pedir });
        paso('  ✔ ' + serie + '  ' + (item.rubro_label || '') + '  ' + money(pedir),
          'color:#1e6b33;font-size:11px');
      }
      const sig = botonSiguientePagina();
      if (!sig) break;
      clickReal(sig);
      await esperarPortal();
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

    if (!hechas.length) return fallar('no se pudo marcar ningún comprobante.');

    // 3) Procesar y guardar la selección (todavía no es el envío)
    const bProcesar = botonPorTexto(/procesar facturas/);
    if (!bProcesar) return fallar('no encontré el botón "Procesar facturas seleccionadas"');
    paso('Procesando la selección…');
    clickReal(bProcesar);
    await esperarPortal();

    const bGuardar = await esperar(() => botonPorTexto(/guardar seleccion/), 12000)
      ? botonPorTexto(/guardar seleccion/) : null;
    if (!bGuardar) return fallar('no encontré el botón "Guardar selección realizada". Revisá el ' +
      'detalle en pantalla: puede que el portal esté pidiendo corregir algún monto.');
    paso('Guardando la selección…');
    clickReal(bGuardar);
    await esperarPortal();

    // 4) El envío definitivo, con confirmación explícita
    paso('Selección guardada. Falta el envío.', 'font-weight:700;color:#1e6b33');
    confirmarEnvio(hechas.length, total, mes);
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
  const mostrarConstancia = (cuantos, total) => {
    const texto = document.body.innerText || '';
    const ok = /carga de archivo realizada exitosamente/i.test(sinTildes(texto));
    const mf = /(\d{2}[-/]\d{2}[-/]\d{4}[ ]+\d{2}:\d{2}(?::\d{2})?)/.exec(texto);
    const mt = /total[^\n]{0,40}?(\d[\d.,]*)/i.exec(texto);
    const constancia = {
      comprobantes: cuantos,
      monto: (mt && leerNumero(mt[1]) !== null) ? leerNumero(mt[1]) : Math.round(total * 100) / 100,
      fecha_carga: mf ? mf[1] : '',
      mensaje: ok ? 'Carga de archivo realizada exitosamente' : '',
    };
    limpiar();
    linea(ok ? 'Solicitud presentada' : 'Terminó el envío',
      'font-weight:700;color:' + (ok ? '#1e6b33' : '#8b6b1e') + ';margin-bottom:6px');
    if (!ok) {
      linea('No encontré en la pantalla la confirmación "Carga de archivo realizada ' +
        'exitosamente". Revisá el portal antes de darla por presentada.', 'color:#8b6b1e');
    }
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

  // Un mes por solicitud: si el período abarca varios (semestral), se elige cuál.
  const elegirMes = () => {
    const meses = (paquete.detalle_meses || []).filter((d) => d.comprobantes > 0).map((d) => d.mes);
    if (meses.length <= 1) return llenarYEnviar(meses[0] || paquete.periodo.mes);
    limpiar();
    linea('El portal presenta un mes por solicitud. ¿Cuál cargo ahora?',
      'font-weight:700;color:#1e6b33;margin-bottom:6px');
    meses.forEach((m) => {
      const d = (paquete.detalle_meses || []).find((x) => x.mes === m) || {};
      cuerpo.appendChild(boton((MESES[m - 1] || m) + '  ·  ' + (d.comprobantes || 0) +
        ' compr.  ·  ' + money(d.solicitar || 0), () => llenarYEnviar(m)));
    });
    cuerpo.appendChild(boton('Volver', pintar, CSS_GRIS));
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
    return p.join(String.fromCharCode(10));
  };

  // El panel se pinta al final: usa lo definido arriba.
  pintar();
})();
