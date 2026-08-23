"""El listado del portal entra al sistema de una, sin copiar ni pegar.

POR QUÉ EXISTE: traer la grilla del SRI era la mitad del trabajo. Sin la
extensión instalada, el enviador la dejaba en el PORTAPAPELES y había que ir a
la app y tocar "Pegar comprobantes del portal"; si la copia fallaba —o alguien
cerraba la pestaña— el mes se perdía y había que recorrer la grilla otra vez.
Ahora el botón se lo entrega al sistema: abre esa pestaña y le pasa el listado.

Acá se prueba ese ida y vuelta DE VERDAD, con dos orígenes distintos (dos
servidores locales en puertos separados), que es lo que obliga a que el
`postMessage` sea cross-origin como en la vida real:

    portal  http://127.0.0.1:A/portal_devolucion_falso.html
    sistema http://127.0.0.1:B/devoluciones-iva/tercera-edad

`scripts/app_falsa_devolucion.html` hace de pantalla del sistema: replica su
contrato —pedirle el listado a quien la abrió, aceptarlo solo del portal y
contestar si entró—, sin backend.

    python scripts/test_entrega_al_sistema.py         # las dos variantes
    python scripts/test_entrega_al_sistema.py otro    # una sola

Variantes:
    entrega   el sistema abierto en el contribuyente del portal -> entra
    tarde     la pantalla tarda en engancharse y NO pide nada (cayó antes en la
              clave o en elegir contribuyente) -> el listado se ofrece hasta que
              alguien lo toma, en vez de perderse
    otro      el sistema abierto en OTRA persona -> el sistema lo rechaza y el
              enviador lo dice (el listado no se pierde: sigue en el panel)

Necesita Playwright (pip install playwright && playwright install chromium).
"""
import functools
import http.server
import json
import pathlib
import sys
import threading
from urllib.parse import unquote

from playwright.sync_api import sync_playwright

RAIZ = pathlib.Path(__file__).resolve().parent.parent
TXT = RAIZ / "frontend/src/utils/enviador-devolucion.bookmarklet.txt"
FUENTE_JS = RAIZ / "sri_downloader/bookmarklet_devolucion.js"
APP_FALSA = RAIZ / "scripts/app_falsa_devolucion.html"

IDENT_PORTAL = "0912345678"          # a quien muestra abierto el portal falso
IDENT_ABIERTO = ""                   # a quien tiene abierto el sistema simulado
DEMORA_MS = 0                        # cuánto tarda el sistema en enganchar


def codigo_del_marcador(fuente: str) -> str:
    if fuente == "src":
        js = FUENTE_JS.read_text(encoding="utf-8")
        return js[js.index("(async () => {"):]
    url = TXT.read_text(encoding="utf-8").strip()
    return unquote(url[len("javascript:"):])


class ManejadorApp(http.server.BaseHTTPRequestHandler):
    """Cualquier ruta devuelve la pantalla simulada del sistema.

    El enviador abre `/devoluciones-iva/tercera-edad`, que en la app real es una
    ruta del router; un servidor de archivos daría 404."""

    def do_GET(self):                                   # noqa: N802 (API de la clase)
        # A quién tiene abierto el sistema se lo dice el servidor: el enviador
        # abre una ruta fija y no hay dónde poner un query string.
        cuerpo = ("<script>window.__identAbierto = %s; window.__demora = %d;</script>"
                  % (json.dumps(IDENT_ABIERTO), DEMORA_MS)
                  + APP_FALSA.read_text(encoding="utf-8")).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.end_headers()
        self.wfile.write(cuerpo)

    def log_message(self, *_):                          # sin ruido en la consola
        return


def servir(handler) -> tuple:
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    hilo = threading.Thread(target=srv.serve_forever, daemon=True)
    hilo.start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


def correr(modo: str, fuente: str) -> bool:
    global IDENT_ABIERTO, DEMORA_MS
    # 'otro': el sistema está abierto en una persona distinta a la del portal.
    IDENT_ABIERTO = "1702086305" if modo == "otro" else ""
    # 'tarde': la pantalla engancha recién a los 8 segundos y NO pide nada, como
    # cuando la pestaña cae primero en la clave o en elegir contribuyente.
    DEMORA_MS = 8000 if modo == "tarde" else 0
    codigo = codigo_del_marcador(fuente)
    # El portal falso se sirve por HTTP (no file://) para que tenga un origen
    # de verdad: es lo que hace que el `postMessage` entre ventanas se comporte
    # como en el SRI.
    portal_srv, portal_url = servir(
        functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(RAIZ / "scripts")))
    app_srv, app_url = servir(ManejadorApp)
    ok = True
    try:
        with sync_playwright() as p:
            nav = p.chromium.launch(headless=True)
            ctx = nav.new_context(permissions=["clipboard-read", "clipboard-write"])
            pg = ctx.new_page()
            errores = []
            pg.on("pageerror", lambda e: errores.append("PAGEERROR: " + str(e)))

            pg.goto(portal_url + "/portal_devolucion_falso.html?modo=widget")
            pg.click("#lnkIngresar")
            # Lo que la extensión inyecta en el portal cuando está instalada. Sin
            # extensión llega incrustado en el marcador; el enviador lee la misma
            # variable, así que la prueba vale para los dos caminos.
            pg.evaluate("o => { window.__jomapAppOrigen = o; }", app_url)
            pg.evaluate(codigo)
            pg.wait_for_timeout(1200)

            panel = "#jomap-enviador-devolucion"
            pg.click(f"{panel} button:has-text('Traer comprobantes al sistema')")
            pg.wait_for_timeout(600)
            pg.click(f"{panel} button:text-matches('^2026$')")
            pg.wait_for_timeout(1500)                   # el portal llena los meses por ajax
            pg.click(f"{panel} button:text-matches('^julio$', 'i')")

            # Los botones aparecen DESPUÉS de intentar la entrega por la
            # extensión (que acá no está y tarda su espera en darse por vencida).
            botones = []
            for _ in range(40):
                pg.wait_for_timeout(500)
                botones = pg.evaluate(
                    f"[...document.querySelectorAll('{panel} button')].map(b => b.textContent)")
                if "Enviar al sistema" in botones:
                    break
            if "Enviar al sistema" not in botones:
                print(f"  ✖ el panel no ofrece enviar al sistema: {botones}")
                print("  panel:", pg.evaluate(f"document.querySelector('{panel}').innerText")[-600:])
                nav.close()
                return False

            # El clic va con el mouse de verdad: `window.open` necesita que el
            # navegador vea un gesto del usuario, y un .click() por código no lo es.
            with pg.context.expect_page() as nueva:
                pg.click(f"{panel} button:has-text('Enviar al sistema')")
            app = nueva.value
            app.wait_for_load_state()
            pg.wait_for_timeout(1500)

            if modo == "tarde":
                pg.wait_for_timeout(12000)              # que la pantalla llegue a engancharse
            recibidos = app.evaluate("window.__recibidos || []")
            estado = app.evaluate("(document.getElementById('estado')||{}).textContent||''")
            texto = pg.evaluate(f"document.querySelector('{panel}').innerText")
            bulto = (recibidos[0] or {}).get("bulto") if recibidos else None

            llego = bool(bulto) and len(bulto.get("filas") or []) == 12
            print(f"  {'✔' if llego else '✖'} el listado llegó al sistema sin pasar por el portapapeles")
            if not llego:
                print("  recibidos:", recibidos)
            ok = ok and llego

            # Y el sistema es el que dice de quién es: viaja con la cédula que
            # muestra el portal, no con la del último envío.
            suyo = bool(bulto) and str(bulto.get("identificacion") or "") == IDENT_PORTAL
            print(f"  {'✔' if suyo else '✖'} viaja a nombre de quien abrió el portal ({IDENT_PORTAL})")
            ok = ok and suyo

            if modo == "otro":
                # Rechazado por el sistema: el enviador tiene que decir por qué,
                # no dar por bueno un viaje que no terminó.
                dice = "otro contribuyente" in texto and "rechazado" in estado
                print(f"  {'✔' if dice else '✖'} el enviador avisa que hay otro contribuyente abierto")
                if not dice:
                    print("  panel:", texto[-300:], "| app:", estado)
                ok = ok and dice

                # Y no lo suelta: al abrir en el sistema a quien corresponde,
                # entra solo. Antes había que volver al portal y empezar de nuevo.
                app.evaluate("i => { window.__identAbierto = i; }", IDENT_PORTAL)
                app.wait_for_timeout(4000)
                estado2 = app.evaluate("(document.getElementById('estado')||{}).textContent||''")
                texto2 = pg.evaluate(f"document.querySelector('{panel}').innerText")
                entra = estado2.startswith("ingresados") and "entraron en el sistema" in texto2
                print(f"  {'✔' if entra else '✖'} al abrir al contribuyente correcto, entran solos")
                if not entra:
                    print("  panel:", texto2[-300:], "| app:", estado2)
                ok = ok and entra
            else:
                entraron = "entraron en el sistema" in texto and estado.startswith("ingresados")
                print(f"  {'✔' if entraron else '✖'} el enviador confirma que entraron")
                if not entraron:
                    print("  panel:", texto[-300:], "| app:", estado)
                ok = ok and entraron

            if errores:
                ok = False
                print("  ✖ errores en la página:", errores)
            nav.close()
    finally:
        portal_srv.shutdown()
        app_srv.shutdown()
    return ok


if __name__ == "__main__":
    modos = [sys.argv[1]] if len(sys.argv) > 1 else ["entrega", "tarde", "otro"]
    fuente = sys.argv[2] if len(sys.argv) > 2 else "min"
    print(f"Entrega directa del listado al sistema ({fuente})")
    todo_bien = True
    for m in modos:
        print(f"— {m}")
        todo_bien = correr(m, fuente) and todo_bien
    sys.exit(0 if todo_bien else 1)
