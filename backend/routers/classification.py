from fastapi import APIRouter, Depends, HTTPException, File, UploadFile, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, List
from auth import get_current_user
from database import get_supabase_client, fetch_all, fetch_in
import pandas as pd
import io
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib import colors
from reportlab.lib.units import inch

router = APIRouter(prefix="/api/classification", tags=["classification"])

import time as _time

_BACKFILL_TTL = 60  # seg: no repetir el escaneo completo en cada carga de la pagina
_backfill_cache: dict = {}  # (user_id, is_admin) -> timestamp del ultimo backfill

class ClassificationEntry(BaseModel):
    ruc: str
    nombre_proveedor: str
    categoria: str


def _client_ids_del_equipo(supabase, user_id):
    """client_id de TODOS los contribuyentes que el usuario puede ver (según su
    rol), o None si es admin (ve todos → sin filtro). La clasificación es un
    catálogo de EQUIPO: al clasificar un RUC hay que reclasificar sus facturas en
    todos esos contribuyentes, no solo las que subió este usuario."""
    from tenancy import visible_client_ids
    try:
        return visible_client_ids(user_id)  # None = admin (todos)
    except Exception as e:
        print(f"Error resolviendo clientes visibles de {user_id}: {e}")
        return set()


def _propagate_classification(supabase, ruc: str, categoria: str, user_id: str,
                              client_ids="__auto__") -> int:
    """Aplica la categoría a TODAS las facturas de ese RUC en los contribuyentes
    que el usuario puede ver (no solo las que subió él): las que están SIN
    CLASIFICAR y también las que ya tenían OTRA categoría. Así, al cambiar la
    clasificación de un RUC, se reclasifican todos sus comprobantes de todo el
    EQUIPO (una clasificación por RUC, consistente). Devuelve cuántas facturas
    cambiaron de categoría (no cuenta las que ya tenían esa misma categoría).

    client_ids: conjunto de client_id a los que limitar la propagación. Por
    defecto ('__auto__') se resuelven los contribuyentes visibles del usuario;
    None = admin (todas las facturas del RUC, sin filtro por contribuyente)."""
    ruc = (ruc or "").strip()
    categoria = (categoria or "").strip().upper()
    if not ruc or not categoria:
        return 0
    if client_ids == "__auto__":
        client_ids = _client_ids_del_equipo(supabase, user_id)
    try:
        if client_ids is None:  # admin: todas las facturas del RUC
            rows = supabase.table("invoices").select("id,clasificacion")\
                .eq("ruc_proveedor", ruc).execute().data or []
        else:
            client_ids = list(client_ids)
            if not client_ids:
                return 0
            rows = []
            for i in range(0, len(client_ids), 100):  # .in_ por lotes de client_id
                lote = client_ids[i:i + 100]
                r = supabase.table("invoices").select("id,clasificacion")\
                    .eq("ruc_proveedor", ruc).in_("client_id", lote).execute().data or []
                rows.extend(r)
    except Exception as e:
        print(f"Error leyendo facturas del RUC {ruc}: {e}")
        return 0
    # Solo las que tienen una categoría distinta (incluye SIN CLASIFICAR / null)
    a_cambiar = [r["id"] for r in rows
                 if (r.get("clasificacion") or "").strip().upper() != categoria]
    if not a_cambiar:
        return 0
    cambiadas = 0
    for i in range(0, len(a_cambiar), 200):  # en lotes, por si el RUC tiene muchas
        lote = a_cambiar[i:i + 200]
        try:
            r = supabase.table("invoices").update({"clasificacion": categoria}).in_("id", lote).execute()
            cambiadas += len(r.data or [])
        except Exception as e:
            print(f"Error propagando clasificación {ruc}: {e}")
    return cambiadas


def resolve_team_classification(supabase, user_id: str) -> dict:
    """{ruc: categoria} del catálogo EFECTIVO del equipo para auto-clasificar al
    subir comprobantes: catálogo GENERAL (filas de los admin) como base + los
    OVERRIDES personales del usuario (el override con categoría gana). Antes cada
    carga solo miraba las filas del propio usuario, así que un no-admin subía todo
    SIN CLASIFICAR aunque el catálogo general del equipo ya tuviera la regla."""
    try:
        todas = fetch_all(lambda: supabase.table("classification_map")
                          .select("ruc,categoria,user_id,updated_at,created_at"))
    except Exception as e:
        print(f"Error cargando catálogo de equipo: {e}")
        return {}
    admin_set = set(_admin_ids(supabase))
    general = _mejor_por_ruc([r for r in todas if r.get("user_id") in admin_set])
    m = {}
    for ruc, g in general.items():
        cat = (g.get("categoria") or "").strip().upper()
        if cat:
            m[ruc] = cat
    for r in todas:  # overrides del usuario ganan sobre el general
        if r.get("user_id") == user_id:
            ruc = (r.get("ruc") or "").strip()
            cat = (r.get("categoria") or "").strip().upper()
            if ruc and cat:
                m[ruc] = cat
    return m

def _mejor_por_ruc(filas, prefer_user_id=None):
    """Una sola fila por RUC cuando el clasificador está repartido entre varios
    usuarios del equipo. Preferencia (de mayor a menor):
      1) fila CON categoría sobre una vacía,
      2) la más reciente (updated_at, o created_at si falta),
      3) en empate, la del propio usuario.
    Así una edición reciente del admin no queda 'tapada' por una fila antigua de
    otro usuario con el mismo RUC (causaba que las categorías 'se revirtieran')."""
    def _rank(r):
        has_cat = 1 if (r.get("categoria") or "").strip() else 0
        ts = r.get("updated_at") or r.get("created_at") or ""
        own = 1 if prefer_user_id and r.get("user_id") == prefer_user_id else 0
        return (has_cat, ts, own)
    best = {}
    for r in filas:
        k = (r.get("ruc") or "").strip()
        if not k:
            continue
        cur = best.get(k)
        if cur is None or _rank(r) > _rank(cur):
            best[k] = r
    return best


def _admin_ids(supabase):
    """user_ids con rol 'admin': dueños del catálogo GENERAL (compartido con todo
    el equipo). Los demás usuarios solo tienen OVERRIDES personales."""
    try:
        rows = supabase.table("app_admins").select("user_id").eq("role", "admin").execute().data or []
        return [r["user_id"] for r in rows]
    except Exception:
        return []


def _prov_map(supabase, user_id, is_admin):
    """Mapa RUC -> datos del catálogo de proveedores calificados (Rebajas/Exenciones):
    calificado, categoría (tipo de calificación), vigencia (inicio–fin) y actividad SRI."""
    cols = "ruc,calificado,categoria,vigencia_inicio,vigente_hasta,actividad"
    try:
        if is_admin:
            prov = fetch_all(lambda: supabase.table("rebajas_proveedores").select(cols))
        else:
            prov = supabase.table("rebajas_proveedores").select(cols).eq("user_id", user_id).execute().data or []
    except Exception:
        return {}
    m = {}
    for p in prov:
        k = (p.get("ruc") or "").strip()
        if not k:
            continue
        # Preferir un registro calificado si existe más de uno por RUC
        if k not in m or (p.get("calificado") and not m[k].get("calificado")):
            m[k] = p
    return m


def _fill_actividad(supabase, ruc, user_id=None):
    """Trae la actividad económica del SRI y la guarda en el clasificador (auto)."""
    from services.min_produccion import consultar_sri
    ruc = (ruc or "").strip()
    if not ruc:
        return
    try:
        sri = consultar_sri(ruc, timeout=8) or {}
        ae = (sri.get("actividad_economica") or "").strip()
        if ae:
            q = supabase.table("classification_map").update({"actividad": ae}).eq("ruc", ruc)
            if user_id:
                q = q.eq("user_id", user_id)
            q.execute()
    except Exception:
        pass


def _incluir_proveedores_calificados(supabase, user_id, is_admin):
    """Asegura que los proveedores calificados (Rebajas/Exenciones) también aparezcan
    en el clasificador de gastos: crea su fila en classification_map si falta.
    Escanea rebajas_proveedores + classification_map completos, así que se
    limita a una vez cada _BACKFILL_TTL segundos (antes corría en cada carga
    de la página del clasificador)."""
    cache_key = (user_id, is_admin)
    hit = _backfill_cache.get(cache_key)
    if hit and (_time.monotonic() - hit) < _BACKFILL_TTL:
        return
    _backfill_cache[cache_key] = _time.monotonic()
    try:
        cols = "ruc,nombre,categoria,user_id"
        if is_admin:
            prov = fetch_all(lambda: supabase.table("rebajas_proveedores").select(cols).eq("calificado", True))
            existentes = {(r.get("ruc") or "").strip() for r in fetch_all(lambda: supabase.table("classification_map").select("ruc"))}
        else:
            prov = supabase.table("rebajas_proveedores").select(cols).eq("user_id", user_id).eq("calificado", True).execute().data or []
            existentes = {(r.get("ruc") or "").strip() for r in (supabase.table("classification_map").select("ruc").eq("user_id", user_id).execute().data or [])}
        # Entran SIN CLASIFICAR (categoría de gasto vacía) para que el usuario
        # los clasifique. Su tipo de calificación se muestra en la columna
        # Calificación. Un solo insert en lote en vez de uno por proveedor.
        nuevas = []
        for p in prov:
            ruc = (p.get("ruc") or "").strip()
            if not ruc or ruc in existentes:
                continue
            nuevas.append({
                "user_id": p.get("user_id") or user_id,
                "ruc": ruc,
                "nombre_proveedor": (p.get("nombre") or "").upper(),
                "categoria": "",
            })
            existentes.add(ruc)
        for i in range(0, len(nuevas), 200):
            try:
                supabase.table("classification_map").insert(nuevas[i:i + 200]).execute()
            except Exception:
                pass
    except Exception:
        pass


@router.get("/")
async def list_classifications(user_id: str = Depends(get_current_user)):
    try:
        from routers.access import rol_de
        supabase = get_supabase_client()
        is_admin = rol_de(user_id) == "admin"
        _incluir_proveedores_calificados(supabase, user_id, is_admin)

        # Catálogo GENERAL (compartido con todo el equipo) = filas de los admin.
        # Cada usuario puede tener OVERRIDES personales (sus propias filas) que solo
        # le afectan a él. Distintivo: es_propio (mío) / override_users (para admin).
        admin_set = set(_admin_ids(supabase))
        filas = fetch_all(lambda: supabase.table("classification_map").select("*").order("nombre_proveedor"))
        general_by_ruc = _mejor_por_ruc([r for r in filas if r.get("user_id") in admin_set])

        if is_admin:
            # Para el admin: el catálogo general + cuántos usuarios personalizaron
            # cada RUC (distintivo para decidir si adopta el cambio al general).
            ov = {}
            for r in filas:
                if r.get("user_id") in admin_set:
                    continue
                if (r.get("categoria") or "").strip():
                    ov.setdefault((r.get("ruc") or "").strip(), set()).add(r.get("user_id"))
            rows = []
            for r in general_by_ruc.values():
                r["es_propio"] = True       # el admin edita directamente el general
                r["es_general"] = True
                r["override_users"] = len(ov.get((r.get("ruc") or "").strip(), ()))
                rows.append(r)
        else:
            # Usuario normal: general como base + sus overrides personales. Un
            # override vacío no tapa el general; un RUC exclusivo suyo sí se muestra.
            propios = {}
            for p in filas:
                if p.get("user_id") != user_id:
                    continue
                k = (p.get("ruc") or "").strip()
                if k:
                    propios[k] = p
            resultado = {}
            for k, g in general_by_ruc.items():
                resultado[k] = {**g, "es_propio": False, "es_general": True}
            for k, p in propios.items():
                if (p.get("categoria") or "").strip() or k not in resultado:
                    resultado[k] = {**p, "es_propio": True, "es_general": k in general_by_ruc}
            rows = list(resultado.values())

        rows.sort(key=lambda r: (r.get("nombre_proveedor") or ""))
        pmap = _prov_map(supabase, user_id, is_admin)
        for r in rows:
            k = (r.get("ruc") or "").strip()
            p = pmap.get(k) or {}
            r["calificado"] = bool(p.get("calificado"))
            r["calif_categoria"] = p.get("categoria") or ""
            r["calif_inicio"] = p.get("vigencia_inicio") or ""
            r["calif_fin"] = p.get("vigente_hasta") or ""
            # Actividad económica (SRI): la guardada en el clasificador o, si falta, la del proveedor
            r["actividad"] = (r.get("actividad") or "").strip() or (p.get("actividad") or "")
        return rows
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class RucsIn(BaseModel):
    rucs: List[str] = []


@router.post("/actividades-rucs")
async def actividades_rucs(body: RucsIn, user_id: str = Depends(get_current_user)):
    """Devuelve {ruc: actividad económica (SRI)} para una lista de RUC. Primero del
    clasificador (rápido); los que falten, del SRI (y los guarda si la fila existe)."""
    try:
        from services.min_produccion import consultar_sri
        supabase = get_supabase_client()
        rucs = list({(r or "").strip() for r in (body.rucs or []) if r and r.strip()})[:80]
        if not rucs:
            return {}
        res = {}
        try:
            rows = supabase.table("classification_map").select("ruc,actividad,id").in_("ruc", rucs).execute().data or []
        except Exception:
            rows = []
        id_por_ruc = {}
        for x in rows:
            k = (x.get("ruc") or "").strip()
            a = (x.get("actividad") or "").strip()
            if k and k not in id_por_ruc:
                id_por_ruc[k] = x.get("id")
            if k and a and a != "—" and k not in res:
                res[k] = a
        faltan = [r for r in rucs if r not in res][:20]  # cap para no demorar
        for ruc in faltan:
            try:
                sri = consultar_sri(ruc, timeout=6) or {}
            except Exception:
                sri = {}
            ae = (sri.get("actividad_economica") or "").strip()
            if ae:
                res[ruc] = ae
                if id_por_ruc.get(ruc):
                    try:
                        supabase.table("classification_map").update({"actividad": ae}).eq("id", id_por_ruc[ruc]).execute()
                    except Exception:
                        pass
        return res
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/por-contribuyente")
async def por_contribuyente(identificacion: str = Query(...), user_id: str = Depends(get_current_user)):
    """SOLO los gastos del propio contribuyente: los proveedores (RUC) que aparecen
    en SUS facturas de gastos, con su clasificación (categoría), calificación (tipo +
    vigencia) y actividad económica. Los que faltan aparecen SIN CLASIFICAR."""
    try:
        from routers.access import rol_de
        from tenancy import can_access_identificacion, visible_clients
        supabase = get_supabase_client()
        if not can_access_identificacion(user_id, identificacion):
            return []
        is_admin = rol_de(user_id) == "admin"
        # client_ids de TODOS los períodos visibles de ese contribuyente
        if is_admin:
            cls = supabase.table("clients").select("id").eq("identificacion", identificacion).execute().data or []
        else:
            cls = [c for c in visible_clients(user_id, "id,identificacion") if c.get("identificacion") == identificacion]
        client_ids = [c["id"] for c in cls]
        if not client_ids:
            return []
        # Proveedores (RUC + nombre) de las facturas de gastos del contribuyente
        inv = fetch_in(lambda: supabase.table("invoices").select("ruc_proveedor,nombre_proveedor"), client_ids, "client_id")
        prov = {}
        for r in inv:
            ruc = (r.get("ruc_proveedor") or "").strip()
            if ruc and ruc not in prov:
                prov[ruc] = (r.get("nombre_proveedor") or "").strip()
        if not prov:
            return []
        # Resolución general + override: cada RUC toma la categoría del override
        # personal del usuario si la tiene; si no, la del catálogo general (admin).
        admin_set = set(_admin_ids(supabase))
        todas = fetch_all(lambda: supabase.table("classification_map").select("*"))
        general_by_ruc = _mejor_por_ruc([r for r in todas if r.get("user_id") in admin_set])
        propios = {}
        for p in todas:
            if p.get("user_id") == user_id:
                k = (p.get("ruc") or "").strip()
                if k:
                    propios[k] = p
        rows = []
        for ruc, nombre in prov.items():
            p = propios.get(ruc)
            g = general_by_ruc.get(ruc)
            if p and (p.get("categoria") or "").strip():
                rows.append({**p, "es_propio": True, "es_general": ruc in general_by_ruc})
            elif g:
                rows.append({**g, "es_propio": False, "es_general": True})
            elif p:
                rows.append({**p, "es_propio": True, "es_general": False})
            else:
                try:
                    ins = supabase.table("classification_map").insert({
                        "user_id": user_id, "ruc": ruc,
                        "nombre_proveedor": (nombre or "").upper(), "categoria": "",
                    }).execute()
                    if ins.data:
                        rows.append({**ins.data[0], "es_propio": True, "es_general": False})
                except Exception:
                    pass
        pmap = _prov_map(supabase, user_id, is_admin)
        for r in rows:
            k = (r.get("ruc") or "").strip()
            p = pmap.get(k) or {}
            r["calificado"] = bool(p.get("calificado"))
            r["calif_categoria"] = p.get("categoria") or ""
            r["calif_inicio"] = p.get("vigencia_inicio") or ""
            r["calif_fin"] = p.get("vigente_hasta") or ""
            r["actividad"] = (r.get("actividad") or "").strip() or (p.get("actividad") or "")
        rows.sort(key=lambda r: (r.get("nombre_proveedor") or ""))
        return rows
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/enriquecer-actividades")
async def enriquecer_actividades(user_id: str = Depends(get_current_user)):
    """Trae la actividad económica principal del SRI para los RUC del clasificador
    que aún no la tienen. Procesa por lotes (rápido); el frontend llama en bucle
    hasta que 'restantes' sea 0. Marca '—' cuando el SRI no devuelve actividad."""
    try:
        from routers.access import rol_de
        from services.min_produccion import consultar_sri
        supabase = get_supabase_client()
        is_admin = rol_de(user_id) == "admin"
        q = supabase.table("classification_map").select("id,ruc,actividad")
        if not is_admin:
            q = q.eq("user_id", user_id)
        filas = q.execute().data or []
        faltan = [r for r in filas if (r.get("ruc") or "").strip() and not (r.get("actividad") or "").strip()]
        lote = faltan[:8]
        actualizados = 0
        for r in lote:
            ruc = (r.get("ruc") or "").strip()
            try:
                sri = consultar_sri(ruc, timeout=6) or {}
            except Exception:
                sri = {}
            ae = (sri.get("actividad_economica") or "").strip() or "—"
            try:
                supabase.table("classification_map").update({"actividad": ae}).eq("id", r["id"]).execute()
                if ae != "—":
                    actualizados += 1
            except Exception:
                pass
        return {"actualizados": actualizados, "procesados": len(lote),
                "restantes": max(0, len(faltan) - len(lote))}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/")
async def create_classification(
    entry: ClassificationEntry,
    user_id: str = Depends(get_current_user)
):
    try:
        supabase = get_supabase_client()
        ruc = entry.ruc.strip()
        existing = supabase.table("classification_map").select("id").eq("ruc", ruc).eq("user_id", user_id).execute()
        if existing.data:
            response = supabase.table("classification_map").update({
                "nombre_proveedor": entry.nombre_proveedor.upper(),
                "categoria": entry.categoria.upper()
            }).eq("ruc", ruc).eq("user_id", user_id).execute()
        else:
            response = supabase.table("classification_map").insert({
                "user_id": user_id,
                "ruc": ruc,
                "nombre_proveedor": entry.nombre_proveedor.upper(),
                "categoria": entry.categoria.upper()
            }).execute()
        reclasificadas = _propagate_classification(supabase, ruc, entry.categoria, user_id)
        # La actividad económica (SRI) NO se consulta aquí: era una llamada HTTP
        # síncrona al SRI (hasta 8s) que hacía lento el guardado. El frontend la
        # rellena aparte en lote (enriquecer-actividades) al cargar el clasificador.
        result = response.data[0] if response.data else {}
        return {**result, "reclasificadas": reclasificadas}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.put("/by-id/{entry_id}")
async def update_classification_by_id(
    entry_id: str,
    entry: ClassificationEntry,
    user_id: str = Depends(get_current_user)
):
    """Editar SIEMPRE escribe en el clasificador del que edita: el admin edita el
    catálogo GENERAL (compartido); cualquier otro usuario crea/actualiza su
    OVERRIDE personal (solo le afecta a él, con distintivo). Nunca modifica la fila
    de otro usuario. El id recibido solo sirve para detectar un renombre de RUC."""
    try:
        from routers.access import rol_de
        supabase = get_supabase_client()
        is_admin = rol_de(user_id) == "admin"
        new_ruc = entry.ruc.strip().replace("'", "")
        cur = supabase.table("classification_map").select("id,ruc,user_id").eq("id", entry_id).execute().data
        old = cur[0] if cur else None
        # Upsert por (user_id, ruc): el que edita es el dueño de la fila resultante.
        supabase.table("classification_map").upsert({
            "user_id": user_id,
            "ruc": new_ruc,
            "nombre_proveedor": entry.nombre_proveedor.upper(),
            "categoria": entry.categoria.upper(),
            "updated_at": "now()",
        }, on_conflict="user_id,ruc").execute()
        # Si el usuario RENOMBRÓ el RUC de SU PROPIA fila, borra la vieja (no deja huérfana).
        if old and old.get("user_id") == user_id and (old.get("ruc") or "").strip() != new_ruc:
            supabase.table("classification_map").delete().eq("id", entry_id).execute()
        # La reclasificación de facturas solo afecta al que edita (su propio dato).
        reclasificadas = _propagate_classification(supabase, new_ruc, entry.categoria, user_id)
        # Sin consulta síncrona al SRI aquí (hacía lento el guardado): la actividad
        # se rellena aparte en lote desde el frontend al cargar el clasificador.
        return {"ruc": new_ruc, "nombre_proveedor": entry.nombre_proveedor.upper(),
                "categoria": entry.categoria.upper(), "reclasificadas": reclasificadas,
                "es_propio": not is_admin, "es_general": is_admin}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/by-id/{entry_id}")
async def delete_classification_by_id(entry_id: str, user_id: str = Depends(get_current_user)):
    """El admin borra del catálogo GENERAL (afecta a todo el equipo). Un usuario
    normal solo puede quitar SU override personal de ese RUC (vuelve a ver el
    general); nunca borra el catálogo general."""
    try:
        from routers.access import rol_de
        supabase = get_supabase_client()
        cur = supabase.table("classification_map").select("ruc,user_id").eq("id", entry_id).execute().data
        if not cur:
            return {"message": "Deleted"}
        ruc = (cur[0].get("ruc") or "").strip()
        if rol_de(user_id) == "admin":
            for aid in _admin_ids(supabase):
                supabase.table("classification_map").delete().eq("user_id", aid).eq("ruc", ruc).execute()
        else:
            supabase.table("classification_map").delete().eq("user_id", user_id).eq("ruc", ruc).execute()
        return {"message": "Deleted"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/{ruc}")
async def update_classification(
    ruc: str,
    entry: ClassificationEntry,
    user_id: str = Depends(get_current_user)
):
    try:
        supabase = get_supabase_client()
        response = supabase.table("classification_map").update({
            "nombre_proveedor": entry.nombre_proveedor.upper(),
            "categoria": entry.categoria.upper()
        }).eq("ruc", ruc.strip()).eq("user_id", user_id).execute()
        reclasificadas = _propagate_classification(supabase, ruc, entry.categoria, user_id)
        result = response.data[0] if response.data else {}
        return {**result, "reclasificadas": reclasificadas}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.delete("/{ruc}")
async def delete_classification(ruc: str, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        supabase.table("classification_map").delete().eq("ruc", ruc.strip()).eq("user_id", user_id).execute()
        return {"message": "Deleted"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

def _propagate_classifications_bulk(supabase, filas: dict, user_id: str) -> int:
    """Como _propagate_classification pero para muchos RUC a la vez (usado en
    /import): consulta las facturas de TODOS los RUC en pocos lotes (en vez de
    una consulta por RUC) y agrupa los ids por categoría destino para hacer
    pocos UPDATE en lote en vez de uno por RUC."""
    rucs = list(filas.keys())
    if not rucs:
        return 0
    # Alcance de EQUIPO: reclasifica en todos los contribuyentes visibles del
    # usuario (no solo lo que subió él), igual que _propagate_classification.
    client_ids = _client_ids_del_equipo(supabase, user_id)
    invoices = []
    if client_ids is None:  # admin: por RUC en toda la base
        for i in range(0, len(rucs), 200):
            lote = rucs[i:i + 200]
            rows = supabase.table("invoices").select("id,ruc_proveedor,clasificacion")\
                .in_("ruc_proveedor", lote).execute().data or []
            invoices.extend(rows)
    else:
        client_ids = list(client_ids)
        if not client_ids:
            return 0
        for i in range(0, len(rucs), 200):
            lote_ruc = rucs[i:i + 200]
            for j in range(0, len(client_ids), 100):
                lote_cli = client_ids[j:j + 100]
                rows = supabase.table("invoices").select("id,ruc_proveedor,clasificacion")\
                    .in_("ruc_proveedor", lote_ruc).in_("client_id", lote_cli).execute().data or []
                invoices.extend(rows)

    por_categoria = {}  # categoria destino -> [ids a cambiar]
    for inv in invoices:
        categoria = filas.get(inv.get("ruc_proveedor"), (None, None))[1]
        if not categoria:
            continue
        actual = (inv.get("clasificacion") or "").strip().upper()
        if actual != categoria:
            por_categoria.setdefault(categoria, []).append(inv["id"])

    cambiadas = 0
    for categoria, ids in por_categoria.items():
        for i in range(0, len(ids), 200):
            lote = ids[i:i + 200]
            try:
                r = supabase.table("invoices").update({"clasificacion": categoria}).in_("id", lote).execute()
                cambiadas += len(r.data or [])
            except Exception as e:
                print(f"Error propagando clasificación en lote ({categoria}): {e}")
    return cambiadas


@router.post("/import")
async def import_classifications(
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user)
):
    try:
        content = await file.read()
        df = pd.read_excel(io.BytesIO(content), header=None)

        supabase = get_supabase_client()

        # 1) Parsear todo el Excel en memoria antes de tocar la BD (RUC repetido
        # en el archivo: la última fila gana, igual que antes fila por fila).
        filas = {}  # ruc -> (nombre, categoria)
        for _, row in df.iterrows():
            ruc = str(row[0]).strip().replace("'", "").zfill(13)
            nombre = str(row[1]).strip().upper() if len(row) > 1 else ""
            categoria = str(row[2]).strip().upper() if len(row) > 2 else ""
            if not ruc or not categoria or ruc == "NAN":
                continue
            filas[ruc] = (nombre, categoria)

        if not filas:
            return {"imported": 0, "updated": 0, "reclasificadas": 0}

        rucs = list(filas.keys())

        # 2) UNA consulta por lote (no una por fila) para saber cuáles ya existen.
        existentes = set()
        for i in range(0, len(rucs), 200):
            lote = rucs[i:i + 200]
            rows = supabase.table("classification_map").select("ruc")\
                .eq("user_id", user_id).in_("ruc", lote).execute().data or []
            existentes.update(r["ruc"] for r in rows)

        # 3) Upsert en lotes (no insert/update fila por fila).
        registros = [{"user_id": user_id, "ruc": ruc, "nombre_proveedor": nombre, "categoria": categoria}
                     for ruc, (nombre, categoria) in filas.items()]
        for i in range(0, len(registros), 200):
            lote = registros[i:i + 200]
            supabase.table("classification_map").upsert(lote, on_conflict="user_id,ruc").execute()

        new_count = sum(1 for ruc in filas if ruc not in existentes)
        updated = len(filas) - new_count

        reclasificadas = _propagate_classifications_bulk(supabase, filas, user_id)

        return {"imported": new_count, "updated": updated, "reclasificadas": reclasificadas}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.get("/export/excel")
async def export_excel_endpoint(user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        response = supabase.table("classification_map").select("ruc, nombre_proveedor, categoria").eq("user_id", user_id).order("nombre_proveedor").execute()
        data = response.data or []

        df = pd.DataFrame(data)
        output = io.BytesIO()
        df.to_excel(output, index=False, header=False)
        output.seek(0)

        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": "attachment; filename=clasificador.xlsx"}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/export/pdf")
async def export_pdf_endpoint(user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        response = supabase.table("classification_map").select("ruc, nombre_proveedor, categoria").eq("user_id", user_id).order("nombre_proveedor").execute()
        data = response.data or []

        output = io.BytesIO()
        doc = SimpleDocTemplate(output, pagesize=letter)
        story = [Paragraph("Clasificador de RUCs", getSampleStyleSheet()['Title']), Spacer(1, 0.3 * inch)]

        pdf_data = [["RUC", "Nombre", "Categoría"]]
        for row in data:
            pdf_data.append([row.get('ruc', ''), row.get('nombre_proveedor', '')[:30], row.get('categoria', '')])

        table = Table(pdf_data, colWidths=[2*inch, 2.5*inch, 1.5*inch])
        table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.grey),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 8),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.black),
            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ]))
        story.append(table)
        doc.build(story)
        output.seek(0)

        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="application/pdf",
            headers={"Content-Disposition": "attachment; filename=clasificador.pdf"}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
