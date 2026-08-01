# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Prueba de la lógica multiempresa contra una base SIMULADA.

No toca Supabase: reemplaza el cliente por una tabla en memoria, así que se
puede correr en cualquier momento y sin credenciales.

    python scripts/test_multiempresa.py

Escenario:
  · ANA pertenece a DOS empresas: admin en MAP, trabajador en VERA.
  · BETO solo pertenece a VERA, como socio.
  · MARCO es administrador de la PLATAFORMA (app_admins), miembro de MAP.
Se comprueba que el rol, los módulos y la cartera de contribuyentes cambian
según la empresa activa, y que nadie ve contribuyentes de la otra empresa.
"""
import os
import sys

# El backend se importa como paquete plano (from database import ...), así que
# su carpeta tiene que estar en el path, se llame desde donde se llame.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

# Credenciales de mentira: config.py las exige para construir Settings, pero esta
# prueba reemplaza el cliente de Supabase y nunca abre una conexión. Así no hace
# falta un .env ni se corre el riesgo de apuntar sin querer a producción.
for _var, _val in (("SUPABASE_URL", "http://localhost"), ("SUPABASE_SERVICE_KEY", "x"),
                   ("SUPABASE_ANON_KEY", "x"), ("JWT_SECRET", "x")):
    os.environ.setdefault(_var, _val)

# ── Base de datos simulada ────────────────────────────────────────────────
MAP_ID, VERA_ID = "org-map", "org-vera"
ANA, BETO, MARCO = "u-ana", "u-beto", "u-marco"

DB = {
    "organizations": [
        {"id": MAP_ID, "nombre": "MAP CONSULTORES", "identificacion": None, "activa": True},
        {"id": VERA_ID, "nombre": "ESTUDIO VERA", "identificacion": None, "activa": True},
    ],
    "organization_members": [
        {"org_id": MAP_ID, "user_id": ANA, "role": "admin"},
        {"org_id": VERA_ID, "user_id": ANA, "role": "trabajador"},
        {"org_id": VERA_ID, "user_id": BETO, "role": "socio"},
        {"org_id": MAP_ID, "user_id": MARCO, "role": "admin"},
    ],
    "organization_member_modules": [
        {"org_id": MAP_ID, "user_id": ANA, "modulo": "gastos", "activo": True, "valid_until": None},
        {"org_id": MAP_ID, "user_id": ANA, "modulo": "declaraciones", "activo": True, "valid_until": None},
        {"org_id": VERA_ID, "user_id": ANA, "modulo": "gastos", "activo": True, "valid_until": None},
        {"org_id": VERA_ID, "user_id": ANA, "modulo": "declaraciones", "activo": False, "valid_until": None},
    ],
    "organization_member_submodules": [],
    "app_admins": [{"user_id": MARCO, "role": "admin"}],
    "user_roles": [{"user_id": MARCO, "role": "admin"}],
    "user_modules": [{"user_id": ANA, "modulo": "retenciones", "activo": True, "valid_until": None}],
    "user_submodules": [],
    "subscriptions": [],
    "client_access": [],
    "clients": [
        {"id": "c1", "user_id": ANA,   "org_id": MAP_ID,  "identificacion": "0911", "nombre": "PANADERIA"},
        {"id": "c2", "user_id": MARCO, "org_id": MAP_ID,  "identificacion": "0922", "nombre": "FERRETERIA"},
        {"id": "c3", "user_id": BETO,  "org_id": VERA_ID, "identificacion": "0933", "nombre": "IMPRENTA"},
        {"id": "c4", "user_id": ANA,   "org_id": VERA_ID, "identificacion": "0944", "nombre": "TALLER"},
    ],
}


class Q:
    def __init__(self, rows):
        self.rows = list(rows)
        self._count = False

    def select(self, _cols="*", count=None):
        self._count = count is not None
        return self

    def eq(self, c, v):
        self.rows = [r for r in self.rows if r.get(c) == v]; return self

    def neq(self, c, v):
        self.rows = [r for r in self.rows if r.get(c) != v]; return self

    def in_(self, c, vals):
        s = set(vals)
        self.rows = [r for r in self.rows if r.get(c) in s]; return self

    def is_(self, c, _null):
        self.rows = [r for r in self.rows if r.get(c) is None]; return self

    def like(self, c, pat):
        pre = pat.rstrip("%")
        self.rows = [r for r in self.rows if str(r.get(c) or "").startswith(pre)]; return self

    def order(self, *a, **k):
        return self

    def limit(self, n):
        self.rows = self.rows[:n]; return self

    def range(self, a, b):
        self.rows = self.rows[a:b + 1]; return self

    def execute(self):
        return type("Res", (), {"data": self.rows, "count": len(self.rows) if self._count else None})()


class FakeSB:
    def table(self, nombre):
        return Q(DB.get(nombre, []))


import database
database.get_supabase_client = lambda: FakeSB()

import orgs
from routers import access
import tenancy

# database ya fue importado por los módulos: reapuntar sus referencias directas
orgs.get_supabase_client = lambda: FakeSB()
access.get_supabase_client = lambda: FakeSB()
tenancy.get_supabase_client = lambda: FakeSB()


def limpiar():
    access.invalidar_cache_rol()
    tenancy.invalidate_clients_cache()
    orgs.invalidar()


def con_empresa(org_id):
    limpiar()
    orgs.set_org_activa(org_id)


fallos = []


def check(desc, obtenido, esperado):
    ok = obtenido == esperado
    print(f"  {'OK ' if ok else 'MAL'} {desc}: {obtenido!r}" + ("" if ok else f"  (esperado {esperado!r})"))
    if not ok:
        fallos.append(desc)


print("\n1) Resolución de la empresa activa")
limpiar()
check("Ana sin cabecera → su empresa de mayor privilegio",
      orgs.resolver_org(ANA, None), MAP_ID)
check("Ana pide VERA (es miembro) → VERA",
      orgs.resolver_org(ANA, VERA_ID), VERA_ID)
check("Beto pide MAP (NO es miembro) → cae a la suya, no a MAP",
      orgs.resolver_org(BETO, MAP_ID), VERA_ID)

print("\n2) El rol depende de la empresa")
con_empresa(MAP_ID);  check("Ana en MAP", access.rol_de(ANA), "admin")
con_empresa(VERA_ID); check("Ana en VERA", access.rol_de(ANA), "trabajador")
con_empresa(VERA_ID); check("Marco (admin de plataforma) en VERA", access.rol_de(MARCO), "admin")
con_empresa(VERA_ID); check("Marco NO es admin de empresa por serlo de plataforma… lo es",
                            access.es_super_admin(MARCO), True)
con_empresa(MAP_ID);  check("Ana es admin de MAP pero NO de la plataforma",
                            access.es_super_admin(ANA), False)

print("\n3) Los módulos dependen de la empresa")
con_empresa(MAP_ID)
check("Ana en MAP", sorted(access.modulos_de(ANA)), ["declaraciones", "gastos"])
con_empresa(VERA_ID)
check("Ana en VERA (declaraciones desactivado)", sorted(access.modulos_de(ANA)), ["gastos"])
con_empresa(None)
check("Ana sin empresa → módulos globales heredados", sorted(access.modulos_de(ANA)), ["retenciones"])

print("\n4) La cartera de contribuyentes no cruza empresas")
con_empresa(MAP_ID)
check("Ana (admin en MAP) ve los de MAP",
      sorted(c["id"] for c in tenancy.visible_clients(ANA)), ["c1", "c2"])
con_empresa(VERA_ID)
check("Ana (trabajador en VERA) solo ve el suyo",
      sorted(c["id"] for c in tenancy.visible_clients(ANA)), ["c4"])
con_empresa(VERA_ID)
check("Beto (socio en VERA) ve los de VERA",
      sorted(c["id"] for c in tenancy.visible_clients(BETO)), ["c3", "c4"])

print("\n5) assert_client_owner corta el salto entre empresas")
from fastapi import HTTPException
con_empresa(MAP_ID)
try:
    tenancy.assert_client_owner("c3", ANA)   # c3 es de VERA
    check("Ana en MAP accede a un contribuyente de VERA", "PERMITIDO", "404")
except HTTPException as e:
    check("Ana en MAP accede a un contribuyente de VERA", e.status_code, 404)
con_empresa(MAP_ID)
check("…pero sí al suyo de MAP", tenancy.assert_client_owner("c1", ANA), True)
con_empresa(VERA_ID)
try:
    tenancy.assert_client_owner("c1", ANA)   # c1 es SUYO, pero está en MAP
    check("Ana en VERA accede a su propio contribuyente de MAP", "PERMITIDO", "404")
except HTTPException as e:
    check("Ana en VERA accede a su propio contribuyente de MAP (dueña, pero otra empresa)",
          e.status_code, 404)

print("\n" + ("FALLOS: " + ", ".join(fallos) if fallos else "TODO CORRECTO"))
sys.exit(1 if fallos else 0)
