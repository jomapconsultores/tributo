# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""El cruce mes a mes entre los honorarios del sistema y las facturas de Odoo.

POR QUÉ EXISTE: la pantalla de facturación mostraba los honorarios de un
contribuyente sin decir a qué mes correspondían, y los meses que quedaron sin
facturar no se distinguían del mes en curso. Todo aparecía junto. El cruce es
el que separa: cada mes se compara contra lo que Odoo realmente emitió y sale
con un veredicto (cuadra / difiere / sin facturar / solo en Odoo).

Lo que se prueba acá es ese veredicto, que es donde una equivocación se paga
caro: dar por facturado un mes que no lo está deja el honorario sin cobrar, y
declarar pendiente uno ya emitido lleva a facturar dos veces.

    cd backend && ./venv/Scripts/python.exe ../scripts/test_cruce_odoo.py
"""
import asyncio
import io
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import routers.odoo_factura as of                          # noqa: E402

fallos = []


def check(nombre, esperado, obtenido):
    ok = esperado == obtenido
    print(f"  {'✓' if ok else '✗'} {nombre}")
    if not ok:
        print(f"      esperado: {esperado}")
        print(f"      obtenido: {obtenido}")
        fallos.append(nombre)


# --- Escenario -------------------------------------------------------------
# Dos contribuyentes, cuatro situaciones distintas repartidas en los meses.
HOY = of.datetime.now(of._EC_TZ_ODOO)


def _mes_atras(n):
    t = (HOY.year * 12 + HOY.month - 1) - n
    a, m = divmod(t, 12)
    return a, m + 1


A_ACT, M_ACT = HOY.year, HOY.month          # mes en curso
A_1, M_1 = _mes_atras(1)                    # mes anterior
A_2, M_2 = _mes_atras(2)
A_3, M_3 = _mes_atras(3)

CLIENTES = [
    {"identificacion": "0102030405001", "nombre": "ALFA CIA LTDA"},
    {"identificacion": "0908070605001", "nombre": "BETA S.A."},
]

# reportes_honorarios: valor SIN IVA salvo que iva_incluido=True
HONORARIOS = [
    # ALFA: mes en curso $30 + IVA = 34.50 → facturado igual → cuadra
    {"identificacion": "0102030405001", "producto": "Declaración IVA", "cobrar": True,
     "valor": 30.0, "iva_incluido": False, "mes": M_ACT, "anio": A_ACT},
    # ALFA: hace un mes $20 + IVA = 23.00 → sin factura → pendiente
    {"identificacion": "0102030405001", "producto": "Declaración IVA", "cobrar": True,
     "valor": 20.0, "iva_incluido": False, "mes": M_1, "anio": A_1},
    # ALFA: hace dos meses $20 + IVA = 23.00 → facturado 30.00 → difiere
    {"identificacion": "0102030405001", "producto": "Declaración IVA", "cobrar": True,
     "valor": 20.0, "iva_incluido": False, "mes": M_2, "anio": A_2},
    # BETA: marcado como NO cobrar → no entra al cruce
    {"identificacion": "0908070605001", "producto": "Anexo PVP+ICE", "cobrar": False,
     "valor": 50.0, "iva_incluido": False, "mes": M_ACT, "anio": A_ACT},
]

# Facturas en Odoo, por RUC y por mes
FACTURAS = {
    "0102030405001": {
        f"{A_ACT:04d}-{M_ACT:02d}": [{"numero": "F-1", "fecha": f"{A_ACT:04d}-{M_ACT:02d}-05",
                                      "total": 34.50, "autorizada": True, "autorizacion": "99",
                                      "estado_pago": "paid", "pagada": True, "por_cobrar": 0.0,
                                      "empresa": "CMAJ"}],
        f"{A_2:04d}-{M_2:02d}": [{"numero": "F-0", "fecha": f"{A_2:04d}-{M_2:02d}-28",
                                  "total": 30.00, "autorizada": True, "autorizacion": "98",
                                  "estado_pago": "not_paid", "pagada": False, "por_cobrar": 30.0,
                                  "empresa": "CMAJ"}],
    },
    # BETA tiene una factura sin honorario registrado → solo en Odoo
    "0908070605001": {
        f"{A_3:04d}-{M_3:02d}": [{"numero": "F-9", "fecha": f"{A_3:04d}-{M_3:02d}-15",
                                  "total": 11.20, "autorizada": False, "autorizacion": None,
                                  "estado_pago": "not_paid", "pagada": False, "por_cobrar": 11.2,
                                  "empresa": "CMAJ"}],
    },
}

# --- Sustitutos de las dependencias externas -------------------------------
of.visible_clients = lambda user_id, cols: CLIENTES
of.get_supabase_client = lambda: None
of.fetch_all = lambda q: HONORARIOS
of.facturas_por_mes_por_ruc = lambda idents, a, m: FACTURAS

print("\nCruce mensual: honorarios del sistema ↔ facturas de Odoo")
r = of._cruce_mensual(12, "usuario-de-prueba")

por_ruc = {c["ruc"]: {m["clave"]: m for m in c["meses"]} for c in r["data"]}
alfa = por_ruc.get("0102030405001", {})
beta = por_ruc.get("0908070605001", {})

k_act = f"{A_ACT:04d}-{M_ACT:02d}"
k_1 = f"{A_1:04d}-{M_1:02d}"
k_2 = f"{A_2:04d}-{M_2:02d}"
k_3 = f"{A_3:04d}-{M_3:02d}"

print("\nVeredicto por mes")
check("mes en curso con factura del mismo monto → cuadra",
      "cuadra", alfa.get(k_act, {}).get("estado"))
check("honorario del IVA se compara con IVA incluido (30 + 15%)",
      34.50, alfa.get(k_act, {}).get("registrado"))
check("mes anterior con honorario y sin factura → pendiente",
      "pendiente", alfa.get(k_1, {}).get("estado"))
check("mes con factura de monto distinto → difiere",
      "difiere", alfa.get(k_2, {}).get("estado"))
check("la diferencia se informa firmada (Odoo − sistema)",
      7.00, alfa.get(k_2, {}).get("diferencia"))
check("factura sin honorario registrado → solo en Odoo",
      "solo_odoo", beta.get(k_3, {}).get("estado"))
check("un honorario NO marcado para cobrar no entra al cruce",
      None, beta.get(k_act))
check("los meses sin honorario ni factura no ensucian la lista",
      {k_act, k_1, k_2}, set(alfa.keys()))

print("\nMarcador")
res = r["resumen"]
check("cuenta de meses cuadrados", 1, res["cuadran"])
check("cuenta de meses con diferencia", 1, res["difieren"])
check("cuenta de meses sin facturar", 1, res["pendientes"])
check("cuenta de facturas sin respaldo", 1, res["solo_odoo"])
check("monto acumulado sin facturar", 23.00, res["monto_pendiente"])
check("monto acumulado de diferencias", 7.00, res["monto_diferencia"])

print("\nArrastres que ve la pantalla de facturación")

# pendientes_por_mes es un endpoint async que envuelve a _cruce_mensual.
pend = asyncio.run(of.pendientes_por_mes(meses=12, user_id="usuario-de-prueba"))
check("solo arrastra el contribuyente con mes anterior pendiente",
      ["0102030405001"], list(pend["data"].keys()))
check("el arrastre suma lo que quedó sin facturar",
      23.00, pend["data"]["0102030405001"]["total"])
check("el mes en curso NO cuenta como arrastre",
      [k_1], [m["clave"] for m in pend["data"]["0102030405001"]["meses"]])

print()
if fallos:
    print(f"✗ {len(fallos)} comprobación(es) fallaron:")
    for f in fallos:
        print(f"   · {f}")
    sys.exit(1)
print("✓ Todo el cruce responde lo que debe.")
