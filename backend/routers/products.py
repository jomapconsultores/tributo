from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Optional
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client
from services.codigos_ice import buscar_bd, lookups as codigos_lookups, importar_a_bd, contar_bd
from tenancy import assert_client_owner, can_access_identificacion

router = APIRouter(prefix="/api/products", tags=["products"])

COLUMNS = ("id,identificacion,nombre,cod_prod_sri,cod_prod_ice,cod_prod_pvp,cod_impuesto,"
           "cod_clasificacion,cod_pais,capacidad,grado,presentacion,unidad,botellas_por_caja")


class ProductIn(BaseModel):
    identificacion: str
    nombre: str
    cod_prod_sri: Optional[str] = ""
    cod_prod_ice: Optional[str] = ""
    cod_prod_pvp: Optional[str] = ""
    cod_impuesto: Optional[str] = "3031"
    cod_clasificacion: Optional[str] = ""
    cod_pais: Optional[str] = "593"
    capacidad: Optional[str] = "750"
    grado: Optional[str] = "15"
    presentacion: Optional[str] = "13"
    unidad: Optional[str] = "66"
    botellas_por_caja: Optional[int] = 12


class ProductUpdate(BaseModel):
    nombre: Optional[str] = None
    cod_prod_sri: Optional[str] = None
    cod_prod_ice: Optional[str] = None
    cod_prod_pvp: Optional[str] = None
    cod_impuesto: Optional[str] = None
    cod_clasificacion: Optional[str] = None
    cod_pais: Optional[str] = None
    capacidad: Optional[str] = None
    grado: Optional[str] = None
    presentacion: Optional[str] = None
    unidad: Optional[str] = None
    botellas_por_caja: Optional[int] = None


def _ident_de_cliente(supabase, client_id):
    c = supabase.table("clients").select("identificacion").eq("id", client_id).execute()
    return c.data[0]["identificacion"] if c.data else None


@router.get("/codigos-ice/search")
async def codigos_ice_search(q: str = Query(""), impuesto: Optional[str] = Query("3031"), _: str = Depends(get_current_user)):
    """Busca marcas en los Códigos ICE (desde la BD; cae al archivo si está vacía)."""
    return {"data": buscar_bd(get_supabase_client(), q, impuesto)}


@router.get("/codigos-ice/count")
async def codigos_ice_count(_: str = Depends(get_current_user)):
    return {"total": contar_bd(get_supabase_client())}


@router.post("/codigos-ice/import")
async def codigos_ice_import(_: str = Depends(get_current_user)):
    """Importa/actualiza TODOS los códigos del archivo a la BD (reemplazo total)."""
    try:
        total = importar_a_bd(get_supabase_client())
        return {"message": "Códigos importados", "total": total}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/codigos-ice/lookups")
async def codigos_ice_lookups(_: str = Depends(get_current_user)):
    """Listas auxiliares (presentación, capacidad, unidad, grado, país)."""
    return codigos_lookups()


@router.get("/")
async def list_products(identificacion: str = Query(...), user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        # El catálogo se guarda por contribuyente (RUC) y se comparte entre todos
        # sus usuarios autorizados: se muestra completo (lo cree quien lo cree),
        # igual que /by-client, para que socio/admin trabajen sobre lo mismo.
        if not can_access_identificacion(user_id, identificacion):
            raise HTTPException(status_code=404, detail="Contribuyente no encontrado")
        res = supabase.table("client_products").select(COLUMNS).eq("identificacion", identificacion).order("nombre").execute()
        return {"data": res.data or []}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/by-client/{client_id}")
async def by_client(client_id: str, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        assert_client_owner(client_id, user_id)
        ident = _ident_de_cliente(supabase, client_id)
        if not ident:
            return {"data": [], "identificacion": None}
        # Autorizado por assert_client_owner: el catálogo del contribuyente se ve
        # completo (lo cree quien lo cree), para que socio/admin trabajen igual.
        res = supabase.table("client_products").select(COLUMNS).eq("identificacion", ident).order("nombre").execute()
        return {"data": res.data or [], "identificacion": ident}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/")
async def create_product(entry: ProductIn, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        data = entry.dict()
        data["user_id"] = user_id
        data["nombre"] = (data.get("nombre") or "").strip().upper()
        if not data["nombre"]:
            raise HTTPException(status_code=400, detail="El nombre es obligatorio")
        if not can_access_identificacion(user_id, data["identificacion"]):
            raise HTTPException(status_code=404, detail="Contribuyente no encontrado")
        # El catálogo se comparte por RUC. Solo se considera duplicado el MISMO
        # producto con la MISMA presentación, capacidad y grado; así se permiten
        # variantes (misma marca, distinta presentación/capacidad/grado).
        existing = supabase.table("client_products").select("id")\
            .eq("identificacion", data["identificacion"]).eq("nombre", data["nombre"])\
            .eq("presentacion", data.get("presentacion"))\
            .eq("capacidad", data.get("capacidad"))\
            .eq("grado", data.get("grado"))\
            .eq("unidad", data.get("unidad"))\
            .eq("cod_pais", data.get("cod_pais")).execute()
        if existing.data:
            res = supabase.table("client_products").update(data).eq("id", existing.data[0]["id"]).execute()
        else:
            res = supabase.table("client_products").insert(data).execute()
        return res.data[0] if res.data else None
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


def _assert_puede_editar_producto(supabase, prod_id, user_id):
    """Autoriza por el RUC del producto (catálogo compartido), no por quién lo creó."""
    p = supabase.table("client_products").select("identificacion").eq("id", prod_id).execute()
    if not p.data:
        raise HTTPException(status_code=404, detail="Producto no encontrado")
    if not can_access_identificacion(user_id, p.data[0]["identificacion"]):
        raise HTTPException(status_code=404, detail="Producto no encontrado")


@router.put("/{prod_id}")
async def update_product(prod_id: str, entry: ProductUpdate, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        _assert_puede_editar_producto(supabase, prod_id, user_id)
        data = {k: v for k, v in entry.dict().items() if v is not None}
        if "nombre" in data:
            data["nombre"] = data["nombre"].strip().upper()
        res = supabase.table("client_products").update(data).eq("id", prod_id).execute()
        return res.data[0] if res.data else None
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{prod_id}")
async def delete_product(prod_id: str, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        _assert_puede_editar_producto(supabase, prod_id, user_id)
        supabase.table("client_products").delete().eq("id", prod_id).execute()
        return {"message": "Eliminado"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
