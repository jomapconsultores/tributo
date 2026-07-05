"""Utilidades de aislamiento multiusuario.

El backend usa la service key de Supabase (que omite RLS), por lo que el
aislamiento se aplica en la capa de aplicación: se filtra por user_id y se
verifica la propiedad del cliente. Los accesos otorgados por el administrador
(tabla client_access) también se respetan.
"""
import time as _time
from fastapi import HTTPException
from database import get_supabase_client, fetch_all, fetch_in


def assert_client_owner(client_id, user_id):
    """Lanza 404 si el usuario no puede acceder al contribuyente según su ROL:
      - dueño directo (clients.user_id) o acceso otorgado (client_access): siempre.
      - admin: cualquier contribuyente.
      - socio: cualquiera MENOS los creados por un administrador.
      - cliente: solo los propios y los compartidos.
    """
    supabase = get_supabase_client()
    r = supabase.table("clients").select("id,user_id").eq("id", client_id).execute().data
    if not r:
        raise HTTPException(status_code=404, detail="Cliente no encontrado")
    cli = r[0]
    if cli.get("user_id") == user_id:
        return True
    g = supabase.table("client_access").select("client_id").eq("client_id", client_id).eq("granted_to", user_id).execute()
    if g.data:
        return True
    from routers.access import rol_de
    role = rol_de(user_id)
    if role == "admin":
        return True
    if role == "socio" and cli.get("user_id") not in _admin_user_ids():
        return True
    raise HTTPException(status_code=404, detail="Cliente no encontrado")


def shared_client_ids(user_id: str) -> list:
    """IDs de clientes explícitamente otorgados a user_id por un administrador."""
    supabase = get_supabase_client()
    rows = supabase.table("client_access").select("client_id").eq("granted_to", user_id).execute().data or []
    return [r["client_id"] for r in rows]


_ADMIN_IDS_TTL = 30  # seg: cache de administradores (evita 1 query por client_id único en filter_ids_by_tenancy)
_admin_ids_cache = {"ids": None, "ts": 0.0}


def _admin_user_ids() -> set:
    """user_id de los administradores máximos (role='admin'). Lo que crea un
    administrador solo lo ve otro administrador: ni el socio ni los clientes."""
    now = _time.monotonic()
    if _admin_ids_cache["ids"] is not None and (now - _admin_ids_cache["ts"]) < _ADMIN_IDS_TTL:
        return _admin_ids_cache["ids"]
    supabase = get_supabase_client()
    try:
        rows = supabase.table("app_admins").select("user_id,role").eq("role", "admin").execute().data or []
    except Exception:
        rows = []
    ids = {r["user_id"] for r in rows}
    _admin_ids_cache["ids"] = ids
    _admin_ids_cache["ts"] = now
    return ids


_VC_TTL = 30  # seg: cache de clientes visibles por usuario (evita viajes repetidos)
_vc_cache: dict = {}  # user_id -> (rows_full, ts)


def invalidate_clients_cache(user_id: str = None):
    """Limpia el cache de clientes visibles (al crear/editar/borrar un cliente)."""
    if user_id is None:
        _vc_cache.clear()
    else:
        _vc_cache.pop(user_id, None)


def _compute_visible_clients_full(user_id: str) -> list:
    """Filas COMPLETAS de `clients` visibles para `user_id` según su ROL."""
    from routers.access import rol_de
    supabase = get_supabase_client()
    role = rol_de(user_id)
    if role == "admin":
        return fetch_all(lambda: supabase.table("clients").select("*"))
    if role == "socio":
        todos = fetch_all(lambda: supabase.table("clients").select("*"))
        admin_uids = _admin_user_ids()
        compartidos = set(shared_client_ids(user_id))
        return [c for c in todos
                if c.get("user_id") not in admin_uids or c["id"] in compartidos]
    # cliente: propios + compartidos
    propios = fetch_all(lambda: supabase.table("clients").select("*").eq("user_id", user_id))
    sids = shared_client_ids(user_id)
    if sids:
        seen = {c["id"] for c in propios}
        compartidos = fetch_all(lambda: supabase.table("clients").select("*").in_("id", sids))
        propios = propios + [c for c in compartidos if c["id"] not in seen]
    return propios


def visible_clients(user_id: str, select: str = "*") -> list:
    """Filas de `clients` visibles para `user_id` según su ROL (en TODOS los
    módulos), con cache corto por usuario para evitar viajes repetidos a la BD.
      - admin : ve TODOS los contribuyentes, sin importar quién los creó.
      - socio : ve los de los clientes y los suyos propios (todo MENOS lo creado
                por un administrador), más los compartidos explícitamente.
      - cliente: solo los propios y los que un administrador le compartió.
    """
    hit = _vc_cache.get(user_id)
    if hit and (_time.monotonic() - hit[1]) < _VC_TTL:
        rows = hit[0]
    else:
        rows = _compute_visible_clients_full(user_id)
        _vc_cache[user_id] = (rows, _time.monotonic())
    if select == "*":
        return rows
    cols = [c.strip() for c in select.split(",")]
    return [{k: r.get(k) for k in cols} for r in rows]


def visible_client_ids(user_id: str):
    """Conjunto de client_id visibles para el usuario según su ROL, o None si
    puede ver TODOS (administrador → sin filtro). Mismas reglas que
    visible_clients. Útil para filtrar los datos por `client_id` en cada módulo."""
    from routers.access import rol_de
    if rol_de(user_id) == "admin":
        return None
    return {c["id"] for c in visible_clients(user_id, "id")}


def can_access_identificacion(user_id: str, identificacion: str) -> bool:
    """True si el usuario puede ver algún contribuyente con esa identificación.
    Para datos guardados por RUC (catálogo de productos, etc.) que se comparten
    entre todos los usuarios autorizados del contribuyente, sin importar quién
    los creó. Mismas reglas de rol que visible_clients."""
    from routers.access import rol_de
    if rol_de(user_id) == "admin":
        return True
    return any(c.get("identificacion") == identificacion
               for c in visible_clients(user_id, "identificacion"))


def fetch_visible_rows(supabase, table: str, columns: str, user_id: str,
                        order_col: str = None, desc: bool = True):
    """Filas de `table` visibles para `user_id` según su ROL: propias +
    compartidas (deduplicadas por id), o TODAS si es admin. Mismo patrón que
    estaba copiado en list_ice/list_sales/list_retentions/list_invoices (cada
    router lo reimplementaba por su cuenta, ya con alguna divergencia entre
    ellos)."""
    def _q():
        return supabase.table(table).select(columns)

    vis = visible_client_ids(user_id)  # None = admin (ve todo)
    if vis is None:
        rows = fetch_all(_q)
    else:
        propios = fetch_all(lambda: _q().eq("user_id", user_id))
        compartidas = fetch_in(_q, vis, "client_id")
        seen, rows = set(), []
        for r in propios + compartidas:
            if r["id"] not in seen:
                seen.add(r["id"])
                rows.append(r)
    if order_col:
        rows.sort(key=lambda r: r.get(order_col) or "", reverse=desc)
    return rows


def filter_ids_by_tenancy(supabase, table: str, ids: list, user_id: str) -> list:
    """De una lista de ids de `table`, devuelve solo los que pertenecen a un
    client_id al que `user_id` tiene acceso (según su ROL). Mismo patrón que
    estaba copiado en bulk_move/bulk_delete de invoices/ice/sales_iva/retentions
    (verifica tenencia fila por fila antes de un update/delete en lote)."""
    if not ids:
        return []
    rows = supabase.table(table).select("id,client_id").in_("id", ids).execute().data or []
    unique_client_ids = {r["client_id"] for r in rows}
    allowed = set()
    for cid in unique_client_ids:
        try:
            assert_client_owner(cid, user_id)
            allowed.add(cid)
        except HTTPException:
            pass
    return [r["id"] for r in rows if r["client_id"] in allowed]
