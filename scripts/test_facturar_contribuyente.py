# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Prueba el cierre de una declaración y su factura:

  · Honorarios da por HECHA una declaración solo cuando se presentó en el SRI;
    la que está guardada sin presentar se avisa aparte.
  · Quién factura: lo guardado manda; si no, la empresa de la última factura en
    Odoo («Marco Antonio» → Contabilidad MAP); si no, CMAJ.
  · Facturar un contribuyente va a Odoo o a Contabilidad MAP según eso, y no
    duplica lo que ya se facturó (también lo facturado en MAP).
  · La factura que se manda a MAP lleva la base sin IVA y el descuento en plata.

No toca Supabase, Odoo ni MAP: todo se reemplaza en memoria.

    python scripts/test_facturar_contribuyente.py
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
HOY = datetime(2026, 9, 21, 9, 0, tzinfo=EC)
EN_SEPT = "2026-09-10T15:00:00+00:00"

CLIENTES = [
    {"id": "c-ana", "identificacion": "0911111111001", "nombre": "ANA"},     # presentada, CMAJ
    {"id": "c-beto", "identificacion": "0922222222001", "nombre": "BETO"},   # guardada sin presentar
    {"id": "c-carla", "identificacion": "0933333333001", "nombre": "CARLA"},  # Odoo dice Marco Antonio
    {"id": "c-diego", "identificacion": "0944444444001", "nombre": "DIEGO"},  # elegido MAP, ya facturado en MAP
]
SERVICIOS = [{"client_id": c["id"], "service": "declaracion_iva", "active": True} for c in CLIENTES]
DECLARACIONES = [
    {"client_id": "c-ana", "tipo": "IVA", "created_at": EN_SEPT, "presentada_sri": True, "presentada_sri_at": EN_SEPT},
    {"client_id": "c-beto", "tipo": "IVA", "created_at": EN_SEPT, "presentada_sri": False},
    {"client_id": "c-carla", "tipo": "IVA", "created_at": EN_SEPT, "presentada_sri": True, "presentada_sri_at": EN_SEPT},
    {"client_id": "c-diego", "tipo": "IVA", "created_at": EN_SEPT, "presentada_sri": True, "presentada_sri_at": EN_SEPT},
]
HONORARIOS = [
    {"user_id": USUARIO, "identificacion": c["identificacion"], "producto": "Declaración IVA", "cobrar": True,
     "valor": 20.0, "precio_oficial": 25.0, "descuento": 20.0, "iva_incluido": False, "mes": 9, "anio": 2026}
    for c in CLIENTES
]
TABLAS = {
    "client_services": SERVICIOS,
    "declaraciones": DECLARACIONES,
    "anexos": [],
    "reportes_honorarios": HONORARIOS,
    "reportes_trabajo": [],
    "facturacion_emisor": [{"user_id": USUARIO, "identificacion": "0944444444001", "emisor": "map"}],
}
ESCRITOS = []


class Q:
    def __init__(self, nombre, rows):
        self.nombre, self.rows = nombre, list(rows)

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

    def upsert(self, fila, **_k):
        ESCRITOS.append((self.nombre, fila))
        return self

    def execute(self):
        return type("Res", (), {"data": self.rows, "count": None})()


class FakeSB:
    def table(self, nombre):
        return Q(nombre, TABLAS.get(nombre, []))


import database
database.get_supabase_client = lambda: FakeSB()
import tenancy
tenancy.visible_clients = lambda user_id, cols="*": [dict(c) for c in CLIENTES]

from routers import reportes, facturar, odoo_factura
from services import contabilidad_map

reportes.get_supabase_client = lambda: FakeSB()
facturar.get_supabase_client = lambda: FakeSB()


class _FakeDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return HOY


reportes.datetime = _FakeDatetime

# Odoo: ANA y CARLA tienen facturas viejas; la de CARLA salió de «Marco Antonio».
odoo_factura.valores_honorarios_por_ruc = lambda idents, cache_key=None: {
    "0911111111001": [{"concepto": "Declaración IVA", "oficial": 25, "descuento": 20, "neto": 20,
                       "numero": "1", "fecha": "2026-08-10", "empresa": "CMAJ ASOCIADOS S.A.S."}],
    "0933333333001": [{"concepto": "Declaración IVA", "oficial": 25, "descuento": 20, "neto": 20,
                       "numero": "2", "fecha": "2026-08-10", "empresa": "MARCO ANTONIO POSLIGUA"}],
}
odoo_factura.facturas_periodo_por_ruc = lambda idents, mes, anio, cache_key=None: {}
# MAP: a DIEGO ya se le facturó septiembre.
contabilidad_map.configurado = lambda: True
contabilidad_map.facturas_de_referencia = lambda ref: (
    {"0944444444001": {"numero": "001-001-000000050", "fecha": "2026-09-15", "total": 23.0,
                       "autorizada": True, "autorizacion": "X", "sistema": "map"}}
    if ref == "HON-2026-09" else {})

LLAMADAS = {"odoo": [], "map": []}


async def _odoo_falso(user_id, r, cobrables, mes, anio):
    LLAMADAS["odoo"].append(r["identificacion"])
    return {"sistema": "odoo", "numero": "001-001-000000777", "total": 23.0, "ya_existia": False,
            "autorizada": True, "autorizacion": "A", "estado": "AUTORIZADA"}


def _map_falso(user_id, r, cobrables, mes, anio):
    LLAMADAS["map"].append(r["identificacion"])
    return {"sistema": "map", "numero": "001-001-000000051", "total": 23.0, "ya_existia": False,
            "autorizada": True, "autorizacion": "M", "estado": "AUTORIZADA"}


facturar._emitir_odoo = _odoo_falso
facturar._emitir_map = _map_falso
facturar.es_admin = lambda uid: uid == USUARIO

fallos = []


def check(ok, titulo, detalle=""):
    print(("  OK   " if ok else "  FALLA") + f"  {titulo}" + (f"  ->  {detalle}" if not ok and detalle else ""))
    if not ok:
        fallos.append(titulo)


print("\n=== Honorarios: hecho = presentada en el SRI ===\n")
filas, _, _ = reportes._filas_y_total(USUARIO)
por = {f["contribuyente"]: f for f in filas}
check(por["ANA"]["hecho"], "ANA presentó: está hecha")
check(not por["BETO"]["hecho"], "BETO solo la guardó: NO está hecha")
check(por["BETO"]["sin_presentar"], "y se avisa que falta presentarla")
check(not por["ANA"]["sin_presentar"], "a ANA no se le avisa nada")

print("\n=== Quién factura ===\n")
check(por["ANA"]["emisor"] == "cmaj", "ANA: su última factura es de CMAJ → Odoo", por["ANA"]["emisor"])
check(por["CARLA"]["emisor"] == "map" and por["CARLA"]["emisor_origen"] == "odoo",
      "CARLA: su última factura salió de Marco Antonio → Contabilidad MAP", str(por["CARLA"]))
check(por["DIEGO"]["emisor"] == "map" and por["DIEGO"]["emisor_origen"] == "guardado",
      "DIEGO: lo elegido y guardado manda", str(por["DIEGO"]))
check(por["BETO"]["emisor"] == "cmaj", "BETO: sin nada, CMAJ", por["BETO"]["emisor"])
check(por["DIEGO"]["procesado"] and por["DIEGO"]["factura_sistema"] == "map",
      "lo facturado en MAP cuenta como procesado", str(por["DIEGO"]))

print("\n=== Facturar un contribuyente ===\n")
r = asyncio.run(facturar.emitir(facturar.EmitirIn(identificacion="0911111111001"), USUARIO))
check(LLAMADAS["odoo"] == ["0911111111001"] and r["emisor"] == "cmaj", "ANA sale por Odoo", str(r))
r = asyncio.run(facturar.emitir(facturar.EmitirIn(identificacion="0933333333001"), USUARIO))
check(LLAMADAS["map"] == ["0933333333001"] and r["emisor"] == "map", "CARLA sale por Contabilidad MAP", str(r))
r = asyncio.run(facturar.emitir(facturar.EmitirIn(identificacion="0944444444001"), USUARIO))
check(r.get("ya_existia") and len(LLAMADAS["map"]) == 1, "DIEGO ya estaba facturado en MAP: no se duplica", str(r))
check(any(t == "reportes_honorarios" and f["identificacion"] == "0911111111001" for t, f in ESCRITOS) is False,
      "un honorario ya guardado a mano no se reescribe")
try:
    asyncio.run(facturar.emitir(facturar.EmitirIn(identificacion="0911111111001"), "otro"))
    check(False, "alguien que no es administrador no puede facturar")
except facturar.HTTPException as e:
    check(e.status_code == 403, "alguien que no es administrador no puede facturar", str(e.status_code))

res = asyncio.run(facturar.resumen_contribuyente("0933333333001", None, None, USUARIO))
check(res["emisor"] == "map" and res["total"] == 23.0 and len(res["lineas"]) == 1,
      "el resumen dice sistema, líneas y total con IVA", str(res))

print("\n=== La factura que va a Contabilidad MAP ===\n")
enviado = {}


def _llamar_falso(metodo, params=None, cuerpo=None, timeout=0):
    enviado.update(cuerpo or {})
    return {"numero": "001-001-000000052", "estado": "AUTORIZADA"}


contabilidad_map._llamar = _llamar_falso
contabilidad_map.emitir(identificacion="0933333333001", nombre="CARLA", referencia="HON-2026-09",
                        etiqueta="SEPTIEMBRE 2026",
                        lineas=[{"concepto": "Declaración IVA", "valor": 20.0, "precio_oficial": 25.0, "descuento": 20.0}])
it = enviado["items"][0]
check(enviado["referencia"] == "HON-2026-09" and enviado["tipo_id_cliente"] == "RUC",
      "lleva el mes que cubre y el tipo de identificación", str(enviado))
check(it["precio_unitario"] == 25.0 and it["descuento"] == 5.0,
      "precio oficial y descuento EN PLATA (20% de 25 = 5)", str(it))
check("SEPTIEMBRE 2026" in it["descripcion"], "el concepto dice el mes", it["descripcion"])
contabilidad_map.emitir(identificacion="0912345678", nombre="X", referencia="HON-2026-09", etiqueta="",
                        iva_incluido=True, lineas=[{"concepto": "Asesoría", "valor": 23.0}])
check(enviado["tipo_id_cliente"] == "CEDULA" and enviado["items"][0]["precio_unitario"] == 20.0,
      "con IVA incluido se manda la base (23 → 20) y la cédula como CEDULA", str(enviado))

print()
if fallos:
    print(f"{len(fallos)} FALLAS: " + "; ".join(fallos))
    sys.exit(1)
print("Todo en orden.")
