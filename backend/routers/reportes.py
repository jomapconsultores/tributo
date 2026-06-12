"""REPORTES de honorarios: cuadro de todos los contribuyentes con los SERVICIOS
que se les hace (declaraciones y anexos, esencialmente), indicando si se cobra
y el valor a cobrar. Los valores se guardan (tabla reportes_honorarios) para
reutilizarse a futuro. Exportable a Excel y PDF."""
import io
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client

router = APIRouter(prefix="/api/reportes", tags=["reportes"])

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


def _filas_y_total(user_id):
    """Construye las filas (contribuyente × concepto) con cobrar/valor guardados,
    pre-marcando lo relevante (servicios contratados, anexos y declaraciones
    realmente hechas). Devuelve (filas, total_a_cobrar)."""
    sb = get_supabase_client()
    rows_clients = sb.table("clients").select("id,identificacion,nombre").eq("user_id", user_id).execute().data or []
    nombre_por_ruc = {}
    id_to_ruc = {}
    for c in rows_clients:
        ident = c["identificacion"]
        nombre_por_ruc.setdefault(ident, c.get("nombre") or "")
        id_to_ruc[c["id"]] = ident
    all_ids = list(id_to_ruc.keys())

    serv_por_ruc = {}
    anexo_rucs = set()
    decl_keys = set()
    if all_ids:
        servicios = sb.table("client_services").select("client_id,service").in_(
            "client_id", all_ids).eq("active", True).execute().data or []
        for s in servicios:
            ruc = id_to_ruc.get(s["client_id"])
            if ruc:
                serv_por_ruc.setdefault(ruc, set()).add(s["service"])
        anexos = sb.table("anexos").select("client_id").eq("user_id", user_id).execute().data or []
        anexo_rucs = {id_to_ruc.get(a["client_id"]) for a in anexos}
        decls = sb.table("declaraciones").select("client_id,tipo").eq("user_id", user_id).execute().data or []
        for d in decls:
            ruc = id_to_ruc.get(d["client_id"])
            t = (d.get("tipo") or "").upper()
            if ruc and t == "IVA":
                decl_keys.add((ruc, "declaracion_iva"))
            if ruc and t == "ICE":
                decl_keys.add((ruc, "declaracion_ice"))

    guardados = sb.table("reportes_honorarios").select(
        "identificacion,producto,cobrar,valor").eq("user_id", user_id).execute().data or []
    by_key = {(g["identificacion"], g["producto"]): g for g in guardados}

    filas = []
    total = 0.0
    for ruc in sorted(nombre_por_ruc, key=lambda r: (nombre_por_ruc[r] or "").upper()):
        for label, key in CONCEPTOS:
            relevante = (key in serv_por_ruc.get(ruc, set())
                         or (key == "anexo" and ruc in anexo_rucs)
                         or (ruc, key) in decl_keys)
            g = by_key.get((ruc, label))
            cobrar = bool(g["cobrar"]) if g else relevante
            valor = float(g["valor"]) if g and g.get("valor") is not None else 0.0
            if cobrar:
                total += valor
            filas.append({
                "identificacion": ruc,
                "contribuyente": nombre_por_ruc[ruc],
                "concepto": label,
                "relevante": relevante,
                "cobrar": cobrar,
                "valor": round(valor, 2),
            })
    return filas, round(total, 2)


@router.get("/cobros")
async def cobros(user_id: str = Depends(get_current_user)):
    filas, total = _filas_y_total(user_id)
    return {"data": filas, "total_a_cobrar": total}


@router.put("/cobros")
async def guardar_cobro(entry: CobroIn, user_id: str = Depends(get_current_user)):
    """Guarda (upsert) el 'cobrar' y 'valor' de un contribuyente + concepto."""
    sb = get_supabase_client()
    concepto = (entry.producto or "").strip()
    ident = (entry.identificacion or "").strip()
    if not ident or not concepto:
        raise HTTPException(status_code=400, detail="Contribuyente y concepto son obligatorios")
    try:
        sb.table("reportes_honorarios").upsert({
            "user_id": user_id,
            "identificacion": ident,
            "producto": concepto,
            "marca": "",
            "cobrar": bool(entry.cobrar),
            "valor": float(entry.valor or 0),
            "updated_at": "now()",
        }, on_conflict="user_id,identificacion,producto").execute()
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/export/excel")
async def export_excel(user_id: str = Depends(get_current_user)):
    import xlsxwriter
    filas, total = _filas_y_total(user_id)
    out = io.BytesIO()
    wb = xlsxwriter.Workbook(out, {"in_memory": True})
    ws = wb.add_worksheet("Honorarios")
    title = wb.add_format({"bold": True, "font_color": "#1a5276", "font_size": 13})
    head = wb.add_format({"bold": True, "bg_color": "#1a5276", "font_color": "white", "border": 1, "align": "center"})
    cell = wb.add_format({"border": 1})
    money = wb.add_format({"border": 1, "num_format": "$#,##0.00"})
    si = wb.add_format({"border": 1, "align": "center"})
    tot = wb.add_format({"bold": True, "border": 1, "num_format": "$#,##0.00", "bg_color": "#eafaf1"})

    ws.write(0, 0, "REPORTE DE HONORARIOS A COBRAR", title)
    r = 2
    for j, h in enumerate(["Contribuyente", "RUC", "Concepto / Servicio", "¿Cobrar?", "Valor a cobrar"]):
        ws.write(r, j, h, head)
    for f in filas:
        r += 1
        ws.write(r, 0, f["contribuyente"], cell)
        ws.write(r, 1, f["identificacion"], cell)
        ws.write(r, 2, f["concepto"], cell)
        ws.write(r, 3, "Sí" if f["cobrar"] else "No", si)
        ws.write_number(r, 4, f["valor"] if f["cobrar"] else 0, money)
    r += 1
    ws.write(r, 3, "TOTAL", head)
    ws.write_number(r, 4, total, tot)
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
async def export_pdf(user_id: str = Depends(get_current_user)):
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.units import inch
    from reportlab.lib import colors
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
    filas, total = _filas_y_total(user_id)
    out = io.BytesIO()
    doc = SimpleDocTemplate(out, pagesize=letter, topMargin=0.5 * inch, bottomMargin=0.5 * inch)
    st = getSampleStyleSheet()
    story = [Paragraph("Reporte de honorarios a cobrar", st["Title"]), Spacer(1, 0.15 * inch)]
    data = [["Contribuyente", "RUC", "Concepto / Servicio", "Cobrar", "Valor"]]
    for f in filas:
        data.append([f["contribuyente"], f["identificacion"], f["concepto"],
                     "Sí" if f["cobrar"] else "No",
                     f"${f['valor']:.2f}" if f["cobrar"] else "$0.00"])
    data.append(["", "", "", "TOTAL", f"${total:.2f}"])
    t = Table(data, repeatRows=1, colWidths=[2.2 * inch, 1.3 * inch, 1.7 * inch, 0.7 * inch, 0.9 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1a5276")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 7.5),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#eafaf1")),
        ("FONTNAME", (3, -1), (-1, -1), "Helvetica-Bold"),
        ("ALIGN", (4, 0), (4, -1), "RIGHT"),
        ("ALIGN", (3, 0), (3, -1), "CENTER"),
    ]))
    story.append(t)
    doc.build(story)
    out.seek(0)
    return StreamingResponse(
        iter([out.getvalue()]), media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename=Reporte_Honorarios.pdf"})
