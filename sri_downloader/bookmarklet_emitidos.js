/*
 * BOOKMARKLET — Bajar Comprobantes EMITIDOS del SRI por mes o semestre
 * ====================================================================
 *
 * QUÉ HACE: estando en el SRI, en "Facturación Electrónica > Comprobantes
 * electrónicos emitidos" (ya logueado), recorre día por día el período elegido
 * (un mes, 1er semestre ene-jun, o 2do semestre jul-dic), junta todas las CLAVES
 * DE ACCESO (49 díg) de las facturas emitidas y descarga un TXT (formato que acepta
 * POST /api/sales-iva/process-txt del backend).
 *
 * POR QUÉ ASÍ: el portal del SRI fuerza login en cada navegación nueva, así que NO
 * se puede automatizar desde afuera. Pero una vez DENTRO del formulario, "Consultar"
 * es un ajax de PrimeFaces que no recarga la página — un bookmarklet recorre las
 * fechas sin romperse. El SRI solo muestra las emitidas del RUC logueado. Fecha < hoy.
 *
 * IDs del form (confirmados jul-2026): fecha=frmPrincipal:calendarFechaDesde_input,
 * Consultar=frmPrincipal:btnConsultar, tabla=frmPrincipal:tablaCompEmitidos.
 * La clave se extrae CELDA por celda (td) — NO por innerText del panel, que concatena
 * el secuencial con la clave y el regex \d{49} agarra una ventana errónea.
 *
 * DÓNDE VIVE LA COPIA QUE SE DESPACHA: frontend/src/utils/bajador-emitidos.bookmarklet.txt
 * (misma lógica, minificada). La app la ofrece como botón arrastrable en
 * Ingresos IVA y en el Sidebar (Ingresos IVA > "Bajar EMITIDAS por fecha").
 * Si tocás este archivo, actualizá también ese .txt.
 */

// ---- Fuente legible (mantener/editar acá; la de abajo es la misma minificada) ----
(async () => {
  const $ = id => document.getElementById(id);
  const di = $('frmPrincipal:calendarFechaDesde_input');
  const btn = $('frmPrincipal:btnConsultar');
  const panel = $('frmPrincipal:panelListaComprobantes') || document.body;
  if (!di || !btn) { alert('Primero abrí la consulta: Facturación Electrónica > Comprobantes electrónicos emitidos.'); return; }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const opt = (prompt('¿QUE FECHA queres bajar?\n\nEscribi:\n  M  = un mes\n  S1 = 1er semestre (ene-jun)\n  S2 = 2do semestre (jul-dic)', 'M') || '').trim().toUpperCase();
  if (!opt) return;
  const year = parseInt(prompt('Año (AAAA):', String(new Date().getFullYear())), 10);
  if (!year) return;
  let months;
  if (opt === 'S1') months = [1, 2, 3, 4, 5, 6];
  else if (opt === 'S2') months = [7, 8, 9, 10, 11, 12];
  else { const mm = parseInt(prompt('Mes (1-12):', String(new Date().getMonth() + 1)), 10); if (!mm) return; months = [mm]; }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const claves = new Set();
  let con = 0, sin = 0, skip = 0;
  const grab = () => {
    const tbl = $('frmPrincipal:tablaCompEmitidos') || panel;
    tbl.querySelectorAll('td').forEach(td => { const m = (td.textContent || '').match(/\d{49}/); if (m) claves.add(m[0]); });
  };

  for (const m of months) {
    const nd = new Date(year, m, 0).getDate();
    for (let d = 1; d <= nd; d++) {
      const f = new Date(year, m - 1, d); f.setHours(0, 0, 0, 0);
      if (f >= today) { skip++; continue; }              // el SRI exige fecha < hoy
      const s = String(d).padStart(2, '0') + '/' + String(m).padStart(2, '0') + '/' + year;
      di.value = s;
      di.dispatchEvent(new Event('input', { bubbles: true }));
      di.dispatchEvent(new Event('change', { bubbles: true }));
      btn.click();
      await sleep(2300);
      let g = 0;
      while (g++ < 80) {                                  // recorrer todas las páginas del día
        grab();
        const nx = panel.querySelector('.ui-paginator-next:not(.ui-state-disabled)');
        if (!nx) break;
        nx.click(); await sleep(1400);
      }
      if (/No existen datos/i.test(panel.innerText)) sin++; else con++;
      document.title = s + ' - ' + claves.size + ' claves';
    }
  }

  const txt = [...claves].join('\n') + (claves.size ? '\n' : '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain' }));
  a.download = 'emitidos_' + (opt === 'M' ? ('mes' + months[0]) : opt) + '_' + year + '.txt';
  document.body.appendChild(a); a.click(); a.remove();
  document.title = 'SRI';
  alert('Listo. Claves de acceso: ' + claves.size + '.\nDias con datos: ' + con + ', sin datos: ' + sin + (skip ? ', omitidos (fecha >= hoy): ' + skip : '') + '.\n\nSe descargo el TXT. Ahora subilo en Ingresos IVA > "Subir reporte (TXT)" y el sistema baja los XML solo.');
})();


/* ============================================================================
 * MINIFICADO: ya no se duplica acá para que no se bifurque. La única copia
 * ejecutable es frontend/src/utils/bajador-emitidos.bookmarklet.txt — una sola
 * línea `javascript:...` que la app sirve como botón arrastrable. Para instalarlo
 * a mano, abrí ese archivo y pegá la línea como URL de un marcador nuevo.
 * ============================================================================ */
