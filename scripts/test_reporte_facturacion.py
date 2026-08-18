# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Prueba el reporte del mes: quién declaró, a quién falta facturarle y el
comparativo contra lo que Odoo tiene emitido.

No toca Supabase ni Odoo: la base es una tabla en memoria y el lector de
facturas de Odoo se reemplaza por una función simulada.

    python scripts/test_reporte_facturacion.py

Escenario de agosto 2026:
  · ANA      IVA + ICE contratados, declaró las dos y su anexo → TOTAL, facturada.
  · BETO     IVA + ICE, solo declaró IVA                       → PARCIAL, sin facturar.
  · CARLA    IVA, no declaró nada, tiene honorario registrado   → NINGUNA, sin facturar.
  · DIEGO    sin servicios mensuales, con factura en Odoo       → solo en Odoo.
  · ELSA     IVA, declaró lo suyo, honorario 20 y factura de 23 → TOTAL, monto distinto.
"""
import asyncio
import os
import sys
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

for _var, _val in (("SUPABASE_URL", "http://localhost"), ("SUPABASE_SERVICE_KEY", "x"),
                   ("SUPABASE_ANON_KEY", "x"), ("JWT_SECRET", "x")):
    os.environ.setdefault(_var, _val)

USUARIO = "u-marco"
EC = timezone(timedelta(hours=-5))
HOY = datetime(2026, 8, 18, 9, 0, tzinfo=EC)
EN_AGOSTO = "2026-08-10T15:00:00+00:00"
EN_JULIO = "2026-07-10T15:00:00+00:00"

CLIENTES = [
    {"id": "c-ana", "identificacion": "0911111111001", "nombre": "ANA"},
    {"id": "c-beto", "identificacion": "0922222222001", "nombre": "BETO"},
    {"id": "c-carla", "identificacion": "0933333333001", "nombre": "CARLA"},
    {"id": "c-diego", "identificacion": "0944444444001", "nombre": "DIEGO"},
    {"id": "c-elsa", "identificacion": "0955555555001", "nombre": "ELSA"},
]
SERVICIOS = [
    {"client_id": "c-ana", "service": "declaracion_iva", "active": True},
    {"client_id": "c-ana", "service": "declaracion_ice", "active": True},
    {"client_id": "c-beto", "service": "declaracion_iva", "active": True},
    {"client_id": "c-beto", "service": "declaracion_ice", "active": True},
    {"client_id": "c-carla", "service": "declaracion_iva", "active": True},
    {"client_id": "c-elsa", "service": "declaracion_iva", "active": True},
    {"client_id": "c-diego", "service": "devolucion_iva", "active": True},   # no es mensual
]
DECLARACIONES = [
    {"client_id": "c-ana", "tipo": "IVA", "created_at": EN_AGOSTO},
    {"client_id": "c-ana", "tipo": "ICE", "created_at": EN_AGOSTO},
    {"client_id": "c-beto", "tipo": "IVA", "created_at": EN_AGOSTO},
    {"client_id": "c-beto", "tipo": "ICE", "created_at": EN_JULIO},   # del mes pasado: no cuenta
    {"client_id": "c-elsa", "tipo": "IVA", "created_at": EN_AGOSTO},
]
ANEXOS = [
    {"client_id": "c-ana", "created_at": EN_AGOSTO},
]
HONORARIOS = [
    {"identificacion": "0911111111001", "producto": "Declaración IVA", "cobrar": True,
     "valor": 30.0, "iva_incluido": False, "mes": 8, "anio": 2026},
    {"identificacion": "0922222222001", "producto": "Declaración IVA", "cobrar": True,
     "valor": 15.0, "iva_incluido": False, "mes": 8, "anio": 2026},
    {"identificacion": "0933333333001", "producto": "Declaración IVA", "cobrar": True,
     "valor": 15.0, "iva_incluido": False, "mes": 8, "anio": 2026},
    {"identificacion": "0955555555001", "producto": "Declaración IVA", "cobrar": True,
     "valor": 20.0, "iva_incluido": True, "mes": 8, "anio": 2026},
    {"identificacion": "0911111111001", "producto": "Declaración IVA", "cobrar": True,
     "valor": 99.0, "iva_incluido": False, "mes": 7, "anio": 2026},   # otro mes: fuera
]

TABLAS = {
    "client_services": SERVICIOS,
    "declaraciones": DECLARACIONES,
    "anexos": ANEXOS,
    "reportes_honorarios": [{**h, "user_id": USUARIO} for h in HONORARIOS],
}


class Q:
    def __init__(self, rows):
        self.rows = list(rows)

    def select(self, *_a, **_k):
        return self

    def eq(self, c, v):
        self.rows = [r for r in self.rows if r.get(c) == v]
        return self

    def in_(self, c, vals):
        s = set(vals)
        self.rows = [r for r in self.rows if r.get(c) in s]
        return self

    def order(self, *_a, **_k):
        return self

    def range(self, a, b):
        self.rows = self.rows[a:b + 1]
        return self

    def limit(self, n):
        self.rows = self.rows[:n]
        return self

    def execute(self):
        return type("Res", (), {"data": self.rows, "count": None})()


class FakeSB:
    def table(self, nombre):
        return Q(TABLAS.get(nombre, []))


import database
database.get_supabase_client = lambda: FakeSB()

from routers import odoo_factura as R

R.get_supabase_client = lambda: FakeSB()
R.visible_clients = lambda user_id, cols: [dict(c) for c in CLIENTES]
# Lo que Odoo tiene emitido de AGOSTO 2026 (atribuido por la referencia del mes)
R.facturas_por_mes_por_ruc = lambda idents, a, m: {
    "0911111111001": {"2026-08": [{"numero": "001-001-000000900", "fecha": "2026-08-15",
                                   "total": 34.50, "autorizada": True, "autorizacion": "ABC",
                                   "estado_pago": "paid", "pagada": True, "por_cobrar": 0.0,
                                   "empresa": "CMAJ ASOCIADOS S.A.S."}]},
    "0944444444001": {"2026-08": [{"numero": "001-001-000000901", "fecha": "2026-08-16",
                                   "total": 11.50, "autorizada": False, "autorizacion": None,
                                   "estado_pago": "not_paid", "pagada": False, "por_cobrar": 11.50,
                                   "empresa": "CMAJ ASOCIADOS S.A.S."}]},
    "0955555555001": {"2026-08": [{"numero": "001-001-000000902", "fecha": "2026-08-17",
                                   "total": 23.00, "autorizada": True, "autorizacion": "DEF",
                                   "estado_pago": "not_paid", "pagada": False, "por_cobrar": 23.00,
                                   "empresa": "CMAJ ASOCIADOS S.A.S."}]},
}


class _FakeDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return HOY


R.datetime = _FakeDatetime

fallos = []


def check(ok, titulo, detalle=""):
    print(("  OK   " if ok else "  FALLA") + f"  {titulo}" + (f"  ->  {detalle}" if not ok and detalle else ""))
    if not ok:
        fallos.append(titulo)


print("\n=== Reporte del mes: declarado, facturado y comparativo ===\n")

res = asyncio.run(R.reporte_facturacion(None, None, USUARIO))
por_ruc = {d["nombre"]: d for d in res["data"]}
r = res["resumen"]

check(res["periodo"]["clave"] == "2026-08", "el reporte sale del mes en curso", res["periodo"]["clave"])

# --- Trabajo declarativo: total, parcial, ninguna -------------------------
ana = por_ruc["ANA"]
check(ana["declaracion"]["estado"] == "total", "ANA declaró todo lo suyo (IVA, ICE y anexo)",
      str(ana["declaracion"]))
beto = por_ruc["BETO"]
check(beto["declaracion"]["estado"] == "parcial", "BETO queda como PARCIAL", str(beto["declaracion"]))
check(set(beto["declaracion"]["faltan"]) == {"declaracion_ice", "anexo"},
      "y se dice qué le falta", str(beto["declaracion"]["faltan"]))
check("declaracion_ice" not in beto["declaracion"]["hechas"],
      "el ICE declarado el mes pasado no cuenta para este mes")
carla = por_ruc["CARLA"]
check(carla["declaracion"]["estado"] == "ninguna", "CARLA no declaró nada", str(carla["declaracion"]))
diego = por_ruc["DIEGO"]
check(diego["declaracion"]["estado"] == "sin_obligaciones",
      "DIEGO no tiene obligaciones mensuales: no cuenta como faltante", str(diego["declaracion"]))

# --- Facturación y comparativo -------------------------------------------
check(ana["estado_facturacion"] == "facturado", "ANA está facturada", ana["estado_facturacion"])
check(beto["estado_facturacion"] == "pendiente", "a BETO le falta facturar", beto["estado_facturacion"])
check(carla["estado_facturacion"] == "pendiente", "a CARLA también", carla["estado_facturacion"])
check(diego["estado_facturacion"] == "solo_odoo", "la factura de DIEGO no tiene honorario registrado",
      diego["estado_facturacion"])
elsa = por_ruc["ELSA"]
check(elsa["estado_facturacion"] == "difiere", "ELSA: el monto facturado no coincide",
      elsa["estado_facturacion"])
check(elsa["diferencia"] == 3.0, "y la diferencia se dice en plata", str(elsa["diferencia"]))

# ANA y ELSA declararon todo lo que les toca (ELSA solo tiene IVA contratado).
check(r["decl_total"] == 2 and r["decl_parcial"] == 1 and r["decl_ninguna"] == 1,
      "el resumen cuenta completas, parciales y sin declarar",
      f"{r['decl_total']}/{r['decl_parcial']}/{r['decl_ninguna']}")
check(r["pendientes"] == 2 and r["monto_pendiente"] == 34.50,
      "y a cuántos falta facturarles, con su monto", f"{r['pendientes']} · {r['monto_pendiente']}")
check(r["monto_registrado"] == 89.00, "total registrado del mes", str(r["monto_registrado"]))
check(r["monto_facturado"] == 69.00, "total facturado en Odoo", str(r["monto_facturado"]))

# --- El reporte de Odoo, tal cual ----------------------------------------
check(r["facturas"] == 3 and r["autorizadas"] == 2 and r["pagadas"] == 1,
      "el reporte de Odoo: emitidas, autorizadas por el SRI y cobradas",
      f"{r['facturas']}/{r['autorizadas']}/{r['pagadas']}")
check(r["por_cobrar"] == 34.50, "y cuánto queda por cobrar", str(r["por_cobrar"]))
check(len(res["facturas_odoo"]) == 3 and res["facturas_odoo"][0]["fecha"] == "2026-08-17",
      "las facturas vienen listadas, de la más nueva a la más vieja",
      str([f["fecha"] for f in res["facturas_odoo"]]))

print("\n" + ("TODO CORRECTO." if not fallos else f"{len(fallos)} FALLAS: " + "; ".join(fallos)) + "\n")
sys.exit(1 if fallos else 0)
