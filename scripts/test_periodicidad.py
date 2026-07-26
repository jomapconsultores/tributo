"""Prueba de services/periodicidad.py con un Supabase falso en memoria.

No toca la BD ni necesita el backend levantado:

    ./backend/venv/Scripts/python.exe scripts/test_periodicidad.py
"""
import sys, os
from pathlib import Path

# El script vive en scripts/ pero importa services/ del backend. Se resuelve desde
# la ruta del archivo para poder correrlo desde cualquier directorio.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import types
# El módulo importa database (que crea el cliente real al importar config): lo stubbeamos.
fake_db = types.ModuleType("database")
def fetch_all(qf, chunk=1000):
    return qf().execute().data or []
fake_db.fetch_all = fetch_all
fake_db.get_supabase_client = lambda: None
sys.modules["database"] = fake_db

from services.periodicidad import plan_cambio, aplicar_cambio  # noqa: E402


class Q:
    def __init__(self, db, tabla, cols="*", count=None):
        self.db, self.tabla, self.count_mode = db, tabla, count
        self.filtros = []          # (col, valor)
        self.in_filtros = []       # (col, [valores])
        self._limit = None

    def eq(self, col, val):
        self.filtros.append((col, val)); return self

    def in_(self, col, vals):
        self.in_filtros.append((col, list(vals))); return self

    def limit(self, n):
        self._limit = n; return self

    def range(self, a, b):
        self._range = (a, b); return self

    def _rows(self):
        rows = self.db.data.get(self.tabla, [])
        for col, val in self.filtros:
            rows = [r for r in rows if r.get(col) == val]
        for col, vals in self.in_filtros:
            rows = [r for r in rows if r.get(col) in vals]
        return rows

    def execute(self):
        rows = self._rows()
        res = types.SimpleNamespace(data=list(rows), count=len(rows) if self.count_mode else None)
        if self._limit:
            res.data = res.data[: self._limit]
        return res


class Upd(Q):
    def __init__(self, db, tabla, patch):
        super().__init__(db, tabla); self.patch = patch

    def execute(self):
        rows = self._rows()
        for r in rows:
            r.update(self.patch)
        return types.SimpleNamespace(data=list(rows), count=len(rows))


class Tabla:
    def __init__(self, db, nombre):
        self.db, self.nombre = db, nombre

    def select(self, cols="*", count=None):
        return Q(self.db, self.nombre, cols, count)

    def update(self, patch):
        return Upd(self.db, self.nombre, patch)

    def insert(self, fila):
        filas = fila if isinstance(fila, list) else [fila]
        for f in filas:
            f.setdefault("id", f"new-{self.nombre}-{len(self.db.data.get(self.nombre, []))}")
            self.db.data.setdefault(self.nombre, []).append(f)
        return types.SimpleNamespace(execute=lambda: types.SimpleNamespace(data=filas, count=len(filas)))


class FakeSB:
    def __init__(self, data):
        self.data = data

    def table(self, nombre):
        return Tabla(self, nombre)


def cliente(cid, mes, anio=2026, periodicidad="mensual", sem=None):
    return {"id": cid, "user_id": "u1", "identificacion": "0918099342001",
            "nombre": "FLOR MARIA", "tipo_identificacion": "RUC", "periodo_mes": mes,
            "periodo_anio": anio, "periodicidad": periodicidad, "periodo_semestre": sem,
            "es_agente_retencion": False}


def inv(cid, clave):
    return {"id": f"i-{cid}-{clave}", "client_id": cid, "unique_id": clave}


fallos = []
def check(nombre, cond, extra=""):
    print(("  OK  " if cond else "FALLA ") + nombre + ("" if cond else f"  → {extra}"))
    if not cond:
        fallos.append(nombre)


# --- 1. mensual → semestral con meses sueltos que hay que unir -----------------
db = FakeSB({
    "clients": [cliente("c3", 3), cliente("c4", 4), cliente("c5", 5)],
    "invoices": [inv("c3", "k1"), inv("c4", "k2"), inv("c5", "k3"), inv("c5", "k4")],
    "sales_iva": [inv("c4", "v1")],
    "ice_sales": [], "retentions": [], "retenciones_efectuadas": [],
})
plan = plan_cambio(db, "c5", "semestral", 1)
check("destino = el mes más avanzado del semestre (c5)", plan["destino"]["client_id"] == "c5", plan["destino"])
check("se re-ancla a junio", plan["destino"]["periodo_mes"] == 6, plan["destino"])
check("propone unir marzo y abril", [f["periodo_mes"] for f in plan["fusionar"]] == [3, 4], plan["fusionar"])
check("cuenta los comprobantes por mes", plan["fusionar"][1]["comprobantes"] == {"Gastos": 1, "Ingresos IVA": 1},
      plan["fusionar"][1])
check("avisa que quedaría incompleta", any("incompleta" in a for a in plan["avisos"]), plan["avisos"])

res = aplicar_cambio(db, "c5", "semestral", 1, fusionar=True)
c5 = [c for c in db.data["clients"] if c["id"] == "c5"][0]
check("c5 queda semestral S1 anclado en junio",
      (c5["periodicidad"], c5["periodo_semestre"], c5["periodo_mes"]) == ("semestral", 1, 6), c5)
check("los gastos de marzo/abril se movieron a c5",
      sorted(i["unique_id"] for i in db.data["invoices"] if i["client_id"] == "c5") == ["k1", "k2", "k3", "k4"],
      db.data["invoices"])
check("las ventas de abril se movieron a c5",
      [v["client_id"] for v in db.data["sales_iva"]] == ["c5"], db.data["sales_iva"])
check("no se borró ningún período", len(db.data["clients"]) == 3, db.data["clients"])
check("resumen de movidos", res["movidos"]["Gastos"]["movidos"] == 2, res["movidos"])

# --- 2. no se fusiona si no se pide -------------------------------------------
db2 = FakeSB({
    "clients": [cliente("d1", 1), cliente("d2", 2)],
    "invoices": [inv("d1", "x1")], "sales_iva": [], "ice_sales": [],
    "retentions": [], "retenciones_efectuadas": [],
})
aplicar_cambio(db2, "d2", "semestral", 1, fusionar=False)
check("sin fusionar, los gastos siguen en enero",
      db2.data["invoices"][0]["client_id"] == "d1", db2.data["invoices"])

# --- 3. duplicados: el mismo comprobante en los dos meses ---------------------
db3 = FakeSB({
    "clients": [cliente("e1", 1), cliente("e6", 6)],
    "invoices": [inv("e1", "z1"), inv("e1", "z2"), inv("e6", "z1")],
    "sales_iva": [], "ice_sales": [], "retentions": [], "retenciones_efectuadas": [],
})
r3 = aplicar_cambio(db3, "e6", "semestral", 1, fusionar=True)
check("el duplicado se queda en el origen", r3["movidos"]["Gastos"] == {"movidos": 1, "duplicados": 1}, r3["movidos"])
check("no se perdió ninguna factura", len(db3.data["invoices"]) == 3, db3.data["invoices"])

# --- 4. semestre sin ningún mes cargado → abre el período ---------------------
db4 = FakeSB({
    "clients": [cliente("f8", 8)],
    "invoices": [], "sales_iva": [], "ice_sales": [], "retentions": [], "retenciones_efectuadas": [],
})
plan4 = plan_cambio(db4, "f8", "semestral", 1)
check("avisa que abre el período semestral vacío", plan4["crear_periodo"], plan4)
r4 = aplicar_cambio(db4, "f8", "semestral", 1)
nuevo = [c for c in db4.data["clients"] if c["id"] == r4["client_id"]][0]
check("el período nuevo es del mismo contribuyente",
      nuevo["identificacion"] == "0918099342001" and nuevo["periodo_mes"] == 6 and nuevo["periodo_semestre"] == 1, nuevo)
check("el período de agosto queda intacto",
      [c for c in db4.data["clients"] if c["id"] == "f8"][0]["periodicidad"] == "mensual", db4.data["clients"])

# --- 5. volver a mensual ------------------------------------------------------
db5 = FakeSB({
    "clients": [cliente("g6", 6, periodicidad="semestral", sem=1)],
    "invoices": [], "sales_iva": [], "ice_sales": [], "retentions": [], "retenciones_efectuadas": [],
})
plan5 = plan_cambio(db5, "g6", "mensual")
check("avisa que los comprobantes quedan en el mes ancla", any("quedan todos en el mes" in a for a in plan5["avisos"]),
      plan5["avisos"])
aplicar_cambio(db5, "g6", "mensual")
g6 = db5.data["clients"][0]
check("vuelve a mensual sin semestre",
      (g6["periodicidad"], g6["periodo_semestre"], g6["periodo_mes"]) == ("mensual", None, 6), g6)

# --- 6. segundo semestre ------------------------------------------------------
db6 = FakeSB({
    "clients": [cliente("h9", 9), cliente("h12", 12)],
    "invoices": [inv("h9", "w1")], "sales_iva": [], "ice_sales": [],
    "retentions": [], "retenciones_efectuadas": [],
})
plan6 = plan_cambio(db6, "h9", "semestral", 2)
check("S2: destino es el mes ancla (diciembre) si ya existe", plan6["destino"]["client_id"] == "h12", plan6["destino"])
check("S2: propone unir septiembre", [f["periodo_mes"] for f in plan6["fusionar"]] == [9], plan6["fusionar"])

print()
print("FALLOS:", fallos if fallos else "ninguno")
sys.exit(1 if fallos else 0)
