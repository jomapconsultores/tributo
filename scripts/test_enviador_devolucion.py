"""Prueba el marcador Enviador-DEVOLUCIÓN contra un portal simulado.

POR QUÉ EXISTE: al portal real del SRI no se puede entrar desde código —cada
navegación pide login SSO— y presentar una solicitud es irreversible, así que
la única forma de tocar el marcador sin romper un trámite de verdad es correrlo
contra una copia del formulario. `scripts/portal_devolucion_falso.html` imita la
pantalla "Ingresar facturas electrónicas": combos Año/Período que se llenan por
ajax, grilla paginada de a 10, casilla que habilita "IVA solicitado" y "Tipo de
gasto", y los botones Procesar / Guardar / Cargar Información.

Se prueba el .txt MINIFICADO, que es el que se despacha: un bug del minificador
no se ve en la fuente.

    python scripts/test_enviador_devolucion.py            # las tres variantes
    python scripts/test_enviador_devolucion.py widget     # una sola
    python scripts/test_enviador_devolucion.py nativo src # y contra la fuente

Variantes del portal (el SRI cambia el widget entre versiones):
    widget  el click va a la caja del checkbox   -> tiene que marcar los 12
    nativo  la caja no escucha, sí el checkbox   -> tiene que marcar los 12
    muerto  no escucha nadie                     -> tiene que CORTAR y avisar

Necesita Playwright (pip install playwright && playwright install chromium).
"""
import json
import pathlib
import sys
import time
from urllib.parse import unquote

from playwright.sync_api import sync_playwright

RAIZ = pathlib.Path(__file__).resolve().parent.parent
PORTAL = RAIZ / "scripts/portal_devolucion_falso.html"
TXT = RAIZ / "frontend/src/utils/enviador-devolucion.bookmarklet.txt"
FUENTE_JS = RAIZ / "sri_downloader/bookmarklet_devolucion.js"

SERIES = ["003-301-0000891%02d" % (n + 10) for n in range(1, 13)]


def codigo_del_marcador(fuente: str) -> str:
    if fuente == "src":
        js = FUENTE_JS.read_text(encoding="utf-8")
        return js[js.index("(async () => {"):]
    url = TXT.read_text(encoding="utf-8").strip()
    return unquote(url[len("javascript:"):])


def paquete_de_prueba() -> dict:
    """Lo mismo que entrega GET /devoluciones-iva/solicitudes/{id}/envio."""
    items = []
    for n, serie in enumerate(SERIES, start=1):
        items.append({
            "clave_acceso": str(n).rjust(49, "0"),
            "serie": serie,
            "fecha": f"{n:02d}/07/2026",
            "ruc_proveedor": "0999999999001",
            "proveedor": f"COMERCIAL PRUEBA {n} SA",
            "rubro": "alimentacion", "rubro_label": "Alimentación", "rubro_sri": "4",
            "base": 10.0, "iva": 1.5 + n, "total": 11.5 + n,
        })
    iva = round(sum(i["iva"] for i in items), 2)
    return {
        "solicitud_id": "sim-001",
        "contribuyente": {"identificacion": "0912345678", "nombre": "CONTRIBUYENTE DE PRUEBA"},
        "periodo": {"mes": 7, "anio": 2026, "periodicidad": "mensual",
                    "semestre": None, "etiqueta": "Julio 2026"},
        "beneficiario": {"tipo": "adulto_mayor", "porcentaje_discapacidad": None},
        "totales": {"base": 120.0, "iva": iva, "tope": 361.50, "solicitado": iva},
        "detalle_meses": [{"mes": 7, "comprobantes": len(items), "iva": iva,
                           "tope": 361.50, "solicitar": iva, "excedente": 0}],
        "estado": "borrador",
        "items": items,
    }


PANEL = "(document.getElementById('jomap-enviador-devolucion')||{}).innerText||''"
DEL_PANEL = "[...document.querySelectorAll('#jomap-enviador-devolucion button')]"
BOTONES = DEL_PANEL + ".map(b=>b.textContent)"


def correr(modo: str, fuente: str) -> bool:
    codigo = codigo_del_marcador(fuente)
    with sync_playwright() as p:
        nav = p.chromium.launch(headless=True)
        ctx = nav.new_context(permissions=["clipboard-read", "clipboard-write"])
        pg = ctx.new_page()
        errores = []
        pg.on("pageerror", lambda e: errores.append("PAGEERROR: " + str(e)))

        pg.goto(PORTAL.as_uri() + "?modo=" + modo)
        pg.click("#lnkIngresar")
        pg.wait_for_timeout(800)
        # La app deja la solicitud en el portapapeles; el marcador la lee de ahí.
        pg.evaluate("txt => navigator.clipboard.writeText(txt)", json.dumps(paquete_de_prueba()))
        pg.evaluate(codigo)
        pg.wait_for_timeout(1500)

        botones = pg.evaluate(BOTONES)
        if "Llenar y presentar en el portal" not in botones:
            print(f"  ✖ el panel no ofrece 'Llenar y presentar': {botones}")
            nav.close()
            return False
        pg.evaluate(DEL_PANEL + ".find(b=>b.textContent==='Llenar y presentar en el portal').click()")

        t0 = time.time()
        panel = ""
        for _ in range(150):
            pg.wait_for_timeout(1000)
            panel = pg.evaluate(PANEL)
            if "Falta el envío" in panel or "aceptando las marcas" in panel:
                break
        tardo = time.time() - t0
        marcadas = pg.evaluate(
            "[...document.querySelectorAll('.ui-chkbox-box.ui-state-active')].length")
        tipos = pg.evaluate("[...document.querySelectorAll('#tblFacturas select')]"
                            ".map(s=>s.value).filter(Boolean).length")
        procesados = pg.evaluate("[...document.querySelectorAll('#tblFacturas tr')].length - 1")

        if modo == "muerto":
            ok = "aceptando las marcas" in panel
            print(f"  {'✔' if ok else '✖'} cortó avisando ({tardo:.0f}s)"
                  if ok else f"  ✖ no cortó: {panel[-200:]}")
        else:
            ok = ("Falta el envío" in panel and "Marcados en el portal: 12 de 12" in panel
                  and tipos == procesados)
            print(f"  {'✔' if ok else '✖'} 12 de 12 marcados y clasificados, "
                  f"llegó al envío ({tardo:.0f}s)")
            if not ok:
                print("  panel:", panel[-600:])
        if errores:
            ok = False
            print("  ✖ errores en la página:", errores)
        # En la última página quedan 2 filas: las dos tienen que estar marcadas.
        if modo != "muerto" and marcadas != procesados:
            print(f"  ⚠ marcadas en pantalla: {marcadas} de {procesados}")
        nav.close()
        return ok


if __name__ == "__main__":
    modos = [sys.argv[1]] if len(sys.argv) > 1 else ["widget", "nativo", "muerto"]
    fuente = sys.argv[2] if len(sys.argv) > 2 else "min"
    print(f"Enviador-DEVOLUCIÓN contra el portal simulado ({fuente})")
    todo_bien = True
    for m in modos:
        print(f"— portal '{m}'")
        todo_bien = correr(m, fuente) and todo_bien
    sys.exit(0 if todo_bien else 1)
