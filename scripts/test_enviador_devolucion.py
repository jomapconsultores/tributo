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
    semestral  periodo de dos meses -> una solicitud por mes, seguidas
    extension  solicitud inyectada como hace la extension -> corre SOLA
    auto    solicitud autorizada desde el sistema -> corre SOLA, sin un click
    widget  el click va a la caja del checkbox     -> tiene que marcar los 12
    nativo  la caja no escucha, sí el checkbox     -> tiene que marcar los 12
    muerto  no escucha nadie                       -> tiene que CORTAR y avisar

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
EXT = RAIZ / "extension"

SERIES = ["003-301-0000891%02d" % (n + 10) for n in range(1, 13)]          # julio
SERIES_JUNIO = ["003-301-0000892%02d" % (n + 10) for n in range(1, 5)]    # junio


def codigo_del_marcador(fuente: str) -> str:
    if fuente == "src":
        js = FUENTE_JS.read_text(encoding="utf-8")
        return js[js.index("(async () => {"):]
    url = TXT.read_text(encoding="utf-8").strip()
    return unquote(url[len("javascript:"):])


def paquete_semestral() -> dict:
    """Un período de dos meses: el portal pide UNA solicitud por cada uno.

    Es el caso que obligaba a repetir el trámite a mano tantas veces como meses
    tuviera el período."""
    p = paquete_de_prueba(auto=True)
    junio = []
    for n, serie in enumerate(SERIES_JUNIO, start=1):
        junio.append({
            "clave_acceso": ("j%d" % n).rjust(49, "0"),
            "serie": serie,
            "fecha": f"{n:02d}/06/2026",
            "ruc_proveedor": "0999999999001",
            "proveedor": f"COMERCIAL JUNIO {n} SA",
            "rubro": "alimentacion", "rubro_label": "Alimentación", "rubro_sri": "4",
            "base": 10.0, "iva": 2.0 + n, "total": 12.0 + n,
        })
    ivaJun = round(sum(i["iva"] for i in junio), 2)
    ivaJul = round(sum(i["iva"] for i in p["items"]), 2)
    p["items"] = junio + p["items"]
    p["periodo"] = {"mes": 6, "anio": 2026, "periodicidad": "semestral",
                    "semestre": 1, "etiqueta": "1er semestre 2026"}
    p["detalle_meses"] = [
        {"mes": 6, "comprobantes": len(junio), "iva": ivaJun, "tope": 361.50,
         "solicitar": ivaJun, "excedente": 0},
        {"mes": 7, "comprobantes": len(SERIES), "iva": ivaJul, "tope": 361.50,
         "solicitar": ivaJul, "excedente": 0},
    ]
    p["totales"] = {"base": 0, "iva": ivaJun + ivaJul, "tope": 361.50,
                    "solicitado": ivaJun + ivaJul}
    return p


def paquete_de_prueba(auto: bool = False) -> dict:
    """Lo mismo que entrega GET /devoluciones-iva/solicitudes/{id}/envio.

    `auto` es la marca que pone la app cuando el usuario autoriza el envio
    desde el sistema: con ella el marcador arranca solo, sin tocar nada."""
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
        "auto": auto,
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

        # 'auto' no es una variante del portal sino del paquete: corre sobre el
        # portal normal, pero con la solicitud ya autorizada desde el sistema.
        # 'extension' entrega la solicitud como lo hace la extensión de Chrome:
        # inyectada en la página, sin pasar por el portapapeles.
        extension = modo == "extension"
        semestral = modo == "semestral"
        # 'quejoso' marca bien pero el portal rechaza la selección al procesar:
        # corre en automático porque es ahí donde el rechazo hace daño —el
        # recorrido seguía de largo y presentaba como si nada—.
        quejoso = modo == "quejoso"
        # 'otro': el portal abierto con una persona distinta a la de la
        # solicitud. Tiene que cortar ANTES de tocar nada.
        otro = modo == "otro"
        auto = modo in ("auto", "extension", "semestral", "quejoso", "otro")
        propio = quejoso or otro
        pg.goto(PORTAL.as_uri() + "?modo=" +
                (modo if propio else ("widget" if auto else modo)))
        pg.click("#lnkIngresar")
        # Lo que el enviador le manda de vuelta a la app al terminar. Se escucha
        # en todos los modos: es la única prueba de que el trámite hecho en el
        # portal llega a marcarse como presentado en el sistema.
        pg.evaluate("""() => {
          window.__constancias = [];
          window.addEventListener('message', (e) => {
            if (e.data && e.data.tipo === 'jomap-devolucion-constancia' && e.data.constancia) {
              window.__constancias.push(e.data);
            }
          });
        }""")
        pg.wait_for_timeout(800)
        if extension:
            # Se corren los scripts DE VERDAD de la extension, con las APIs de
            # Chrome simuladas: asi se prueba el puente app -> almacenamiento ->
            # portal, que es donde puede romperse sin que nadie lo note.
            pg.evaluate("""(url) => {
              const datos = {};
              // Qué se guardó y qué constancias viajaron: es lo que se mira al
              // final para saber si el camino de vuelta (portal -> app) existe.
              window.__guardados = [];
              window.chrome = {
                storage: { local: {
                  set: (o, cb) => {
                    Object.keys(o).forEach((k) => window.__guardados.push(k));
                    Object.assign(datos, o); cb && cb();
                  },
                  get: (k, cb) => cb({ [k]: datos[k] }),
                  remove: (k, cb) => { delete datos[k]; cb && cb(); },
                } },
                runtime: { getURL: () => url },
              };
            }""", (EXT / "enviador.js").as_uri())
            pg.evaluate((EXT / "contenido-app.js").read_text(encoding="utf-8"))
            pg.evaluate("p => window.postMessage({ tipo: 'jomap-devolucion-paquete', paquete: p }, '*')",
                        paquete_de_prueba(True))
            pg.wait_for_timeout(300)
            pg.evaluate((EXT / "contenido-sri.js").read_text(encoding="utf-8"))
        else:
            # La app deja la solicitud en el portapapeles; el marcador la lee de ahí.
            paquete = paquete_semestral() if semestral else paquete_de_prueba(auto)
            pg.evaluate("txt => navigator.clipboard.writeText(txt)", json.dumps(paquete))
        if not extension:
            pg.evaluate(codigo)
        pg.wait_for_timeout(1500)

        # Con la solicitud autorizada desde el sistema no se toca NADA: el
        # marcador tiene que estar trabajando desde que se abrió.
        if not auto:
            botones = pg.evaluate(BOTONES)
            if "Llenar y presentar en el portal" not in botones:
                print(f"  ✖ el panel no ofrece 'Llenar y presentar': {botones}")
                nav.close()
                return False
            pg.evaluate(DEL_PANEL + ".find(b=>b.textContent==='Llenar y presentar en el portal').click()")

            # Sin autorizar desde el sistema, la pide el propio marcador.
            pg.wait_for_timeout(500)
            autorizar = "Sí, presentar automáticamente"
            if autorizar not in pg.evaluate(BOTONES):
                print(f"  ✖ no apareció la autorización: {pg.evaluate(BOTONES)}")
                nav.close()
                return False
            pg.evaluate(DEL_PANEL + f".find(b=>b.textContent==={json.dumps(autorizar)}).click()")

        t0 = time.time()
        panel = ""
        for _ in range(150):
            pg.wait_for_timeout(1000)
            panel = pg.evaluate(PANEL)
            if ("Solicitud presentada" in panel or "Meses presentados" in panel
                    or "aceptando las marcas" in panel or "Terminó con problemas" in panel
                    or "el portal no aceptó" in panel or "No presento nada" in panel):
                break
        tardo = time.time() - t0
        marcadas = pg.evaluate(
            "[...document.querySelectorAll('.ui-chkbox-box.ui-state-active')].length")
        tipos = pg.evaluate("[...document.querySelectorAll('#tblFacturas select')]"
                            ".map(s=>s.value).filter(Boolean).length")
        procesados = pg.evaluate("[...document.querySelectorAll('#tblFacturas tr')].length - 1")

        if semestral:
            # Dos meses seguidos: 4 comprobantes de junio y 12 de julio, cada uno
            # con su vuelta completa por el portal.
            ok = ("Meses presentados" in panel and "Junio: 4 comprobante" in panel
                  and "Julio: 12 comprobante" in panel)
            print(f"  {'✔' if ok else '✖'} dos meses presentados en una corrida ({tardo:.0f}s)")
            if not ok:
                print("  panel:", panel[-700:])
            # Seis meses en el portal son UNA solicitud en el sistema: la
            # constancia que vuelve tiene que venir sumada, o el reporte diría
            # que se presentó solo el último mes.
            avisos = pg.evaluate("window.__constancias || []")
            c = (avisos[0].get("constancia") or {}) if avisos else {}
            suma = (c.get("comprobantes") == 16 and c.get("meses") == 2
                    and "exitosamente" in (c.get("mensaje") or ""))
            print(f"  {'✔' if suma else '✖'} la constancia vuelve sumada (4+12 comprobantes)")
            if not suma:
                print("   avisos:", avisos)
            ok = ok and suma
        elif otro:
            # Ni una casilla tocada: presentar la solicitud de uno dentro de la
            # sesión de otro es declarar a nombre equivocado. Antes el marcador
            # ni miraba quién había abierto el portal.
            avisos = pg.evaluate("window.__constancias || []")
            ok = ("No presento nada" in panel
                  and "0400533824001" in panel and "0912345678" in panel
                  and marcadas == 0 and not avisos)
            print(f"  {'✔' if ok else '✖'} no tocó nada: el portal está con otra persona "
                  f"({tardo:.0f}s)")
            if not ok:
                print("  panel:", panel[-500:], "| marcadas:", marcadas, "| avisos:", avisos)
        elif quejoso:
            # Lo que importa: que corte con el texto del SRI, que no presente y
            # que NO le avise a la app. Antes seguía de largo, pintaba
            # "Selección guardada" y terminaba marcando como presentado un
            # trámite que el portal había rechazado entero.
            constancia = pg.evaluate("(document.getElementById('constancia')||{}).textContent||''")
            avisos = pg.evaluate("window.__constancias || []")
            ok = ("el portal no aceptó" in panel
                  and "no detalla el tipo de gasto" in panel
                  and "realizada exitosamente" not in constancia
                  and not avisos)
            print(f"  {'✔' if ok else '✖'} cortó con el reclamo del portal, sin presentar "
                  f"ni avisar a la app ({tardo:.0f}s)")
            if not ok:
                print("  panel:", panel[-500:], "| avisos:", avisos,
                      "| quejas en el DOM:",
                      pg.evaluate("[...document.querySelectorAll('.ui-messages-error')]"
                                  ".map(n=>[n.innerText,n.offsetParent!==null])"))
        elif modo == "muerto":
            ok = "aceptando las marcas" in panel
            print(f"  {'✔' if ok else '✖'} cortó avisando ({tardo:.0f}s)"
                  if ok else f"  ✖ no cortó: {panel[-200:]}")
        else:
            # El portal simulado escribe su constancia al recibir la carga: es la
            # prueba de que el recorrido llegó de verdad hasta el final.
            constancia = pg.evaluate("(document.getElementById('constancia')||{}).textContent||''")
            # Al presentar, el panel pasa a mostrar la constancia y reemplaza la
            # bitácora: se comprueba sobre lo que queda —cuántos presentó, que el
            # portal acusó recibo, y que las filas quedaron con su tipo de gasto—.
            ok = ("Solicitud presentada" in panel and "Comprobantes: 12" in panel
                  and "realizada exitosamente" in constancia and tipos == procesados)
            print(f"  {'✔' if ok else '✖'} 12 de 12 marcados y clasificados, presentados "
                  f"y con constancia ({tardo:.0f}s)")
            if not ok:
                print("  panel:", panel[-600:])
            if extension:
                # El camino de vuelta: sin esto el trámite queda hecho en el SRI
                # y la solicitud sigue en Borrador en el sistema, que es
                # exactamente el agujero que se tapó el 2026-08-16.
                avisos = pg.evaluate("window.__constancias || []")
                guardados = pg.evaluate("window.__guardados || []")
                buena = next((a for a in avisos
                              if (a.get("constancia") or {}).get("mensaje")), None)
                vuelve = bool(buena) and "constancia" in guardados
                if vuelve:
                    c = buena["constancia"]
                    vuelve = (c.get("comprobantes") == 12 and buena.get("solicitud_id")
                              and "exitosamente" in c.get("mensaje", ""))
                print(f"  {'✔' if vuelve else '✖'} la constancia vuelve a la app "
                      f"(solicitud_id + {len(avisos)} aviso(s))")
                if not vuelve:
                    print("   avisos:", avisos, "guardados:", guardados)
                ok = ok and vuelve
        if errores:
            ok = False
            print("  ✖ errores en la página:", errores)
        # En la última página quedan 2 filas: las dos tienen que estar marcadas.
        if modo not in ("muerto", "otro") and marcadas != procesados:
            print(f"  ⚠ marcadas en pantalla: {marcadas} de {procesados}")
        nav.close()
        return ok


if __name__ == "__main__":
    modos = [sys.argv[1]] if len(sys.argv) > 1 else ["semestral", "extension", "auto", "widget",
                                                     "nativo", "quejoso", "otro", "muerto"]
    fuente = sys.argv[2] if len(sys.argv) > 2 else "min"
    print(f"Enviador-DEVOLUCIÓN contra el portal simulado ({fuente})")
    todo_bien = True
    for m in modos:
        print(f"— portal '{m}'")
        todo_bien = correr(m, fuente) and todo_bien
    sys.exit(0 if todo_bien else 1)
