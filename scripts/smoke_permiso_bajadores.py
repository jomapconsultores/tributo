# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""El permiso de los bajadores, contra el backend y la BD reales.

Comprueba lo único que sostiene la protección:

    la llave desconocida no pasa
    la llave se ata a la PRIMERA máquina que la usa
    desde otra máquina, no corre
    revocada, deja de correr aunque sea la máquina buena
    y todo intento queda en la bitácora

Uso (con el backend levantado):

    python scripts/smoke_permiso_bajadores.py --api http://127.0.0.1:8017

OJO — escribe en la BD que apunte `backend/.env`, pero SOLO en las tablas de
permisos (`bajadores_llaves` / `bajadores_usos`) y borra al final la llave de
prueba que crea. No toca permisos de personas reales.
"""
import argparse
import os
import sys
import uuid
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))
os.chdir(BACKEND)

import requests     # noqa: E402

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
    base = f"{args.api}/api/bajadores/permiso"

    llave = "prueba-" + uuid.uuid4().hex
    usuario = str(uuid.uuid4())
    fila = sb.table("bajadores_llaves").insert({
        "user_id": usuario, "cual": "todos", "llave": llave,
        "nota": "llave de prueba automática",
    }).execute().data[0]
    print(f"Llave de prueba creada ({llave[:14]}…)")

    def pedir(dispositivo, cual="gastos"):
        return requests.post(base, timeout=60, json={
            "llave": llave, "dispositivo": dispositivo,
            "dispositivo_nombre": "Equipo " + dispositivo[-2:],
            "cual": cual, "identificacion": "0400533824001", "periodo": "07/2026",
        }).json()

    try:
        print("=== 1. una llave que nadie emitió no sirve ===")
        r = requests.post(base, timeout=60, json={
            "llave": "no-existe-" + uuid.uuid4().hex, "dispositivo": "maquina-A"}).json()
        check("rechaza la llave desconocida", r.get("ok") is False, r)
        check("y dice por qué", r.get("motivo") == "desconocida", r.get("motivo"))

        print("=== 2. la primera máquina la activa ===")
        r = pedir("maquina-A")
        check("deja pasar y la activa", r.get("ok") is True and r.get("motivo") == "activada", r)
        guardada = sb.table("bajadores_llaves").select("dispositivo").eq(
            "id", fila["id"]).execute().data[0]
        check("queda atada a esa máquina", guardada["dispositivo"] == "maquina-A", guardada)

        print("=== 3. la misma máquina sigue trabajando ===")
        r = pedir("maquina-A")
        check("segundo uso, sin fricción", r.get("ok") is True and r.get("motivo") == "ok", r)

        print("=== 4. otra máquina, no ===")
        r = pedir("maquina-B")
        check("rechaza la copia en otro equipo", r.get("ok") is False, r)
        check("y lo explica", r.get("motivo") == "otra_maquina", r.get("motivo"))

        print("=== 5. revocada, se apaga ===")
        sb.table("bajadores_llaves").update({"activa": False}).eq("id", fila["id"]).execute()
        r = pedir("maquina-A")
        check("ni siquiera en su propia máquina", r.get("ok") is False, r)
        check("y dice que fue dada de baja", r.get("motivo") == "revocada", r.get("motivo"))

        print("=== 6. todo queda en la bitácora ===")
        usos = sb.table("bajadores_usos").select("resultado").eq(
            "llave_id", fila["id"]).execute().data or []
        resultados = [u["resultado"] for u in usos]
        # Cuatro: el intento con llave inventada no cuelga de ninguna llave.
        check("quedaron los 4 intentos de esta llave", len(resultados) == 4, resultados)
        check("con su resultado cada uno",
              set(resultados) == {"activada", "ok", "otra_maquina", "revocada"},
              resultados)
        # El intento con llave inventada no cuelga de ninguna llave, pero se anota.
        sueltos = sb.table("bajadores_usos").select("id").eq(
            "resultado", "desconocida").limit(1).execute().data or []
        check("y el intento con marcador ajeno también", bool(sueltos))
    finally:
        sb.table("bajadores_usos").delete().eq("llave_id", fila["id"]).execute()
        sb.table("bajadores_llaves").delete().eq("id", fila["id"]).execute()
        print("\n(llave de prueba borrada)")

    print(f"\n{_ok} OK · {_fail} fallas")
    sys.exit(1 if _fail else 0)


if __name__ == "__main__":
    main()
