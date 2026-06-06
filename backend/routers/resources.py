from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import Response
from auth import get_current_user
from services import storage
from services import codigos_ice

router = APIRouter(prefix="/api/resources", tags=["resources"])


@router.get("/codigos-ice/info")
async def codigos_info(_: str = Depends(get_current_user)):
    return storage.info_codigos()


@router.get("/codigos-ice")
async def get_codigos(_: str = Depends(get_current_user)):
    data = storage.descargar_codigos()
    if not data:
        raise HTTPException(status_code=404, detail="No hay archivo de Códigos ICE cargado")
    return Response(
        content=data,
        media_type="application/vnd.ms-excel",
        headers={"Content-Disposition": 'attachment; filename="Codigos ICE.xls"'},
    )


@router.post("/codigos-ice")
async def replace_codigos(file: UploadFile = File(...), _: str = Depends(get_current_user)):
    """Reemplaza el archivo de Códigos ICE en Supabase Storage."""
    try:
        content = await file.read()
        storage.subir_codigos(content)
        codigos_ice.limpiar_cache()  # el próximo search/import lee el nuevo archivo
        return {"message": "Códigos ICE actualizado", "size": len(content)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
