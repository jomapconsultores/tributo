import io
from datetime import date
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from typing import Optional
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client, fetch_all, fetch_in
from services.declaracion import declaracion_iva, declaracion_ice, declaracion_103
from services.declaracion_oficial import llenar_oficial
from tenancy import assert_client_owner, visible_client_ids
from routers.access import es_admin, es_data_admin, modulos_de, puede_submodulo

# Cada tipo de declaración es un submódulo distinto (el admin puede habilitar
# solo IVA sin ICE, etc.). Default = permitido si no hay restricción.
_SUBMODULO_POR_TIPO = {"IVA": "decl_iva", "ICE": "decl_ice", "103": "agret_103"}


def _verificar_submodulo(user_id: str, tipo: str):
    sub = _SUBMODULO_POR_TIPO.get((tipo or "").upper())
    if sub and not puede_submodulo(user_id, sub):
        raise HTTPException(status_code=403, detail=f"Pantalla no habilitada: {sub}")
from services.activity import registrar

router = APIRouter(prefix="/api/declaraciones", tags=["declaraciones"])


class SaveDecl(BaseModel):
    client_id: str
    tipo: str
    datos: dict
    diferir_pago_meses: Optional[int] = 0  # 0 = pagar este mes; 1-3 (IVA); 1 (ICE max)


class AplazarPago(BaseModel):
    client_id: str
    tipo: str
    monto: float
    meses: int
    notas: Optional[str] = None


class MarcarPagado(BaseModel):
    estado: str = "pagado"  # 'pagado' o 'cancelado'


def _cliente(supabase, client_id):
    c = supabase.table("clients").select("identificacion,nombre,periodo_mes,periodo_anio,user_id").eq("id", client_id).execute()
    return c.data[0] if c.data else {}


def _periodo_anterior(mes, anio):
    """Devuelve (mes_anterior, anio_anterior) para buscar la declaración previa."""
    if not mes:
        return None, None
    if mes == 1:
        return 12, (anio or 2026) - 1
    return mes - 1, anio


def _cargar_credito_mes_anterior(supabase, client_id, mes, anio):
    """Si existe una declaración IVA guardada del mes anterior, devuelve sus saldos
    remanentes (605 = adquisiciones, 606 = retenciones). Si no, devuelve ceros."""
    mes_ant, anio_ant = _periodo_anterior(mes, anio)
    if mes_ant is None:
        return 0.0, 0.0
    res = supabase.table("declaraciones").select("datos").eq(
        "client_id", client_id).eq("tipo", "IVA").eq(
        "mes", mes_ant).eq("anio", anio_ant).order(
        "created_at", desc=True).limit(1).execute()
    if not res.data:
        return 0.0, 0.0
    datos = res.data[0].get("datos") or {}
    # El crédito del mes anterior se arrastra SEPARADO: 695 (adquisiciones) → 605,
    # 697 (retenciones) → 607. Compat: si la declaración previa es vieja y solo
    # tiene saldo_a_favor_proximo_mes, se carga todo como adquisiciones.
    resumen = datos.get("resumen") or {}
    adq = resumen.get("credito_proximo_mes_adquisiciones")
    ret = resumen.get("credito_proximo_mes_retenciones")
    if adq is None and ret is None:
        return float(resumen.get("saldo_a_favor_proximo_mes") or 0), 0.0
    return float(adq or 0), float(ret or 0)


def _cargar_overrides(supabase, client_id, tipo, mes, anio):
    """Overrides persistidos por período (crédito 605/606 y factor) que el usuario
    escribió antes. Se recuperan automáticamente al recalcular."""
    try:
        r = supabase.table("declaracion_overrides").select("credito_adq,credito_ret,factor_prop")\
            .eq("client_id", client_id).eq("tipo", (tipo or "IVA").upper())\
            .eq("mes", mes).eq("anio", anio).limit(1).execute().data
        return r[0] if r else {}
    except Exception:
        return {}


def _litros_eq(cant, unidad, densidad):
    """Equivalencia en litros (igual que la pantalla de Rebajas)."""
    try:
        c = float(cant or 0)
    except (TypeError, ValueError):
        c = 0.0
    try:
        d = float(densidad or 1) or 1
    except (TypeError, ValueError):
        d = 1
    u = (unidad or "ml").strip().lower()
    if u in ("ml", "cc", "cm3"):
        return c / 1000
    if u in ("l", "lt", "lts", "litro", "litros"):
        return c
    if u in ("g", "gr", "gramo", "gramos"):
        return (c / d) / 1000
    if u in ("kg", "kilo", "kilos", "kilogramo", "kilogramos"):
        return c / d
    return c / 1000


def _rebajas_por_producto(supabase, identificacion, owner_uid):
    """% de materia prima nacional calificada por producto, desde el módulo
    Rebajas y exenciones (misma regla que su pantalla: el agua no cuenta, se
    convierte a litros, solo suman los proveedores calificados Y VIGENTES, cumple
    si el % es ≥ 70). Usa owner_uid (user_id del dueño del cliente)."""
    if not identificacion:
        return {}
    from datetime import date
    hoy = date.today().isoformat()
    # Catálogo de proveedores: RUC → vigente_hasta (para descartar vencidos)
    vencido = {}
    try:
        provs = fetch_all(lambda: supabase.table("rebajas_proveedores").select(
            "ruc,vigente_hasta").eq("identificacion", identificacion).eq("user_id", owner_uid))
        for pv in provs:
            vh = pv.get("vigente_hasta")
            vencido[(pv.get("ruc") or "").strip()] = bool(vh) and str(vh) < hoy
    except Exception:
        vencido = {}
    ingredientes = fetch_all(lambda: supabase.table("rebajas_ingredientes").select(
        "producto,ingrediente,cantidad,unidad,densidad,ruc_proveedor,calificado").eq(
        "identificacion", identificacion).eq("user_id", owner_uid))
    por_prod = {}
    for r in ingredientes:
        if (r.get("ingrediente") or "").strip().upper() == "AGUA":
            continue
        p = (r.get("producto") or "").strip().upper()
        if not p:
            continue
        d = por_prod.setdefault(p, {"total": 0.0, "calif": 0.0})
        litros = _litros_eq(r.get("cantidad"), r.get("unidad"), r.get("densidad"))
        d["total"] += litros
        # Calificado efectivo: marcado calificado Y su proveedor no está vencido
        ruc = (r.get("ruc_proveedor") or "").strip()
        if r.get("calificado") and not vencido.get(ruc, False):
            d["calif"] += litros
    out = {}
    for p, d in por_prod.items():
        pct = (d["calif"] / d["total"] * 100) if d["total"] else 0.0
        out[p] = {"pct": pct, "cumple": pct >= 70,
                  "es_cerveza": False, "nueva_marca": False, "cupo_anual_sri": False}

    # Condiciones normativas por producto (cerveza/nueva marca/cupo anual SRI)
    conds = supabase.table("rebajas_productos").select(
        "producto,es_cerveza,nueva_marca,cupo_anual_sri").eq(
        "identificacion", identificacion).eq("user_id", owner_uid).execute()
    for r in (conds.data or []):
        p = (r.get("producto") or "").strip().upper()
        if p in out:
            out[p].update({"es_cerveza": bool(r.get("es_cerveza")),
                           "nueva_marca": bool(r.get("nueva_marca")),
                           "cupo_anual_sri": bool(r.get("cupo_anual_sri"))})
    return out


def _pagos_aplazados_vencen(supabase, client_id, mes, anio, tipo):
    """Devuelve los aplazamientos cuyo vencimiento cae EN este período (y siguen pendientes)."""
    res = supabase.table("pagos_aplazados").select("*").eq(
        "client_id", client_id).eq("tipo", tipo).eq(
        "estado", "pendiente").eq("vence_mes", mes).eq("vence_anio", anio).execute()
    return res.data or []


def _calcular(supabase, client_id, tipo, user_id, override_credito_adq=None, override_credito_ret=None, diferir_meses=0,
              override_rebaja=None, override_exencion=None, marcar_rebaja=False, marcar_exencion=False,
              override_ventas_15=None, override_ventas_5=None, override_ventas_0=None, factor_prop=None):
    c = _cliente(supabase, client_id)
    anio = c.get("periodo_anio") or date.today().year
    mes = c.get("periodo_mes") or 1
    # Para clientes compartidos: usar user_id del dueño del cliente para queries históricos
    owner_uid = c.get("user_id") or user_id
    _verificar_submodulo(user_id, tipo)
    if tipo.upper() == "ICE":
        ice = fetch_all(lambda: supabase.table("ice_sales").select("*").eq("client_id", client_id))
        aplazados_ice = _pagos_aplazados_vencen(supabase, client_id, mes, anio, "ICE")
        rebajas_prod = _rebajas_por_producto(supabase, c.get("identificacion") or "", owner_uid)
        decl = declaracion_ice(ice, anio, pagos_aplazados_vencen_este_periodo=aplazados_ice,
                               rebajas_productos=rebajas_prod,
                               override_rebaja=override_rebaja, override_exencion=override_exencion,
                               marcar_rebaja=marcar_rebaja, marcar_exencion=marcar_exencion)
        decl["aplazados_vencen"] = aplazados_ice
    elif tipo.upper() == "103":
        if "agente_retencion" not in modulos_de(user_id):
            raise HTTPException(status_code=403, detail="Módulo no contratado: agente_retencion")
        ref = fetch_all(lambda: supabase.table("retenciones_efectuadas").select("*").eq("client_id", client_id))
        decl = declaracion_103(ref, anio, mes)
    else:
        invoices = fetch_all(lambda: supabase.table("invoices").select("*").eq("client_id", client_id))
        ventas_ice = fetch_all(lambda: supabase.table("ice_sales").select("*").eq("client_id", client_id))
        ventas_iva = fetch_all(lambda: supabase.table("sales_iva").select("*").eq("client_id", client_id))
        retentions = fetch_all(lambda: supabase.table("retentions").select("*").eq("client_id", client_id))
        # La sección "Agente de retención del IVA" solo se agrega si el usuario
        # tiene el módulo contratado (evita que aparezca sin haberlo activado).
        retenciones_ref = (
            fetch_all(lambda: supabase.table("retenciones_efectuadas").select("*").eq("client_id", client_id))
            if "agente_retencion" in modulos_de(user_id) else []
        )

        # Crédito mes anterior: parte del historial y cada casillero (605/606) se
        # puede sobreescribir de forma INDEPENDIENTE si el usuario lo ingresa.
        cred_adq_prev, cred_ret_prev = _cargar_credito_mes_anterior(supabase, client_id, mes, anio)
        # Overrides persistidos del período (manual): tienen prioridad sobre el arrastre.
        ov_pers = _cargar_overrides(supabase, client_id, "IVA", mes, anio)
        if ov_pers.get("credito_adq") is not None:
            cred_adq_prev = float(ov_pers["credito_adq"])
        if ov_pers.get("credito_ret") is not None:
            cred_ret_prev = float(ov_pers["credito_ret"])
        if factor_prop is None and ov_pers.get("factor_prop") is not None:
            factor_prop = float(ov_pers["factor_prop"])
        # Override en vivo (lo que el usuario está editando ahora) manda sobre todo.
        if override_credito_adq is not None:
            cred_adq_prev = float(override_credito_adq)
        if override_credito_ret is not None:
            cred_ret_prev = float(override_credito_ret)

        # Pagos aplazados que vencen este período
        aplazados = _pagos_aplazados_vencen(supabase, client_id, mes, anio, "IVA")

        decl = declaracion_iva(
            invoices, ventas_ice, ventas_iva,
            retentions=retentions,
            credito_mes_anterior_adquisiciones=cred_adq_prev,
            credito_mes_anterior_retenciones=cred_ret_prev,
            pagos_aplazados_vencen_este_periodo=aplazados,
            diferir_meses=diferir_meses,
            override_ventas_15=override_ventas_15,
            override_ventas_5=override_ventas_5,
            override_ventas_0=override_ventas_0,
            factor_prop=factor_prop,
            retenciones_iva_agente=retenciones_ref,
        )
        decl["aplazados_vencen"] = aplazados
    decl["cliente"] = c
    decl["anio"] = anio
    decl["mes"] = mes
    return decl


@router.get("/calcular")
async def calcular(
    client_id: str = Query(...),
    tipo: str = Query("IVA"),
    credito_adq: Optional[float] = Query(None, description="Override crédito tributario mes anterior por adquisiciones (605)"),
    credito_ret: Optional[float] = Query(None, description="Override crédito tributario mes anterior por retenciones (606)"),
    diferir_meses: int = Query(0, description="Preview: difiere el IVA generado N meses (1-3 IVA, 1 ICE max). Solo recálculo, no persiste."),
    rebaja_ice: Optional[float] = Query(None, description="Override manual de la rebaja ICE (si no, se precalcula del módulo Rebajas y exenciones)"),
    exencion_ice: Optional[float] = Query(None, description="Override manual de exenciones ICE"),
    rebaja_manual: int = Query(0, description="Casilla manual: aplica rebaja 50% de la tarifa específica (con advertencia)"),
    exencion_manual: int = Query(0, description="Casilla manual: aplica exención del ICE restante (con advertencia)"),
    ventas_15: Optional[float] = Query(None, description="Override manual de ventas gravadas 15% (411), si no hay XML"),
    ventas_5: Optional[float] = Query(None, description="Override manual de ventas gravadas 5% (412)"),
    ventas_0: Optional[float] = Query(None, description="Override manual de ventas tarifa 0% (413)"),
    factor_prop: Optional[float] = Query(None, description="Override del factor de proporcionalidad (0..1) del crédito tributario IVA"),
    user_id: str = Depends(get_current_user),
):
    try:
        supabase = get_supabase_client()
        assert_client_owner(client_id, user_id)
        return _calcular(supabase, client_id, tipo, user_id, credito_adq, credito_ret, diferir_meses,
                         override_rebaja=rebaja_ice, override_exencion=exencion_ice,
                         marcar_rebaja=bool(rebaja_manual), marcar_exencion=bool(exencion_manual),
                         override_ventas_15=ventas_15, override_ventas_5=ventas_5, override_ventas_0=ventas_0,
                         factor_prop=factor_prop)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/credenciales")
async def credenciales_cliente(client_id: str = Query(...), user_id: str = Depends(get_current_user)):
    """Servicios contratados + metadata de la credencial SRI (admin), SIN password.
    Para revelar la clave, el frontend usa /api/credentials/{id}/reveal (auditado
    en credential_access_log) — antes este endpoint también podía descifrarla
    con reveal=true, saltándose esa auditoría; se eliminó ese camino."""
    try:
        supabase = get_supabase_client()
        admin = es_admin(user_id)
        data_admin = es_data_admin(user_id)
        if not data_admin:
            assert_client_owner(client_id, user_id)
        cl = supabase.table("clients").select("identificacion,nombre,user_id").eq("id", client_id).execute().data
        if not cl:
            return {"servicios": [], "es_admin": admin, "credencial": None}
        ident = cl[0]["identificacion"]
        owner_uid = cl[0]["user_id"]
        # El ADMINISTRADOR (data_admin) ve la clave SRI de CUALQUIER contribuyente
        # sin restricción de dueño: se recogen todos los períodos con esa
        # identificación, aunque estén bajo otro user_id (p.ej. datos del despacho
        # bajo otra cuenta). Socio/cliente siguen limitados a su propio dueño.
        hq = supabase.table("clients").select("id").eq("identificacion", ident)
        if not data_admin:
            hq = hq.eq("user_id", owner_uid)
        hermanos = hq.execute().data or []
        ids = [h["id"] for h in hermanos] or [client_id]
        servicios = supabase.table("client_services").select("service,active").in_("client_id", ids).eq("active", True).execute().data or []
        servicios = sorted({s["service"] for s in servicios})
        credencial = None
        # Admin Y socio ven la clave SRI. El admin sin restricción de dueño (arriba);
        # el socio, limitado a los contribuyentes que puede ver (assert_client_owner
        # ya se aplicó). El rol 'cliente' no ve credenciales.
        if admin:
            cred = supabase.table("service_credentials").select("id,service,username").in_(
                "client_id", ids).eq("service", "sri_portal").execute().data
            if cred:
                c = cred[0]
                credencial = {"id": c["id"], "service": c["service"], "username": c.get("username")}
        return {"servicios": servicios, "es_admin": admin, "credencial": credencial}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/")
async def listar(client_id: Optional[str] = Query(None), tipo: Optional[str] = Query(None), user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        if client_id:
            assert_client_owner(client_id, user_id)
            q = supabase.table("declaraciones").select("*").eq("client_id", client_id)
            if tipo:
                q = q.eq("tipo", tipo.upper())
            data = q.order("created_at", desc=True).execute().data or []
        else:
            def _base():
                b = supabase.table("declaraciones").select("*")
                return b.eq("tipo", tipo.upper()) if tipo else b
            vis = visible_client_ids(user_id)   # None = admin (ve todo)
            if vis is None:
                data = fetch_all(lambda: _base().order("created_at", desc=True))
            else:
                oq = _base().eq("user_id", user_id)
                own = oq.order("created_at", desc=True).execute().data or []
                sh = fetch_in(_base, vis, "client_id")
                seen, data = set(), []
                for d in own + sh:
                    if d["id"] not in seen:
                        seen.add(d["id"])
                        data.append(d)
                data.sort(key=lambda x: x.get("created_at") or "", reverse=True)
        return {"data": data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class OverridesIn(BaseModel):
    client_id: str
    tipo: Optional[str] = "IVA"
    credito_adq: Optional[float] = None
    credito_ret: Optional[float] = None
    factor_prop: Optional[float] = None


@router.put("/overrides")
async def guardar_overrides(entry: OverridesIn, user_id: str = Depends(get_current_user)):
    """Guarda (persistente, por período) el crédito mes anterior (605/606) y el factor
    que el usuario escribe, para recuperarlos al reabrir sin guardar toda la declaración."""
    try:
        supabase = get_supabase_client()
        assert_client_owner(entry.client_id, user_id)
        c = _cliente(supabase, entry.client_id)
        mes = c.get("periodo_mes")
        anio = c.get("periodo_anio")
        data = {
            "client_id": entry.client_id, "tipo": (entry.tipo or "IVA").upper(),
            "mes": mes, "anio": anio,
            "credito_adq": entry.credito_adq, "credito_ret": entry.credito_ret,
            "factor_prop": entry.factor_prop, "updated_at": "now()",
        }
        supabase.table("declaracion_overrides").upsert(
            data, on_conflict="client_id,tipo,mes,anio").execute()
        return {"message": "ok", "mes": mes, "anio": anio}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


def _sumar_periodo(mes, anio, n_meses):
    """Devuelve (mes, anio) al sumar n_meses al período dado."""
    total = (mes - 1) + n_meses
    nuevo_mes = (total % 12) + 1
    nuevo_anio = anio + (total // 12)
    return nuevo_mes, nuevo_anio


@router.post("/")
async def guardar(entry: SaveDecl, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        assert_client_owner(entry.client_id, user_id)
        c = _cliente(supabase, entry.client_id)
        anio = c.get("periodo_anio")
        mes = c.get("periodo_mes")
        tipo = entry.tipo.upper()
        _verificar_submodulo(user_id, tipo)

        # Validar aplazamiento (facilidades de pago: 1 a 3 meses, solo IVA por
        # ahora — declaracion_ice no resta el monto diferido del casillero
        # 902/899, así que permitirlo en ICE duplicaría el valor a pagar).
        diferir = max(0, int(entry.diferir_pago_meses or 0))
        if diferir < 0 or diferir > 3:
            raise HTTPException(status_code=400, detail="Meses a aplazar inválidos (0-3).")
        if diferir > 0 and tipo != "IVA":
            raise HTTPException(status_code=400, detail="El aplazamiento de pago aún no está disponible para ICE.")

        # Insertar declaración
        res = supabase.table("declaraciones").insert({
            "client_id": entry.client_id, "user_id": user_id, "tipo": tipo,
            "anio": anio, "mes": mes, "datos": entry.datos,
        }).execute()
        decl_record = res.data[0] if res.data else None

        # Si difirió pago, crear registro en pagos_aplazados
        if diferir > 0 and decl_record:
            resumen = (entry.datos or {}).get("resumen") or {}
            monto_a_pagar = float(resumen.get("total_a_pagar") or resumen.get("iva_a_pagar") or 0)
            if monto_a_pagar > 0:
                vence_mes, vence_anio = _sumar_periodo(mes or 1, anio or 2026, diferir)
                supabase.table("pagos_aplazados").insert({
                    "client_id": entry.client_id, "user_id": user_id,
                    "declaracion_id": decl_record["id"], "tipo": tipo,
                    "monto": monto_a_pagar, "meses_aplazados": diferir,
                    "origen_mes": mes, "origen_anio": anio,
                    "vence_mes": vence_mes, "vence_anio": vence_anio,
                    "estado": "pendiente",
                }).execute()
        registrar(actor_user_id=user_id, action="save", module="declaraciones",
                  entity=f"Declaración {tipo}", client_id=entry.client_id,
                  identificacion=c.get("identificacion"), contribuyente=c.get("nombre"),
                  metadata={"mes": mes, "anio": anio, "diferir_meses": diferir})
        return decl_record
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/aplazados")
async def listar_aplazados(
    client_id: Optional[str] = Query(None),
    estado: Optional[str] = Query(None, description="pendiente | vencido | pagado | cancelado"),
    user_id: str = Depends(get_current_user),
):
    """Lista pagos aplazados del usuario. Si client_id, solo de ese cliente."""
    try:
        supabase = get_supabase_client()
        if client_id:
            assert_client_owner(client_id, user_id)
            q = supabase.table("pagos_aplazados").select("*").eq("client_id", client_id)
            if estado:
                q = q.eq("estado", estado)
            data = q.order("vence_anio", desc=False).order("vence_mes", desc=False).execute().data or []
        else:
            def _base():
                b = supabase.table("pagos_aplazados").select("*")
                return b.eq("estado", estado) if estado else b
            def _ord(qq):
                return qq.order("vence_anio", desc=False).order("vence_mes", desc=False)
            vis = visible_client_ids(user_id)   # None = admin (ve todo)
            if vis is None:
                data = fetch_all(lambda: _ord(_base()))
            else:
                own = _ord(_base().eq("user_id", user_id)).execute().data or []
                sh = fetch_in(_base, vis, "client_id")
                seen, data = set(), []
                for d in own + sh:
                    if d["id"] not in seen:
                        seen.add(d["id"])
                        data.append(d)
                data.sort(key=lambda x: (x.get("vence_anio") or 0, x.get("vence_mes") or 0))
        return {"data": data}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/aplazados/{aplazado_id}")
async def marcar_aplazado(aplazado_id: str, body: MarcarPagado, user_id: str = Depends(get_current_user)):
    """Marca un pago aplazado como 'pagado' o 'cancelado'."""
    if body.estado not in ("pagado", "cancelado"):
        raise HTTPException(status_code=400, detail="Estado inválido. Use 'pagado' o 'cancelado'.")
    try:
        supabase = get_supabase_client()
        row = supabase.table("pagos_aplazados").select("client_id").eq("id", aplazado_id).execute().data
        if not row:
            raise HTTPException(status_code=404, detail="No encontrado")
        assert_client_owner(row[0]["client_id"], user_id)
        supabase.table("pagos_aplazados").update({"estado": body.estado}).eq("id", aplazado_id).execute()
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{decl_id}")
async def eliminar(decl_id: str, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        row = supabase.table("declaraciones").select("client_id").eq("id", decl_id).execute().data
        if not row:
            raise HTTPException(status_code=404, detail="No encontrada")
        assert_client_owner(row[0]["client_id"], user_id)
        supabase.table("declaraciones").delete().eq("id", decl_id).execute()
        return {"message": "Eliminada"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/export/oficial")
async def export_oficial(client_id: str = Query(...), tipo: str = Query("IVA"),
                         credito_adq: Optional[float] = Query(None), credito_ret: Optional[float] = Query(None),
                         diferir_meses: int = Query(0),
                         rebaja_ice: Optional[float] = Query(None), exencion_ice: Optional[float] = Query(None),
                         rebaja_manual: int = Query(0), exencion_manual: int = Query(0),
                         ventas_15: Optional[float] = Query(None), ventas_5: Optional[float] = Query(None),
                         ventas_0: Optional[float] = Query(None), factor_prop: Optional[float] = Query(None),
                         user_id: str = Depends(get_current_user)):
    """Llena el formulario oficial del SRI (borrador) con los valores calculados."""
    try:
        supabase = get_supabase_client()
        assert_client_owner(client_id, user_id)
        decl = _calcular(supabase, client_id, tipo, user_id, credito_adq, credito_ret, diferir_meses,
                         override_rebaja=rebaja_ice, override_exencion=exencion_ice,
                         marcar_rebaja=bool(rebaja_manual), marcar_exencion=bool(exencion_manual),
                         override_ventas_15=ventas_15, override_ventas_5=ventas_5, override_ventas_0=ventas_0,
                         factor_prop=factor_prop)
        c = decl.get("cliente", {})
        data, llenados, omitidos = llenar_oficial(tipo, decl)
        label = f"Formulario_{tipo.upper()}_{c.get('identificacion','')}_{decl.get('anio')}{str(decl.get('mes') or '').zfill(2)}".replace(" ", "_")
        return StreamingResponse(
            iter([data]),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={
                "Content-Disposition": f"attachment; filename={label}.xlsx",
                "X-Codigos-Llenados": ",".join(llenados),
                "X-Codigos-Omitidos": ",".join(omitidos),
            },
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/export/excel")
async def export_excel(client_id: str = Query(...), tipo: str = Query("IVA"),
                       credito_adq: Optional[float] = Query(None), credito_ret: Optional[float] = Query(None),
                       diferir_meses: int = Query(0),
                       rebaja_ice: Optional[float] = Query(None), exencion_ice: Optional[float] = Query(None),
                       rebaja_manual: int = Query(0), exencion_manual: int = Query(0),
                       ventas_15: Optional[float] = Query(None), ventas_5: Optional[float] = Query(None),
                       ventas_0: Optional[float] = Query(None), factor_prop: Optional[float] = Query(None),
                       user_id: str = Depends(get_current_user)):
    try:
        import xlsxwriter
        supabase = get_supabase_client()
        assert_client_owner(client_id, user_id)
        decl = _calcular(supabase, client_id, tipo, user_id, credito_adq, credito_ret, diferir_meses,
                         override_rebaja=rebaja_ice, override_exencion=exencion_ice,
                         marcar_rebaja=bool(rebaja_manual), marcar_exencion=bool(exencion_manual),
                         override_ventas_15=ventas_15, override_ventas_5=ventas_5, override_ventas_0=ventas_0,
                         factor_prop=factor_prop)
        c = decl.get("cliente", {})
        output = io.BytesIO()
        wb = xlsxwriter.Workbook(output, {"in_memory": True})
        ws = wb.add_worksheet(f"Declaración {tipo.upper()}")
        # Paleta oficial del SRI
        title = wb.add_format({"bold": True, "font_color": "#003399", "font_size": 13})
        head = wb.add_format({"bold": True, "bg_color": "#003399", "font_color": "white", "border": 1})
        sec_fmt = wb.add_format({"bold": True, "bg_color": "#003399", "font_color": "white", "border": 1})
        cod_fmt = wb.add_format({"border": 1, "bg_color": "#ccecff", "font_color": "#003399", "bold": True, "align": "center"})
        cell = wb.add_format({"border": 1})
        money = wb.add_format({"border": 1, "num_format": "#,##0.00"})
        # Filas TOTAL (dorado)
        cod_tot = wb.add_format({"border": 1, "bg_color": "#ffbe3d", "bold": True, "align": "center"})
        cell_tot = wb.add_format({"border": 1, "bg_color": "#ffcc66", "bold": True})
        money_tot = wb.add_format({"border": 1, "bg_color": "#ffcc66", "bold": True, "num_format": "#,##0.00"})
        TOTALES = {"409", "419", "429", "499", "509", "519", "529", "620", "699", "859", "999", "399", "902"}

        ws.write(0, 0, f"DECLARACIÓN {tipo.upper()} — {c.get('identificacion','')} {c.get('nombre','')} · {decl.get('mes')}/{decl.get('anio')}", title)
        ws.write(2, 0, "Sección", head); ws.write(2, 1, "Código SRI", head)
        ws.write(2, 2, "Concepto", head); ws.write(2, 3, "# Fact.", head); ws.write(2, 4, "Valor", head)
        r = 3
        secciones_escritas = set()
        for f in decl["filas"]:
            sec = f.get("seccion", "")
            cod = str(f.get("codigo", ""))
            es_total = cod in TOTALES
            # Encabezado de sección (azul) una vez por sección
            if sec and sec not in secciones_escritas:
                secciones_escritas.add(sec)
                ws.merge_range(r, 0, r, 4, sec, sec_fmt)
                r += 1
            ws.write(r, 0, sec, cell_tot if es_total else cell)
            ws.write(r, 1, cod, cod_tot if es_total else cod_fmt)
            ws.write(r, 2, f.get("concepto", ""), cell_tot if es_total else cell)
            n = f.get("num_comprobantes")
            ws.write(r, 3, n if n is not None else "", cell_tot if es_total else cell)
            ws.write(r, 4, f.get("valor", 0), money_tot if es_total else money)
            r += 1
        ws.set_column(0, 0, 26); ws.set_column(1, 1, 11); ws.set_column(2, 2, 60); ws.set_column(3, 3, 9); ws.set_column(4, 4, 16)
        wb.close()
        output.seek(0)
        label = f"Declaracion_{tipo.upper()}_{c.get('identificacion','')}_{decl.get('anio')}{str(decl.get('mes') or '').zfill(2)}".replace(" ", "_")
        return StreamingResponse(iter([output.getvalue()]),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename={label}.xlsx"})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
