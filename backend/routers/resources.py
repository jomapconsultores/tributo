import os
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from auth import get_current_user

router = APIRouter(prefix="/api/resources", tags=["resources"])

RES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources")
CODIGOS_PATH = os.path.join(RES_DIR, "codigos_ice.xls")


@router.get("/codigos-ice/info")
async def codigos_info(_: str = Depends(get_current_user)):
    if not os.path.exists(CODIGOS_PATH):
        return {"exists": False}
    st = os.stat(CODIGOS_PATH)
    return {"exists": True, "size": st.st_size, "modified": st.st_mtime}


@router.get("/codigos-ice")
async def get_codigos(_: str = Depends(get_current_user)):
    if not os.path.exists(CODIGOS_PATH):
        raise HTTPException(status_code=404, detail="No hay archivo de Códigos ICE cargado")
    return FileResponse(
        CODIGOS_PATH,
        filename="Códigos ICE.xls",
        media_type="application/vnd.ms-excel",
    )


@router.post("/codigos-ice")
async def replace_codigos(file: UploadFile = File(...), _: str = Depends(get_current_user)):
    """Reemplaza el archivo de Códigos ICE (puede actualizarse continuamente)."""
    try:
        os.makedirs(RES_DIR, exist_ok=True)
        content = await file.read()
        with open(CODIGOS_PATH, "wb") as f:
            f.write(content)
        return {"message": "Códigos ICE actualizado", "size": len(content)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
