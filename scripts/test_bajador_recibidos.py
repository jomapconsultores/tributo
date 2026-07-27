# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Prueba del Bajador-GASTOS (bookmarklet de comprobantes RECIBIDOS) contra
RÉPLICAS del formulario del SRI, con Playwright. No toca el portal real.

Lo que se verifica es lo que rompió en producción: el marcador buscaba los combos
SOLO por su id de JSF (`frmPrincipal:ano`, `:mes`, …) y, si el portal los renombra,
no abría nada — decía "abrí la consulta" aunque el formulario estuviera ahí.

Réplicas:
  1. IDS CLÁSICOS   (frmPrincipal:ano/mes/dia/cmbTipoComprobante/btnConsultar).
  2. IDS DISTINTOS  (otros nombres): tiene que reconocerlos por la ETIQUETA visible
     (Año / Mes / Día / Tipo de comprobante) o por el CONTENIDO de las opciones.
  3. SIN FORMULARIO: no debe morir; abre el diagnóstico con la salida manual.

    ./backend/venv/Scripts/python.exe scripts/test_bajador_recibidos.py
"""
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

RAIZ = Path(__file__).resolve().parent.parent
BOOKMARKLET = RAIZ / "frontend" / "src" / "utils" / "bajador-gastos.bookmarklet.txt"

_ok = _fail = 0


def check(nombre, cond, detalle=""):
    global _ok, _fail
    if cond:
        _ok += 1
        print(f"  PASS  {nombre} {detalle}")
    else:
        _fail += 1
        print(f"  FALLA {nombre} {detalle}")
    return bool(cond)


# Claves de acceso: 49 dígitos exactos (es lo que el marcador busca en la grilla).
CLAVES = [str(i) + ("0123456789" * 5)[:48] for i in range(3)]


def _filas():
    return "".join(
        f"<tr><td>{i+1}</td><td>01/06/2026</td><td>PROVEEDOR {i}</td>"
        f"<td>{c}</td><td><a title='Descargar XML' href='#'><img src='x_xml.png'></a></td></tr>"
        for i, c in enumerate(CLAVES))


def pagina_que_revienta():
    """Réplica del portal cuando devuelve SU error: con el día 'Todos' contesta la
    página de error de JBoss (java.lang.ArithmeticException, lo que le pasó al
    usuario); consultado día por día, responde bien. El día 3 tiene una factura."""
    base = pagina(ids_clasicos=True)
    grilla_dia = ("<div id='grid'><table><tr><td>1</td><td>03/01/2026</td>"
                  f"<td>PROVEEDOR X</td><td>{CLAVES[0]}</td></tr></table></div>")
    script = """
    <script>
      var DIA_CON_DATOS = document.getElementById('grid').innerHTML;
      var ov = document.getElementById('dlgpopStatusPrime');
      var btn = document.getElementById('frmPrincipal:btnConsultar');
      btn.onclick = function () {
        var dia = document.getElementById('frmPrincipal:dia').value;
        if (dia === '0') {          // el mes entero: el portal se cae
          document.body.innerHTML = '<h1>JBWEB000065: HTTP Status 500</h1>' +
            '<p>JBWEB000309: type JBWEB000066: Exception report</p>' +
            '<pre>javax.servlet.ServletException ... root cause java.lang.ArithmeticException</pre>';
          return;
        }
        ov.style.display = 'block';               // el overlay real del portal
        setTimeout(function () {
          ov.style.display = 'none';
          var g = document.getElementById('grid');
          g.innerHTML = (dia === '3') ? DIA_CON_DATOS : '';
          g.style.display = '';
          document.getElementById('form_messages').innerText =
            (dia === '3') ? '' : 'No existen datos para los parametros ingresados';
        }, 80);
      };
    </script>"""
    base = base.replace("<div id=\"grid\"",
                        "<div id='form_messages'></div>"
                        "<div id='dlgpopStatusPrime' style='display:none'>Espere por favor</div>"
                        "<div id=\"grid\"")
    base = base.replace(f"<div id=\"grid\" style=\"display:none\"><table>{_filas()}</table></div>",
                        grilla_dia.replace("<div id='grid'>", "<div id='grid' style='display:none'>"))
    return base.replace("</body>", script + "</body>")


def pagina(ids_clasicos=True, con_formulario=True):
    """HTML de la réplica. Con ids_clasicos=False los combos se llaman distinto,
    pero conservan su etiqueta visible y sus opciones."""
    if not con_formulario:
        return "<html><body><h1>Otra pantalla del portal</h1><p>Sin formulario.</p></body></html>"
    ids = ({"anio": "frmPrincipal:ano", "mes": "frmPrincipal:mes", "dia": "frmPrincipal:dia",
            "tipo": "frmPrincipal:cmbTipoComprobante", "btn": "frmPrincipal:btnConsultar"}
           if ids_clasicos else
           {"anio": "cmb_periodo_1", "mes": "cmb_periodo_2", "dia": "cmb_periodo_3",
            "tipo": "cmb_docto", "btn": "btn_ejecutar"})
    meses = "".join(f"<option value='{i}'>{m}</option>" for i, m in enumerate(
        ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto",
         "Septiembre", "Octubre", "Noviembre", "Diciembre"], start=1))
    dias = "<option value='0'>Todos</option>" + "".join(
        f"<option value='{d}'>{d}</option>" for d in range(1, 32))
    return f"""<html><body>
      <table>
        <tr><td>Año</td><td><select id="{ids['anio']}">
            <option value="2025">2025</option><option value="2026" selected>2026</option></select></td></tr>
        <tr><td>Mes</td><td><select id="{ids['mes']}">{meses}</select></td></tr>
        <tr><td>Día</td><td><select id="{ids['dia']}">{dias}</select></td></tr>
        <tr><td>Tipo de comprobante</td><td><select id="{ids['tipo']}">
            <option value="1">Factura</option><option value="4">Nota de Débito</option>
            <option value="6">Comprobante de Retención</option></select></td></tr>
      </table>
      <button id="{ids['btn']}" onclick="document.getElementById('grid').style.display=''">Consultar</button>
      <div id="grid" style="display:none"><table>{_filas()}</table></div>
    </body></html>"""


URL_FALSA = "https://portal.sri.test/comprobantes/recibidos.jsf"


def abrir_panel(page, html):
    """Sirve la réplica desde un origen de verdad (no about:blank: ahí localStorage
    está prohibido y el marcador guarda el avance justamente ahí) y ejecuta el
    bookmarklet tal como lo pegaría el usuario en la consola."""
    page.route(URL_FALSA, lambda ruta: ruta.fulfill(
        status=200, content_type="text/html; charset=utf-8", body=html))
    page.goto(URL_FALSA)
    codigo = BOOKMARKLET.read_text(encoding="utf-8").strip()
    codigo = re.sub(r"^javascript:", "", codigo)
    page.evaluate(codigo)
    page.wait_for_selector("#sri_bajador_gastos", timeout=4000)
    return page.inner_text("#sri_bajador_gastos")


def main():
    print("=== 0. el archivo que despacha la app sobrevive al copiar/pegar ===")
    href = BOOKMARKLET.read_text(encoding="utf-8").strip()
    # Al copiar la dirección de un marcador, Chrome la devuelve URL-codificada: una
    # comilla invertida vuelve como "%60" y pegar eso en la consola es un error de
    # sintaxis (el script "no hace nada"). Por eso no puede quedar ninguna.
    check("sin comillas invertidas (se vuelven %60 al copiar)", "`" not in href)
    check("sin el carácter de porcentaje (rompe la URL javascript:)", "%" not in href)
    check("empieza con javascript:", href.startswith("javascript:"))
    check("no usa ventanas de mensaje (el viejo sí)", "alert(" not in href)

    with sync_playwright() as p:
        nav = p.chromium.launch()
        page = nav.new_page()

        print("=== 1. formulario con los ids clásicos ===")
        txt = abrir_panel(page, pagina(ids_clasicos=True))
        check("abre el panel", "Bajador-GASTOS" in txt)
        check("pregunta qué bajar", "GASTOS" in txt and "RETENCIONES" in txt and "AMBOS" in txt)
        check("ofrece el año", "Año" in txt, txt[:60].replace("\n", " "))
        check("no cae en diagnóstico", "No puedo manejar el formulario" not in txt)

        print("=== 2. el portal renombró los combos (lo que rompía antes) ===")
        txt = abrir_panel(page, pagina(ids_clasicos=False))
        check("los reconoce igual (por etiqueta u opciones)",
              "No puedo manejar el formulario" not in txt, txt[:80].replace("\n", " "))
        check("pregunta qué bajar", "GASTOS" in txt and "RETENCIONES" in txt)
        detectados = page.evaluate("""() => {
          const vis = [...document.querySelectorAll('select')];
          return vis.map(s => s.id);
        }""")
        check("la réplica sí usa otros ids", all(not i.startswith("frmPrincipal") for i in detectados),
              detectados)

        print("=== 3. período por mes y por semestre ===")
        page.click("#sri_bajador_gastos >> text=AMBOS")
        txt = page.inner_text("#sri_bajador_gastos")
        check("ofrece MES y SEMESTRE", "Por MES" in txt and "Por SEMESTRE" in txt, txt[:80].replace("\n", " "))
        page.click("#sri_bajador_gastos >> text=Por SEMESTRE")
        txt = page.inner_text("#sri_bajador_gastos")
        check("pide cuál semestre", "1er semestre" in txt and "2do semestre" in txt)
        page.click("#sri_bajador_gastos >> text=Volver")
        page.click("#sri_bajador_gastos >> text=Por MES")
        txt = page.inner_text("#sri_bajador_gastos")
        check("lista los doce meses", all(m in txt for m in ["Ene", "Jun", "Jul", "Dic"]))

        print("=== 4. pantalla sin formulario: diagnóstico, no un callejón ===")
        txt = abrir_panel(page, pagina(con_formulario=False))
        check("avisa que no puede manejar el formulario", "No puedo manejar el formulario" in txt)
        check("dice qué le falta", "No encontré:" in txt, txt[:120].replace("\n", " "))
        check("ofrece bajar lo que está en pantalla", "Bajar lo que está en pantalla" in txt)
        check("ofrece copiar el diagnóstico", "Copiar diagnóstico" in txt)
        page.click("#sri_bajador_gastos >> text=Bajar lo que está en pantalla")
        txt = page.inner_text("#sri_bajador_gastos")
        check("el modo manual pregunta el tipo", "Son GASTOS" in txt and "Son RETENCIONES" in txt)

        print("=== 5. corrida real de un mes: llena el form y baja el TXT de claves ===")
        ctx = nav.new_context(accept_downloads=True)
        page2 = ctx.new_page()
        # Con los ids RENOMBRADOS, que es el caso que fallaba: si igual completa el
        # formulario y baja el TXT, el marcador sirve aunque el portal los cambie.
        abrir_panel(page2, pagina(ids_clasicos=False))
        page2.click("#sri_bajador_gastos >> input[type=checkbox]")   # sin bajar los XML: más rápido
        # Por texto EXACTO del botón: "GASTOS" a secas también está en el título del panel.
        page2.click("#sri_bajador_gastos >> button:has-text('facturas de compra')")
        page2.click("#sri_bajador_gastos >> button:has-text('Por MES')")
        with page2.expect_download(timeout=30000) as espera:
            page2.click("#sri_bajador_gastos >> button:text-is('Ene')")
        bajado = espera.value
        destino = Path(bajado.path())
        contenido = destino.read_text(encoding="utf-8").strip().splitlines()
        check("el archivo se llama gastos_…", bajado.suggested_filename.startswith("gastos_"),
              bajado.suggested_filename)
        check("trae las claves de acceso de la grilla", sorted(contenido) == sorted(CLAVES),
              f"{len(contenido)} líneas")
        check("eligió el mes en el combo del portal",
              page2.eval_on_selector("#cmb_periodo_2", "s => s.value") == "1",
              page2.eval_on_selector("#cmb_periodo_2", "s => s.value"))
        check("eligió el día 'Todos'",
              page2.eval_on_selector("#cmb_periodo_3", "s => s.value") == "0")
        check("eligió el tipo Factura (gastos = solo facturas)",
              page2.eval_on_selector("#cmb_docto", "s => s.value") == "1")
        txt = page2.inner_text("#sri_bajador_gastos")
        check("informa lo descargado", "Se descargó" in txt and "3 comprobantes" in txt,
              txt[:100].replace("\n", " "))
        ctx.close()

        print("=== 6a. el portal devuelve SU error (ArithmeticException) y se lleva la página ===")
        ctx2 = nav.new_context(accept_downloads=True)
        page3 = ctx2.new_page()
        abrir_panel(page3, pagina_que_revienta())
        page3.click("#sri_bajador_gastos >> input[type=checkbox] >> nth=0")   # sin XML
        page3.click("#sri_bajador_gastos >> button:has-text('facturas de compra')")
        page3.click("#sri_bajador_gastos >> button:has-text('Por MES')")
        page3.click("#sri_bajador_gastos >> button:text-is('Feb')")
        page3.wait_for_function("() => /ArithmeticException/.test(document.body.innerText)", timeout=20000)
        check("el panel muere con la página (por eso hace falta guardar el avance)",
              page3.evaluate("() => !document.getElementById('sri_bajador_gastos')"))
        check("el avance quedó guardado", page3.evaluate(
            "() => !!JSON.parse(localStorage.getItem('jomapBajadorGastos') || 'null')"))

        print("=== 6b. al volver, ofrece retomar y con día por día sí entrega ===")
        # Igual que en la vida real: el usuario recarga el portal y vuelve a abrir el marcador.
        txt = abrir_panel(page3, pagina_que_revienta())
        check("ofrece retomar la descarga a medias", "Quedó una descarga a medias" in txt,
              txt[:90].replace("\n", " "))
        check("ofrece continuar día por día", "día por día" in txt)
        check("ofrece bajar lo ya juntado", "Bajar el TXT de lo ya juntado" in txt)
        with page3.expect_download(timeout=180000) as espera:
            page3.click("#sri_bajador_gastos >> button:has-text('Continuar — día por día')")
        contenido = Path(espera.value.path()).read_text(encoding="utf-8").strip().splitlines()
        check("baja la factura del único día con datos", contenido == [CLAVES[0]],
              f"{len(contenido)} claves")
        check("el formulario sobrevivió: nunca disparó la consulta que rompe",
              page3.eval_on_selector("#frmPrincipal\\:btnConsultar", "b => !!b"))
        check("al terminar, ya no queda avance pendiente", page3.evaluate(
            "() => !localStorage.getItem('jomapBajadorGastos')"))
        ctx2.close()

        nav.close()

    print(f"\n===== RESULTADO: {_ok} PASS / {_fail} FALLA =====")
    return 1 if _fail else 0


if __name__ == "__main__":
    sys.exit(main())
