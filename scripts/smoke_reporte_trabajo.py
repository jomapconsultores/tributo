# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Marcar a mano lo hecho en el reporte de honorarios, contra la BD real.

El reporte deduce el trabajo de lo que quedó registrado (una declaración
guardada, un anexo generado). Lo que se hace por fuera no deja rastro que
deducir y quedaba faltante para siempre. Acá se comprueba lo que arregla eso:

    marcar un concepto como hecho lo pasa de faltante a realizado
    la marca dice que fue a mano (no se confunde con lo comprobado)
    desmarcar lo devuelve a pendiente
    y borrar la marca lo deja como lo vea el sistema

Uso (con el backend levantado):

    python scripts/smoke_reporte_trabajo.py --api http://127.0.0.1:8018

OJO — escribe en la BD que apunte `backend/.env`, pero SOLO en la tabla
`reportes_trabajo` (la que estrena este cambio) y borra al final lo que crea.
Los honorarios y las facturas no se tocan.
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

from config import get_settings           # noqa: E402
from database import get_supabase_client  # noqa: E402

_ok = _fail = 0


def check(que, cond, detalle=""):
    global _ok, _fail
    if cond:
        _ok += 1
        print(f"  OK   {que}")
    else:
        _fail += 1
        print(f"  FALLA {que}  {detalle}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8000")
    args = ap.parse_args()

    sb = get_supabase_client()
    s = get_settings()

    # Un usuario con contribuyentes visibles: el reporte es suyo.
    cl = sb.table("clients").select("user_id,identificacion,nombre").limit(50).execute().data or []
    if not cl:
        sys.exit("No hay contribuyentes en la base.")
    uid = cl[0]["user_id"]
    tok = jwt.encode({"sub": uid, "aud": "authenticated", "exp": int(time.time()) + 3600},
                     s.jwt_secret, algorithm="HS256")
    H = {"Authorization": f"Bearer {tok}"}
    base = f"{args.api}/api/reportes"

    r = requests.get(f"{base}/cobros", headers=H, timeout=120)
    if r.status_code != 200:
        sys.exit(f"GET /cobros respondió {r.status_code}: {r.text[:200]}")
    d = r.json()
    filas = d.get("data") or []
    periodo = d.get("periodo") or {}
    print(f"Período {periodo.get('etiqueta')} · {len(filas)} fila(s)")
    if not filas:
        sys.exit("Ese usuario no tiene filas en el reporte: no hay qué marcar.")

    print("=== 1. la fila trae el estado del trabajo y de dónde sale ===")
    f0 = filas[0]
    check("cada fila dice si está hecho", "hecho" in f0, list(f0)[:8])
    check("y de dónde sale ese estado", "hecho_origen" in f0, f0.get("hecho_origen"))
    check("y la periodicidad del contribuyente", "periodicidad" in f0, f0.get("periodicidad"))

    # Se trabaja sobre un concepto que HOY figura pendiente: es el caso que se
    # quiere arreglar (algo hecho por fuera que el sistema no puede deducir).
    pendiente = next((f for f in filas if not f.get("hecho")), None)
    if not pendiente:
        print("  (no hay ningún concepto pendiente: nada que marcar)")
        print(f"\n{_ok} OK · {_fail} fallas")
        sys.exit(1 if _fail else 0)
    ruc, concepto = pendiente["identificacion"], pendiente["concepto"]
    print(f"  se marca: {ruc} · {concepto}")

    def estado():
        dd = requests.get(f"{base}/cobros", headers=H, timeout=120).json()
        for f in dd.get("data") or []:
            if f["identificacion"] == ruc and f["concepto"] == concepto:
                return f
        return {}

    try:
        print("=== 2. marcarlo lo pasa a realizado ===")
        rr = requests.put(f"{base}/trabajo", headers=H, timeout=60, json={
            "identificacion": ruc, "producto": concepto, "realizado": True,
            "nota": "hecho fuera del sistema (prueba)"})
        check("PUT /trabajo responde 200", rr.status_code == 200, rr.text[:200])
        e = estado()
        check("ahora figura hecho", e.get("hecho") is True, e.get("hecho"))
        check("y consta que se marcó a mano", e.get("hecho_origen") == "manual", e.get("hecho_origen"))
        check("con su nota", "prueba" in (e.get("hecho_nota") or ""), e.get("hecho_nota"))

        print("=== 3. desmarcarlo lo devuelve a pendiente ===")
        requests.put(f"{base}/trabajo", headers=H, timeout=60, json={
            "identificacion": ruc, "producto": concepto, "realizado": False})
        e = estado()
        check("vuelve a pendiente", e.get("hecho") is False, e.get("hecho"))
        check("y sigue diciendo que es decisión de alguien",
              e.get("hecho_origen") == "manual", e.get("hecho_origen"))

        print("=== 4. borrar la marca devuelve el estado al sistema ===")
        requests.put(f"{base}/trabajo", headers=H, timeout=60, json={
            "identificacion": ruc, "producto": concepto, "realizado": None})
        e = estado()
        check("queda como lo ve el sistema", e.get("hecho") == pendiente.get("hecho"),
              f"{e.get('hecho')} vs {pendiente.get('hecho')}")
        check("sin marca manual", e.get("hecho_origen") != "manual", e.get("hecho_origen"))
    finally:
        sb.table("reportes_trabajo").delete().eq("identificacion", ruc).eq(
            "producto", concepto).eq("user_id", uid).execute()
        print("\n(marca de prueba borrada)")

    print(f"\n{_ok} OK · {_fail} fallas")
    sys.exit(1 if _fail else 0)


if __name__ == "__main__":
    main()
