"""Biblioteca de normativa: cuerpos legales (LRTI, Reglamento, normativa
institucional vigente) presentados como libro consultable. El texto se extrae
por página al subir el PDF (PyPDF2) y se guarda en normativa_paginas para
búsqueda; el PDF original queda en el bucket 'normativa' de Supabase Storage.
Los documentos son reemplazables: subir una nueva versión regenera todo."""
import io
import re
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from auth import get_current_user
from database import get_supabase_client
from routers.access import es_admin

router = APIRouter(prefix="/api/normativa", tags=["normativa"])

BUCKET = "normativa"

# Documentos esperados (se crean al subir el PDF por primera vez)
DOCS_BASE = {
    "lrti": {
        "titulo": "Ley de Régimen Tributario Interno (LRTI)",
        "descripcion": "Cuerpo legal principal. ICE: Arts. 75-89 (exenciones Art. 77; tarifas y rebaja del 50% Art. 82).",
    },
    "reglamento-lrti": {
        "titulo": "Reglamento para la Aplicación de la LRTI",
        "descripcion": "Reglamento de aplicación. ICE: Arts. 197 y ss. (exención Arts. 199.3/199.4; rebaja 50% Art. 199.5).",
    },
    "normativa-vigente": {
        "titulo": "Normativa institucional vigente",
        "descripcion": "Normativa vigente; puede sufrir cambios o reemplazos según se vaya actualizando.",
    },
}


def _doc(supabase, slug):
    res = supabase.table("normativa_docs").select("*").eq("slug", slug).execute()
    return res.data[0] if res.data else None


@router.get("/")
async def listar(_: str = Depends(get_current_user)):
    """Documentos disponibles (con metadatos de los esperados aunque falten)."""
    try:
        supabase = get_supabase_client()
        res = supabase.table("normativa_docs").select(
            "id,slug,titulo,descripcion,archivo_nombre,num_paginas,updated_at").execute()
        docs = {d["slug"]: d for d in (res.data or [])}
        out = []
        for slug, base in DOCS_BASE.items():
            d = docs.pop(slug, None)
            out.append(d or {"slug": slug, **base, "archivo_nombre": "", "num_paginas": 0, "updated_at": None})
        out.extend(docs.values())  # documentos extra subidos con otro slug
        return {"data": out}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{slug}/pagina/{num}")
async def pagina(slug: str, num: int, _: str = Depends(get_current_user)):
    """Texto de una página del documento (vista de libro)."""
    try:
        supabase = get_supabase_client()
        d = _doc(supabase, slug)
        if not d:
            raise HTTPException(status_code=404, detail="Documento no cargado todavía.")
        res = supabase.table("normativa_paginas").select("texto").eq(
            "doc_id", d["id"]).eq("pagina", num).execute()
        texto = res.data[0]["texto"] if res.data else ""
        return {"slug": slug, "titulo": d["titulo"], "pagina": num,
                "num_paginas": d.get("num_paginas") or 0, "texto": texto}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _snippet(texto, q, ancho=170):
    t = texto or ""
    i = t.upper().find(q.upper())
    if i < 0:
        return t[:ancho]
    ini = max(0, i - ancho // 2)
    fin = min(len(t), i + len(q) + ancho // 2)
    pre = "…" if ini > 0 else ""
    post = "…" if fin < len(t) else ""
    return pre + re.sub(r"\s+", " ", t[ini:fin]).strip() + post


@router.get("/{slug}/buscar")
async def buscar(slug: str, q: str = Query(..., min_length=2), _: str = Depends(get_current_user)):
    """Búsqueda dentro del cuerpo legal: páginas que contienen el texto."""
    try:
        supabase = get_supabase_client()
        d = _doc(supabase, slug)
        if not d:
            raise HTTPException(status_code=404, detail="Documento no cargado todavía.")
        res = supabase.table("normativa_paginas").select("pagina,texto").eq(
            "doc_id", d["id"]).ilike("texto", f"%{q}%").order("pagina").limit(60).execute()
        hits = [{"pagina": r["pagina"], "snippet": _snippet(r.get("texto"), q)} for r in (res.data or [])]
        return {"slug": slug, "q": q, "total": len(hits), "data": hits}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{slug}/pdf")
async def url_pdf(slug: str, _: str = Depends(get_current_user)):
    """URL pública del PDF original (bucket 'normativa')."""
    try:
        supabase = get_supabase_client()
        d = _doc(supabase, slug)
        if not d or not d.get("archivo_nombre"):
            raise HTTPException(status_code=404, detail="Documento no cargado todavía.")
        url = supabase.storage.from_(BUCKET).get_public_url(f"{slug}.pdf")
        return {"url": url, "archivo_nombre": d.get("archivo_nombre")}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{slug}/reemplazar")
async def reemplazar(
    slug: str,
    file: UploadFile = File(...),
    titulo: str = Form(""),
    descripcion: str = Form(""),
    user_id: str = Depends(get_current_user),
):
    """Sube (o reemplaza) el PDF del cuerpo legal: extrae el texto por página
    para la búsqueda y guarda el original en Storage. Reemplazable cuando la
    normativa se actualice."""
    if not es_admin(user_id):
        raise HTTPException(status_code=403, detail="Solo administradores")
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="El archivo debe ser un PDF.")
    try:
        from PyPDF2 import PdfReader
        contenido = await file.read()
        reader = PdfReader(io.BytesIO(contenido))
        paginas = [(i + 1, (p.extract_text() or "")) for i, p in enumerate(reader.pages)]
        if not paginas:
            raise HTTPException(status_code=400, detail="El PDF no tiene páginas legibles.")

        supabase = get_supabase_client()
        base = DOCS_BASE.get(slug, {})
        d = _doc(supabase, slug)
        datos = {
            "slug": slug,
            "titulo": titulo or (d or {}).get("titulo") or base.get("titulo") or slug,
            "descripcion": descripcion or (d or {}).get("descripcion") or base.get("descripcion") or "",
            "archivo_nombre": file.filename,
            "num_paginas": len(paginas),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        if d:
            supabase.table("normativa_docs").update(datos).eq("id", d["id"]).execute()
            doc_id = d["id"]
        else:
            res = supabase.table("normativa_docs").insert(datos).execute()
            doc_id = res.data[0]["id"]

        # Regenerar páginas (reemplazo completo)
        supabase.table("normativa_paginas").delete().eq("doc_id", doc_id).execute()
        lote = [{"doc_id": doc_id, "pagina": n, "texto": t} for n, t in paginas]
        for i in range(0, len(lote), 100):
            supabase.table("normativa_paginas").insert(lote[i:i + 100]).execute()

        # PDF original al bucket (upsert)
        supabase.storage.from_(BUCKET).upload(
            f"{slug}.pdf", contenido,
            file_options={"content-type": "application/pdf", "upsert": "true"})

        return {"ok": True, "slug": slug, "num_paginas": len(paginas), "titulo": datos["titulo"]}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
