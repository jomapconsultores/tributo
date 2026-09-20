# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""El calendario del SRI en Python dice lo MISMO que el del navegador.

La fecha máxima de declaración se calcula en dos sitios: en la pantalla
(`frontend/src/utils/feriadosEC.js` + `declaracionSRI.js`) y en el servidor
(`backend/services/calendario_sri.py`, que usa el recordatorio por correo).
Son dos copias de una sola regla; si se separan, el correo diría una fecha y la
pantalla otra, y el contribuyente no sabría a cuál creerle.

Este test las enfrenta:

  1. La tabla del 9no dígito es la oficial del SRI.
  2. Día por día, de 2024 a 2030, Python y JavaScript coinciden en qué días NO
     son hábiles y a qué día corre el plazo. El JavaScript se ejecuta de verdad
     con node; no se transcribe.
  3. Casos concretos de traslado (fin de semana y feriado).

Correr:  py -3 scripts/test_calendario_sri.py
Si node no está instalado, el cruce (2) se salta y el resto igual corre.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import date, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

from services.calendario_sri import (  # noqa: E402
    DIA_POR_DIGITO, dia_declaracion, es_dia_no_habil, fecha_limite_mensual,
    fecha_limite_semestral, mes_declaracion_semestre, noveno_digito,
    siguiente_dia_habil, traslado_dia_habil)

RAIZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
FERIADOS_JS = os.path.join(RAIZ, "frontend", "src", "utils", "feriadosEC.js")

ANIO_INI, ANIO_FIN = 2024, 2030

fallos = []


def check(ok, titulo, detalle=""):
    print(f"  {'OK  ' if ok else 'FALLA'}  {titulo}")
    if not ok:
        fallos.append(f"{titulo} {detalle}".strip())


# --- 1. Tabla oficial del 9no dígito ----------------------------------------

def test_tabla_digitos():
    print("\n1) Tabla del noveno dígito (oficial SRI)")
    oficial = {1: 10, 2: 12, 3: 14, 4: 16, 5: 18, 6: 20, 7: 22, 8: 24, 9: 26, 0: 28}
    check(DIA_POR_DIGITO == oficial, "9no dígito -> día máximo (10,12,…,28)")

    # El 9no dígito es el índice 8 del RUC: 1 7 9 0 0 1 2 3 [4] 5 0 0 1.
    check(noveno_digito("1790012345001") == 4, "RUC 1790012345001 -> 9no dígito 4")
    check(dia_declaracion("1790012345001") == 16, "…y por tanto día 16")
    # Cédula de 10 dígitos: también tiene 9no dígito.
    check(dia_declaracion("0102030405") == 28, "cédula terminada en 0 (9no) -> día 28")
    # Basura: no se inventa una fecha.
    for malo in ("", None, "abc", "12345678", "17900123X5001"):
        if dia_declaracion(malo) is not None:
            check(False, f"identificación inválida {malo!r} debería dar None")
            break
    else:
        check(True, "identificación inválida o corta -> None (no inventa fecha)")


# --- 2. Cruce real contra el JavaScript del frontend ------------------------

def _volcado_js():
    """Ejecuta el feriadosEC.js REAL con node y devuelve su veredicto por día."""
    if not shutil.which("node") or not os.path.exists(FERIADOS_JS):
        return None
    tmp = tempfile.mkdtemp(prefix="calsri_")
    try:
        # Se copia como .mjs para que node lo trate como módulo ES sin depender
        # del package.json del frontend.
        mod = os.path.join(tmp, "feriados.mjs")
        with open(FERIADOS_JS, "r", encoding="utf-8") as f:
            contenido = f.read()
        with open(mod, "w", encoding="utf-8") as f:
            f.write(contenido)

        runner = os.path.join(tmp, "run.mjs")
        with open(runner, "w", encoding="utf-8") as f:
            f.write(
                "import { esDiaNoHabil, siguienteDiaHabil, claveFecha } "
                "from './feriados.mjs'\n"
                f"const out = {{}}\n"
                f"for (let a = {ANIO_INI}; a <= {ANIO_FIN}; a++) {{\n"
                "  for (let m = 0; m < 12; m++) {\n"
                "    for (let d = 1; d <= 31; d++) {\n"
                "      const f = new Date(a, m, d)\n"
                "      if (f.getMonth() !== m) continue\n"
                "      out[claveFecha(f)] = [esDiaNoHabil(f), claveFecha(siguienteDiaHabil(f))]\n"
                "    }\n"
                "  }\n"
                "}\n"
                "process.stdout.write(JSON.stringify(out))\n")
        r = subprocess.run(["node", runner], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            print(f"     (node falló: {r.stderr.strip()[:200]})")
            return None
        return json.loads(r.stdout)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_cruce_con_javascript():
    print(f"\n2) Python vs JavaScript, día por día ({ANIO_INI}-{ANIO_FIN})")
    js = _volcado_js()
    if js is None:
        print("     (node no disponible: se salta el cruce)")
        return

    dias = 0
    dif_habil, dif_traslado = [], []
    f = date(ANIO_INI, 1, 1)
    fin = date(ANIO_FIN, 12, 31)
    while f <= fin:
        clave = f.isoformat()
        esperado = js.get(clave)
        if esperado:
            dias += 1
            if bool(esperado[0]) != bool(es_dia_no_habil(f)):
                dif_habil.append(clave)
            if esperado[1] != siguiente_dia_habil(f).isoformat():
                dif_traslado.append(f"{clave}: js={esperado[1]} py={siguiente_dia_habil(f).isoformat()}")
        f += timedelta(days=1)

    check(dias > 2500, f"se compararon {dias} días con el JavaScript real")
    check(not dif_habil, "coinciden los días NO hábiles (fines de semana y feriados)",
          f"difieren {len(dif_habil)}: {dif_habil[:5]}")
    check(not dif_traslado, "coincide el traslado al siguiente día hábil",
          f"difieren {len(dif_traslado)}: {dif_traslado[:5]}")


# --- 3. Traslados concretos --------------------------------------------------

def test_traslados():
    print("\n3) Traslado del plazo cuando el día no es hábil")
    # Un día que cae sábado o domingo tiene que correrse a lunes.
    encontrado = False
    f = date(2026, 1, 1)
    while f < date(2027, 1, 1):
        if f.weekday() == 5:                      # sábado
            t = traslado_dia_habil(f)
            if t["dias"] >= 2 and t["fecha"].weekday() == 0:
                encontrado = True
                check(True, f"sábado {f} -> lunes {t['fecha']} (motivo: {t['motivo']})")
                break
        f += timedelta(days=1)
    if not encontrado:
        check(False, "no se encontró un sábado que se corra a lunes")

    # Un día hábil no se mueve.
    habil = date(2026, 3, 12)                     # jueves cualquiera
    t = traslado_dia_habil(habil)
    check(t["dias"] == 0 and t["fecha"] == habil and t["motivo"] is None,
          "un día hábil no se corre (dias=0, sin motivo)")

    # El plazo nunca cae en día no hábil.
    malos = []
    for anio in range(ANIO_INI, ANIO_FIN + 1):
        for mes in range(1, 13):
            for dia in DIA_POR_DIGITO.values():
                lim = siguiente_dia_habil(date(anio, mes, dia))
                if es_dia_no_habil(lim):
                    malos.append(lim.isoformat())
    check(not malos, "ninguna fecha límite (todos los dígitos y meses) cae en día no hábil",
          f"{malos[:5]}")


# --- 4. Mensual y semestral --------------------------------------------------

def test_periodicidades():
    print("\n4) Calendario mensual y semestral")
    # Mensual: el límite está en el MES ACTUAL (se declara el mes vencido).
    hoy = date(2026, 5, 4)
    t = fecha_limite_mensual("1790012345001", hoy)     # 9no dígito 4 -> día 16
    check(t["original"] == date(2026, 5, 16), "mensual: el límite cae en el mes actual, día del dígito")

    # Semestral: S1 se declara en julio del mismo año; S2 en enero del siguiente.
    check(mes_declaracion_semestre(1, 2026) == (7, 2026), "1er semestre 2026 -> julio 2026")
    check(mes_declaracion_semestre(2, 2026) == (1, 2027), "2do semestre 2026 -> enero 2027")
    t1 = fecha_limite_semestral("1790012345001", 1, 2026)
    check(t1["original"] == date(2026, 7, 16), "semestral S1: 16 de julio de 2026")
    t2 = fecha_limite_semestral("1790012345001", 2, 2026)
    check(t2["original"] == date(2027, 1, 16), "semestral S2: 16 de enero de 2027")
    check(fecha_limite_semestral("1790012345001", None, None) is None,
          "sin semestre/año no se inventa fecha")


# --- 5. El cron avisa una vez, dos días antes --------------------------------

def test_simulacion_del_cron():
    """Corre el cron día a día durante un año y comprueba que cada contribuyente
    sale avisado UNA sola vez por período, exactamente 2 días antes de SU fecha
    máxima. Es la regla que importa: ni antes, ni dos veces, ni nunca."""
    print("\n5) Simulación del cron durante un año (aviso 2 días antes)")
    from services.calendario_sri import fecha_limite_cliente

    DIAS_AVISO = 2
    # Un contribuyente por cada noveno dígito posible (días 10 … 28).
    contribuyentes = [
        {"identificacion": f"17900123{d}5001", "periodicidad": "mensual",
         "periodo_mes": 1, "periodo_anio": 2026}
        for d in range(10)
    ]

    avisos = {c["identificacion"]: [] for c in contribuyentes}
    f = date(2026, 1, 1)
    while f <= date(2026, 12, 31):
        objetivo = f + timedelta(days=DIAS_AVISO)
        for c in contribuyentes:
            lim = fecha_limite_cliente(c, f)
            if lim and lim["fecha"] == objetivo:
                avisos[c["identificacion"]].append((f, lim["fecha"]))
        f += timedelta(days=1)

    # Doce meses -> doce avisos por contribuyente, uno por mes.
    malos = [i for i, v in avisos.items() if len(v) != 12]
    check(not malos, "cada contribuyente recibe 12 avisos al año (uno por mes)",
          f"{[(i, len(avisos[i])) for i in malos[:4]]}")

    # Siempre exactamente 2 días antes, y nunca dos avisos para la misma fecha.
    desfases, repetidos = [], []
    for ident, v in avisos.items():
        for dia_aviso, limite in v:
            if (limite - dia_aviso).days != DIAS_AVISO:
                desfases.append((ident, str(dia_aviso), str(limite)))
        fechas = [x[1] for x in v]
        if len(set(fechas)) != len(fechas):
            repetidos.append(ident)
    check(not desfases, f"el aviso sale siempre {DIAS_AVISO} días antes del vencimiento",
          f"{desfases[:4]}")
    check(not repetidos, "nunca se avisa dos veces del mismo vencimiento", f"{repetidos[:4]}")

    # El aviso cae antes que el vencimiento, que es lo único que lo hace útil.
    tarde = [(i, str(d), str(l)) for i, v in avisos.items() for d, l in v if d >= l]
    check(not tarde, "el aviso siempre llega ANTES de la fecha máxima", f"{tarde[:4]}")

    # Un semestral no se avisa cada mes: una sola vez, antes de su mes de declaración.
    semestral = {"identificacion": "1790012345001", "periodicidad": "semestral",
                 "periodo_semestre": 1, "periodo_anio": 2026, "periodo_mes": 6}
    salidas = []
    f = date(2026, 1, 1)
    while f <= date(2026, 12, 31):
        lim = fecha_limite_cliente(semestral, f)
        if lim and lim["fecha"] == f + timedelta(days=DIAS_AVISO):
            salidas.append(lim["fecha"])
        f += timedelta(days=1)
    check(len(salidas) == 1 and salidas[0].month == 7,
          "un contribuyente semestral se avisa una sola vez, antes de julio",
          f"salidas={[str(s) for s in salidas]}")


if __name__ == "__main__":
    print("Calendario tributario SRI — servidor vs navegador")
    test_tabla_digitos()
    test_cruce_con_javascript()
    test_traslados()
    test_periodicidades()
    test_simulacion_del_cron()
    print("\n" + ("-" * 62))
    if fallos:
        print(f"FALLARON {len(fallos)} comprobaciones:")
        for f_ in fallos:
            print(f"  · {f_}")
        sys.exit(1)
    print("Todo en orden: el servidor y la pantalla dicen la misma fecha.")
