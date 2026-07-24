/*
 * BOOKMARKLET (EXPERIMENTAL) — Bajar los XML de Comprobantes EMITIDOS del SRI
 * ==========================================================================
 *
 * Igual que bookmarklet_emitidos.js pero, en vez de juntar las claves en un TXT,
 * intenta DESCARGAR EL XML de cada factura desde el propio portal (útil para las
 * emitidas del "Facturador" del SRI, que el web service AutorizacionComprobantesOffline
 * NO devuelve — da numeroComprobantes=0).
 *
 * CÓMO FUNCIONA: por cada día con datos, busca en cada fila de la grilla un control
 * de descarga de XML (elemento cuyo title/alt/id/onclick/href/texto contenga "xml")
 * y le hace click. Si NO encuentra ningún control XML, baja "DIAG_fila_emitida.html"
 * con el HTML de una fila para poder ajustar el selector real (aún no confirmado en vivo).
 *
 * USO: entrar a Comprobantes electrónicos emitidos (logueado) y clic al marcador.
 * Si el navegador pide permiso para "descargar varios archivos", dar Permitir.
 * Luego subir los XML en Ingresos IVA > "Subir XML" (/api/sales-iva/process-xml).
 *
 * IDs del form (jul-2026): fecha=frmPrincipal:calendarFechaDesde_input,
 * Consultar=frmPrincipal:btnConsultar, tabla=frmPrincipal:tablaCompEmitidos.
 */

// ---- Fuente legible ----
(async () => {
  const $ = id => document.getElementById(id);
  const di = $('frmPrincipal:calendarFechaDesde_input');
  const btn = $('frmPrincipal:btnConsultar');
  const panel = $('frmPrincipal:panelListaComprobantes') || document.body;
  if (!di || !btn) { alert('Abrí primero: Facturación Electrónica > Comprobantes electrónicos emitidos.'); return; }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const opt = (prompt('¿Qué bajar? M (un mes), S1 (ene-jun) o S2 (jul-dic)', 'M') || '').trim().toUpperCase();
  if (!opt) return;
  const year = parseInt(prompt('Año (AAAA):', String(new Date().getFullYear())), 10);
  if (!year) return;
  let months;
  if (opt === 'S1') months = [1, 2, 3, 4, 5, 6];
  else if (opt === 'S2') months = [7, 8, 9, 10, 11, 12];
  else { const mm = parseInt(prompt('Mes (1-12):', String(new Date().getMonth() + 1)), 10); if (!mm) return; months = [mm]; }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  let xml = 0, con = 0, sin = 0, skip = 0, diag = '';

  const bajarFila = (row) => {
    const cand = [...row.querySelectorAll('a,button,img,input,[onclick]')];
    const el = cand.find(e => /xml/i.test(
      (e.getAttribute('title') || '') + (e.getAttribute('alt') || '') + (e.id || '') +
      (e.getAttribute('onclick') || '') + (e.getAttribute('href') || '') + (e.innerText || '')));
    if (el) { (el.closest('a,button,[onclick]') || el).click(); xml++; return true; }
    return false;
  };

  for (const m of months) {
    const nd = new Date(year, m, 0).getDate();
    for (let d = 1; d <= nd; d++) {
      const f = new Date(year, m - 1, d); f.setHours(0, 0, 0, 0);
      if (f >= today) { skip++; continue; }
      const s = String(d).padStart(2, '0') + '/' + String(m).padStart(2, '0') + '/' + year;
      di.value = s;
      di.dispatchEvent(new Event('input', { bubbles: true }));
      di.dispatchEvent(new Event('change', { bubbles: true }));
      btn.click();
      await sleep(2300);
      if (/No existen datos/i.test(panel.innerText)) { sin++; continue; }
      con++;
      const tbl = $('frmPrincipal:tablaCompEmitidos') || panel;
      const rows = [...tbl.querySelectorAll('tbody tr')].filter(r => /\d{49}/.test(r.textContent || ''));
      for (const row of rows) {
        try { const ok = bajarFila(row); if (!ok && !diag) diag = row.outerHTML; } catch (e) {}
        await sleep(1200);
      }
      document.title = s + ' - ' + xml + ' xml';
    }
  }

  document.title = 'SRI';
  if (!xml && diag) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([diag], { type: 'text/html' }));
    a.download = 'DIAG_fila_emitida.html';
    document.body.appendChild(a); a.click(); a.remove();
    alert('No encontré botón de XML en la grilla. Bajé "DIAG_fila_emitida.html" — pasámelo y con eso ajusto el bajador. (Días con datos: ' + con + ')');
  } else {
    alert('Listo. XML disparados: ' + xml + '. Días con datos: ' + con + '. Si el navegador pidió permiso para bajar varios, dale Permitir. Después subilos en Ingresos IVA > Subir XML.');
  }
})();


/* ============================================================================
 * MINIFICADO — pegar como URL de un marcador nuevo (nombre: "SRI ⬇ Emitidas XML"):
 * ============================================================================

javascript:(async()=>{const $=id=>document.getElementById(id);const di=$('frmPrincipal:calendarFechaDesde_input'),btn=$('frmPrincipal:btnConsultar');const panel=$('frmPrincipal:panelListaComprobantes')||document.body;if(!di||!btn){alert('Abrí primero: Facturación Electrónica > Comprobantes electrónicos emitidos.');return;}const sleep=ms=>new Promise(r=>setTimeout(r,ms));const opt=(prompt('¿Qué bajar? M (un mes), S1 (ene-jun) o S2 (jul-dic)','M')||'').trim().toUpperCase();if(!opt)return;const year=parseInt(prompt('Año (AAAA):',String(new Date().getFullYear())),10);if(!year)return;let months;if(opt==='S1')months=[1,2,3,4,5,6];else if(opt==='S2')months=[7,8,9,10,11,12];else{const mm=parseInt(prompt('Mes (1-12):',String(new Date().getMonth()+1)),10);if(!mm)return;months=[mm];}const today=new Date();today.setHours(0,0,0,0);let xml=0,con=0,sin=0,skip=0,diag='';const bajarFila=row=>{const cand=[...row.querySelectorAll('a,button,img,input,[onclick]')];const el=cand.find(e=>/xml/i.test((e.getAttribute('title')||'')+(e.getAttribute('alt')||'')+(e.id||'')+(e.getAttribute('onclick')||'')+(e.getAttribute('href')||'')+(e.innerText||'')));if(el){(el.closest('a,button,[onclick]')||el).click();xml++;return true;}return false;};for(const m of months){const nd=new Date(year,m,0).getDate();for(let d=1;d<=nd;d++){const f=new Date(year,m-1,d);f.setHours(0,0,0,0);if(f>=today){skip++;continue;}const s=String(d).padStart(2,'0')+'/'+String(m).padStart(2,'0')+'/'+year;di.value=s;di.dispatchEvent(new Event('input',{bubbles:true}));di.dispatchEvent(new Event('change',{bubbles:true}));btn.click();await sleep(2300);if(/No existen datos/i.test(panel.innerText)){sin++;continue;}con++;const tbl=$('frmPrincipal:tablaCompEmitidos')||panel;const rows=[...tbl.querySelectorAll('tbody tr')].filter(r=>/\d{49}/.test(r.textContent||''));for(const row of rows){try{const ok=bajarFila(row);if(!ok&&!diag)diag=row.outerHTML;}catch(e){}await sleep(1200);}document.title=s+' - '+xml+' xml';}}document.title='SRI';if(!xml&&diag){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([diag],{type:'text/html'}));a.download='DIAG_fila_emitida.html';document.body.appendChild(a);a.click();a.remove();alert('No encontré botón de XML en la grilla. Bajé "DIAG_fila_emitida.html" — pasámelo y con eso ajusto el bajador. (Días con datos: '+con+')');}else{alert('Listo. XML disparados: '+xml+'. Días con datos: '+con+'. Si el navegador pidió permiso para bajar varios, dale Permitir. Después subilos en Ingresos IVA > Subir XML.');}})();

 * ============================================================================ */
