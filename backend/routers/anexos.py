# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from typing import Optional, List
from datetime import datetime, timezone
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client, fetch_all, fetch_in
from services.anexo_export import generar_anexo_excel, generar_anexo_pdf
from tenancy import assert_client_owner, visible_client_ids
from services.activity import registrar

router = APIRouter(prefix="/api/anexos", tags=["anexos"])

# Columnas que se devuelven al listar. El período va aparte del JSON para poder
# ordenar y recuperar "los anexos de meses anteriores" del contribuyente.
COLS = "id,client_id,tipo,datos,periodo_anio,periodo_mes,created_at,updated_at"
COLS_VIEJAS = "id,client_id,tipo,datos,created_at"


def _ahora() -> str:
    """Marca de tiempo de la última edición del anexo."""
    return datetime.now(timezone.utc).isoformat()


def _falta_columna(e: Exception) -> bool:
    """True si el error es "esa columna no existe" (migración 061 sin aplicar).

    Entre aplicar la migración y desplegar este código pueden pasar minutos: que
    el anexo se siga guardando —sin período— es preferible a un 500."""
    m = (str(e) or "").lower()
    return "periodo_anio" in m or "periodo_mes" in m or "updated_at" in m


def _asegurar_acceso(supabase, anexo_id: str, user_id: str):
    """404 si el usuario no alcanza el contribuyente del que cuelga el anexo.

    Los anexos sueltos (sin client_id, solo datos antiguos) siguen siendo de su
    autor: no hay contribuyente contra el que comprobar el rol."""
    r = supabase.table("anexos").select("id,client_id,user_id").eq("id", anexo_id).execute().data
    if not r:
        raise HTTPException(status_code=404, detail="Anexo no encontrado")
    fila = r[0]
    if fila.get("client_id"):
        assert_client_owner(fila["client_id"], user_id)
    elif fila.get("user_id") != user_id:
        raise HTTPException(status_code=404, detail="Anexo no encontrado")
    return fila


def _periodo_del_cliente(supabase, client_id: str):
    """(año, mes) del contribuyente/período al que se está guardando el anexo."""
    if not client_id:
        return None, None
    r = supabase.table("clients").select("periodo_anio,periodo_mes").eq("id", client_id).execute().data
    if not r:
        return None, None
    c = r[0]
    anio = int(c["periodo_anio"]) if c.get("periodo_anio") else None
    mes = int(c["periodo_mes"]) if c.get("periodo_mes") else None
    return anio, mes


def _con_periodo(datos: dict, anio, mes) -> dict:
    """Cabecera del anexo alineada con el período del contribuyente.

    El anexo se atribuye al mes de SU contribuyente: si se recupera el de un mes
    anterior para guardarlo en otro período, el Anio/Mes de la cabecera se
    corrige acá —así el XML que se genere después no declara el mes equivocado."""
    if not isinstance(datos, dict) or anio is None or mes is None:
        return datos
    salida = dict(datos)
    header = dict(salida.get("header") or {})
    header["Anio"] = str(anio)
    header["Mes"] = str(mes).zfill(2)
    salida["header"] = header
    return salida


def _ordenar(filas):
    """Más recientes primero: por período declarado y, a igualdad, por fecha."""
    return sorted(
        filas,
        key=lambda a: (a.get("periodo_anio") or 0, a.get("periodo_mes") or 0,
                       a.get("created_at") or ""),
        reverse=True,
    )


class AnexoIn(BaseModel):
    client_id: str
    tipo: str
    datos: dict


class AnexoUpdate(BaseModel):
    tipo: Optional[str] = None
    datos: Optional[dict] = None


class AnexoExport(BaseModel):
    tipo: str
    header: dict
    rows: List[dict]


@router.get("/")
async def listar(client_id: Optional[str] = Query(None), user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        cols = COLS
        try:
            supabase.table("anexos").select(cols).limit(1).execute()
        except Exception as e:
            if not _falta_columna(e):
                raise
            cols = COLS_VIEJAS
        if client_id:
            assert_client_owner(client_id, user_id)
            data = supabase.table("anexos").select(cols).eq("client_id", client_id).execute().data or []
        else:
            vis = visible_client_ids(user_id)   # None = admin (ve todo)
            if vis is None:
                data = fetch_all(lambda: supabase.table("anexos").select(cols))
            else:
                # Solo las SUELTAS (sin contribuyente): lo que cuelga de un
                # contribuyente visible ya viene abajo por client_id. Traerlas
                # todas por user_id arrastraría a la empresa activa los anexos
                # que el usuario creó en OTRA (mismo user_id, cartera ajena).
                own = supabase.table("anexos").select(cols).eq("user_id", user_id)\
                    .is_("client_id", "null").execute().data or []
                sh = fetch_in(lambda: supabase.table("anexos").select(cols), vis, "client_id")
                seen, data = set(), []
                for r in own + sh:
                    if r["id"] not in seen:
                        seen.add(r["id"])
                        data.append(r)
        return {"data": _ordenar(data)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/")
async def guardar(entry: AnexoIn, user_id: str = Depends(get_current_user)):
    """Graba el anexo en la base de datos del contribuyente, atribuido a su mes.

    Si ese contribuyente/período ya tiene un anexo del mismo tipo, se REEMPLAZA
    en vez de duplicarlo: el anexo del mes es uno solo, y volver a guardarlo
    —por ejemplo, el de un mes anterior traído y corregido— lo deja al día."""
    try:
        supabase = get_supabase_client()
        assert_client_owner(entry.client_id, user_id)
        tipo = entry.tipo.upper()
        anio, mes = _periodo_del_cliente(supabase, entry.client_id)
        datos = _con_periodo(entry.datos, anio, mes)
        fila = {"client_id": entry.client_id, "user_id": user_id, "tipo": tipo, "datos": datos}
        periodo = {"periodo_anio": anio, "periodo_mes": mes}

        # ¿Ese contribuyente/período ya tiene anexo de este tipo? (client_id ya
        # ES el período; el filtro por año/mes solo descarta desajustes viejos)
        def _buscar(con_periodo: bool):
            q = supabase.table("anexos").select("id,user_id").eq("client_id", entry.client_id).eq("tipo", tipo)
            if con_periodo and anio and mes:
                q = q.eq("periodo_anio", anio).eq("periodo_mes", mes)
            return (q.execute().data or [None])[0]

        try:
            existente = _buscar(True)
        except Exception as e:
            if not _falta_columna(e):
                raise
            existente = _buscar(False)

        if existente:
            # Se preserva el AUTOR del anexo: quien lo actualiza puede ser otro
            # del despacho con acceso al mismo contribuyente.
            fila = {k: v for k, v in fila.items() if k != "user_id"}
            try:
                res = supabase.table("anexos").update({**fila, **periodo, "updated_at": _ahora()})\
                    .eq("id", existente["id"]).execute()
            except Exception as e:
                if not _falta_columna(e):
                    raise
                res = supabase.table("anexos").update(fila).eq("id", existente["id"]).execute()
        else:
            try:
                res = supabase.table("anexos").insert({**fila, **periodo}).execute()
            except Exception as e:
                if not _falta_columna(e):
                    raise
                res = supabase.table("anexos").insert(fila).execute()

        registrar(actor_user_id=user_id, action="save", module="anexos",
                  entity=f"Anexo {tipo}", client_id=entry.client_id)
        salida = res.data[0] if res.data else {}
        return {**salida, "reemplazado": bool(existente)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/{anexo_id}")
async def actualizar(anexo_id: str, entry: AnexoUpdate, user_id: str = Depends(get_current_user)):
    """Actualiza un anexo guardado (al volver a guardar uno recuperado no se duplica)."""
    try:
        supabase = get_supabase_client()
        # Autorización por CONTRIBUYENTE, no por quien lo creó (igual que al
        # guardarlo). Exigir user_id dejaba el anexo en manos de su autor: la
        # funcionaria que abría el que había guardado el administrador y volvía
        # a guardarlo recibía un 404 y perdía el trabajo en silencio.
        fila = _asegurar_acceso(supabase, anexo_id, user_id)
        data = {}
        if entry.tipo is not None:
            data["tipo"] = entry.tipo.upper()
        if entry.datos is not None:
            anio, mes = _periodo_del_cliente(supabase, fila.get("client_id"))
            data["datos"] = _con_periodo(entry.datos, anio, mes)
            if anio and mes:
                data["periodo_anio"], data["periodo_mes"] = anio, mes
        if not data:
            raise HTTPException(status_code=400, detail="Nada que actualizar")
        try:
            res = supabase.table("anexos").update({**data, "updated_at": _ahora()}).eq("id", anexo_id).execute()
        except Exception as e:
            if not _falta_columna(e):
                raise
            data.pop("periodo_anio", None)
            data.pop("periodo_mes", None)
            res = supabase.table("anexos").update(data).eq("id", anexo_id).execute()
        if not res.data:
            raise HTTPException(status_code=404, detail="Anexo no encontrado")
        return res.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/export/excel")
async def export_excel(payload: AnexoExport, _: str = Depends(get_current_user)):
    """Exporta el anexo en edición (cabecera + filas) a Excel."""
    try:
        contenido = generar_anexo_excel(payload.tipo, payload.header, payload.rows)
        nombre = f"Anexo_{payload.tipo.upper()}_{payload.header.get('Anio','')}{str(payload.header.get('Mes','')).zfill(2)}.xlsx"
        return StreamingResponse(
            iter([contenido]),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename={nombre}"})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/export/pdf")
async def export_pdf(payload: AnexoExport, _: str = Depends(get_current_user)):
    """Exporta el anexo en edición (cabecera + filas) a PDF."""
    try:
        contenido = generar_anexo_pdf(payload.tipo, payload.header, payload.rows)
        nombre = f"Anexo_{payload.tipo.upper()}_{payload.header.get('Anio','')}{str(payload.header.get('Mes','')).zfill(2)}.pdf"
        return StreamingResponse(
            iter([contenido]), media_type="application/pdf",
            headers={"Content-Disposition": f"attachment; filename={nombre}"})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{anexo_id}")
async def obtener(anexo_id: str, user_id: str = Depends(get_current_user)):
    """Un anexo guardado con todo su contenido, para volver a abrirlo y editarlo.

    Va DESPUÉS de las rutas fijas (/export/...) para que no se las trague."""
    try:
        supabase = get_supabase_client()
        _asegurar_acceso(supabase, anexo_id, user_id)
        try:
            r = supabase.table("anexos").select(COLS).eq("id", anexo_id).execute().data
        except Exception as e:
            if not _falta_columna(e):
                raise
            r = supabase.table("anexos").select(COLS_VIEJAS).eq("id", anexo_id).execute().data
        if not r:
            raise HTTPException(status_code=404, detail="Anexo no encontrado")
        return r[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{anexo_id}")
async def eliminar(anexo_id: str, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        _asegurar_acceso(supabase, anexo_id, user_id)   # por contribuyente, no por autor
        supabase.table("anexos").delete().eq("id", anexo_id).execute()
        return {"message": "Eliminado"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
