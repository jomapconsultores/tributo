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
 * QUÉ NO HACE (todavía): llenar el formulario del portal por sí solo. Los IDs de
 * esa pantalla no están fijados acá a propósito: el formulario de devoluciones no
 * es el mismo de comprobantes (que sí está automatizado en bookmarklet_recibidos.js)
 * y hay que verlo en vivo antes de escribir selectores. Cuando estén confirmados,
 * se agrega el llenado automático abajo, donde dice AUTOMATIZACIÓN.
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

  pintar();

  // --- AUTOMATIZACIÓN (pendiente) ------------------------------------------
  // Acá va el llenado del formulario del portal cuando estén confirmados sus
  // selectores reales (mismo criterio que bookmarklet_recibidos.js: buscar por id
  // exacto y, de reserva, por sufijo del id).
})();
