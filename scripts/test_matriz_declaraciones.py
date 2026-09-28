# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Prueba el cuadro mes × contribuyente del estado de declaraciones.

No toca la base: reemplaza el cliente de Supabase por una tabla en memoria.

    python scripts/test_matriz_declaraciones.py

Por qué existe este endpoint: /pendientes se queda con el (año, mes) MÁS ALTO
de cada contribuyente, así que un mes viejo sin marcar no se ve en ninguna
pantalla —y lo que no se ve no se puede marcar—. Acá se comprueba que:

  · la matriz trae TODOS los períodos de la ventana, no solo el último;
  · cada celda distingue presentada / guardada sin confirmar / sin declaración;
  · un mes sin período abierto queda como `na` (el semestral no aparece
    atrasado los cinco meses en que simplemente no le toca declarar);
  · el mismo mes abierto dos veces se resuelve hacia la fila que YA tiene la
    declaración, y el duplicado se avisa en vez de esconderse;
  · la ventana de meses recorta por los períodos que existen, no por el
    calendario;
  · los submódulos apagados no filtran tipos que el usuario no puede ver.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

for _var, _val in (("SUPABASE_URL", "http://localhost"), ("SUPABASE_SERVICE_KEY", "x"),
                   ("SUPABASE_ANON_KEY", "x"), ("JWT_SECRET", "x")):
    os.environ.setdefault(_var, _val)

USUARIO = "u-marco"

# Períodos (filas de `clients`). NEYLA tiene junio abierto DOS veces: el mismo
# mes cargado por dos personas distintas, que es el caso real que rompía el
# recuento. EDELMIRA es semestral: solo existe su mes ancla (junio).
CLIENTES = [
    {"id": "flor-05", "identificacion": "0918099342001", "nombre": "FLOR GUTIERREZ",
     "periodo_mes": 5, "periodo_anio": 2026, "periodicidad": "mensual",
     "es_agente_retencion": False, "created_at": "2026-06-15"},
    {"id": "flor-06", "identificacion": "0918099342001", "nombre": "FLOR GUTIERREZ",
     "periodo_mes": 6, "periodo_anio": 2026, "periodicidad": "mensual",
     "es_agente_retencion": False, "created_at": "2026-07-10"},
    {"id": "flor-07", "identificacion": "0918099342001", "nombre": "FLOR GUTIERREZ",
     "periodo_mes": 7, "periodo_anio": 2026, "periodicidad": "mensual",
     "es_agente_retencion": False, "created_at": "2026-08-01"},
    {"id": "flor-08", "identificacion": "0918099342001", "nombre": "FLOR GUTIERREZ",
     "periodo_mes": 8, "periodo_anio": 2026, "periodicidad": "mensual",
     "es_agente_retencion": False, "created_at": "2026-09-01"},

    {"id": "luis-05", "identificacion": "1900434042001", "nombre": "LUIS AYORA",
     "periodo_mes": 5, "periodo_anio": 2026, "periodicidad": "mensual",
     "es_agente_retencion": False, "created_at": "2026-06-08"},
    {"id": "luis-06", "identificacion": "1900434042001", "nombre": "LUIS AYORA",
     "periodo_mes": 6, "periodo_anio": 2026, "periodicidad": "mensual",
     "es_agente_retencion": False, "created_at": "2026-07-10"},

    # Junio duplicado: la fila "b" se abrió después y quedó vacía.
    {"id": "neyla-06a", "identificacion": "0302957311001", "nombre": "NEYLA ALVAREZ",
     "periodo_mes": 6, "periodo_anio": 2026, "periodicidad": "mensual",
     "es_agente_retencion": False, "created_at": "2026-07-15"},
    {"id": "neyla-06b", "identificacion": "0302957311001", "nombre": "NEYLA ALVAREZ",
     "periodo_mes": 6, "periodo_anio": 2026, "periodicidad": "mensual",
     "es_agente_retencion": False, "created_at": "2026-07-24"},

    {"id": "edel-06", "identificacion": "0102030405001", "nombre": "EDELMIRA SAN MARTIN",
     "periodo_mes": 6, "periodo_anio": 2026, "periodicidad": "semestral",
     "es_agente_retencion": False, "created_at": "2026-07-10"},

    # Sin servicios contratados: no debe generar ninguna fila.
    {"id": "ana-08", "identificacion": "0106507288001", "nombre": "ANA AYABACA",
     "periodo_mes": 8, "periodo_anio": 2026, "periodicidad": "mensual",
     "es_agente_retencion": False, "created_at": "2026-09-01"},
]

SERVICIOS = [
    {"client_id": "flor-05", "service": "declaracion_iva", "active": True},
    {"client_id": "luis-05", "service": "declaracion_iva", "active": True},
    # El ICE quedó activo en un período viejo y nunca se copió a los nuevos:
    # el servicio se considera contratado igual (mismo criterio que /pendientes).
    {"client_id": "luis-05", "service": "declaracion_ice", "active": True},
    {"client_id": "neyla-06a", "service": "declaracion_iva", "active": True},
    {"client_id": "edel-06", "service": "declaracion_iva", "active": True},
]

DECLARACIONES = [
    {"client_id": "flor-06", "tipo": "IVA", "presentada_sri": True},
    # Guardada pero sin confirmar la subida al SRI.
    {"client_id": "flor-07", "tipo": "IVA", "presentada_sri": False},
    {"client_id": "luis-05", "tipo": "IVA", "presentada_sri": True},
    {"client_id": "luis-06", "tipo": "IVA", "presentada_sri": True},
    {"client_id": "luis-06", "tipo": "ICE", "presentada_sri": True},
    # De las dos filas de junio de Neyla, la declaración cuelga de la primera.
    {"client_id": "neyla-06a", "tipo": "IVA", "presentada_sri": True},
    {"client_id": "edel-06", "tipo": "IVA", "presentada_sri": True},
]


class Q:
    def __init__(self, rows):
        self.rows = list(rows)

    def select(self, *_a, **_k):
        return self

    def eq(self, c, v):
        self.rows = [r for r in self.rows if r.get(c) == v]
        return self

    def in_(self, c, vals):
        self.rows = [r for r in self.rows if r.get(c) in set(vals)]
        return self

    def order(self, *_a, **_k):
        return self

    def range(self, a, b):
        self.rows = self.rows[a:b + 1]
        return self

    def execute(self):
        return type("Res", (), {"data": self.rows, "count": None})()


class FakeSB:
    def table(self, nombre):
        if nombre == "client_services":
            return Q(SERVICIOS)
        if nombre == "declaraciones":
            return Q(DECLARACIONES)
        return Q([])


import database
database.get_supabase_client = lambda: FakeSB()

from routers import declaraciones as R

R.get_supabase_client = lambda: FakeSB()
R.visible_clients = lambda user_id, cols="*": [dict(c) for c in CLIENTES]
R.fetch_in = lambda factory, ids, col="client_id", **_k: factory().in_(col, list(ids)).execute().data

SUBMODULOS = {"decl_iva": True, "decl_ice": True, "agret_103": True}
R.modulos_de = lambda uid: ["declaraciones", "agente_retencion"]
R.puede_submodulo = lambda uid, sub: SUBMODULOS.get(sub, True)

fallos = []


def check(ok, titulo, detalle=""):
    print(("  OK   " if ok else "  FALLA") + f"  {titulo}" + (f"  ->  {detalle}" if not ok and detalle else ""))
    if not ok:
        fallos.append(titulo)


def fila(res, nombre, tipo):
    for f in res["filas"]:
        if f["nombre"] == nombre and f["tipo"] == tipo:
            return f
    return None


def estados(f):
    return {k: v["estado"] for k, v in f["celdas"].items()}


print("\n=== Estado de declaraciones: el cuadro mes x contribuyente ===\n")

res = asyncio.run(R.matriz_declaraciones(6, USUARIO))

# 1. La ventana sale de los períodos que EXISTEN, no del calendario.
claves = [p["clave"] for p in res["periodos"]]
check(claves == ["2026-05", "2026-06", "2026-07", "2026-08"],
      "las columnas son los meses con período abierto, en orden", claves)

# 2. Todos los meses, no solo el último: esto es lo que /pendientes no hace.
f = fila(res, "FLOR GUTIERREZ", "IVA")
e = estados(f)
check(e == {"2026-05": "falta", "2026-06": "presentada",
            "2026-07": "guardada", "2026-08": "falta"},
      "cada mes trae su propio estado (y mayo/agosto ya no son invisibles)", e)

# 3. Guardada no es presentada: el paso de confirmar la subida se ve distinto.
check(f["celdas"]["2026-07"]["estado"] == "guardada",
      "una declaración calculada pero sin confirmar la subida no cuenta como hecha")

# 4. Cada celda trae con qué marcarla.
check(f["celdas"]["2026-05"].get("client_id") == "flor-05",
      "la celda trae el client_id con el que se marca",
      str(f["celdas"]["2026-05"]))

# 5. Un mes sin período abierto es `na`, no un faltante.
luis = fila(res, "LUIS AYORA", "IVA")
check(estados(luis) == {"2026-05": "presentada", "2026-06": "presentada",
                        "2026-07": "na", "2026-08": "na"},
      "los meses sin período abierto no se cuentan como atrasados", estados(luis))

# 6. El semestral solo tiene celda en su mes ancla.
edel = fila(res, "EDELMIRA SAN MARTIN", "IVA")
check(estados(edel) == {"2026-05": "na", "2026-06": "presentada",
                        "2026-07": "na", "2026-08": "na"},
      "el contribuyente semestral no aparece atrasado fuera de su semestre",
      estados(edel))
check(edel["periodicidad"] == "semestral", "y la fila lo declara, para poder mostrarlo")

# 7. El servicio contratado en un período viejo sigue contando.
luis_ice = fila(res, "LUIS AYORA", "ICE")
check(luis_ice is not None, "el ICE activo en un período viejo igual genera su fila")
check(estados(luis_ice)["2026-05"] == "falta" and estados(luis_ice)["2026-06"] == "presentada",
      "y su estado se calcula mes a mes como el del IVA", estados(luis_ice))

# 8. Duplicado: se marca sobre la fila que YA tiene la declaración, y se avisa.
neyla = fila(res, "NEYLA ALVAREZ", "IVA")
c06 = neyla["celdas"]["2026-06"]
check(c06["estado"] == "presentada", "el mes duplicado no se da por pendiente si una fila ya declaró")
check(c06.get("client_id") == "neyla-06a",
      "y se marca sobre la fila que tiene la declaración, no sobre la vacía", str(c06))
check(c06.get("duplicado") == 2, "el duplicado se avisa en la celda", str(c06))

# 9. Sin servicios contratados no hay nada que declarar.
check(fila(res, "ANA AYABACA", "IVA") is None,
      "un contribuyente sin servicios no genera filas")

# 10. La ventana recorta por los meses más recientes.
res2 = asyncio.run(R.matriz_declaraciones(2, USUARIO))
check([p["clave"] for p in res2["periodos"]] == ["2026-07", "2026-08"],
      "pedir 2 meses trae los dos más recientes",
      str([p["clave"] for p in res2["periodos"]]))

# 11. Los permisos mandan: sin submódulo de ICE, esa fila no existe.
SUBMODULOS["decl_ice"] = False
res3 = asyncio.run(R.matriz_declaraciones(6, USUARIO))
check(fila(res3, "LUIS AYORA", "ICE") is None,
      "con el submódulo de ICE apagado, el ICE no se muestra")
check(fila(res3, "LUIS AYORA", "IVA") is not None, "pero el IVA sigue estando")
SUBMODULOS["decl_ice"] = True

# 12. Sin ningún módulo de declaraciones, la pantalla queda vacía (no revienta).
R.modulos_de = lambda uid: ["gastos"]
res4 = asyncio.run(R.matriz_declaraciones(6, USUARIO))
check(res4 == {"periodos": [], "filas": []},
      "sin módulos de declaraciones no se filtra nada", str(res4)[:120])

print()
if fallos:
    print(f"FALLARON {len(fallos)} comprobacion(es):")
    for f_ in fallos:
        print("  - " + f_)
    sys.exit(1)
print("Todo en orden.\n")
