"""Clientes importados (compradores de las facturas), guardados aparte de la
tabla clients (contribuyentes). Se alimentan al procesar XML de ventas ICE."""


def extraer_compradores(registros):
    """Únicos (ruc → tipo_id, nombre) desde los registros parseados de facturas."""
    unicos = {}
    for r in registros or []:
        ruc = (r.get("id_cliente") or "").strip()
        if not ruc:
            continue
        unicos[ruc] = {
            "ruc": ruc,
            "tipo_id": (r.get("tipo_id_cliente") or "04").strip() or "04",
            "nombre": (r.get("razon_social_cliente") or "").strip()[:200],
        }
    return list(unicos.values())


def upsert_compradores(supabase, user_id, identificacion, compradores):
    """Inserta/actualiza compradores de un contribuyente. Devuelve cuántos procesó."""
    if not identificacion or not compradores:
        return 0
    filas = [{
        "user_id": user_id,
        "identificacion": identificacion,
        "ruc": c["ruc"],
        "tipo_id": c.get("tipo_id") or "04",
        "nombre": c.get("nombre") or "",
    } for c in compradores if c.get("ruc")]
    if not filas:
        return 0
    supabase.table("compradores").upsert(
        filas, on_conflict="user_id,identificacion,ruc").execute()
    return len(filas)


def sync_desde_ventas(supabase, user_id):
    """Reconstruye compradores desde las ventas ICE ya importadas (backfill)."""
    ventas = supabase.table("ice_sales").select(
        "client_id,id_cliente,tipo_id_cliente,razon_social_cliente"
    ).eq("user_id", user_id).execute().data or []
    if not ventas:
        return 0
    clientes = supabase.table("clients").select("id,identificacion").eq("user_id", user_id).execute().data or []
    ident_por_id = {c["id"]: c.get("identificacion") for c in clientes}
    por_contribuyente = {}
    for v in ventas:
        ident = ident_por_id.get(v.get("client_id"))
        ruc = (v.get("id_cliente") or "").strip()
        if not ident or not ruc:
            continue
        por_contribuyente.setdefault(ident, {})[ruc] = {
            "ruc": ruc,
            "tipo_id": (v.get("tipo_id_cliente") or "04").strip() or "04",
            "nombre": (v.get("razon_social_cliente") or "").strip()[:200],
        }
    total = 0
    for ident, unicos in por_contribuyente.items():
        total += upsert_compradores(supabase, user_id, ident, list(unicos.values()))
    return total
