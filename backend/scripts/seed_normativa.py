"""Siembra (o re-siembra) la biblioteca de normativa con PDFs locales.
Uso:  python scripts/seed_normativa.py <lrti.pdf> <reglamento.pdf> <vigente.pdf>
Hace lo mismo que el endpoint /api/normativa/{slug}/reemplazar pero desde la
máquina local, usando el .env del backend (service key)."""
import io
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

from PyPDF2 import PdfReader
from supabase import create_client

BUCKET = "normativa"
DOCS = [
    ("lrti", "Ley de Régimen Tributario Interno (LRTI)",
     "Cuerpo legal principal. ICE: Arts. 75-89 (exenciones Art. 77; tarifas y rebaja del 50% Art. 82)."),
    ("reglamento-lrti", "Reglamento para la Aplicación de la LRTI",
     "Reglamento de aplicación. ICE: Arts. 197 y ss. (exención Arts. 199.3/199.4; rebaja 50% Art. 199.5)."),
    ("normativa-vigente", "Normativa institucional vigente",
     "Normativa vigente; puede sufrir cambios o reemplazos según se vaya actualizando."),
]


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)
    supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])

    for (slug, titulo, descripcion), ruta in zip(DOCS, sys.argv[1:4]):
        print(f"→ {slug}: {ruta}")
        contenido = open(ruta, "rb").read()
        reader = PdfReader(io.BytesIO(contenido))
        paginas = [(i + 1, (p.extract_text() or "")) for i, p in enumerate(reader.pages)]
        print(f"   {len(paginas)} páginas extraídas")

        datos = {"slug": slug, "titulo": titulo, "descripcion": descripcion,
                 "archivo_nombre": os.path.basename(ruta), "num_paginas": len(paginas),
                 "updated_at": datetime.now(timezone.utc).isoformat()}
        res = supabase.table("normativa_docs").upsert(datos, on_conflict="slug").execute()
        doc_id = res.data[0]["id"]

        supabase.table("normativa_paginas").delete().eq("doc_id", doc_id).execute()
        lote = [{"doc_id": doc_id, "pagina": n, "texto": t} for n, t in paginas]
        for i in range(0, len(lote), 100):
            supabase.table("normativa_paginas").insert(lote[i:i + 100]).execute()
        print("   texto cargado")

        supabase.storage.from_(BUCKET).upload(
            f"{slug}.pdf", contenido,
            file_options={"content-type": "application/pdf", "upsert": "true"})
        print("   PDF subido al bucket")

    print("✔ Biblioteca de normativa sembrada.")


if __name__ == "__main__":
    main()
