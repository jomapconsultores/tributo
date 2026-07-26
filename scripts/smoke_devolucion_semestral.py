# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Devolución de IVA de un contribuyente SEMESTRAL contra el backend y la BD reales.

El tope de la devolución es MENSUAL, así que un período semestral lleva SEIS topes
(uno por mes) y el monto a solicitar es la SUMA de lo que cabe en cada mes — no
`min(IVA del semestre, un tope)`. Este smoke lo comprueba de punta a punta:
comprobantes → guardar → desglose por mes → paquete de envío → Excel → borrar.

    cd backend
    ./venv/Scripts/python.exe ../scripts/smoke_devolucion_semestral.py --api http://127.0.0.1:8000

ESCRIBE en la BD que apunte `backend/.env`: guarda una solicitud de prueba y la
borra al terminar. Se niega a correr si ya existe una del período (el guardado la
reemplazaría). El e2e completo (contribuyente mensual) está en
scripts/e2e_devoluciones_iva.py.
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
    ap = argparse.ArgumentParser(description="Smoke de devolución IVA semestral")
    ap.add_argument("--api", default="http://127.0.0.1:8000")
    ap.add_argument("--ruc", help="contribuyente semestral concreto")
    args = ap.parse_args()

    s = get_settings()
    sb = get_supabase_client()

    q = sb.table("clients").select(
        "id,user_id,identificacion,nombre,periodo_mes,periodo_anio,periodicidad,periodo_semestre"
    ).eq("periodicidad", "semestral")
    if args.ruc:
        q = q.eq("identificacion", args.ruc)
    filas = q.execute().data or []
    if not filas:
        sys.exit("No hay contribuyentes semestrales.")

    mejor, mejor_n = None, -1
    for f in filas:
        n = len(sb.table("invoices").select("id").eq("client_id", f["id"]).execute().data or [])
        if n > mejor_n:
            mejor, mejor_n = f, n
    if mejor_n <= 0:
        sys.exit("Ningún contribuyente semestral tiene comprobantes cargados.")
    c = mejor
    print(f"Contribuyente SEMESTRAL: {c['identificacion']} — {c['nombre']}")
    print(f"Período: S{c['periodo_semestre']} {c['periodo_anio']} (ancla {c['periodo_mes']:02d}) "
          f"— comprobantes: {mejor_n}")

    previa = sb.table("devoluciones_iva_solicitudes").select("id").eq(
        "client_id", c["id"]).eq("mes", c["periodo_mes"]).eq("anio", c["periodo_anio"]).execute().data
    if previa:
        sys.exit("Ya existe una solicitud de ese período; el guardado la reemplazaría. Aborto.")

    tok = jwt.encode({"sub": c["user_id"], "aud": "authenticated",
                      "exp": int(time.time()) + 900}, s.jwt_secret, algorithm="HS256")
    H = {"Authorization": f"Bearer {tok}"}
    base = f"{args.api}/api/devoluciones-iva"

    print("=== 1. comprobantes del semestre ===")
    d = requests.get(f"{base}/comprobantes", params={"client_id": c["id"]}, headers=H).json()
    check("el período se reconoce semestral", d.get("periodicidad") == "semestral", d.get("periodicidad"))
    check("cubre los seis meses", len(d.get("meses") or []) == 6, d.get("meses"))
    check("la etiqueta dice semestre", "semestre" in (d.get("periodo") or "").lower(), d.get("periodo"))
    comps = d["comprobantes"]
    check("hay comprobantes", len(comps) > 0, len(comps))
    ids = [x["id"] for x in comps]

    print("=== 2. guardar con los seis topes ===")
    r = requests.post(f"{base}/solicitudes", headers=H, json={
        "client_id": c["id"], "tipo_beneficiario": "tercera_edad", "invoice_ids": ids})
    if not check("POST 200", r.status_code == 200, r.text[:200]):
        sys.exit(1)
    sol = r.json()
    sid = sol["id"]
    det = sol["detalle_meses"]
    print(f"    IVA {sol['total_iva']} · tope período {sol['tope_mensual']} "
          f"· solicitado {sol['monto_solicitado']} · excedente {sol['excedente']}")
    for m in det:
        print(f"      mes {m['mes']:02d}: {m['comprobantes']:>4} compr. · IVA {m['iva']:>9} "
              f"· tope {m['tope']} · pide {m['solicitar']:>9} · sobra {m['excedente']}")
    try:
        check("un desglose por cada mes del semestre", len(det) == 6, len(det))
        check("los meses son los del semestre",
              [m["mes"] for m in det] == list(range(1, 7) if c["periodo_semestre"] == 1 else range(7, 13)),
              [m["mes"] for m in det])
        check("todos los meses llevan el MISMO tope mensual",
              len({m["tope"] for m in det}) == 1, {m["tope"] for m in det})
        check("el tope del período es la suma de los seis",
              round(sum(m["tope"] for m in det), 2) == round(sol["tope_mensual"], 2))
        check("cada mes pide min(IVA del mes, tope del mes)",
              all(m["solicitar"] == round(min(m["iva"], m["tope"]), 2) for m in det))
        check("el monto es la suma de los meses",
              round(sum(m["solicitar"] for m in det), 2) == sol["monto_solicitado"])
        check("el IVA del período es la suma de los meses",
              round(sum(m["iva"] for m in det), 2) == sol["total_iva"])
        check("los comprobantes del desglose son todos los marcados",
              sum(m["comprobantes"] for m in det) == len(ids),
              f"{sum(m['comprobantes'] for m in det)} vs {len(ids)}")
        # Lo que distingue al semestral: NO se compara el IVA total contra un solo tope.
        tope_mes = det[0]["tope"]
        if sol["total_iva"] > tope_mes:
            check("no se recorta al tope de UN mes (es semestral)",
                  sol["monto_solicitado"] != round(min(sol["total_iva"], tope_mes), 2),
                  f"pide {sol['monto_solicitado']}, un solo tope daría {min(sol['total_iva'], tope_mes)}")

        print("=== 3. rubros ===")
        d2 = requests.get(f"{base}/comprobantes", params={"client_id": c["id"]}, headers=H).json()
        check("todos los ítems quedaron con tipo de gasto",
              all(x.get("rubro") for x in d2["comprobantes"]))

        print("=== 4. paquete de envío y Excel ===")
        env = requests.get(f"{base}/solicitudes/{sid}/envio", headers=H)
        if check("envio 200", env.status_code == 200, env.text[:120]):
            p = env.json()
            check("el paquete trae el desglose por mes", len(p["detalle_meses"]) == 6)
            check("la etiqueta del período dice semestre",
                  "semestre" in p["periodo"]["etiqueta"].lower(), p["periodo"]["etiqueta"])
        x = requests.get(f"{base}/solicitudes/{sid}/export/excel", headers=H)
        check("excel 200 y es xlsx", x.status_code == 200 and x.content[:2] == b"PK", f"{len(x.content)} bytes")
        check("el archivo se llama por semestre", "-S" in x.headers.get("content-disposition", ""),
              x.headers.get("content-disposition"))
    finally:
        print("=== 5. limpieza ===")
        check("delete 200", requests.delete(f"{base}/solicitudes/{sid}", headers=H).status_code == 200)
        queda = sb.table("devoluciones_iva_solicitudes").select("id").eq("id", sid).execute().data
        check("no queda la solicitud de prueba", not queda)
        check("no quedan ítems huérfanos", not (sb.table("devoluciones_iva_items").select("id").eq(
            "solicitud_id", sid).execute().data or []))

    print(f"\n===== RESULTADO: {_ok} PASS / {_fail} FALLA =====")
    return 1 if _fail else 0


if __name__ == "__main__":
    sys.exit(main())
