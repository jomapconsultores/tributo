from concurrent.futures import ThreadPoolExecutor
from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Optional
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client, fetch_all
from services.sri_ruc import consultar_ruc
from services.periodo import (periodo_a_declarar, periodo_anterior,
                              semestre_a_declarar, semestre_anterior,
                              mes_ancla_semestre, semestre_de_mes)
from tenancy import visible_clients, assert_client_owner, invalidate_clients_cache, can_access_identificacion
from services.activity import registrar, _email_de

router = APIRouter(prefix="/api/clients", tags=["clients"])


class ClientCreate(BaseModel):
    identificacion: str
    nombre: str
    periodo_mes: int
    periodo_anio: int
    tipo_identificacion: Optional[str] = "RUC"
    notas: Optional[str] = None
    es_agente_retencion: Optional[bool] = False
    # Periodicidad de declaración de IVA: 'mensual' (por defecto) o 'semestral'.
    # Para 'semestral' el mes ancla (periodo_mes) se fija al último mes del semestre.
    periodicidad: Optional[str] = "mensual"
    periodo_semestre: Optional[int] = None   # 1 | 2, solo si periodicidad='semestral'
    forzar: bool = False   # crear aunque OTRO usuario del equipo ya tenga este contribuyente+período


class ClientUpdate(BaseModel):
    identificacion: Optional[str] = None
    nombre: Optional[str] = None
    periodo_mes: Optional[int] = None
    periodo_anio: Optional[int] = None
    tipo_identificacion: Optional[str] = None
    notas: Optional[str] = None
    iva_incluido: Optional[bool] = None
    es_agente_retencion: Optional[bool] = None
    periodicidad: Optional[str] = None
    periodo_semestre: Optional[int] = None


def _shared_ids(supabase, user_id: str) -> list:
    """Client IDs que otro usuario compartió explícitamente con user_id."""
    rows = supabase.table("client_access").select("client_id").eq("granted_to", user_id).execute().data or []
    return [r["client_id"] for r in rows]


@router.get("/")
async def list_clients(user_id: str = Depends(get_current_user)):
    """Lista los clientes con estadísticas (# facturas y monto total)."""
    try:
        supabase = get_supabase_client()
        # Visibles según rol (admin: todos; socio: clientes+propios; cliente: propios+compartidos).
        clients = visible_clients(user_id, "*")
        # Marcar/enriquecer los que llegaron por acceso compartido (client_access).
        shared_set = set(_shared_ids(supabase, user_id))
        if shared_set:
            owner_uids = list({c["user_id"] for c in clients if c["id"] in shared_set and c.get("user_id")})
            owner_map = {}
            if owner_uids:
                try:
                    rows = supabase.table("app_admins").select("user_id,email").in_("user_id", owner_uids).execute().data or []
                    owner_map = {r["user_id"]: r["email"] for r in rows}
                except Exception:
                    pass
            for c in clients:
                if c["id"] in shared_set:
                    c["is_shared"] = True
                    c["owner_email"] = owner_map.get(c.get("user_id"), "")
        clients.sort(key=lambda x: ((x.get("nombre") or ""), -(x.get("periodo_anio") or 0), -(x.get("periodo_mes") or 0)))

        # Estadísticas por client_id (funciona independientemente del user_id)
        client_ids = [c["id"] for c in clients]
        if not client_ids:
            return clients
        invoices = fetch_all(lambda: supabase.table("invoices").select("client_id, total, clasificacion").in_("client_id", client_ids))
        stats = {}
        for inv in invoices:
            cid = inv.get("client_id")
            if not cid:
                continue
            s = stats.setdefault(cid, {"count": 0, "total": 0.0, "sin_clasificar": 0})
            s["count"] += 1
            s["total"] += float(inv.get("total") or 0)
            if not inv.get("clasificacion") or inv.get("clasificacion") == "SIN CLASIFICAR":
                s["sin_clasificar"] += 1

        for c in clients:
            s = stats.get(c["id"], {"count": 0, "total": 0.0, "sin_clasificar": 0})
            c["num_facturas"] = s["count"]
            c["monto_total"] = round(s["total"], 2)
            c["sin_clasificar"] = s["sin_clasificar"]

        return clients
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/by-service")
async def clients_by_service(service: str = Query(...), user_id: str = Depends(get_current_user)):
    """Identificaciones (RUCs) que tienen el servicio activo en client_services."""
    try:
        supabase = get_supabase_client()
        clientes = visible_clients(user_id, "id,identificacion")
        if not clientes:
            return {"identificaciones": []}
        ids = [c["id"] for c in clientes]
        services_list = [s.strip() for s in service.split(',') if s.strip()]
        svc = supabase.table("client_services").select("client_id").in_("client_id", ids).in_("service", services_list).eq("active", True).execute().data or []
        activos = {r["client_id"] for r in svc}
        idents = list({c["identificacion"] for c in clientes if c["id"] in activos})
        return {"identificaciones": idents}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/consulta-ruc")
async def consulta_ruc(ruc: str, _: str = Depends(get_current_user)):
    """Datos básicos del RUC desde la API pública del SRI (razón social, estado,
    actividad, régimen, obligaciones). Para registrar/precargar contribuyentes."""
    return consultar_ruc(ruc)


@router.get("/contribuyentes")
async def contribuyentes(user_id: str = Depends(get_current_user)):
    """Árbol para Base de Datos: contribuyentes (por identificación) → períodos
    (año, mes) → conteo de datos por tipo (gastos/retenciones/ice/calculo)."""
    try:
        supabase = get_supabase_client()
        clients = visible_clients(user_id, "id,identificacion,nombre,tipo_identificacion,periodo_mes,periodo_anio")

        client_ids = [c["id"] for c in clients]

        def counts(table):
            if not client_ids:
                return {}
            rows = fetch_all(lambda: supabase.table(table).select("client_id").in_("client_id", client_ids))
            m = {}
            for r in rows:
                cid = r.get("client_id")
                if cid:
                    m[cid] = m.get(cid, 0) + 1
            return m

        with ThreadPoolExecutor(max_workers=4) as ex:
            f_inv = ex.submit(counts, "invoices")
            f_ret = ex.submit(counts, "retentions")
            f_ice = ex.submit(counts, "ice_sales")
            f_cal = ex.submit(counts, "ice_calc")
            inv = f_inv.result()
            ret = f_ret.result()
            ice = f_ice.result()
            cal = f_cal.result()

        ag = {}
        for c in clients:
            ident = c["identificacion"]
            g = ag.setdefault(ident, {
                "identificacion": ident, "nombre": c["nombre"],
                "tipo_identificacion": c.get("tipo_identificacion", "RUC"),
                "periodos": [], "totales": {"gastos": 0, "retenciones": 0, "ice": 0, "calculo_ice": 0},
            })
            cid = c["id"]
            datos = {"gastos": inv.get(cid, 0), "retenciones": ret.get(cid, 0),
                     "ice": ice.get(cid, 0), "calculo_ice": cal.get(cid, 0)}
            g["periodos"].append({"client_id": cid, "anio": c.get("periodo_anio"),
                                  "mes": c.get("periodo_mes"), "datos": datos})
            for k in datos:
                g["totales"][k] += datos[k]
            g["nombre"] = c["nombre"]

        out = []
        for g in ag.values():
            g["periodos"].sort(key=lambda p: (-(p["anio"] or 0), -(p["mes"] or 0)))
            out.append(g)
        out.sort(key=lambda g: (g["nombre"] or "").upper())
        return out
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/summary/{identificacion}")
async def client_summary(identificacion: str, user_id: str = Depends(get_current_user)):
    """Resumen de TODO lo trabajado para un contribuyente, agregado por
    año → mes → producto (clasificación). Recorre todos sus períodos."""
    try:
        supabase = get_supabase_client()
        ident = identificacion.strip()
        if not can_access_identificacion(user_id, ident):
            raise HTTPException(status_code=404, detail="No hay registros para esa identificación")
        recs = supabase.table("clients").select("*").eq("identificacion", ident).execute().data or []
        if not recs:
            raise HTTPException(status_code=404, detail="No hay registros para esa identificación")

        nombre = recs[0].get("nombre")
        id_to_period = {r["id"]: (r.get("periodo_anio"), r.get("periodo_mes")) for r in recs}
        client_ids = list(id_to_period.keys())

        invoices = []
        if client_ids:
            invoices = fetch_all(lambda: supabase.table("invoices").select(
                "client_id, clasificacion, base_15, iva_15, total, estado"
            ).in_("client_id", client_ids))

        agg = {}
        for inv in invoices:
            anio, mes = id_to_period.get(inv["client_id"], (None, None))
            clasif = inv.get("clasificacion") or "SIN CLASIFICAR"
            key = (anio, mes, clasif)
            a = agg.setdefault(key, {
                "anio": anio, "mes": mes, "clasificacion": clasif,
                "num_facturas": 0, "base_15": 0.0, "iva_15": 0.0, "total": 0.0
            })
            a["num_facturas"] += 1
            a["base_15"] += float(inv.get("base_15") or 0)
            a["iva_15"] += float(inv.get("iva_15") or 0)
            a["total"] += float(inv.get("total") or 0)

        filas = sorted(
            agg.values(),
            key=lambda x: (-(x["anio"] or 0), -(x["mes"] or 0), x["clasificacion"])
        )
        for f in filas:
            f["base_15"] = round(f["base_15"], 2)
            f["iva_15"] = round(f["iva_15"], 2)
            f["total"] = round(f["total"], 2)

        periodos = sorted(
            [{"client_id": r["id"], "anio": r.get("periodo_anio"), "mes": r.get("periodo_mes")} for r in recs],
            key=lambda x: (-(x["anio"] or 0), -(x["mes"] or 0))
        )
        return {"identificacion": ident, "nombre": nombre, "periodos": periodos, "filas": filas}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/services-map")
async def services_map(user_id: str = Depends(get_current_user)):
    """Mapa service → [identificaciones] para todos los servicios activos del usuario."""
    try:
        supabase = get_supabase_client()
        clientes = visible_clients(user_id, "id,identificacion")
        if not clientes:
            return {}
        id_to_ident = {c["id"]: c["identificacion"] for c in clientes}
        client_ids = list(id_to_ident.keys())
        svc_rows = supabase.table("client_services").select("client_id,service").in_("client_id", client_ids).eq("active", True).execute().data or []
        result = {}
        for row in svc_rows:
            svc = row.get("service")
            ident = id_to_ident.get(row["client_id"])
            if svc and ident:
                result.setdefault(svc, []).append(ident)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{client_id}")
async def get_client(client_id: str, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        assert_client_owner(client_id, user_id)
        response = supabase.table("clients").select("*").eq("id", client_id).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/")
async def create_client(entry: ClientCreate, user_id: str = Depends(get_current_user)):
    """Crea un cliente para un período (mes+año). Si ya existe ese mismo
    contribuyente en ese período, devuelve el existente."""
    try:
        supabase = get_supabase_client()
        identificacion = entry.identificacion.strip().replace("'", "")
        if not identificacion or not entry.nombre.strip():
            raise HTTPException(status_code=400, detail="Identificación y Nombre son obligatorios")
        if not (2000 <= entry.periodo_anio <= 2100):
            raise HTTPException(status_code=400, detail="Año inválido")

        # Periodicidad: para semestral se exige el semestre (1 ó 2) y el mes ancla
        # (periodo_mes) se deriva del semestre (último mes: 6 ó 12). Para mensual,
        # el mes debe estar entre 1 y 12 y no hay semestre.
        periodicidad = (entry.periodicidad or "mensual").lower()
        if periodicidad not in ("mensual", "semestral"):
            raise HTTPException(status_code=400, detail="Periodicidad inválida")
        periodo_semestre = None
        periodo_mes = entry.periodo_mes
        if periodicidad == "semestral":
            periodo_semestre = int(entry.periodo_semestre or 0)
            if periodo_semestre not in (1, 2):
                raise HTTPException(status_code=400, detail="El semestre debe ser 1 ó 2")
            periodo_mes = mes_ancla_semestre(periodo_semestre)
        else:
            if not (1 <= periodo_mes <= 12):
                raise HTTPException(status_code=400, detail="El mes debe estar entre 1 y 12")

        existing = supabase.table("clients").select("*")\
            .eq("user_id", user_id)\
            .eq("identificacion", identificacion)\
            .eq("periodo_mes", periodo_mes)\
            .eq("periodo_anio", entry.periodo_anio)\
            .execute()
        if existing.data:
            return existing.data[0]

        # Anti-duplicado de EQUIPO: si OTRO usuario ya registró este contribuyente en
        # este período, no crear un duplicado en silencio — avisar (409) para que se
        # use el existente. El usuario decide: abrir el existente o forzar la creación.
        if not entry.forzar:
            ajeno = supabase.table("clients").select("id,nombre,user_id")\
                .eq("identificacion", identificacion)\
                .eq("periodo_mes", periodo_mes)\
                .eq("periodo_anio", entry.periodo_anio)\
                .neq("user_id", user_id)\
                .limit(1).execute().data
            if ajeno:
                a = ajeno[0]
                raise HTTPException(status_code=409, detail={
                    "existe_en_equipo": True,
                    "client_id": a["id"],
                    "nombre": a.get("nombre"),
                    "creado_por": _email_de(a.get("user_id")),
                    "periodo": f"{periodo_mes:02d}/{entry.periodo_anio}",
                })

        response = supabase.table("clients").insert({
            "user_id": user_id,
            "identificacion": identificacion,
            # El nombre del contribuyente se guarda SIEMPRE en MAYÚSCULAS
            # (requisito: debe verse todo en mayúsculas, como en el SRI).
            "nombre": entry.nombre.strip().upper(),
            "tipo_identificacion": entry.tipo_identificacion or "RUC",
            "periodo_mes": periodo_mes,
            "periodo_anio": entry.periodo_anio,
            "periodicidad": periodicidad,
            "periodo_semestre": periodo_semestre,
            "notas": entry.notas,
            "es_agente_retencion": bool(entry.es_agente_retencion),
        }).execute()
        nuevo = response.data[0] if response.data else None
        invalidate_clients_cache()
        if nuevo:
            registrar(actor_user_id=user_id, action="create", module="clientes",
                      entity="Nuevo cliente", client_id=nuevo.get("id"),
                      identificacion=identificacion, contribuyente=entry.nombre.strip().upper(),
                      metadata={"periodo": f"{periodo_mes:02d}/{entry.periodo_anio}"})
        return nuevo
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/abrir-periodo-vencido")
async def abrir_periodo_vencido(user_id: str = Depends(get_current_user)):
    """Declaración mes/semestre vencido — apertura automática de período.

    · MENSUAL: abre el período a declarar (el mes ANTERIOR al calendario, hora
      Ecuador; en julio → junio) para los contribuyentes mensuales que YA tienen
      el mes inmediatamente anterior a ese (los que se trabajaron el ciclo pasado).
    · SEMESTRAL: al inicio de un semestre de declaración (JULIO → 1er semestre
      ENE–JUN; ENERO → 2do semestre JUL–DIC del año anterior) abre ese semestre
      para los contribuyentes semestrales que YA tienen el semestre inmediatamente
      anterior. Fuera de julio/enero no se abre nada semestral.

    Los contribuyentes viejos/inactivos no se arrastran. Idempotente: los que ya
    tienen el período destino se omiten, así que se puede llamar en cada inicio de
    sesión sin duplicar. NO copia datos (facturas, ventas, retenciones): deja el
    período listo para cargar. Los períodos anteriores quedan archivados intactos."""
    try:
        from datetime import datetime
        from services.periodo import EC_TZ
        supabase = get_supabase_client()
        tgt_mes, tgt_anio = periodo_a_declarar()                  # p.ej. julio → junio
        src_mes, src_anio = periodo_anterior(tgt_mes, tgt_anio)   # mes previo al destino (mayo)
        periodo = {"mes": tgt_mes, "anio": tgt_anio}

        # Contribuyentes VISIBLES para el usuario según su rol (admin: todos;
        # socio/cliente: los suyos + compartidos). No se filtra por el user_id del
        # actor: los datos suelen pertenecer a otra cuenta (el despacho) y aún así
        # el actor debe poder abrir su período.
        visibles = visible_clients(user_id, "*")

        def _es_semestral(c):
            return (c.get("periodicidad") or "mensual") == "semestral"

        def _fila_base(owner, ident, c):
            """Fila nueva con la identidad del contribuyente (sin período)."""
            fila = {
                "user_id": owner,   # se preserva el DUEÑO del contribuyente, no el actor
                "identificacion": ident,
                "nombre": (c.get("nombre") or "").strip().upper(),  # siempre en MAYÚSCULAS
                "tipo_identificacion": c.get("tipo_identificacion") or "RUC",
                "es_agente_retencion": bool(c.get("es_agente_retencion")),
            }
            # Campos opcionales: solo se copian si tienen valor, para respetar los
            # defaults de la columna (igual que create_client, que no los fija).
            if c.get("notas") is not None:
                fila["notas"] = c.get("notas")
            if c.get("iva_incluido") is not None:
                fila["iva_incluido"] = c.get("iva_incluido")
            return fila

        nuevos = []

        # ---- MENSUALES ------------------------------------------------------
        mensuales = [c for c in visibles if not _es_semestral(c)]
        # Fuente: mensuales cuyo período es el inmediatamente anterior al destino.
        fuente = [c for c in mensuales
                  if c.get("periodo_mes") == src_mes and c.get("periodo_anio") == src_anio]
        # Los que YA tienen el período destino → no se duplican. La unicidad es por
        # (dueño, identificación), porque dos dueños pueden tener el mismo RUC.
        ya = {(c.get("user_id"), c.get("identificacion")) for c in mensuales
              if c.get("periodo_mes") == tgt_mes and c.get("periodo_anio") == tgt_anio}
        por_clave = {}
        for c in fuente:
            por_clave.setdefault((c.get("user_id"), c.get("identificacion")), c)
        for (owner, ident), c in por_clave.items():
            if (owner, ident) in ya:
                continue
            fila = _fila_base(owner, ident, c)
            fila["periodo_mes"] = tgt_mes
            fila["periodo_anio"] = tgt_anio
            fila["periodicidad"] = "mensual"
            nuevos.append(fila)

        # ---- SEMESTRALES ----------------------------------------------------
        # Solo se abre en el mes de inicio del semestre de declaración (ene/jul).
        mes_actual = (datetime.now(EC_TZ)).month
        sem_periodo = None
        if mes_actual in (1, 7):
            sem_tgt, anio_tgt = semestre_a_declarar()               # semestre a declarar ahora
            sem_src, anio_src = semestre_anterior(sem_tgt, anio_tgt)  # semestre inmediatamente anterior
            ancla_tgt = mes_ancla_semestre(sem_tgt)
            semestrales = [c for c in visibles if _es_semestral(c)]
            fuente_s = [c for c in semestrales
                        if int(c.get("periodo_semestre") or semestre_de_mes(c.get("periodo_mes") or 1)) == sem_src
                        and c.get("periodo_anio") == anio_src]
            ya_s = {(c.get("user_id"), c.get("identificacion")) for c in semestrales
                    if int(c.get("periodo_semestre") or semestre_de_mes(c.get("periodo_mes") or 1)) == sem_tgt
                    and c.get("periodo_anio") == anio_tgt}
            por_clave_s = {}
            for c in fuente_s:
                por_clave_s.setdefault((c.get("user_id"), c.get("identificacion")), c)
            for (owner, ident), c in por_clave_s.items():
                if (owner, ident) in ya_s:
                    continue
                fila = _fila_base(owner, ident, c)
                fila["periodo_mes"] = ancla_tgt
                fila["periodo_anio"] = anio_tgt
                fila["periodicidad"] = "semestral"
                fila["periodo_semestre"] = sem_tgt
                nuevos.append(fila)
            sem_periodo = {"semestre": sem_tgt, "anio": anio_tgt}

        if not nuevos:
            return {"creados": 0, "periodo": periodo, "semestre": sem_periodo, "detalle": []}

        supabase.table("clients").insert(nuevos).execute()
        invalidate_clients_cache()
        registrar(actor_user_id=user_id, action="create", module="clientes",
                  entity="Apertura período mes vencido", cantidad=len(nuevos),
                  metadata={"periodo": f"{tgt_mes:02d}/{tgt_anio}", "creados": len(nuevos)})
        return {"creados": len(nuevos), "periodo": periodo, "semestre": sem_periodo,
                "detalle": [{"identificacion": n["identificacion"], "nombre": n["nombre"]} for n in nuevos]}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# Datos de IDENTIDAD del contribuyente: al editarlos se propagan a TODOS sus
# períodos (todo el módulo). Los de período (mes/año, y periodicidad/semestre que
# van juntos por el CHECK de coherencia) solo al registro elegido.
_CAMPOS_IDENTIDAD = {"identificacion", "nombre", "tipo_identificacion", "notas", "iva_incluido", "es_agente_retencion"}


@router.put("/{client_id}")
async def update_client(client_id: str, entry: ClientUpdate, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        # Autorización por ROL (no solo el dueño): la socia/admin pueden editar los
        # contribuyentes visibles, no únicamente los que creó su propio usuario.
        assert_client_owner(client_id, user_id)
        data = {k: v for k, v in entry.dict().items() if v is not None}
        if "identificacion" in data:
            data["identificacion"] = data["identificacion"].strip().replace("'", "")
        if "nombre" in data:
            # Siempre en MAYÚSCULAS (requisito: el nombre se ve todo en mayúsculas).
            data["nombre"] = data["nombre"].strip().upper()
        # Coherencia de periodicidad al editar:
        #  · semestral → el mes ancla se deriva del semestre (6 ó 12) y se guarda
        #    periodo_semestre (1 ó 2);
        #  · mensual   → se limpia el semestre (queda NULL).
        if data.get("periodicidad") == "semestral":
            sem = int(data.get("periodo_semestre") or 0)
            if sem in (1, 2):
                data["periodo_semestre"] = sem
                data["periodo_mes"] = mes_ancla_semestre(sem)
        elif data.get("periodicidad") == "mensual":
            data["periodo_semestre"] = None
        data["updated_at"] = "now()"
        # Identificación y dueño actuales (para ubicar todos los períodos del
        # MISMO contribuyente, sin tocar los de otros usuarios/despachos que
        # coincidan por casualidad en el mismo RUC).
        cur = supabase.table("clients").select("identificacion,user_id").eq("id", client_id).execute().data
        ident_actual = cur[0]["identificacion"] if cur else None
        owner_actual = cur[0]["user_id"] if cur else None
        # 1) El registro seleccionado recibe TODOS los cambios (incluido período).
        response = supabase.table("clients").update(data).eq("id", client_id).execute()
        # 2) Los campos de identidad se propagan al resto de períodos del MISMO
        #    contribuyente y del MISMO dueño, para que el cambio afecte a todo
        #    el módulo sin filtrar hacia clientes de otros usuarios.
        identidad = {k: v for k, v in data.items() if k in _CAMPOS_IDENTIDAD}
        if ident_actual and owner_actual and identidad:
            identidad["updated_at"] = "now()"
            supabase.table("clients").update(identidad).eq(
                "identificacion", ident_actual).eq(
                "user_id", owner_actual).neq("id", client_id).execute()
        invalidate_clients_cache()
        return response.data[0] if response.data else None
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{client_id}")
async def delete_client(client_id: str, user_id: str = Depends(get_current_user)):
    """Elimina un cliente (este período) y todas sus facturas (cascade)."""
    try:
        supabase = get_supabase_client()
        assert_client_owner(client_id, user_id)   # autorización por rol
        supabase.table("clients").delete().eq("id", client_id).execute()
        invalidate_clients_cache()
        return {"message": "Cliente eliminado"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
