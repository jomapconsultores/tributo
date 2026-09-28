# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Prueba que un corte de conexión con la base no llegue a la pantalla.

No toca la red: simula las respuestas y los cortes.

    python scripts/test_reintento_conexion.py

El caso real: «Error del servidor (RemoteProtocolError)» al abrir el informe
general y la facturación. El proxy que tiene delante la base multiplexa las
peticiones sobre UNA conexión HTTP/2 y, cuando se le amontonan varias con
query strings enormes (listas largas de client_id), la corta con GOAWAY. Los
dos endpoints que fallaban eran los únicos que lanzaban cinco consultas a la
vez compartiendo el mismo cliente.

Lo que se comprueba:
  · un corte de conexión se reintenta y la consulta termina bien;
  · un error de DATOS (columna inexistente, permisos) NO se reintenta: sería
    esconder un error real detrás de cuatro esperas;
  · si el corte no cede, el error se propaga (no se devuelve nada a medias);
  · la espera entre intentos CRECE, en vez de reintentar de inmediato;
  · `get_supabase_client_aislado()` devuelve un cliente NUEVO cada vez —ese es
    el punto: que cada hilo tenga su conexión— mientras que
    `get_supabase_client()` sigue cacheado para el resto de la app.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

for _var, _val in (("SUPABASE_URL", "http://localhost"), ("SUPABASE_SERVICE_KEY", "x"),
                   ("SUPABASE_ANON_KEY", "x"), ("JWT_SECRET", "x")):
    os.environ.setdefault(_var, _val)

import database

fallos = []


def check(ok, titulo, detalle=""):
    print(("  OK   " if ok else "  FALLA") + f"  {titulo}" + (f"  ->  {detalle}" if not ok and detalle else ""))
    if not ok:
        fallos.append(titulo)


# Las esperas no se cumplen de verdad: se anotan, para poder revisarlas.
esperas = []
database._time.sleep = lambda s: esperas.append(round(s, 3))
# Sin azar, para que la progresión sea comprobable.
database._random.random = lambda: 0.0


class ErrorCorte(Exception):
    """Lo que levanta httpx cuando el proxy corta la conexión."""
    def __init__(self):
        super().__init__("RemoteProtocolError: Server disconnected without sending a response")


class ErrorDeDatos(Exception):
    def __init__(self):
        super().__init__('column "no_existe" does not exist')


class ConsultaFalsa:
    """Falla las primeras `cortes` veces y después responde."""
    def __init__(self, cortes, error=ErrorCorte):
        self.cortes, self.error, self.intentos = cortes, error, 0

    def __call__(self):
        return self

    def execute(self):
        self.intentos += 1
        if self.intentos <= self.cortes:
            raise self.error()
        return type("Res", (), {"data": [{"id": 1}], "count": None})()


print("\n=== Cortes de conexion con la base ===\n")

# 1. Un corte aislado se reintenta y la consulta sale bien.
esperas.clear()
q = ConsultaFalsa(cortes=1)
res = database._ejecutar_con_reintento(q)
check(res.data == [{"id": 1}] and q.intentos == 2,
      "un corte suelto se reintenta y la consulta termina bien",
      f"intentos={q.intentos}")

# 2. Aguanta una racha: cuatro cortes seguidos y todavía se recupera.
esperas.clear()
q = ConsultaFalsa(cortes=4)
res = database._ejecutar_con_reintento(q)
check(res.data == [{"id": 1}] and q.intentos == 5,
      "aguanta cuatro cortes seguidos (antes se rendia al tercero)",
      f"intentos={q.intentos}")

# 3. La espera CRECE. Reintentar de inmediato cae dentro del mismo atasco.
check(esperas == [0.2, 0.4, 0.8, 1.6],
      "la espera entre intentos se duplica cada vez", str(esperas))

# 4. Un error de datos se propaga en el acto: no es un corte, es un bug.
esperas.clear()
q = ConsultaFalsa(cortes=99, error=ErrorDeDatos)
try:
    database._ejecutar_con_reintento(q)
    check(False, "un error de datos NO se reintenta")
except ErrorDeDatos:
    check(q.intentos == 1 and esperas == [],
          "un error de datos NO se reintenta: se propaga tal cual",
          f"intentos={q.intentos} esperas={esperas}")

# 5. Si el corte no cede, el error sale: nunca se devuelve una respuesta a medias.
esperas.clear()
q = ConsultaFalsa(cortes=99)
try:
    database._ejecutar_con_reintento(q)
    check(False, "un corte que no cede tiene que propagarse")
except Exception as e:
    check(q.intentos == 5 and "RemoteProtocolError" in str(e),
          "si el corte no cede tras los intentos, el error se propaga",
          f"intentos={q.intentos}")

# 6. El azar separa a dos hilos que fallaron juntos.
database._random.random = lambda: 1.0
esperas.clear()
q = ConsultaFalsa(cortes=1)
database._ejecutar_con_reintento(q)
check(esperas == [0.25],
      "la espera lleva algo de azar, para que dos hilos no reintenten a la vez",
      str(esperas))
database._random.random = lambda: 0.0

print("\n=== Una conexion por hilo ===\n")

creados = []
database.create_client = lambda url, key: creados.append(key) or object()

# 7. El cliente aislado es NUEVO cada vez: es su razón de ser.
a = database.get_supabase_client_aislado()
b = database.get_supabase_client_aislado()
check(a is not b, "get_supabase_client_aislado() devuelve un cliente distinto cada vez")
check(len(creados) == 2, "y abre su propia conexion cada vez", f"creados={len(creados)}")

# 8. El de siempre sigue cacheado: no se multiplican conexiones en toda la app.
database.get_supabase_client.cache_clear()
creados.clear()
c1 = database.get_supabase_client()
c2 = database.get_supabase_client()
check(c1 is c2 and len(creados) == 1,
      "get_supabase_client() sigue cacheado (uno solo para el resto de la app)",
      f"creados={len(creados)}")

print()
if fallos:
    print(f"FALLARON {len(fallos)} comprobacion(es):")
    for f_ in fallos:
        print("  - " + f_)
    sys.exit(1)
print("Todo en orden.\n")
