# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Verificación end-to-end del módulo Devolución de IVA (tercera edad / discapacidad).

Ejercita las 7 rutas de `/api/devoluciones-iva` contra el backend HTTP real y la
BD real: topes, comprobantes, guardar, reemplazo UNIQUE(client,mes,anio),
validaciones, tope proporcional por discapacidad, excedente, tenancy, cambio de
estado, export Excel y borrado. Es el equivalente ejecutable del checklist de
`docs/verificacion-devolucion-iva-e2e.md`.

Uso (con el backend levantado en :8000):

    cd backend
    ./venv/Scripts/python.exe ../scripts/e2e_devoluciones_iva.py
    ./venv/Scripts/python.exe ../scripts/e2e_devoluciones_iva.py --ruc 0918099342001

OJO — el script ESCRIBE en la BD que apunte `backend/.env`. Guarda una solicitud
de prueba en el período del contribuyente elegido y la borra al final. Como el
endpoint de guardado REEMPLAZA la solicitud del período, el script se **niega a
correr** si ya existe una solicitud para ese cliente/período (usa --force solo si
de verdad esa solicitud es descartable). Elige por defecto un contribuyente con
el servicio `devolucion_iva` activo y comprobantes cargados.
"""
import argparse
import os
import sys
import time
from pathlib import Path

# El script vive en scripts/ pero importa config/database del backend.
BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))
os.chdir(BACKEND)  # para que python-dotenv encuentre backend/.env

import jwt          # noqa: E402
import requests     # noqa: E402

from config import get_settings          # noqa: E402
from database import get_supabase_client  # noqa: E402

TOPES_ESPERADOS = {
    ("tercera_edad", 2026, None): 361.50,   # 482 x 5 x 0.15
    ("discapacidad", 2026, 85): 144.60,     # 482 x 2 x 0.15 x 1.0
    ("discapacidad", 2026, 40): 86.76,      # 144.60 x 0.6
}

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


def elegir_cliente(sb, ruc=None, client_id=None):
    """Contribuyente con servicio `devolucion_iva` y, de preferencia, comprobantes."""
    svc = sb.table("client_services").select("client_id").eq(
        "service", "devolucion_iva").execute().data or []
    ids = [s["client_id"] for s in svc]
    if not ids:
        sys.exit("No hay ningún contribuyente con el servicio 'devolucion_iva' activo.")

    q = sb.table("clients").select(
        "id,user_id,identificacion,nombre,periodo_mes,periodo_anio").in_("id", ids)
    if client_id:
        q = q.eq("id", client_id)
    elif ruc:
        q = q.eq("identificacion", ruc)
    filas = q.execute().data or []
    if not filas:
        sys.exit("Ese contribuyente no existe o no tiene el servicio 'devolucion_iva'.")

    # Preferir el que tenga comprobantes: sin ellos no se puede probar el flujo.
    mejor, mejor_n = None, -1
    for f in filas:
        n = len(sb.table("invoices").select("id").eq("client_id", f["id"]).execute().data or [])
        if n > mejor_n:
            mejor, mejor_n = f, n
    if mejor_n <= 0:
        sys.exit(f"'{mejor['nombre']}' no tiene comprobantes cargados; sube facturas "
                 f"(TXT/XML o sri_downloader) o elige otro con --ruc.")
    return mejor, mejor_n


def main():
    ap = argparse.ArgumentParser(description="E2E del módulo Devolución de IVA")
    ap.add_argument("--api", default="http://127.0.0.1:8000")
    ap.add_argument("--ruc", help="identificación del contribuyente a usar")
    ap.add_argument("--client-id", help="id exacto de la fila de clients")
    ap.add_argument("--force", action="store_true",
                    help="correr aunque ya exista una solicitud del período (LA REEMPLAZA)")
    args = ap.parse_args()

    s = get_settings()
    sb = get_supabase_client()

    try:
        requests.get(f"{args.api}/openapi.json", timeout=5).raise_for_status()
    except Exception as e:
        sys.exit(f"El backend no responde en {args.api} ({e}).\n"
                 f"Levántalo con:  cd backend && ./venv/Scripts/python.exe -m uvicorn main:app --port 8000")

    cli, n_comp = elegir_cliente(sb, args.ruc, args.client_id)
    cid, uid = cli["id"], cli["user_id"]
    print(f"Contribuyente: {cli['identificacion']} — {cli['nombre']}")
    print(f"Período: {cli['periodo_mes']:02d}/{cli['periodo_anio']} · comprobantes: {n_comp}\n")

    previas = sb.table("devoluciones_iva_solicitudes").select("id,estado").eq(
        "client_id", cid).eq("mes", cli["periodo_mes"]).eq("anio", cli["periodo_anio"]).execute().data or []
    if previas and not args.force:
        sys.exit(f"ABORTADO: ya existe una solicitud ({previas[0]['estado']}) para este "
                 f"cliente/período y el guardado la REEMPLAZARÍA.\n"
                 f"Elige otro contribuyente con --ruc, o usa --force si es descartable.")

    # Token propio (HS256 con JWT_SECRET) — mismo camino que el login biométrico.
    tok = jwt.encode({"sub": uid, "aud": "authenticated", "exp": int(time.time()) + 3600},
                     s.jwt_secret, algorithm="HS256")
    H = {"Authorization": f"Bearer {tok}"}
    base = f"{args.api}/api/devoluciones-iva"

    print("=== 1. parámetros y topes ===")
    for (tipo, anio, pct), esperado in TOPES_ESPERADOS.items():
        p = {"anio": anio, "tipo": tipo}
        if pct is not None:
            p["porcentaje"] = pct
        got = requests.get(f"{base}/parametros", params=p, headers=H).json().get("tope_mensual")
        check(f"tope {tipo} {anio}{f' {pct}%' if pct else ''} = {esperado}", got == esperado, got)
    check("tipo inválido -> 400",
          requests.get(f"{base}/parametros", params={"anio": 2026, "tipo": "x"},
                       headers=H).status_code == 400)
    check("sin token -> 401",
          requests.get(f"{base}/parametros", params={"anio": 2026}).status_code == 401)

    print("=== 2. comprobantes ===")
    d = requests.get(f"{base}/comprobantes", params={"client_id": cid}, headers=H).json()
    comps = d["comprobantes"]
    iva_total = round(sum(c["iva"] for c in comps), 2)
    print(f"    periodo={d['periodo']} comprobantes={len(comps)} IVA disponible={iva_total}")
    check("hay comprobantes", len(comps) > 0)
    ids = [c["id"] for c in comps]

    check("cada comprobante trae rubro sugerido",
          all(c.get("rubro_sugerido") for c in comps),
          [c.get("rubro_sugerido") for c in comps[:3]])
    check("el período trae sus meses", len(d.get("meses") or []) in (1, 6), d.get("meses"))

    print("=== 3. guardar solicitud ===")
    # Se direcciona el primer comprobante a un tipo de gasto concreto, para
    # comprobar que el rubro elegido se guarda en el ítem (snapshot).
    rubros_pedidos = {ids[0]: "salud"} if ids else {}
    r = requests.post(f"{base}/solicitudes", headers=H, json={
        "client_id": cid, "tipo_beneficiario": "tercera_edad", "invoice_ids": ids,
        "rubros": rubros_pedidos})
    if not check("POST 200", r.status_code == 200, r.text[:200]):
        sys.exit(1)
    sol = r.json()
    print(f"    total_iva={sol['total_iva']} tope={sol['tope_mensual']} "
          f"solicitado={sol['monto_solicitado']} excedente={sol['excedente']}")
    check("monto = min(IVA, tope)",
          sol["monto_solicitado"] == round(min(sol["total_iva"], sol["tope_mensual"]), 2))
    check("ítems guardados = comprobantes enviados", sol["items_count"] == len(ids))
    check("estado inicial borrador", sol["estado"] == "borrador")
    check("trae el desglose por mes", len(sol.get("detalle_meses") or []) >= 1, sol.get("detalle_meses"))
    check("los topes por mes suman el tope del período",
          round(sum(m["tope"] for m in sol["detalle_meses"]), 2) == round(sol["tope_mensual"], 2),
          sol.get("detalle_meses"))
    check("el monto es la suma de lo pedido en cada mes",
          round(sum(m["solicitar"] for m in sol["detalle_meses"]), 2) == sol["monto_solicitado"])
    sid = sol["id"]

    d2 = requests.get(f"{base}/comprobantes", params={"client_id": cid}, headers=H).json()
    guardado = {c["id"]: c.get("rubro") for c in d2["comprobantes"]}
    check("el tipo de gasto elegido quedó guardado",
          not rubros_pedidos or guardado.get(ids[0]) == "salud", guardado.get(ids[0]))

    print("=== 3b. paquete de envío al SRI ===")
    env = requests.get(f"{base}/solicitudes/{sid}/envio", headers=H)
    if check("envio 200", env.status_code == 200, env.text[:150]):
        p = env.json()
        check("el paquete trae todos los comprobantes", len(p["items"]) == len(ids), len(p["items"]))
        check("cada ítem lleva clave de acceso y rubro",
              all(i.get("clave_acceso") and i.get("rubro") for i in p["items"]))
        check("el paquete trae el total a solicitar",
              p["totales"]["solicitado"] == sol["monto_solicitado"])
    check("marcar enviada -> presentada",
          requests.post(f"{base}/solicitudes/{sid}/enviar", headers=H).status_code == 200)
    hist_env = requests.get(f"{base}/solicitudes", params={"client_id": cid}, headers=H).json()["data"]
    envi = [x for x in hist_env if x["id"] == sid]
    check("queda con fecha de presentación",
          bool(envi and envi[0].get("presentada_at")), envi[0] if envi else None)

    print("=== 4. reemplazo UNIQUE(client, mes, anio) ===")
    requests.post(f"{base}/solicitudes", headers=H, json={
        "client_id": cid, "tipo_beneficiario": "tercera_edad", "invoice_ids": ids[:2]})
    hist = requests.get(f"{base}/solicitudes", params={"client_id": cid}, headers=H).json()["data"]
    delp = [x for x in hist if x["mes"] == cli["periodo_mes"] and x["anio"] == cli["periodo_anio"]]
    check("sigue habiendo 1 sola solicitud del período", len(delp) == 1, f"hay {len(delp)}")
    sid = delp[0]["id"] if delp else sid

    print("=== 5. validaciones ===")
    check("sin comprobantes -> 400", requests.post(f"{base}/solicitudes", headers=H, json={
        "client_id": cid, "tipo_beneficiario": "tercera_edad", "invoice_ids": []}).status_code == 400)
    check("discapacidad sin % -> 400", requests.post(f"{base}/solicitudes", headers=H, json={
        "client_id": cid, "tipo_beneficiario": "discapacidad",
        "invoice_ids": ids[:1]}).status_code == 400)
    r = requests.post(f"{base}/solicitudes", headers=H, json={
        "client_id": cid, "tipo_beneficiario": "discapacidad",
        "porcentaje_discapacidad": 40, "invoice_ids": ids})
    if check("discapacidad 40% -> 200", r.status_code == 200, r.text[:120]):
        sd = r.json()
        sid = sd["id"]
        check("tope proporcional 40% = 86.76", sd["tope_mensual"] == 86.76, sd["tope_mensual"])
        check("monto respeta el tope", sd["monto_solicitado"] == round(min(sd["total_iva"], 86.76), 2))
        if sd["total_iva"] > sd["tope_mensual"]:
            check("excedente ejercitado", sd["monto_solicitado"] == sd["tope_mensual"],
                  f"IVA {sd['total_iva']} > tope {sd['tope_mensual']}")
        else:
            print(f"  NOTA  excedente no ejercitado: IVA {sd['total_iva']} <= tope {sd['tope_mensual']}")

    print("=== 6. tenancy ===")
    check("cliente ajeno -> 403/404", requests.get(
        f"{base}/comprobantes", params={"client_id": "00000000-0000-0000-0000-000000000000"},
        headers=H).status_code in (403, 404))

    print("=== 7. estado y Excel ===")
    check("cambiar estado 200", requests.put(
        f"{base}/solicitudes/{sid}", headers=H, json={"estado": "presentada"}).status_code == 200)
    check("estado inválido -> 400", requests.put(
        f"{base}/solicitudes/{sid}", headers=H, json={"estado": "x"}).status_code == 400)
    r = requests.get(f"{base}/solicitudes/{sid}/export/excel", headers=H)
    check("excel 200", r.status_code == 200)
    check("excel es xlsx", r.content[:2] == b"PK", f"{len(r.content)} bytes")

    print("=== 8. limpieza ===")
    check("delete 200", requests.delete(f"{base}/solicitudes/{sid}", headers=H).status_code == 200)
    hist = requests.get(f"{base}/solicitudes", params={"client_id": cid}, headers=H).json()["data"]
    rest = [x for x in hist if x["mes"] == cli["periodo_mes"] and x["anio"] == cli["periodo_anio"]]
    check("solicitud de prueba eliminada", len(rest) == 0, f"quedan {len(rest)}")
    check("no quedan ítems huérfanos", not (sb.table("devoluciones_iva_items").select("id").eq(
        "solicitud_id", sid).execute().data or []))

    print(f"\n===== RESULTADO: {_ok} PASS / {_fail} FALLA =====")
    return 1 if _fail else 0


if __name__ == "__main__":
    sys.exit(main())
