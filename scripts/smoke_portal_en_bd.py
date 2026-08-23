# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""La grilla del portal y lo excluido, contra el backend y la BD reales.

Comprueba lo que la pantalla ya no guarda en el navegador:

    GET  /comprobantes   devuelve `ocultos` aparte de la lista
    POST /excluidos      saca un comprobante de la devolución (y lo devuelve)
    POST /periodo/limpiar vacía el mes (solo se prueba en un período SIN solicitud)

Uso (con el backend levantado):

    python scripts/smoke_portal_en_bd.py --api http://127.0.0.1:8010

OJO — escribe en la BD que apunte `backend/.env`, pero SOLO en la tabla
`devoluciones_iva_portal` (la que estrena este cambio) y borra al final la fila
que crea. No toca solicitudes: si el período elegido ya tiene una, el paso de
limpiar se salta.
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
    ap.add_argument("--ruc", help="contribuyente a usar (por defecto, el primero con gasto)")
    args = ap.parse_args()

    sb = get_supabase_client()
    s = get_settings()

    # Un contribuyente con el servicio activo y comprobantes cargados: es el
    # único caso donde la pantalla tiene algo que mostrar.
    if args.ruc:
        # Con RUC a mano se busca por contribuyente: el servicio se contrata por
        # identificación, y puede estar anotado en otro de sus períodos.
        ids = [c["id"] for c in (sb.table("clients").select("id").eq(
            "identificacion", args.ruc).execute().data or [])]
        if not ids:
            sys.exit(f"No hay ningún contribuyente {args.ruc}.")
    else:
        svc = sb.table("client_services").select("client_id").eq(
            "service", "devolucion_iva").execute().data or []
        ids = [x["client_id"] for x in svc]
    if not ids:
        sys.exit("No hay contribuyentes con el servicio 'devolucion_iva'.")
    cliente = None
    for cid in ids:
        cl = sb.table("clients").select("id,user_id,identificacion,nombre,periodo_mes,periodo_anio").eq(
            "id", cid).execute().data
        if not cl:
            continue
        inv = sb.table("invoices").select("id", count="exact").eq("client_id", cid).limit(1).execute()
        if inv.count:
            cliente = cl[0]
            break
    if not cliente:
        sys.exit("Ningún contribuyente con ese servicio tiene comprobantes cargados.")
    print(f"Contribuyente: {cliente['identificacion']} — {cliente['nombre']}")

    tok = jwt.encode({"sub": cliente["user_id"], "aud": "authenticated",
                      "exp": int(time.time()) + 3600}, s.jwt_secret, algorithm="HS256")
    H = {"Authorization": f"Bearer {tok}"}
    base = f"{args.api}/api/devoluciones-iva"

    print("=== 1. la lista y lo oculto vienen del servidor ===")
    r = requests.get(f"{base}/comprobantes", params={"client_id": cliente["id"]}, headers=H)
    check("GET /comprobantes responde 200", r.status_code == 200, r.text[:200])
    d = r.json()
    check("trae 'ocultos'", isinstance(d.get("ocultos"), list), d.get("ocultos"))
    check("trae 'portal_traido_at'", "portal_traido_at" in d)

    # Se trabaja sobre un mes CON gasto cargado y todavía sin presentar: es el
    # mes que el usuario abriría. El período configurado del contribuyente puede
    # estar vacío, y ahí no habría nada que sacar de la devolución.
    per = requests.get(f"{base}/periodos", params={"client_id": cliente["id"]},
                       headers=H).json().get("periodos") or []
    elegido = next((p for p in per
                    if p.get("comprobantes") and p.get("estado") == "pendiente"), None)
    if not elegido:
        sys.exit("Ese contribuyente no tiene ningún mes con gasto sin presentar.")
    mes, anio = elegido["mes"], elegido["anio"]
    # Y SIEMPRE con el mes puesto: pedido así el servidor acota la lista a ese
    # mes (sin mes devuelve todo el gasto del contribuyente), y comparar una
    # lista contra la otra sería comparar dos cosas distintas.
    d = requests.get(f"{base}/comprobantes",
                     params={"client_id": cliente["id"], "mes": mes, "anio": anio},
                     headers=H).json()
    comps = d.get("comprobantes") or []
    print(f"  período {mes}/{anio} · {len(comps)} comprobante(s) del mes")

    if not comps:
        print("  (sin comprobantes en el período: no se puede probar el excluir)")
    else:
        print("=== 2. sacar un comprobante de la devolución ===")
        victima = comps[0]["id"]
        r = requests.post(f"{base}/excluidos", headers=H, json={
            "client_id": cliente["id"], "mes": mes, "anio": anio, "ids": [victima]})
        check("POST /excluidos responde 200", r.status_code == 200, r.text[:200])
        d2 = requests.get(f"{base}/comprobantes",
                          params={"client_id": cliente["id"], "mes": mes, "anio": anio},
                          headers=H).json()
        check("ya no está en la lista",
              victima not in [c["id"] for c in d2.get("comprobantes") or []])
        check("aparece en 'ocultos'", victima in [c["id"] for c in d2.get("ocultos") or []])

        print("=== 3. volver a mostrarlo ===")
        requests.post(f"{base}/excluidos", headers=H, json={
            "client_id": cliente["id"], "mes": mes, "anio": anio, "ids": []})
        d3 = requests.get(f"{base}/comprobantes",
                          params={"client_id": cliente["id"], "mes": mes, "anio": anio},
                          headers=H).json()
        check("vuelve a la lista", victima in [c["id"] for c in d3.get("comprobantes") or []])
        check("y 'ocultos' queda vacío", not (d3.get("ocultos") or []))

    print("=== 4. lo guardado en la solicitud llega MARCADO ===")
    # El mismo comprobante puede estar en Gastos y en la grilla del SRI. Cuando
    # eso pasaba, la fila del portal se descartaba por repetida y con ella se
    # perdía la marca: la pantalla mostraba "0 de 36 marcados" y $0,00 sobre una
    # solicitud que en la base tenía sus diez comprobantes y su monto.
    # Entre TODOS los períodos de este contribuyente: la solicitud vive en el
    # client_id del mes que se trabajó, que no tiene por qué ser el abierto.
    sol = []
    for cid in ids:
        sol += sb.table("devoluciones_iva_solicitudes").select(
            "id,client_id,mes,anio,total_iva").eq("client_id", cid).execute().data or []
    caso = None
    for x in sol:
        items = sb.table("devoluciones_iva_items").select("factura_numero,invoice_id").eq(
            "solicitud_id", x["id"]).execute().data or []
        delportal = [i for i in items if not i.get("invoice_id")]
        if delportal:
            caso = (x, delportal)
            break
    if not caso:
        print("  (este contribuyente no tiene ninguna solicitud armada con la grilla del SRI)")
    else:
        x, delportal = caso
        dd = requests.get(f"{base}/comprobantes",
                          params={"client_id": x["client_id"], "mes": x["mes"], "anio": x["anio"]},
                          headers=H).json()
        por_id = {c["id"]: c for c in dd.get("comprobantes") or []}
        sel = [i for i in dd.get("seleccionados") or []]
        check(f"vienen marcados los {len(delportal)} del portal", len(sel) == len(delportal),
              f"marcados: {len(sel)}")
        check("todos los marcados tienen su fila en la lista",
              all(i in por_id for i in sel), [i for i in sel if i not in por_id])
        iva = round(sum(por_id[i]["iva"] for i in sel if i in por_id), 2)
        check(f"el IVA marcado es el de la solicitud ({x['total_iva']})",
              abs(iva - float(x["total_iva"] or 0)) < 0.02, iva)
        series = [c.get("factura_numero") for c in (dd.get("comprobantes") or []) if c.get("factura_numero")]
        check("ningún comprobante aparece dos veces", len(series) == len(set(series)),
              len(series) - len(set(series)))

    print("=== 5. vaciar el período ===")
    hay_solicitud = bool(sb.table("devoluciones_iva_solicitudes").select("id").eq(
        "client_id", cliente["id"]).eq("mes", mes).eq("anio", anio).execute().data)
    if hay_solicitud:
        print("  (ese período ya tiene solicitud guardada: no se toca)")
    else:
        r = requests.post(f"{base}/periodo/limpiar", headers=H, json={
            "client_id": cliente["id"], "mes": mes, "anio": anio})
        check("POST /periodo/limpiar responde 200", r.status_code == 200, r.text[:200])
        d4 = requests.get(f"{base}/comprobantes",
                          params={"client_id": cliente["id"], "mes": mes, "anio": anio},
                          headers=H).json()
        check("el mes queda en blanco", not (d4.get("comprobantes") or []),
              len(d4.get("comprobantes") or []))
        check("y lo sacado se puede volver a ver", len(d4.get("ocultos") or []) == len(comps))

    # Limpieza: la fila de esta prueba se borra (el período queda como estaba).
    sb.table("devoluciones_iva_portal").delete().eq("client_id", cliente["id"]).eq(
        "mes", mes).eq("anio", anio).execute()
    print(f"\n{_ok} OK · {_fail} fallas")
    sys.exit(1 if _fail else 0)


if __name__ == "__main__":
    main()
