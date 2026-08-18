# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Prueba del guardado de anexos PVP+ICE por contribuyente y mes.

No toca Supabase: reemplaza el cliente por una tabla en memoria, así que se
puede correr en cualquier momento y sin credenciales.

    python scripts/test_anexos_periodo.py

Escenario: la PANADERIA (RUC 0911) tiene abiertos junio y julio de 2026.
Se comprueba que:
  · el anexo se graba en la base del CONTRIBUYENTE y queda atribuido a SU mes;
  · volver a guardarlo en el mismo mes lo reemplaza (no se duplica) y conserva
    al autor original;
  · el anexo de junio se puede traer, modificar y guardar en JULIO sin tocar el
    de junio, y la cabecera del nuevo declara julio;
  · el listado devuelve los anexos del más nuevo al más viejo.
"""
import asyncio
import os
import sys

# El backend se importa como paquete plano (from database import ...), así que
# su carpeta tiene que estar en el path, se llame desde donde se llame.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

# Credenciales de mentira: config.py las exige para construir Settings, pero esta
# prueba reemplaza el cliente de Supabase y nunca abre una conexión.
for _var, _val in (("SUPABASE_URL", "http://localhost"), ("SUPABASE_SERVICE_KEY", "x"),
                   ("SUPABASE_ANON_KEY", "x"), ("JWT_SECRET", "x")):
    os.environ.setdefault(_var, _val)

ANA, BETO = "u-ana", "u-beto"
JUNIO, JULIO = "c-junio", "c-julio"

DB = {
    "clients": [
        {"id": JUNIO, "user_id": ANA, "identificacion": "0911", "nombre": "PANADERIA",
         "periodo_anio": 2026, "periodo_mes": 6},
        {"id": JULIO, "user_id": ANA, "identificacion": "0911", "nombre": "PANADERIA",
         "periodo_anio": 2026, "periodo_mes": 7},
    ],
    "anexos": [],
}

_SEQ = [0]


class Q:
    """Consulta simulada: solo lo que usa el router (select/eq/is_/insert/update)."""

    def __init__(self, tabla):
        self.tabla = tabla
        self.rows = list(DB.get(tabla, []))
        self._modo = None
        self._payload = None

    def select(self, _cols="*", count=None):
        self._modo = "select"
        return self

    def insert(self, fila):
        self._modo, self._payload = "insert", fila
        return self

    def update(self, cambios):
        self._modo, self._payload = "update", cambios
        return self

    def delete(self):
        self._modo = "delete"
        return self

    def eq(self, c, v):
        self.rows = [r for r in self.rows if r.get(c) == v]
        return self

    def in_(self, c, vals):
        s = set(vals)
        self.rows = [r for r in self.rows if r.get(c) in s]
        return self

    def is_(self, c, _null):
        self.rows = [r for r in self.rows if r.get(c) is None]
        return self

    def order(self, *a, **k):
        return self

    def limit(self, n):
        self.rows = self.rows[:n]
        return self

    def range(self, a, b):
        self.rows = self.rows[a:b + 1]
        return self

    def execute(self):
        if self._modo == "insert":
            _SEQ[0] += 1
            fila = {"id": f"anx-{_SEQ[0]}", "created_at": f"2026-08-1{_SEQ[0]}T00:00:00Z", **self._payload}
            DB[self.tabla].append(fila)
            datos = [fila]
        elif self._modo == "update":
            ids = {r["id"] for r in self.rows}
            datos = []
            for r in DB[self.tabla]:
                if r["id"] in ids:
                    r.update(self._payload)
                    datos.append(r)
        elif self._modo == "delete":
            ids = {r["id"] for r in self.rows}
            DB[self.tabla] = [r for r in DB[self.tabla] if r["id"] not in ids]
            datos = []
        else:
            datos = self.rows
        return type("Res", (), {"data": datos, "count": None})()


class FakeSB:
    def table(self, nombre):
        return Q(nombre)


import database
database.get_supabase_client = lambda: FakeSB()

from routers import anexos as R

R.get_supabase_client = lambda: FakeSB()
R.assert_client_owner = lambda client_id, user_id: True      # la tenencia se prueba aparte
R.visible_client_ids = lambda user_id: [JUNIO, JULIO]
R.registrar = lambda **k: None

fallos = []


def check(ok, titulo, detalle=""):
    print(("  OK   " if ok else "  FALLA") + f"  {titulo}" + (f"  →  {detalle}" if not ok and detalle else ""))
    if not ok:
        fallos.append(titulo)


def anexo(tipo, filas, anio="2026", mes="06"):
    return {"tipo": tipo, "header": {"IdInformante": "0911", "razonSocial": "PANADERIA",
                                     "Anio": anio, "Mes": mes}, "rows": filas}


def guardar(client_id, tipo, datos, quien=ANA):
    return asyncio.run(R.guardar(R.AnexoIn(client_id=client_id, tipo=tipo, datos=datos), quien))


def listar(quien=ANA):
    return asyncio.run(R.listar(None, quien))["data"]


print("\n=== Anexos PVP+ICE: se graban por contribuyente y quedan atribuidos a su mes ===\n")

# 1. Se graba en la base del contribuyente, con su período
g = guardar(JUNIO, "ice", anexo("ICE", [{"codProdICE": "3031", "ventaICE": "10"}]))
check(g["client_id"] == JUNIO, "el anexo cuelga del contribuyente/período elegido")
check((g["periodo_anio"], g["periodo_mes"]) == (2026, 6), "queda atribuido a junio 2026",
      f"{g.get('periodo_anio')}-{g.get('periodo_mes')}")
check(not g["reemplazado"] and len(DB["anexos"]) == 1, "es un anexo nuevo")

# 2. Volver a guardarlo en el mismo mes lo reemplaza y conserva al autor
g2 = guardar(JUNIO, "ICE", anexo("ICE", [{"codProdICE": "3031", "ventaICE": "12"}]), quien=BETO)
check(g2["reemplazado"] and len(DB["anexos"]) == 1, "regrabar el mismo mes NO duplica")
check(g2["id"] == g["id"], "se actualiza el mismo registro")
check(g2["datos"]["rows"][0]["ventaICE"] == "12", "guarda el contenido corregido")
check(DB["anexos"][0]["user_id"] == ANA, "conserva al autor original del anexo")

# 3. Un anexo PVP del mismo mes convive con el ICE (son anexos distintos)
guardar(JUNIO, "PVP", anexo("PVP", [{"codProdPVP": "3031", "precioPVP": "9.50"}]))
check(len(DB["anexos"]) == 2, "el PVP del mismo mes no pisa al ICE")

# 4. El de junio se trae, se modifica y se guarda en JULIO: nace uno nuevo
g3 = guardar(JULIO, "ICE", anexo("ICE", [{"codProdICE": "3031", "ventaICE": "25"}], mes="06"))
check(len(DB["anexos"]) == 3, "guardar en otro mes crea un anexo aparte")
check((g3["periodo_anio"], g3["periodo_mes"]) == (2026, 7), "el nuevo queda atribuido a julio 2026")
check(g3["datos"]["header"]["Mes"] == "07",
      "la cabecera se corrige al mes de destino (el XML no declara junio)",
      g3["datos"]["header"].get("Mes"))
junio = next(a for a in DB["anexos"] if a["id"] == g["id"])
check(junio["datos"]["rows"][0]["ventaICE"] == "12" and junio["periodo_mes"] == 6,
      "el anexo de junio queda intacto")

# 5. Listado del más nuevo al más viejo
orden = [(a["tipo"], a["periodo_mes"]) for a in listar()]
check(orden[0] == ("ICE", 7), "el listado empieza por el mes más reciente", str(orden))
check(len(orden) == 3, "salen los tres anexos del contribuyente", str(orden))

# 6. Actualizar por id (el botón "Actualizar anexo" del editor)
upd = asyncio.run(R.actualizar(g3["id"], R.AnexoUpdate(tipo="ICE", datos=anexo(
    "ICE", [{"codProdICE": "3031", "ventaICE": "30"}], mes="01")), ANA))
check(upd["datos"]["rows"][0]["ventaICE"] == "30", "actualizar guarda los cambios")
check(upd["datos"]["header"]["Mes"] == "07", "actualizar no deja declarar un mes ajeno",
      upd["datos"]["header"].get("Mes"))
check(upd.get("updated_at") is not None, "queda registrada la fecha de la última edición")

print("\n" + ("TODO CORRECTO." if not fallos else f"{len(fallos)} FALLAS: " + "; ".join(fallos)) + "\n")
sys.exit(1 if fallos else 0)
