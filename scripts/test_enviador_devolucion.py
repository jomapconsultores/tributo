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
    inicio       el portal recién abierto -> tiene que caminar el aviso legal,
                 la cuenta bancaria y el menú, y recién ahí trabajar
    semestral    periodo de dos meses -> una solicitud por mes, seguidas
    extension    solicitud inyectada como hace la extension -> corre SOLA
    traer        "Traer comprobantes al sistema" -> el listado viaja SOLO a la
                 app por la extension, y no se suelta hasta que ella lo ingresa
    traer_otro   lo mismo, pero el portal esta abierto con OTRA persona -> el
                 listado tiene que viajar a nombre de quien lo muestra, no del
                 de la solicitud que quedo del envio anterior
    auto         solicitud autorizada desde el sistema -> corre SOLA, sin click
    widget       el click va a la caja del checkbox   -> marca los 12
    nativo       la caja no escucha, sí el checkbox   -> marca los 12
    discapacidad la otra entrada, con el catálogo de tipo de gasto cambiado ->
                 tiene que elegir por la ETIQUETA, no por el código
    quejoso      el portal RECHAZA la selección       -> corta sin presentar
    otro         el portal abierto con otra persona   -> ni carga la solicitud
    sin_permiso  la llave del marcador está revocada  -> no hace nada, ni abre
                 el panel: el bajador no es de uso libre
    sin_rubro    un comprobante sin tipo de gasto     -> no toca el portal y dice
                 cuál falta (el combo del SRI no admite vacío)
    en_tramite   el mes YA tiene devolución presentada -> el portal no trae grilla,
                 hay que decirlo y avisarle al sistema para que lo marque
    cuentas      el contribuyente tiene DOS cuentas    -> se pregunta a cuál
                 acreditar en vez de tomar la primera
    cruzado      el marcador dentro de la app, con la solicitud de otro copiada
    muerto       no escucha nadie                     -> tiene que CORTAR y avisar

Necesita Playwright (pip install playwright && playwright install chromium).
"""
import http.server
import json
import pathlib
import sys
import threading
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


# Qué contesta el sistema cuando el marcador pide permiso. La prueba lo cambia
# para el caso en que el permiso está revocado.
PERMISO_OK = True


class PermisoFalso(http.server.BaseHTTPRequestHandler):
    """El sistema diciendo que sí. El marcador no trabaja sin este permiso.

    Se levanta acá porque el marcador REAL pregunta antes de tocar el portal, y
    una prueba que se saltara ese paso estaría probando otro marcador."""

    def do_POST(self):                                  # noqa: N802
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        cuerpo = (b'{"ok": true, "motivo": "ok"}' if PERMISO_OK else
                  '{"ok": false, "motivo": "revocada", "detalle": "Este marcador fue dado de baja."}'
                  .encode("utf-8"))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.end_headers()
        self.wfile.write(cuerpo)

    def do_OPTIONS(self):                               # noqa: N802
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.end_headers()

    def log_message(self, *_):
        return


def servidor_permiso():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), PermisoFalso)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


def codigo_del_marcador(fuente: str, api: str = "") -> str:
    if fuente == "src":
        js = FUENTE_JS.read_text(encoding="utf-8")
        codigo = js[js.index("(async () => {"):]
    else:
        url = TXT.read_text(encoding="utf-8").strip()
        codigo = unquote(url[len("javascript:"):])
    # Los huecos que la app rellena al generar el marcador: a dónde preguntar el
    # permiso y con qué llave.
    return codigo.replace("JOMAP_API", api).replace("JOMAP_LLAVE", "llave-de-prueba")


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


def paquete_discapacidad() -> dict:
    """La otra entrada del portal: personas con discapacidad.

    Mismo trámite y mismos nombres de gasto, pero el catálogo de esa grilla NUNCA
    se verificó contra el portal. Acá se lo simula con los códigos cambiados de
    lugar, que es lo peor plausible: elegir por código pondría "vivienda" donde
    va "alimentación" y el trámite saldría mal sin que nadie lo note."""
    p = paquete_de_prueba(auto=True)
    p["beneficiario"] = {"tipo": "discapacidad", "porcentaje_discapacidad": 75}
    p["totales"]["tope"] = 144.60
    p["detalle_meses"][0]["tope"] = 144.60
    return p


# Lo que hace la app al abrir la pantalla: publicar la llave de quien está
# autorizado, para que la extensión pueda pasársela al enviador.
PUBLICAR_LLAVE = (
    "a => window.postMessage({ tipo: 'jomap-bajadores-llave', "
    "llave: 'llave-de-prueba', api: a }, '*')"
)

PANEL = "(document.getElementById('jomap-enviador-devolucion')||{}).innerText||''"
DEL_PANEL = "[...document.querySelectorAll('#jomap-enviador-devolucion button')]"
BOTONES = DEL_PANEL + ".map(b=>b.textContent)"


def tocar(pg, patron: str) -> bool:
    """Toca el botón del panel cuyo texto casa con el patrón (regex JS)."""
    return pg.evaluate(
        "() => { const b = " + DEL_PANEL + f".find(x => {patron}.test((x.textContent||'').trim()));"
        " if (!b) return false; b.click(); return true; }")


def probar_traida(pg, ruc_esperado: str = "0912345678") -> bool:
    """El listado del portal tiene que viajar SOLO al sistema.

    Antes terminaba en el portapapeles y había que acordarse de pegarlo en la
    app: si la copia fallaba —o alguien cerraba la pestaña— el mes se perdía y
    había que volver a recorrer la grilla del SRI."""
    # Lo que la extensión le entrega a la app (el tramo de vuelta).
    pg.evaluate("""() => {
      window.__alaApp = [];
      window.addEventListener('message', (e) => {
        if (e.data && e.data.tipo === 'jomap-devolucion-comprobantes-app') window.__alaApp.push(e.data);
      });
    }""")
    if not tocar(pg, "/^Traer comprobantes al sistema$/"):
        print(f"  ✖ el panel no ofrece traer comprobantes: {pg.evaluate(BOTONES)}")
        print("  permiso:", pg.evaluate("window.__jomapApi || null"))
        return False
    pg.wait_for_timeout(600)
    if not tocar(pg, "/^2026$/"):
        print(f"  ✖ no ofreció el año: {pg.evaluate(BOTONES)}")
        return False
    pg.wait_for_timeout(1500)                      # el portal llena los meses por ajax
    if not tocar(pg, "/^julio$/i"):
        print(f"  ✖ no ofreció el mes: {pg.evaluate(BOTONES)}")
        return False

    panel = ""
    for _ in range(30):
        pg.wait_for_timeout(500)
        panel = pg.evaluate(PANEL)
        if "Ya viajaron al sistema" in panel or "Sin la extensión" in panel:
            break
    guardados = pg.evaluate("window.__guardados || []")
    ok = "Ya viajaron al sistema" in panel and "comprobantes" in guardados
    print(f"  {'✔' if ok else '✖'} el listado viaja solo (y el panel lo dice)")
    if not ok:
        print("  panel:", panel[-400:], "| guardados:", guardados)

    # La app pide lo que haya esperando al abrir la pantalla: navegar dentro de
    # la app no dispara ningún `focus`, y sin el pedido el listado se quedaría
    # guardado sin que nadie lo reclame.
    pg.evaluate("() => window.postMessage({ tipo: 'jomap-devolucion-comprobantes-pedido' }, '*')")
    pg.wait_for_timeout(600)
    entregas = pg.evaluate("window.__alaApp || []")
    b = (entregas[0] or {}).get("bulto") if entregas else None
    llego = bool(b) and len(b.get("filas") or []) == 12 and b.get("identificacion") == ruc_esperado
    print(f"  {'✔' if llego else '✖'} la extensión se lo entrega a la app "
          f"(12 filas, a nombre de {ruc_esperado})")
    if not llego:
        print("  entregas:", entregas)

    # Y no se suelta hasta que la app avisa que los ingresó: si se soltara al
    # entregarlos, volver a la pestaña en el momento equivocado —otra pantalla,
    # otro contribuyente— perdería el mes.
    pg.evaluate("() => window.postMessage({ tipo: 'jomap-devolucion-comprobantes-pedido' }, '*')")
    pg.wait_for_timeout(600)
    espera = len(pg.evaluate("window.__alaApp || []")) == 2
    print(f"  {'✔' if espera else '✖'} sigue esperando mientras la app no lo ingresa")

    pg.evaluate("() => window.postMessage({ tipo: 'jomap-devolucion-comprobantes-ingresados' }, '*')")
    pg.wait_for_timeout(400)
    pg.evaluate("() => window.postMessage({ tipo: 'jomap-devolucion-comprobantes-pedido' }, '*')")
    pg.wait_for_timeout(600)
    soltado = len(pg.evaluate("window.__alaApp || []")) == 2
    print(f"  {'✔' if soltado else '✖'} ingresado en la app, ya no se vuelve a entregar")

    return ok and llego and espera and soltado


def correr(modo: str, fuente: str) -> bool:
    global PERMISO_OK
    PERMISO_OK = modo != "sin_permiso"
    permiso_srv, permiso_url = servidor_permiso()
    codigo = codigo_del_marcador(fuente, permiso_url)
    try:
        return _correr(modo, codigo, permiso_url)
    finally:
        permiso_srv.shutdown()


def _correr(modo: str, codigo: str, permiso_url: str) -> bool:
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
        # 'traer' corre el mismo puente de la extensión, pero para el camino de
        # IDA de los comprobantes: el listado del portal hacia el sistema.
        # 'traer_otro': la grilla se trae con el portal abierto en un
        # contribuyente distinto al de la solicitud que quedó del envío
        # anterior. Los comprobantes son de quien los muestra: etiquetarlos con
        # el de la solicitud los mandaba a la ficha equivocada del sistema.
        traer_otro = modo == "traer_otro"
        traer = modo in ("traer", "traer_otro")
        extension = modo in ("extension", "traer", "traer_otro")
        semestral = modo == "semestral"
        # 'quejoso' marca bien pero el portal rechaza la selección al procesar:
        # corre en automático porque es ahí donde el rechazo hace daño —el
        # recorrido seguía de largo y presentaba como si nada—.
        quejoso = modo == "quejoso"
        # 'otro': el portal abierto con una persona distinta a la de la
        # solicitud copiada. Tiene que descartarla ANTES de tocar nada: acá el
        # desacuerdo lo canta el portal, no la app (que ni siquiera está).
        otro = modo == "otro"
        # 'discapacidad': la otra entrada del portal, con su catálogo de tipo de
        # gasto sin verificar.
        discapacidad = modo == "discapacidad"
        # 'cruzado': el marcador tocado DENTRO de la app, con el sistema abierto
        # en un contribuyente y el portapapeles trayendo la solicitud de otro.
        cruzado = modo == "cruzado"
        # 'sin_rubro': la solicitud llega con un comprobante sin clasificar. El
        # portal no admite el combo vacío, así que el trámite quedaría trabado a
        # mitad de camino: hay que cortar ANTES de tocar nada.
        sin_rubro = modo == "sin_rubro"
        # 'en_tramite': el portal contesta que ese período ya está presentado.
        en_tramite = modo == "en_tramite"
        # 'cuentas': dos cuentas bancarias registradas. A cuál se acredita la
        # devolución lo decide el contribuyente, no el orden de la tabla.
        cuentas = modo == "cuentas"
        # 'sin_permiso': la llave del marcador está revocada. No es un fallo del
        # portal: el marcador no debe hacer NADA, ni pintar su panel.
        sin_permiso = modo == "sin_permiso"
        # 'inicio': el portal recién abierto. El marcador tiene que caminar el
        # aviso legal, la cuenta bancaria y el menú de dos pasos antes de poder
        # trabajar; antes exigía que eso estuviera hecho a mano.
        inicio = modo == "inicio"
        auto = modo in ("auto", "extension", "semestral", "quejoso", "otro",
                        "discapacidad", "inicio", "sin_rubro", "en_tramite", "cuentas")
        propio = quejoso or otro or discapacidad or inicio or en_tramite or cuentas
        modo_portal = ("otro" if traer_otro
                       else modo if propio
                       else "widget" if (auto or cruzado or traer)
                       else modo)
        pg.goto(PORTAL.as_uri() + "?modo=" + modo_portal)
        # En 'inicio' y 'cuentas' NO se toca nada: el portal queda en el aviso
        # legal y es el marcador el que tiene que abrirse paso hasta la grilla.
        if not (inicio or cuentas):
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
                  // Chrome acepta una clave o una lista; el enviador pide dos
                  // de una (la solicitud y dónde vive el sistema).
                  get: (k, cb) => {
                    const claves = Array.isArray(k) ? k : [k];
                    const out = {};
                    claves.forEach((c) => { out[c] = datos[c]; });
                    cb(out);
                  },
                  remove: (k, cb) => { delete datos[k]; cb && cb(); },
                } },
                runtime: {
                  getURL: () => url,
                  // De acá saca la extensión dónde vive el sistema cuando
                  // todavía nadie abrió la app con ella puesta.
                  getManifest: () => ({
                    content_scripts: [{
                      js: ['contenido-app.js'],
                      matches: ['https://tributos.pensamiento-libre.org/*'],
                    }],
                  }),
                },
              };
            }""", (EXT / "enviador.js").as_uri())
            pg.evaluate((EXT / "contenido-app.js").read_text(encoding="utf-8"))
            # La llave viaja como en la vida real: la app la publica, la extensión
            # la guarda y se la pasa al enviador en el portal. Su copia del
            # enviador es igual para todos y no la lleva incrustada.
            pg.evaluate(PUBLICAR_LLAVE, permiso_url)
            pg.wait_for_timeout(300)
            pg.evaluate("p => window.postMessage({ tipo: 'jomap-devolucion-paquete', paquete: p }, '*')",
                        paquete_de_prueba(not traer))
            pg.wait_for_timeout(300)
            pg.evaluate((EXT / "contenido-sri.js").read_text(encoding="utf-8"))
        else:
            # La app deja la solicitud en el portapapeles; el marcador la lee de ahí.
            paquete = (paquete_semestral() if semestral
                       else paquete_discapacidad() if discapacidad
                       else paquete_de_prueba(auto))
            if sin_rubro:
                # Como llega del sistema cuando nadie revisó la propuesta de
                # tipo de gasto que hace la grilla del portal.
                paquete["items"][3]["rubro"] = ""
                paquete["items"][3]["rubro_sri"] = ""
                paquete["items"][3]["rubro_label"] = "Sin asignar"
            pg.evaluate("txt => navigator.clipboard.writeText(txt)", json.dumps(paquete))
        if cruzado:
            # Lo que publica la pantalla de devoluciones: a quién tiene abierto.
            pg.evaluate("() => { window.__jomapDevolucionContexto = {"
                        "identificacion: '1702086305',"
                        "nombre: 'JUDITH RODRIGUEZ', mes: 7, anio: 2026 }; }")
        if not extension:
            pg.evaluate(codigo)
        pg.wait_for_timeout(1500)

        if traer:
            ok = probar_traida(pg, "0400533824001" if traer_otro else "0912345678")
            if errores:
                ok = False
                print("  ✖ errores en la página:", errores)
            nav.close()
            return ok

        if sin_permiso:
            hay_panel = pg.evaluate("!!document.getElementById('jomap-enviador-devolucion')")
            texto = pg.evaluate("(document.body.innerText||'')")
            ok = (not hay_panel) and "Marcador no autorizado" in texto
            print(f"  {'✔' if ok else '✖'} no abre el panel y avisa que no está autorizado")
            if not ok:
                print("  panel:", hay_panel, "| texto:", texto[-300:])
            nav.close()
            return ok

        if cruzado or otro:
            panel = pg.evaluate(PANEL)
            marcadas = pg.evaluate(
                "[...document.querySelectorAll('.ui-chkbox-box.ui-state-active')].length")
            avisos = pg.evaluate("window.__constancias || []")
            # La solicitud ajena no se carga ni cuando el desacuerdo lo canta la
            # app ('cruzado') ni cuando lo canta el propio portal ('otro'): en
            # los dos casos el panel se queda en "traer los comprobantes" y
            # explica qué descartó. Antes, en el portal no había con qué
            # contradecir al portapapeles y el panel mostraba el nombre, los
            # comprobantes y los montos del contribuyente anterior.
            quien = "JUDITH RODRIGUEZ" if cruzado else "0400533824001"
            # El nombre ajeno SÍ aparece —el aviso explica de quién es lo que se
            # descartó—; lo que no puede aparecer es la solicitud cargada, que es
            # la cabecera con el monto y la lista de comprobantes.
            ok = ("IVA a solicitar" not in panel
                  and "Traer los comprobantes al sistema" in panel
                  and quien in panel                          # quién está abierto
                  and "No se carga" in panel and marcadas == 0
                  and not avisos)
            print(f"  {'✔' if ok else '✖'} no cargó la solicitud de otro contribuyente")
            if not ok:
                print("  panel:", panel[:600], "| marcadas:", marcadas, "| avisos:", avisos)
            nav.close()
            return ok

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
        elif inicio:
            # Que haya llegado hasta el final desde el aviso legal, sin que nadie
            # le abriera el camino.
            constancia = pg.evaluate("(document.getElementById('constancia')||{}).textContent||''")
            ok = ("Solicitud presentada" in panel and "Comprobantes: 12" in panel
                  and "realizada exitosamente" in constancia)
            print(f"  {'✔' if ok else '✖'} caminó el asistente desde el aviso legal y presentó "
                  f"({tardo:.0f}s)")
            if not ok:
                print("  panel:", panel[-500:])
        elif discapacidad:
            # Con los códigos cambiados de lugar, elegir por código pondría
            # VIVIENDA (el 4 de allá). Tiene que ir por la etiqueta y avisar que
            # el catálogo no es el que traíamos.
            valores = pg.evaluate("[...document.querySelectorAll('#tblFacturas select')]"
                                  ".map(s=>s.value)")
            etiquetas = pg.evaluate("[...document.querySelectorAll('#tblFacturas "
                                    ".ui-selectonemenu-label')].map(e=>e.textContent)")
            ok = ("Solicitud presentada" in panel
                  and bool(valores) and all(v == "2" for v in valores)
                  and all("alimentaci" in e.lower() for e in etiquetas)
                  and "catálogo del portal" in panel)
            print(f"  {'✔' if ok else '✖'} eligió por la etiqueta, no por el código, "
                  f"y lo avisó ({tardo:.0f}s)")
            if not ok:
                print("  valores:", valores, "| etiquetas:", etiquetas)
                print("  panel:", panel[-400:])
        elif cuentas:
            # Se detiene a preguntar y NO sigue solo: la cuenta es donde cae la
            # plata del contribuyente.
            botones = pg.evaluate(BOTONES)
            pregunta = ("A qué cuenta" in panel
                        and any("BANCO DE PRUEBA" in b for b in botones)
                        and any("BANCO DEL AUSTRO" in b for b in botones))
            print(f"  {'✔' if pregunta else '✖'} pregunta a qué cuenta acreditar")
            if not pregunta:
                print("  panel:", panel[:400], "| botones:", botones)
            ok = pregunta
            if pregunta:
                # Elegida la segunda, el recorrido sigue hasta presentar.
                tocar(pg, "/AUSTRO/")
                for _ in range(60):
                    pg.wait_for_timeout(1000)
                    panel = pg.evaluate(PANEL)
                    if "Solicitud presentada" in panel or "✖" in panel:
                        break
                siguio = "Solicitud presentada" in panel
                print(f"  {'✔' if siguio else '✖'} con la cuenta elegida, termina el trámite")
                if not siguio:
                    print("  panel:", panel[-400:])
                ok = ok and siguio
        elif en_tramite:
            # Nada marcado y el motivo dicho con todas las letras: ese mes ya
            # tiene devolución presentada y el portal no admite repetirla.
            avisos = pg.evaluate("window.__constancias || []")
            # Y se lo dice al sistema: el estado del período lo determina el
            # portal, no una marca a mano.
            aviso = (avisos[0] or {}).get("constancia") if avisos else {}
            ok = ("tiene una devolución en trámite" in panel
                  and marcadas == 0
                  and len(avisos) == 1 and (aviso or {}).get("ya_en_tramite") is True)
            print(f"  {'✔' if ok else '✖'} avisa que el período ya está presentado "
                  f"y se lo informa al sistema ({tardo:.0f}s)")
            if not ok:
                print("  panel:", panel[-400:], "| marcadas:", marcadas)
        elif sin_rubro:
            # Ni una casilla tocada: sin tipo de gasto el portal no deja
            # procesar, y descubrirlo a mitad del recorrido dejaba el trámite
            # marcado a medias y el panel sin explicar por qué.
            avisos = pg.evaluate("window.__constancias || []")
            ok = ("sin tipo de gasto" in panel
                  and "COMERCIAL PRUEBA 4" in panel
                  and marcadas == 0 and not avisos)
            print(f"  {'✔' if ok else '✖'} no tocó el portal: falta el tipo de gasto "
                  f"({tardo:.0f}s)")
            if not ok:
                print("  panel:", panel[-400:], "| marcadas:", marcadas)
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
                    # La fecha y los RUC salen de "Ver detalle", no de la
                    # confirmación: sin entrar ahí, la constancia llega coja.
                    provs = c.get("proveedores") or []
                    if not c.get("fecha_carga"):
                        vuelve = False
                        print("   ✖ la constancia volvió SIN la fecha de carga")
                    if len(provs) != 12 or not all(p.get("ruc") for p in provs):
                        vuelve = False
                        print(f"   ✖ RUC de proveedores en la constancia: {len(provs)} de 12")
                print(f"  {'✔' if vuelve else '✖'} la constancia vuelve a la app "
                      f"(solicitud_id + {len(avisos)} aviso(s))")
                if not vuelve:
                    print("   avisos:", avisos, "guardados:", guardados)
                ok = ok and vuelve
        if errores:
            ok = False
            print("  ✖ errores en la página:", errores)
        # En la última página quedan 2 filas: las dos tienen que estar marcadas.
        if (modo not in ("muerto", "otro", "sin_rubro", "en_tramite", "cuentas")
                and marcadas != procesados):
            print(f"  ⚠ marcadas en pantalla: {marcadas} de {procesados}")
        nav.close()
        return ok


if __name__ == "__main__":
    modos = [sys.argv[1]] if len(sys.argv) > 1 else ["semestral", "extension", "traer", "traer_otro",
                                                     "auto", "widget", "nativo", "discapacidad", "quejoso",
                                                     "cruzado", "inicio", "otro", "sin_rubro",
                                                     "en_tramite", "cuentas", "sin_permiso",
                                                     "muerto"]
    fuente = sys.argv[2] if len(sys.argv) > 2 else "min"
    print(f"Enviador-DEVOLUCIÓN contra el portal simulado ({fuente})")
    todo_bien = True
    for m in modos:
        print(f"— portal '{m}'")
        todo_bien = correr(m, fuente) and todo_bien
    sys.exit(0 if todo_bien else 1)
