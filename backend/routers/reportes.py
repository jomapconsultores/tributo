"""REPORTES de honorarios: cuadro de todos los contribuyentes con los SERVICIOS
que se les hace (declaraciones y anexos, esencialmente), indicando si se cobra
y el valor a cobrar. Los valores se guardan (tabla reportes_honorarios) para
reutilizarse a futuro. Exportable a Excel y PDF."""
import io
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client, fetch_all
from services.email_sender import enviar_correo, email_configurado

DESTINO_ODOO = "johannanievecela@hotmail.com"
IVA_RATE = 0.15  # IVA Ecuador vigente
EC_TZ = timezone(timedelta(hours=-5))  # Ecuador (UTC-5, sin horario de verano)
MESES_ES = ["", "enero", "febrero", "marzo", "abril", "mayo", "junio",
            "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]

router = APIRouter(prefix="/api/reportes", tags=["reportes"])


def _periodo_actual():
    """Mes/año de cobro actual (hora Ecuador)."""
    now = datetime.now(EC_TZ)
    return now.month, now.year


def _es_mes_actual(created_at, mes, anio) -> bool:
    """¿La fecha (ISO) cae dentro del mes calendario (mes/anio) en hora Ecuador?"""
    if not created_at:
        return False
    try:
        dt = datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        dt = dt.astimezone(EC_TZ)
        return dt.month == mes and dt.year == anio
    except Exception:
        return False


def _desglose_iva(total: float):
    """Si el valor INCLUYE IVA, separa base imponible + IVA (15%)."""
    base = round(total / (1 + IVA_RATE), 2)
    iva = round(total - base, 2)
    return base, iva

# Conceptos/servicios que se facturan (lo que se hace por cliente)
CONCEPTOS = [
    ("Declaración IVA", "declaracion_iva"),
    ("Declaración ICE", "declaracion_ice"),
    ("Declaración Renta", "declaracion_renta"),
    ("Anexo PVP+ICE", "anexo"),
    ("Devolución IVA", "devolucion_iva"),
]


class CobroIn(BaseModel):
    identificacion: str
    producto: str            # nombre del concepto (ej. "Declaración IVA")
    marca: Optional[str] = ""
    cobrar: Optional[bool] = True
    valor: Optional[float] = 0
    iva_incluido: Optional[bool] = False   # False = "+IVA" (se suma 15%); True = IVA ya incluido


def _filas_y_total(user_id):
    """Construye las filas (contribuyente × concepto) del PERÍODO ACTUAL con
    cobrar/valor guardados, pre-marcando lo relevante (servicios contratados,
    anexos y declaraciones). Marca en verde (`hecho`) lo declarado ESTE mes
    calendario y arrastra los valores del mes anterior cuando no hay del actual.
    Devuelve (filas, total_a_cobrar, historial) donde historial es
    {ruc: [{anio, mes, etiqueta, subtotal, items:[...]}]} de meses anteriores."""
    from tenancy import shared_client_ids
    sb = get_supabase_client()
    cur_mes, cur_anio = _periodo_actual()
    cur_key = cur_anio * 100 + cur_mes
    own_clients = fetch_all(lambda: sb.table("clients").select("id,identificacion,nombre,iva_incluido").eq("user_id", user_id))
    sids = shared_client_ids(user_id)
    if sids:
        sh_clients = fetch_all(lambda: sb.table("clients").select("id,identificacion,nombre,iva_incluido").in_("id", sids))
        seen_cids = {c["id"] for c in own_clients}
        rows_clients = own_clients + [c for c in sh_clients if c["id"] not in seen_cids]
    else:
        rows_clients = own_clients
    nombre_por_ruc = {}
    id_to_ruc = {}
    iva_por_ruc = {}
    client_id_por_ruc = {}
    for c in rows_clients:
        ident = c["identificacion"]
        nombre_por_ruc.setdefault(ident, c.get("nombre") or "")
        id_to_ruc[c["id"]] = ident
        iva_por_ruc.setdefault(ident, bool(c.get("iva_incluido")))
        client_id_por_ruc.setdefault(ident, str(c["id"]))
    all_ids = list(id_to_ruc.keys())

    serv_por_ruc = {}

    # Parallelizar las 4 consultas independientes entre sí
    def _q_servicios():
        if not all_ids:
            return []
        return fetch_all(lambda: sb.table("client_services").select("client_id,service").in_(
            "client_id", all_ids).eq("active", True))

    # Declaraciones/anexos por CLIENTE visible (propio o compartido), no por quién
    # los hizo: el verde señala que el trabajo del contribuyente está hecho.
    def _q_anexos():
        if not all_ids:
            return []
        return fetch_all(lambda: sb.table("anexos").select("client_id,created_at").in_("client_id", all_ids))

    def _q_decls():
        if not all_ids:
            return []
        return fetch_all(lambda: sb.table("declaraciones").select("client_id,tipo,created_at").in_("client_id", all_ids))

    def _q_guardados():
        return fetch_all(lambda: sb.table("reportes_honorarios").select(
            "identificacion,producto,cobrar,valor,iva_incluido,mes,anio").eq("user_id", user_id))

    with ThreadPoolExecutor(max_workers=4) as ex:
        f_svc = ex.submit(_q_servicios)
        f_anx = ex.submit(_q_anexos)
        f_dec = ex.submit(_q_decls)
        f_grd = ex.submit(_q_guardados)
        servicios = f_svc.result()
        anexos_r   = f_anx.result()
        decls_r    = f_dec.result()
        guardados  = f_grd.result()

    for s in servicios:
        ruc = id_to_ruc.get(s["client_id"])
        if ruc:
            serv_por_ruc.setdefault(ruc, set()).add(s["service"])

    # Declaraciones: "ever" (alguna vez) para decidir quién aparece y qué es
    # relevante; "mes" (este mes calendario) para pintar en verde "se debe facturar".
    _TIPO_KEY = {"IVA": "declaracion_iva", "ICE": "declaracion_ice", "RENTA": "declaracion_renta"}
    decl_ever, decl_mes = set(), set()
    for d in decls_r:
        ruc = id_to_ruc.get(d["client_id"])
        key = _TIPO_KEY.get((d.get("tipo") or "").upper())
        if not ruc or not key:
            continue
        decl_ever.add((ruc, key))
        if _es_mes_actual(d.get("created_at"), cur_mes, cur_anio):
            decl_mes.add((ruc, key))
    anexo_ever, anexo_mes = set(), set()
    for a in anexos_r:
        ruc = id_to_ruc.get(a["client_id"])
        if not ruc:
            continue
        anexo_ever.add(ruc)
        if _es_mes_actual(a.get("created_at"), cur_mes, cur_anio):
            anexo_mes.add(ruc)

    # Honorarios guardados, separados por período:
    #  - guardados_cur: los del mes en curso (editables)
    #  - prev_por_prod: el más reciente de meses anteriores (para arrastrar)
    #  - historial:     todos los meses anteriores agrupados (solo lectura)
    guardados_cur = {}
    prev_por_prod = {}
    hist = {}
    for g in guardados:
        ruc = g["identificacion"]
        prod = g["producto"]
        k = (ruc, prod)
        pk = (g.get("anio") or 0) * 100 + (g.get("mes") or 0)
        if pk == cur_key:
            guardados_cur[k] = g
        elif pk < cur_key:
            prev = prev_por_prod.get(k)
            if prev is None or ((prev.get("anio") or 0) * 100 + (prev.get("mes") or 0)) < pk:
                prev_por_prod[k] = g
            # Historial (solo lo que se cobró con valor)
            if g.get("cobrar") and float(g.get("valor") or 0) > 0:
                valor = float(g["valor"])
                iva_incl = bool(g.get("iva_incluido"))
                bruto = round(valor if iva_incl else valor * (1 + IVA_RATE), 2)
                per = hist.setdefault(ruc, {}).setdefault(
                    (g["anio"], g["mes"]),
                    {"anio": g["anio"], "mes": g["mes"],
                     "etiqueta": f"{MESES_ES[g['mes']]} {g['anio']}", "subtotal": 0.0, "items": []})
                per["items"].append({"concepto": prod, "valor": round(valor, 2),
                                     "iva_incluido": iva_incl, "bruto": bruto})
                per["subtotal"] = round(per["subtotal"] + bruto, 2)

    historial = {}
    for ruc, perds in hist.items():
        historial[ruc] = sorted(perds.values(), key=lambda p: (p["anio"], p["mes"]), reverse=True)

    fixed_labels = {label for label, _ in CONCEPTOS}
    # Rubros personalizados activos (del mes actual o arrastrados del anterior)
    custom_por_ruc = {}
    for (ruc, prod) in set(guardados_cur) | set(prev_por_prod):
        if prod not in fixed_labels:
            custom_por_ruc.setdefault(ruc, set()).add(prod)

    # Solo salen contribuyentes "con algo": servicio contratado, declaración/anexo
    # hecho alguna vez, o un cobro guardado (cualquier período).
    rucs_con_decl = {k[0] for k in decl_ever}
    rucs_con_guardado = {g["identificacion"] for g in guardados}
    def _activo(ruc):
        return (bool(serv_por_ruc.get(ruc)) or ruc in anexo_ever
                or ruc in rucs_con_decl or ruc in rucs_con_guardado)

    filas = []
    total = 0.0
    rucs_orden = [r for r in sorted(nombre_por_ruc, key=lambda r: (nombre_por_ruc[r] or "").upper()) if _activo(r)]
    for ruc in rucs_orden:
        def _fila(concepto, relevante, hecho, personalizado, g, arrastrado=False):
            nonlocal total
            cobrar = bool(g["cobrar"]) if g else relevante
            valor = float(g["valor"]) if g and g.get("valor") is not None else 0.0
            # IVA por ítem: lo guardado manda; si no hay, cae al ajuste del cliente.
            iva_incl = bool(g["iva_incluido"]) if g and g.get("iva_incluido") is not None else iva_por_ruc.get(ruc, False)
            # "bruto" = total a cobrar con IVA incluido (base + 15%). Si el valor ya
            # incluye IVA, el bruto es el mismo valor; si es "+IVA", se suma el 15%.
            bruto = round(valor if iva_incl else valor * (1 + IVA_RATE), 2)
            if cobrar:
                total += bruto
            filas.append({
                "identificacion": ruc,
                "contribuyente": nombre_por_ruc[ruc],
                "client_id": client_id_por_ruc.get(ruc),
                "iva_incluido": iva_incl,
                "concepto": concepto,
                "relevante": relevante,
                "hecho": hecho,
                "arrastrado": arrastrado,
                "personalizado": personalizado,
                "cobrar": cobrar,
                "valor": round(valor, 2),
                "bruto": bruto,
            })
        for label, key in CONCEPTOS:
            hecho = ((ruc, key) in decl_mes) or (key == "anexo" and ruc in anexo_mes)
            realizado = ((ruc, key) in decl_ever) or (key == "anexo" and ruc in anexo_ever)
            relevante = realizado or (key in serv_por_ruc.get(ruc, set()))
            g_cur = guardados_cur.get((ruc, label))
            g_prev = prev_por_prod.get((ruc, label))
            _fila(label, relevante, hecho, False, g_cur or g_prev,
                  arrastrado=(g_cur is None and g_prev is not None))
        for prod in sorted(custom_por_ruc.get(ruc, set()), key=str.upper):
            g_cur = guardados_cur.get((ruc, prod))
            g_prev = prev_por_prod.get((ruc, prod))
            _fila(prod, False, False, True, g_cur or g_prev,
                  arrastrado=(g_cur is None and g_prev is not None))
    return filas, round(total, 2), historial


@router.put("/cliente-iva/{client_id}")
async def set_cliente_iva(client_id: str, iva_incluido: bool, user_id: str = Depends(get_current_user)):
    """Guarda si los valores de un contribuyente ya incluyen IVA."""
    sb = get_supabase_client()
    res = sb.table("clients").update({"iva_incluido": iva_incluido}).eq("id", client_id).eq("user_id", user_id).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Cliente no encontrado")
    return {"ok": True}


@router.get("/cobros")
async def cobros(user_id: str = Depends(get_current_user)):
    filas, total, historial = _filas_y_total(user_id)
    cur_mes, cur_anio = _periodo_actual()
    return {"data": filas, "total_a_cobrar": total, "historial": historial,
            "periodo": {"mes": cur_mes, "anio": cur_anio,
                        "etiqueta": f"{MESES_ES[cur_mes]} {cur_anio}"}}


@router.put("/cobros")
async def guardar_cobro(entry: CobroIn, user_id: str = Depends(get_current_user)):
    """Guarda (upsert) el 'cobrar' y 'valor' de un contribuyente + concepto en el
    período (mes/año) ACTUAL. Los meses anteriores quedan intactos como histórico."""
    sb = get_supabase_client()
    concepto = (entry.producto or "").strip()
    ident = (entry.identificacion or "").strip()
    if not ident or not concepto:
        raise HTTPException(status_code=400, detail="Contribuyente y concepto son obligatorios")
    cur_mes, cur_anio = _periodo_actual()
    try:
        sb.table("reportes_honorarios").upsert({
            "user_id": user_id,
            "identificacion": ident,
            "producto": concepto,
            "marca": "",
            "cobrar": bool(entry.cobrar),
            "valor": float(entry.valor or 0),
            "iva_incluido": bool(entry.iva_incluido),
            "mes": cur_mes,
            "anio": cur_anio,
            "updated_at": "now()",
        }, on_conflict="user_id,identificacion,producto,mes,anio").execute()
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/cobros")
async def borrar_cobro(identificacion: str, producto: str, user_id: str = Depends(get_current_user)):
    """Elimina una fila guardada (sirve para quitar un rubro personalizado)."""
    sb = get_supabase_client()
    sb.table("reportes_honorarios").delete().eq("user_id", user_id).eq(
        "identificacion", (identificacion or "").strip()).eq("producto", (producto or "").strip()).execute()
    return {"ok": True}


@router.post("/enviar-correo")
async def enviar_correo_reporte(iva_incluido: bool = False, user_id: str = Depends(get_current_user)):
    """Envía a Johanna (Odoo) el detalle de honorarios y el total a facturar.
    Requiere SMTP configurado; si no, devuelve configurado=False para que el
    front abra el correo redactado (mailto)."""
    if not email_configurado():
        return {"ok": False, "configurado": False,
                "error": "El envío automático no está configurado en el servidor."}
    filas, total, _ = _filas_y_total(user_id)
    # 'bruto' = valor con IVA incluido por ítem (base + 15%). El total ya es con IVA.
    por_ruc = {}
    for f in filas:
        if f["cobrar"] and f.get("bruto", 0) > 0:
            g = por_ruc.setdefault(f["identificacion"], {"nombre": f["contribuyente"], "items": [], "sub": 0.0})
            etiqueta = " (IVA incl.)" if f.get("iva_incluido") else " (+IVA)"
            g["items"].append(f"   - {f['concepto']}: ${f['bruto']:.2f}{etiqueta}")
            g["sub"] += f["bruto"]
    if not por_ruc:
        raise HTTPException(status_code=400, detail="No hay valores a cobrar para enviar.")
    bloques = []
    for ruc, g in por_ruc.items():
        base, iva = _desglose_iva(g["sub"])
        bloques.append(f"{g['nombre']} ({ruc})\n" + "\n".join(g["items"])
                       + f"\n   Subtotal: ${g['sub']:.2f}  (Base ${base:.2f} + IVA ${iva:.2f})")
    base_t, iva_t = _desglose_iva(total)
    cierre = (f"\n\nTOTAL A FACTURAR (IVA incl.): ${total:.2f}"
              f"\n   Base imponible: ${base_t:.2f}\n   IVA 15%: ${iva_t:.2f}\n\nGracias.")
    cuerpo = ("Hola Johanna,\n\nDetalle de honorarios para registrar la factura en Odoo:\n\n"
              + "\n\n".join(bloques) + cierre)
    ok, err = enviar_correo(DESTINO_ODOO, "Honorarios para facturar en Odoo", cuerpo)
    if not ok:
        raise HTTPException(status_code=400, detail=err or "No se pudo enviar el correo.")
    return {"ok": True, "configurado": True, "destinatario": DESTINO_ODOO,
            "total": total, "base": base_t, "iva": iva_t}


@router.get("/export/excel")
async def export_excel(iva_incluido: bool = False, user_id: str = Depends(get_current_user)):
    import xlsxwriter
    filas, total, _ = _filas_y_total(user_id)
    out = io.BytesIO()
    wb = xlsxwriter.Workbook(out, {"in_memory": True})
    ws = wb.add_worksheet("Honorarios")
    title = wb.add_format({"bold": True, "font_color": "#1a5276", "font_size": 13})
    head = wb.add_format({"bold": True, "bg_color": "#1a5276", "font_color": "white", "border": 1, "align": "center"})
    cell = wb.add_format({"border": 1})
    money = wb.add_format({"border": 1, "num_format": "$#,##0.00"})
    si = wb.add_format({"border": 1, "align": "center"})
    tot = wb.add_format({"bold": True, "border": 1, "num_format": "$#,##0.00", "bg_color": "#eafaf1"})
    sub_lbl = wb.add_format({"bold": True, "border": 1, "bg_color": "#eef5fb", "font_color": "#1a5276", "align": "right"})
    sub_val = wb.add_format({"bold": True, "border": 1, "num_format": "$#,##0.00", "bg_color": "#eef5fb", "font_color": "#1a5276"})

    ws.write(0, 0, "REPORTE DE HONORARIOS A COBRAR", title)
    r = 2
    for j, h in enumerate(["Contribuyente", "RUC", "Concepto / Servicio", "¿Cobrar?", "Valor a cobrar"]):
        ws.write(r, j, h, head)

    def _subtotal(row, contrib, monto):
        ws.merge_range(row, 0, row, 3, f"Subtotal {contrib}", sub_lbl)
        ws.write_number(row, 4, round(monto, 2), sub_val)

    curr = None
    sub = 0.0
    for f in filas:
        if curr is not None and f["contribuyente"] != curr:
            r += 1
            _subtotal(r, curr, sub)
            sub = 0.0
        curr = f["contribuyente"]
        r += 1
        ws.write(r, 0, f["contribuyente"], cell)
        ws.write(r, 1, f["identificacion"], cell)
        ws.write(r, 2, f["concepto"], cell)
        ws.write(r, 3, "Sí" if f["cobrar"] else "No", si)
        ws.write_number(r, 4, f["bruto"] if f["cobrar"] else 0, money)
        if f["cobrar"]:
            sub += f["bruto"]
    if curr is not None:
        r += 1
        _subtotal(r, curr, sub)
    r += 1
    ws.write(r, 3, "TOTAL (IVA incl.)", head)
    ws.write_number(r, 4, total, tot)
    base_t, iva_t = _desglose_iva(total)
    r += 1; ws.write(r, 3, "Base imponible", sub_lbl); ws.write_number(r, 4, base_t, sub_val)
    r += 1; ws.write(r, 3, "IVA 15%", sub_lbl); ws.write_number(r, 4, iva_t, sub_val)
    ws.set_column(0, 0, 34)
    ws.set_column(1, 1, 16)
    ws.set_column(2, 2, 24)
    ws.set_column(3, 4, 14)
    wb.close()
    out.seek(0)
    return StreamingResponse(
        iter([out.getvalue()]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=Reporte_Honorarios.xlsx"})


@router.get("/export/pdf")
async def export_pdf(iva_incluido: bool = False, user_id: str = Depends(get_current_user)):
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.units import inch
    from reportlab.lib import colors
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
    filas, total, _ = _filas_y_total(user_id)
    out = io.BytesIO()
    doc = SimpleDocTemplate(out, pagesize=letter, topMargin=0.5 * inch, bottomMargin=0.5 * inch)
    st = getSampleStyleSheet()
    story = [Paragraph("Reporte de honorarios a cobrar", st["Title"]), Spacer(1, 0.15 * inch)]
    data = [["Contribuyente", "RUC", "Concepto / Servicio", "Cobrar", "Valor"]]
    sub_rows = []  # índices de filas de subtotal (para colorearlas)
    curr = None
    sub = 0.0
    for f in filas:
        if curr is not None and f["contribuyente"] != curr:
            data.append(["", "", "", f"Subtotal {curr}", f"${sub:.2f}"])
            sub_rows.append(len(data) - 1)
            sub = 0.0
        curr = f["contribuyente"]
        data.append([f["contribuyente"], f["identificacion"], f["concepto"],
                     "Sí" if f["cobrar"] else "No",
                     f"${f['bruto']:.2f}" if f["cobrar"] else "$0.00"])
        if f["cobrar"]:
            sub += f["bruto"]
    if curr is not None:
        data.append(["", "", "", f"Subtotal {curr}", f"${sub:.2f}"])
        sub_rows.append(len(data) - 1)
    data.append(["", "", "", "TOTAL (IVA incl.)", f"${total:.2f}"])
    base_t, iva_t = _desglose_iva(total)
    data.append(["", "", "", "Base imponible", f"${base_t:.2f}"])
    data.append(["", "", "", "IVA 15%", f"${iva_t:.2f}"])
    t = Table(data, repeatRows=1, colWidths=[2.2 * inch, 1.3 * inch, 1.7 * inch, 1.0 * inch, 0.9 * inch])
    estilo = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1a5276")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 7.5),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#eafaf1")),
        ("FONTNAME", (3, -1), (-1, -1), "Helvetica-Bold"),
        ("ALIGN", (4, 0), (4, -1), "RIGHT"),
        ("ALIGN", (3, 0), (3, -1), "CENTER"),
    ]
    for si in sub_rows:
        estilo.append(("BACKGROUND", (0, si), (-1, si), colors.HexColor("#eef5fb")))
        estilo.append(("FONTNAME", (3, si), (-1, si), "Helvetica-Bold"))
        estilo.append(("TEXTCOLOR", (0, si), (-1, si), colors.HexColor("#1a5276")))
    t.setStyle(TableStyle(estilo))
    story.append(t)
    doc.build(story)
    out.seek(0)
    return StreamingResponse(
        iter([out.getvalue()]), media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename=Reporte_Honorarios.pdf"})
