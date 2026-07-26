# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Prueba de humo del cambio de periodicidad (mensual <-> semestral) contra el
backend HTTP y la BD REALES, en modo PREVISUALIZACIÓN: solo llama a
`POST /api/clients/periodicidad/preview`, que NO escribe nada.

Comprueba, para contribuyentes de verdad, que el plan que se le muestra al usuario
antes de confirmar es coherente: período destino dentro del semestre, mes ancla
6 ó 12, meses a fusionar con su conteo de comprobantes y avisos.

    cd backend
    ./venv/Scripts/python.exe ../scripts/smoke_periodicidad.py --api http://127.0.0.1:8000

La lógica pura (fusión, duplicados, vuelta a mensual) se prueba sin BD en
scripts/test_periodicidad.py.
"""
import argparse
import os
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))
os.chdir(BACKEND)

import jwt          # noqa: E402
import requests     # noqa: E402

from config import get_settings          # noqa: E402
from database import get_supabase_client  # noqa: E402

_ok = _fail = 0


def check(nombre, cond, detalle=""):
    global _ok, _fail
    if cond:
        _ok += 1
        print(f"  PASS  {nombre} {detalle}")
    else:
        _fail += 1
        print(f"  FALLA {nombre} {detalle}")
    return bool(cond)


def main():
    ap = argparse.ArgumentParser(description="Smoke del cambio de periodicidad (solo preview)")
    ap.add_argument("--api", default="http://127.0.0.1:8000")
    ap.add_argument("--ruc", help="probar con un contribuyente concreto")
    args = ap.parse_args()

    s = get_settings()
    sb = get_supabase_client()

    q = sb.table("clients").select(
        "id,user_id,identificacion,nombre,periodo_mes,periodo_anio,periodicidad,periodo_semestre")
    if args.ruc:
        q = q.eq("identificacion", args.ruc)
    filas = q.execute().data or []
    if not filas:
        sys.exit("No hay contribuyentes para probar.")

    # El período MÁS RECIENTE de cada contribuyente: es sobre el que actúa la pantalla.
    ultimo = {}
    for f in filas:
        if f.get("periodo_mes") is None or f.get("periodo_anio") is None:
            continue
        k = f["identificacion"]
        cur = ultimo.get(k)
        if not cur or (f["periodo_anio"], f["periodo_mes"]) > (cur["periodo_anio"], cur["periodo_mes"]):
            ultimo[k] = f

    mensuales = [f for f in ultimo.values() if (f.get("periodicidad") or "mensual") == "mensual"]
    semestrales = [f for f in ultimo.values() if (f.get("periodicidad") or "mensual") == "semestral"]
    print(f"Contribuyentes: {len(ultimo)} ({len(mensuales)} mensuales, {len(semestrales)} semestrales)")

    casos = mensuales[:3] + semestrales[:2]
    if not casos:
        sys.exit("No hay contribuyentes con período definido.")

    for c in casos:
        tok = jwt.encode({"sub": c["user_id"], "aud": "authenticated",
                          "exp": int(time.time()) + 600}, s.jwt_secret, algorithm="HS256")
        H = {"Authorization": f"Bearer {tok}"}
        base = f"{args.api}/api/clients/periodicidad/preview"
        es_semestral = (c.get("periodicidad") or "mensual") == "semestral"
        sem_actual = c.get("periodo_semestre") or (1 if (c["periodo_mes"] or 1) <= 6 else 2)
        print(f"\n--- {c['nombre'][:38]} ({c['identificacion']}) "
              f"período {c['periodo_mes']:02d}/{c['periodo_anio']} "
              f"{'SEMESTRAL S' + str(sem_actual) if es_semestral else 'mensual'}")

        # a) a semestral, en el semestre que contiene su período actual
        destino_sem = 1 if (c["periodo_mes"] or 1) <= 6 else 2
        r = requests.post(base, headers=H, json={
            "client_id": c["id"], "periodicidad": "semestral", "periodo_semestre": destino_sem})
        if not check("preview a semestral -> 200", r.status_code == 200, r.text[:120]):
            continue
        p = r.json()
        ancla = 6 if destino_sem == 1 else 12
        check("mes ancla correcto", p["destino"]["periodo_mes"] == ancla, p["destino"])
        check("mismo año", p["anio"] == c["periodo_anio"], p["anio"])
        check("el destino sale de un período del semestre (o se abre uno)",
              p["crear_periodo"] or bool(p["destino"]["client_id"]), p["destino"])
        ini, fin = (1, 6) if destino_sem == 1 else (7, 12)
        check("todo lo que propone unir cae en el semestre",
              all(ini <= f["periodo_mes"] <= fin and f["periodo_anio"] == p["anio"]
                  for f in p["fusionar"]), [f["periodo_mes"] for f in p["fusionar"]])
        check("no se propone unir el propio destino",
              all(f["client_id"] != p["destino"]["client_id"] for f in p["fusionar"]))
        con_datos = [f for f in p["fusionar"] if f["total"]]
        if con_datos:
            check("avisa que la declaración saldría incompleta",
                  any("incompleta" in a for a in p["avisos"]), p["avisos"])
            print(f"        uniría: " + ", ".join(
                f"mes {f['periodo_mes']:02d} ({f['total']} compr.)" for f in con_datos))
        else:
            print("        no hay meses sueltos con comprobantes que unir")

        # b) vuelta a mensual
        r2 = requests.post(base, headers=H, json={"client_id": c["id"], "periodicidad": "mensual"})
        if check("preview a mensual -> 200", r2.status_code == 200, r2.text[:120]):
            p2 = r2.json()
            check("a mensual no propone fusionar nada", not p2["fusionar"], p2["fusionar"])
            if es_semestral:
                check("avisa dónde quedan los comprobantes del semestre",
                      any("quedan todos en el mes" in a for a in p2["avisos"]), p2["avisos"])

    # Tenancy: un client_id ajeno no debe dejar previsualizar.
    tok = jwt.encode({"sub": casos[0]["user_id"], "aud": "authenticated",
                      "exp": int(time.time()) + 600}, s.jwt_secret, algorithm="HS256")
    r = requests.post(f"{args.api}/api/clients/periodicidad/preview",
                      headers={"Authorization": f"Bearer {tok}"},
                      json={"client_id": "00000000-0000-0000-0000-000000000000",
                            "periodicidad": "semestral", "periodo_semestre": 1})
    print()
    check("cliente ajeno -> 403/404", r.status_code in (403, 404), r.status_code)
    check("sin token -> 401", requests.post(
        f"{args.api}/api/clients/periodicidad/preview",
        json={"client_id": casos[0]["id"], "periodicidad": "mensual"}).status_code == 401)

    print(f"\n===== RESULTADO: {_ok} PASS / {_fail} FALLA =====")
    return 1 if _fail else 0


if __name__ == "__main__":
    sys.exit(main())
