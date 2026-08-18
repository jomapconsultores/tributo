# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Prueba que la facturación de honorarios quede separada POR MES.

No toca Supabase ni Odoo: reemplaza el cliente de la base por una tabla en
memoria y el lector de facturas de Odoo por una función simulada.

    python scripts/test_facturacion_por_mes.py

Lo que se comprueba:
  · el período que cubre una factura viaja en su referencia (HON-AAAA-MM), que
    es lo que permite emitir julio y agosto el mismo día sin confundirlos;
  · /api/odoo/por-facturar devuelve UN BLOQUE POR MES, del más nuevo al más
    viejo, con las líneas de cada contribuyente;
  · el mes en curso NO viene por ahí (lo arma la pantalla con /reportes/cobros);
  · el mes que ya tiene factura deja de ofrecerse;
  · el IVA incluido se refleja en el total del contribuyente.
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
# "Hoy" para la prueba: 18 de agosto de 2026. El mes en curso es agosto.
HOY = datetime(2026, 8, 18, 10, 0, tzinfo=timezone(timedelta(hours=-5)))

HONORARIOS = [
    # Julio 2026 — dos contribuyentes, uno con IVA incluido en el valor
    {"identificacion": "0102537644001", "producto": "Declaración IVA", "cobrar": True,
     "valor": 15.0, "precio_oficial": 15.0, "descuento": 0, "iva_incluido": False, "mes": 7, "anio": 2026},
    {"identificacion": "0102537644001", "producto": "Declaraciones IESS", "cobrar": True,
     "valor": 15.0, "precio_oficial": None, "descuento": 0, "iva_incluido": False, "mes": 7, "anio": 2026},
    {"identificacion": "0302286786001", "producto": "Declaración IVA", "cobrar": True,
     "valor": 11.50, "precio_oficial": None, "descuento": 0, "iva_incluido": True, "mes": 7, "anio": 2026},
    # Junio 2026 — ya facturado en Odoo (no debe ofrecerse)
    {"identificacion": "0102537644001", "producto": "Declaración IVA", "cobrar": True,
     "valor": 15.0, "precio_oficial": None, "descuento": 0, "iva_incluido": False, "mes": 6, "anio": 2026},
    # Agosto 2026 — mes en curso: lo arma /reportes/cobros, no este endpoint
    {"identificacion": "0102537644001", "producto": "Declaración IVA", "cobrar": True,
     "valor": 15.0, "precio_oficial": None, "descuento": 0, "iva_incluido": False, "mes": 8, "anio": 2026},
    # No cobrable y sin valor: no son honorarios a facturar
    {"identificacion": "0302286786001", "producto": "Anexo", "cobrar": False,
     "valor": 30.0, "precio_oficial": None, "descuento": 0, "iva_incluido": False, "mes": 7, "anio": 2026},
    {"identificacion": "0302286786001", "producto": "Cursos", "cobrar": True,
     "valor": 0.0, "precio_oficial": None, "descuento": 0, "iva_incluido": False, "mes": 7, "anio": 2026},
]

CLIENTES = [
    {"identificacion": "0102537644001", "nombre": "ADRIAN VICENTE OCHOA NAULA"},
    {"identificacion": "0302286786001", "nombre": "DIEGO PATRICIO AVILA AVILA"},
]


class Q:
    def __init__(self, rows):
        self.rows = list(rows)

    def select(self, *_a, **_k):
        return self

    def eq(self, c, v):
        self.rows = [r for r in self.rows if r.get(c) == v]
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
        # user_id no está en las filas de prueba: se agrega al vuelo para que
        # el filtro .eq("user_id", ...) del endpoint las encuentre.
        if nombre == "reportes_honorarios":
            return Q([{**h, "user_id": USUARIO} for h in HONORARIOS])
        return Q([])


import database
database.get_supabase_client = lambda: FakeSB()

from routers import odoo_factura as R

R.get_supabase_client = lambda: FakeSB()
R.visible_clients = lambda user_id, cols: list(CLIENTES)
# Junio ya está facturado: la factura lleva la referencia del mes que cubre.
R.facturas_por_mes_por_ruc = lambda idents, a, m: {
    "0102537644001": {"2026-06": [{"numero": "001-001-000000123", "periodo": "2026-06",
                                   "por_referencia": True, "total": 17.25}]},
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


print("\n=== Facturacion de honorarios: separada por mes ===\n")

# 1. La referencia que identifica el mes que cubre la factura
check(R._ref_honorarios(2026, 7) == "HON-2026-07", "la factura declara su mes en la referencia",
      R._ref_honorarios(2026, 7))
check(R._periodo_de_ref("HON-2026-07") == "2026-07", "y ese mes se puede leer de vuelta")
check(R._periodo_de_ref("Pago cliente") is None, "una referencia cualquiera no se confunde con un período")
check(R._etiqueta_mes(2026, 7) == "JULIO 2026", "el mes se escribe con nombre en el concepto",
      R._etiqueta_mes(2026, 7))

# 2. El endpoint: un bloque por mes
res = asyncio.run(R.por_facturar(12, USUARIO))
meses = res["meses"]
claves = [m["clave"] for m in meses]
check(claves == ["2026-07"], "solo se ofrece lo pendiente, mes por mes", str(claves))
check(res["periodo_actual"]["mes"] == 8, "el mes en curso queda identificado", str(res["periodo_actual"]))
check("2026-08" not in claves, "el mes en curso NO se mezcla acá (lo arma /reportes/cobros)")
check("2026-06" not in claves, "el mes ya facturado deja de ofrecerse")

julio = meses[0]
rucs = sorted(c["ruc"] for c in julio["contribuyentes"])
check(rucs == ["0102537644001", "0302286786001"], "julio trae a sus dos contribuyentes", str(rucs))

adrian = next(c for c in julio["contribuyentes"] if c["ruc"] == "0102537644001")
check(len(adrian["lineas"]) == 2, "con sus conceptos", str([l["concepto"] for l in adrian["lineas"]]))
check(adrian["total"] == 34.50, "y el total con IVA (15+15 + 15%)", str(adrian["total"]))

diego = next(c for c in julio["contribuyentes"] if c["ruc"] == "0302286786001")
check(diego["total"] == 11.50, "el valor que ya venía con IVA no se vuelve a recargar", str(diego["total"]))
check(all(l["concepto"] not in ("Anexo", "Cursos") for l in diego["lineas"]),
      "lo no cobrable y lo que vale 0 no se factura", str([l["concepto"] for l in diego["lineas"]]))

check(julio["total"] == 46.00, "el mes suma lo de todos", str(julio["total"]))
check(julio["etiqueta"] == "Julio 2026", "cada bloque dice de qué mes es", julio["etiqueta"])

print("\n" + ("TODO CORRECTO." if not fallos else f"{len(fallos)} FALLAS: " + "; ".join(fallos)) + "\n")
sys.exit(1 if fallos else 0)
