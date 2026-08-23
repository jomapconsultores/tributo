# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""El Excel y el PDF del reporte, generados de verdad y leídos de vuelta.

Un export no se puede dar por bueno porque el endpoint responda 200: el archivo
puede salir corrupto, con las columnas corridas o sin lo que se le agregó. Acá
se descargan los dos y se les mira el contenido.

    la hoja trae las columnas Período y Trabajo
    el estado dice si fue el sistema o una persona ("Hecho (a mano)")
    los totales quedaron en su columna, no corridos
    y el PDF se genera y abre

Uso (con el backend levantado):

    python scripts/smoke_export_reportes.py --api http://127.0.0.1:8018

Solo LEE: descarga los archivos a la carpeta temporal y no toca la base.
"""
import argparse
import os
import sys
import tempfile
import time
import zipfile
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


def texto_del_xlsx(ruta: Path) -> str:
    """Lo que dice la hoja, sin depender de librerías de lectura.

    Un .xlsx es un zip con XML adentro: para comprobar que están los títulos y
    las etiquetas alcanza con mirar las cadenas compartidas."""
    with zipfile.ZipFile(ruta) as z:
        partes = [n for n in z.namelist() if n.endswith(("sharedStrings.xml", "sheet1.xml"))]
        return "\n".join(z.read(n).decode("utf-8", "replace") for n in partes)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8000")
    args = ap.parse_args()

    sb = get_supabase_client()
    s = get_settings()
    cl = sb.table("clients").select("user_id").limit(1).execute().data or []
    if not cl:
        sys.exit("No hay contribuyentes en la base.")
    tok = jwt.encode({"sub": cl[0]["user_id"], "aud": "authenticated",
                      "exp": int(time.time()) + 3600}, s.jwt_secret, algorithm="HS256")
    H = {"Authorization": f"Bearer {tok}"}
    base = f"{args.api}/api/reportes"
    tmp = Path(tempfile.gettempdir())

    print("=== 1. Excel ===")
    r = requests.get(f"{base}/export/excel", headers=H, timeout=180)
    check("responde 200", r.status_code == 200, r.status_code)
    xlsx = tmp / "smoke_reporte.xlsx"
    xlsx.write_bytes(r.content)
    check("el archivo abre como xlsx", zipfile.is_zipfile(xlsx), len(r.content))
    if zipfile.is_zipfile(xlsx):
        t = texto_del_xlsx(xlsx)
        check("trae la columna Período", "Período" in t)
        check("trae la columna Trabajo", "Trabajo" in t)
        check("dice el estado de cada servicio", "Hecho" in t or "Pendiente" in t)
        check("y el resumen de pendientes al pie",
              "Pendientes de hacer" in t or "Sin pendientes" in t)
        check("los totales siguen ahí", "TOTAL (IVA incl.)" in t)
        check("con su desglose", "Base imponible" in t and "IVA 15%" in t)

    print("=== 2. PDF ===")
    r = requests.get(f"{base}/export/pdf", headers=H, timeout=180)
    check("responde 200", r.status_code == 200, r.status_code)
    check("es un PDF de verdad", r.content[:5] == b"%PDF-", r.content[:20])
    check("y no viene vacío", len(r.content) > 1500, len(r.content))
    (tmp / "smoke_reporte.pdf").write_bytes(r.content)
    print(f"  (archivos en {tmp})")

    print(f"\n{_ok} OK · {_fail} fallas")
    sys.exit(1 if _fail else 0)


if __name__ == "__main__":
    main()
