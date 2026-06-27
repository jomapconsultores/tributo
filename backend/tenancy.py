"""Utilidades de aislamiento multiusuario.

El backend usa la service key de Supabase (que omite RLS), por lo que el
aislamiento se aplica en la capa de aplicación: se filtra por user_id y se
verifica la propiedad del cliente. Los accesos otorgados por el administrador
(tabla client_access) también se respetan.
"""
from fastapi import HTTPException
from database import get_supabase_client, fetch_all


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


def _admin_user_ids() -> set:
    """user_id de los administradores máximos (role='admin'). Lo que crea un
    administrador solo lo ve otro administrador: ni el socio ni los clientes."""
    supabase = get_supabase_client()
    try:
        rows = supabase.table("app_admins").select("user_id,role").eq("role", "admin").execute().data or []
    except Exception:
        rows = []
    return {r["user_id"] for r in rows}


def visible_clients(user_id: str, select: str = "*") -> list:
    """Filas de `clients` visibles para `user_id` según su ROL (en TODOS los
    módulos). Reglas de negocio:
      - admin : ve TODOS los contribuyentes, sin importar quién los creó.
      - socio : ve los de los clientes y los suyos propios (todo MENOS lo creado
                por un administrador), más los compartidos explícitamente.
      - cliente: solo los propios y los que un administrador le compartió.
    """
    from routers.access import rol_de
    supabase = get_supabase_client()
    role = rol_de(user_id)

    def _cols(*extra):
        """Asegura las columnas pedidas + las necesarias, sin duplicar."""
        if select == "*":
            return "*"
        cols = [c.strip() for c in select.split(",")]
        for e in extra:
            if e not in cols:
                cols.append(e)
        return ",".join(cols)

    if role == "admin":
        return fetch_all(lambda: supabase.table("clients").select(select))

    if role == "socio":
        # Necesita id + user_id para excluir lo creado por administradores.
        cols = _cols("id", "user_id")
        todos = fetch_all(lambda: supabase.table("clients").select(cols))
        admin_uids = _admin_user_ids()
        compartidos = set(shared_client_ids(user_id))
        return [c for c in todos
                if c.get("user_id") not in admin_uids or c["id"] in compartidos]

    # cliente: propios + compartidos
    cols = _cols("id")
    propios = fetch_all(lambda: supabase.table("clients").select(cols).eq("user_id", user_id))
    sids = shared_client_ids(user_id)
    if sids:
        seen = {c["id"] for c in propios}
        compartidos = fetch_all(lambda: supabase.table("clients").select(cols).in_("id", sids))
        propios = propios + [c for c in compartidos if c["id"] not in seen]
    return propios


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
