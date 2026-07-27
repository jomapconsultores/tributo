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


def abrir_panel(page, html):
    page.set_content(html)
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

        nav.close()

    print(f"\n===== RESULTADO: {_ok} PASS / {_fail} FALLA =====")
    return 1 if _fail else 0


if __name__ == "__main__":
    sys.exit(main())
