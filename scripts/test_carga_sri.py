# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Prueba del archivo con el que se llena una declaración en el portal del SRI.

No toca Supabase ni el portal: solo la traducción de la declaración calculada al
JSON que lee el formulario en línea. Se puede correr en cualquier momento.

    python scripts/test_carga_sri.py

Lo que se comprueba:

  · cada casillero sale con el CONCEPTO del portal, no con su número
    (411 -> concepto460): mandar el número llenaría otro campo o ninguno;
  · lo que el portal calcula (casilleros de solo lectura) no se manda;
  · el valor bruto se completa con el neto cuando el sistema solo tiene uno;
  · lo que el sistema anota con un código de otro sentido (903 del ICE es
    "diferido que vence", en el SRI es interés por mora) NO se traslada, y se
    dice por qué;
  · el 103 va por concepto de retención a su par base/retenido.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

for _var, _val in (("SUPABASE_URL", "http://localhost"), ("SUPABASE_SERVICE_KEY", "x"),
                   ("SUPABASE_ANON_KEY", "x"), ("JWT_SECRET", "x")):
    os.environ.setdefault(_var, _val)

from services.carga_sri import CONCEPTOS, armar_carga           # noqa: E402
from services.declaracion import declaracion_103                 # noqa: E402
from routers.retenciones_efectuadas import CONCEPTOS_RENTA       # noqa: E402

fallos = []


def check(cond, que, detalle=""):
    print(("  ok  " if cond else "  FALLA ") + que + (f"  [{detalle}]" if detalle and not cond else ""))
    if not cond:
        fallos.append(que)


CLIENTE = {"identificacion": "1790000000001", "nombre": "Prueba S.A.", "periodicidad": "mensual",
           "periodo_mes": 8, "periodo_anio": 2026}


def decl(tipo, filas, resumen=None, cliente=None):
    return {"tipo": tipo, "filas": filas, "resumen": resumen or {}, "cliente": cliente or CLIENTE,
            "anio": 2026, "mes": 8, "periodo_label": "Agosto 2026"}


def f(seccion, codigo, valor):
    return {"seccion": seccion, "codigo": codigo, "concepto": codigo, "valor": valor}


print("\nTablas leídas del portal")
check(CONCEPTOS["IVA"]["411"] == ("460", True), "IVA 411 es concepto460, editable")
check(CONCEPTOS["IVA"]["601"] == ("2140", False), "IVA 601 lo calcula el SRI")
check(CONCEPTOS["ICE"]["303"] == ("140", True), "ICE 303 es concepto140")
check(CONCEPTOS["103"]["353"] == ("320", True), "103 353 es concepto320")
for tipo, tabla in CONCEPTOS.items():
    conceptos = [c for c, _ in tabla.values()]
    check(len(conceptos) == len(set(conceptos)), f"{tipo}: ningún concepto repetido")

print("\nIVA")
iva = armar_carga("IVA", decl("IVA", [
    f("VENTAS", "411", 1000), f("VENTAS", "421", 150), f("VENTAS", "413", 200),
    f("VENTAS", "414", 30), f("VENTAS", "415", 20), f("VENTAS", "412", 0),
    f("ADQUISICIONES", "510", 400), f("ADQUISICIONES", "520", 60),
    f("RESULTADO", "429", 150), f("RESULTADO", "563", 0.8333), f("RESULTADO", "564", 50),
    f("RESULTADO", "605", 12.5), f("RESULTADO", "609", 7), f("RESULTADO", "480", 9),
    f("AGENTE DE RETENCIÓN DEL IVA", "721", 3), f("AGENTE DE RETENCIÓN DEL IVA", "799", 3),
]))
det = iva["archivo"]["contenido"]["detallesDeclaracion"]
check(det.get("460") == "1000.00" and det.get("450") == "1000.00", "411 neto y 401 bruto con el mismo valor", det)
check(det.get("470") == "150.00", "421 IVA ventas")
check(det.get("1040") == "50.00" and det.get("1038") == "50.00", "exentas + no objeto suman en 441/431", det)
check("520" not in det, "ventas al 5% en cero no se mandan")
check(det.get("1280") == "400.00" and det.get("1270") == "400.00", "510 neto y 500 bruto")
check(det.get("2130") == "50.00" and det.get("2160") == "12.50" and det.get("2200") == "7.00", "564, 605 y 609 editables")
check(det.get("2515") == "3.00", "721 retención 10% como agente")
check("880" not in det and "2110" not in det and "2550" not in det, "429, 563 y 799 los calcula el SRI")
check({x["casillero"] for x in iva["calculados_por_el_sri"]} >= {"429", "563", "799"}, "y se listan como calculados")
check([x["codigo"] for x in iva["no_trasladados"]] == ["480"], "480 del sistema no se traslada", iva["no_trasladados"])
check(iva["obligacion"] == "2011" and iva["grupo"] == "IVA", "obligación 2011, grupo IVA")
check("identificadorGrupoObligacion=IVA" in iva["url"], "URL del formulario de IVA")
check(iva["contribuyente"]["identificacion"] == "1790000000001", "RUC del contribuyente")

semestral = armar_carga("IVA", decl("IVA", [f("VENTAS", "411", 10)],
                                    cliente={**CLIENTE, "periodicidad": "semestral", "periodo_semestre": 1}))
check(semestral["obligacion"] == "2021", "IVA semestral va por la obligación 2021")
check(semestral["archivo"]["nombre"].endswith("2026-S1.json"), "nombre del archivo semestral")

print("\nICE")
ice = armar_carga("ICE", decl("ICE", [
    f("AD VALOREM", "303", 500), f("AD VALOREM", "305", 0.75), f("AD VALOREM", "309", 375),
    f("ESPECÍFICO", "314", 12.3456), f("ESPECÍFICO", "315", 10.5), f("ESPECÍFICO", "319", 129.63),
    f("RESULTADO", "399", 504.63), f("RESULTADO", "R-50", 20), f("RESULTADO", "EXE", 5),
    f("RESULTADO", "499", 479.63), f("RESULTADO", "903", 40), f("RESULTADO", "904", 519.63),
]))
det = ice["archivo"]["contenido"]["detallesDeclaracion"]
check(det.get("140") == "500.00" and det.get("141") == "500.00", "303 bruto y 304 neto")
check(det.get("144") == "12.35" and det.get("145") == "12.35", "313/314 volumen")
check(det.get("143") == "375.00" and det.get("147") == "129.63", "309 y 319 causados")
check(det.get("415") == "5.00", "exención va a 326")
check("142" not in det and "146" not in det, "las tarifas 305/315 las pone el SRI")
check("190" not in det and "200" not in det, "903/904 del sistema no llenan interés ni multa")
check(sorted(x["codigo"] for x in ice["no_trasladados"]) == ["903", "904", "R-50"],
      "R-50, 903 y 904 quedan explicados", ice["no_trasladados"])
check(ice["obligacion"] == "3031", "obligación 3031 bebidas alcohólicas")

print("\n103")
filas = [
    {"estado": "OK", "base_renta": 1000, "ret_renta": 100, "concepto_renta": "Honorarios profesionales y dietas (persona natural)"},
    {"estado": "OK", "base_renta": 500, "ret_renta": 10, "concepto_renta": "Transferencia de bienes muebles de naturaleza corporal"},
    {"estado": "OK", "base_renta": 200, "ret_renta": 4, "concepto_renta": "Transferencia de bienes muebles de naturaleza corporal"},
    {"estado": "OK", "base_renta": 100, "ret_renta": 5, "concepto_renta": "Otras retenciones aplicables 5%"},
    {"estado": "OK", "base_renta": 100, "ret_renta": 10, "concepto_renta": "Otras retenciones aplicables 10%"},
    {"estado": "OK", "base_renta": 80, "ret_renta": 8, "concepto_renta": "Otro concepto (especificar)"},
]
r103 = armar_carga("103", {**declaracion_103(filas, 2026, 8), "cliente": CLIENTE, "anio": 2026, "mes": 8},
                   CONCEPTOS_RENTA)
det = r103["archivo"]["contenido"]["detallesDeclaracion"]
check(det.get("310") == "1000.00" and det.get("320") == "100.00", "honorarios 303/353")
check(det.get("870") == "700.00" and det.get("880") == "14.00", "bienes muebles suma 312/362")
check(det.get("1485") == "200.00" and det.get("1495") == "15.00", "5% y 10% en otros porcentajes 346/396")
check("1500" not in det and "2010" not in det, "349 y 499 los calcula el SRI")
check(len(r103["no_trasladados"]) == 1 and "Otro concepto" in r103["no_trasladados"][0]["descripcion"],
      "el concepto libre se deja para elegir a mano", r103["no_trasladados"])
check(r103["grupo"] == "RETENC" and r103["obligacion"] == "1031", "grupo RETENC, obligación 1031")

print("\n" + ("TODO OK" if not fallos else f"{len(fallos)} FALLA(S)"))
sys.exit(1 if fallos else 0)
