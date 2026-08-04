# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Utilidades de aislamiento multiempresa / multiusuario.

El backend usa la service key de Supabase (que omite RLS), por lo que el
aislamiento se aplica en la capa de aplicación: se filtra por user_id y se
verifica la propiedad del cliente. Los accesos otorgados por el administrador
(tabla client_access) también se respetan.

Con multiempresa (migración 051) hay DOS filtros encadenados:
  1. EMPRESA: solo se ven contribuyentes de la empresa activa (clients.org_id).
     Es una frontera dura: ningún rol la cruza.
  2. ROL dentro de esa empresa: las reglas de siempre (admin ve todo; socio todo
     menos lo creado por un admin; trabajador/cliente solo lo propio y lo
     compartido por client_access).

Sin empresa activa —migración 051 aún sin aplicar, o usuario sin membresías—
solo se aplica el filtro 2 y el comportamiento es idéntico al anterior.

Lo compartido se cuenta por CONTRIBUYENTE
-----------------------------------------
client_access guarda una fila por período, pero lo que el administrador otorga
es el contribuyente entero. La visibilidad se resuelve por identificación
(`shared_identificaciones`), no por la lista de filas: así el período que se abre
el mes que viene ya nace compartido, en vez de desaparecer de la vista hasta que
alguien lo vuelva a marcar a mano.
"""
from fastapi import HTTPException
from database import get_supabase_client, fetch_all, fetch_in
import orgs


def _cliente_en_org(cli: dict, org_id, es_plataforma: bool) -> bool:
    """¿El contribuyente es alcanzable desde la empresa activa?

    Tres formas de serlo, y ninguna más:
      1. pertenece a la empresa activa;
      2. su empresa dueña AUTORIZÓ a la activa (migración 052), sea abriendo su
         cartera entera o ese RUC concreto;
      3. es huérfano (sin org_id) y quien mira es el administrador de plataforma
         — así nunca se filtran a la empresa equivocada, pero tampoco quedan
         inaccesibles para siempre: quien administra puede verlos y reasignarlos.
    """
    if not org_id:
        return True
    if cli.get("org_id") == org_id:
        return True
    aut = orgs.autorizaciones_recibidas(org_id)
    if cli.get("org_id") in aut["carteras"]:
        return True
    if cli.get("identificacion") and cli["identificacion"] in aut["identificaciones"]:
        return True
    return es_plataforma and cli.get("org_id") is None


def assert_client_owner(client_id, user_id):
    """Lanza 404 si el usuario no puede acceder al contribuyente según su
    EMPRESA activa y su ROL en ella:
      - fuera de la empresa activa: nunca (ni siquiera el dueño directo).
      - dueño directo (clients.user_id) o acceso otorgado (client_access): siempre.
      - admin: cualquier contribuyente.
      - socio: cualquiera MENOS los creados por un administrador.
      - trabajador / cliente: solo los propios y los compartidos.
    """
    supabase = get_supabase_client()
    from routers.access import rol_de, es_super_admin
    org_id = orgs.org_activa()
    # La columna org_id solo se pide si hay empresa activa, lo que implica que la
    # migración 051 está aplicada. Pedirla siempre haría fallar TODAS las
    # comprobaciones de acceso mientras el SQL no se haya ejecutado.
    # identificacion hace falta para resolver las autorizaciones por RUC (052) y
    # el acceso compartido, que también es por contribuyente y no por período.
    columnas = "id,user_id,org_id,identificacion" if org_id else "id,user_id,identificacion"
    r = supabase.table("clients").select(columnas).eq("id", client_id).execute().data
    if not r:
        raise HTTPException(status_code=404, detail="Cliente no encontrado")
    cli = r[0]

    if not _cliente_en_org(cli, org_id, es_super_admin(user_id)):
        # 404 y no 403: no se revela que el contribuyente existe en otra empresa.
        raise HTTPException(status_code=404, detail="Cliente no encontrado")

    if cli.get("user_id") == user_id:
        return True
    if _esta_compartido(cli, user_id):
        return True
    role = rol_de(user_id)
    if role == "admin":
        return True
    if role == "socio" and cli.get("user_id") not in _admin_user_ids(org_id):
        return True
    raise HTTPException(status_code=404, detail="Cliente no encontrado")


def filtro_org(q, col: str = "org_id"):
    """Acota una consulta sobre `clients` a la EMPRESA ACTIVA.

    Para los sitios que buscan «todos los períodos de este RUC» sin pasar por
    visible_clients: ahí el rol admin salta la verificación por contribuyente a
    propósito (necesita ver los períodos que están bajo otra cuenta del mismo
    despacho), y sin este filtro esa excepción se llevaría por delante la
    separación entre empresas. Sin empresa activa no hace nada."""
    org_id = orgs.org_activa()
    return q.eq(col, org_id) if org_id else q


def shared_client_ids(user_id: str) -> list:
    """IDs de clientes explícitamente otorgados a user_id por un administrador.

    OJO: son ids de FILA, o sea contribuyente + período. Para decidir visibilidad
    hay que usar `shared_identificaciones`, no esta lista — ver allí el porqué."""
    supabase = get_supabase_client()
    rows = supabase.table("client_access").select("client_id").eq("granted_to", user_id).execute().data or []
    return [r["client_id"] for r in rows]


def shared_identificaciones(user_id: str) -> set:
    """CONTRIBUYENTES (por identificación) compartidos con `user_id`.

    El acceso se otorga por RUC —la pantalla del administrador dice "todos los
    períodos de este contribuyente"— pero se GUARDA como una fila de
    client_access por cada período existente en ese momento. Como cada período es
    una fila nueva de `clients`, todo período abierto DESPUÉS de otorgar el
    acceso nacía sin fila y quedaba invisible: cada mes, al abrir el período
    nuevo, los trabajadores y socios perdían de golpe toda su cartera hasta que
    el administrador volviera a marcar uno por uno.

    Por eso la visibilidad se resuelve aquí por identificación: lo otorgado es el
    contribuyente, y sus períodos —los de ayer y los de mañana— viajan con él.
    La frontera de empresa NO se toca: la sigue aplicando `_cliente_en_org`."""
    hit = _si_cache.get(user_id)
    if hit and (_time.monotonic() - hit[1]) < _VC_TTL:
        return hit[0]
    supabase = get_supabase_client()
    ids = shared_client_ids(user_id)
    idents = set()
    if ids:
        filas = fetch_in(lambda: supabase.table("clients").select("identificacion"),
                         ids, "id", 40)
        idents = {f["identificacion"] for f in filas if f.get("identificacion")}
    _si_cache[user_id] = (idents, _time.monotonic())
    return idents


def _esta_compartido(cli: dict, user_id: str) -> bool:
    """¿Le compartieron a `user_id` este contribuyente? Por RUC, no por período."""
    ident = cli.get("identificacion")
    return bool(ident) and ident in shared_identificaciones(user_id)


def _admin_user_ids(org_id=None) -> set:
    """user_id de los administradores máximos (role='admin'). Lo que crea un
    administrador solo lo ve otro administrador: ni el socio ni los clientes.

    Refleja al admin DE RAÍZ, no el rol activo: si un admin cambia su vista a
    'cliente' (borra su fila de app_admins), sigue contando como admin aquí
    gracias a user_roles, para que sus contribuyentes NO se filtren a los socios
    mientras navega con otro rol.

    Con una empresa activa se suman los administradores DE ESA EMPRESA: dentro de
    un despacho, lo que registra su admin tampoco lo ve su socio."""
    supabase = get_supabase_client()
    ids = set()
    try:
        rows = supabase.table("app_admins").select("user_id").eq("role", "admin").execute().data or []
        ids.update(r["user_id"] for r in rows)
    except Exception:
        pass
    try:
        rows2 = supabase.table("user_roles").select("user_id").eq("role", "admin").execute().data or []
        ids.update(r["user_id"] for r in rows2)
    except Exception:
        pass
    ids.update(orgs.admins_de_org(org_id if org_id is not None else orgs.org_activa()))
    return ids


import time as _time

_VC_TTL = 30  # seg: cache de clientes visibles por usuario (evita viajes repetidos)
# Clave (user_id, org_id): el mismo usuario ve conjuntos distintos según la
# empresa activa, así que cachear solo por usuario mezclaría las carteras.
_vc_cache: dict = {}  # (user_id, org_id) -> (rows_full, ts)
# Contribuyentes compartidos, por RUC. No depende de la empresa activa (la
# frontera la aplica después _cliente_en_org), así que basta la clave user_id.
_si_cache: dict = {}  # user_id -> (set(identificacion), ts)


def invalidate_clients_cache(user_id: str = None):
    """Limpia el cache de clientes visibles (al crear/editar/borrar un cliente,
    y al otorgar o revocar un acceso compartido)."""
    if user_id is None:
        _vc_cache.clear()
        _si_cache.clear()
    else:
        for clave in [k for k in _vc_cache if k[0] == user_id]:
            _vc_cache.pop(clave, None)
        _si_cache.pop(user_id, None)


def _consulta_clients(supabase, org_id, es_plataforma: bool):
    """Consulta base de `clients` ya acotada a la empresa activa.

    Al administrador de plataforma no se le filtra en la BD para que también
    alcance los contribuyentes huérfanos (org_id NULL); el filtro fino lo hace
    después `_cliente_en_org`."""
    q = supabase.table("clients").select("*")
    if org_id and not es_plataforma:
        q = q.eq("org_id", org_id)
    return q


def _compute_visible_clients_full(user_id: str) -> list:
    """Filas COMPLETAS de `clients` visibles para `user_id` en la empresa activa,
    según su ROL en ella."""
    from routers.access import rol_de, es_super_admin
    supabase = get_supabase_client()
    role = rol_de(user_id)
    org_id = orgs.org_activa()
    plataforma = es_super_admin(user_id)

    def _base():
        return _consulta_clients(supabase, org_id, plataforma)

    # Lo compartido se resuelve por CONTRIBUYENTE, no por período: ver
    # `shared_identificaciones`. Antes, cada período nuevo (que es una fila nueva
    # de `clients`) nacía fuera de lo compartido y desaparecía de la vista.
    idents_compartidos = shared_identificaciones(user_id)

    if role == "admin":
        rows = fetch_all(_base)
    elif role == "socio":
        todos = fetch_all(_base)
        admin_uids = _admin_user_ids(org_id)
        rows = [c for c in todos
                if c.get("user_id") not in admin_uids
                or c.get("identificacion") in idents_compartidos]
    else:
        # trabajador / cliente: propios + compartidos
        propios = fetch_all(lambda: _base().eq("user_id", user_id))
        rows = propios
        if idents_compartidos:
            seen = {c["id"] for c in propios}
            # SIN filtrar por empresa en la BD a propósito: un contribuyente
            # compartido puede vivir en otra empresa que autorizó a esta (052), y
            # a estos dos roles los prestados solo les llegan por client_access.
            # Quien cierra la frontera es `_cliente_en_org`, al final.
            compartidos = fetch_in(lambda: supabase.table("clients").select("*"),
                                   list(idents_compartidos), "identificacion", 40)
            rows = propios + [c for c in compartidos if c["id"] not in seen]

    # Contribuyentes de OTRAS empresas que autorizaron a esta (migración 052).
    # Se suman solo para quien tiene acceso operativo a la cartera —admin y
    # socio—; a trabajador y cliente les siguen llegando únicamente por
    # client_access, que es individual y ya está contemplado arriba. La consulta
    # solo se hace si existe alguna autorización, que es lo excepcional.
    if org_id and role in ("admin", "socio") and orgs.hay_autorizaciones(org_id):
        aut = orgs.autorizaciones_recibidas(org_id)
        vistos = {c["id"] for c in rows}
        prestados = []
        if aut["carteras"]:
            prestados += fetch_in(lambda: supabase.table("clients").select("*"),
                                  list(aut["carteras"]), "org_id", 40)
        if aut["identificaciones"]:
            prestados += fetch_in(lambda: supabase.table("clients").select("*"),
                                  list(aut["identificaciones"]), "identificacion", 40)
        for c in prestados:
            if c["id"] not in vistos:
                vistos.add(c["id"])
                c["es_prestado"] = True   # el frontend lo marca como venido de otra empresa
                rows.append(c)

    # Frontera de empresa: se aplica SIEMPRE al final, por encima del rol.
    return [c for c in rows if _cliente_en_org(c, org_id, plataforma)]


def visible_clients(user_id: str, select: str = "*") -> list:
    """Filas de `clients` visibles para `user_id` en la EMPRESA ACTIVA según su
    ROL (en TODOS los módulos), con cache corto para evitar viajes repetidos a
    la BD.
      - admin : ve TODOS los contribuyentes de la empresa, sin importar quién
                los creó.
      - socio : ve los de los clientes y los suyos propios (todo MENOS lo creado
                por un administrador), más los compartidos explícitamente.
      - trabajador / cliente: solo los propios y los que le compartieron.
    Ningún rol ve contribuyentes de otra empresa.
    """
    clave = (user_id, orgs.org_activa())
    hit = _vc_cache.get(clave)
    if hit and (_time.monotonic() - hit[1]) < _VC_TTL:
        rows = hit[0]
    else:
        rows = _compute_visible_clients_full(user_id)
        _vc_cache[clave] = (rows, _time.monotonic())
    if select == "*":
        return rows
    cols = [c.strip() for c in select.split(",")]
    return [{k: r.get(k) for k in cols} for r in rows]


def visible_client_ids(user_id: str):
    """Conjunto de client_id visibles para el usuario, o None si puede ver TODOS
    sin filtro. Mismas reglas que visible_clients.

    OJO: solo devuelve None (= sin filtro) cuando NO hay empresa activa. Con
    multiempresa, ni siquiera el administrador puede saltarse la frontera de
    empresa, así que se devuelve el conjunto explícito de su cartera."""
    from routers.access import rol_de
    if rol_de(user_id) == "admin" and not orgs.org_activa():
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

    vis = visible_client_ids(user_id)  # None = sin empresa activa y admin (ve todo)
    if vis is None:
        rows = fetch_all(_q)
    else:
        # Todo lo que cuelga de un contribuyente visible ya lo trae `fetch_in`,
        # sin importar quién lo creó — así que de las filas PROPIAS solo hay que
        # añadir las sueltas, las que no tienen contribuyente (datos antiguos).
        # Traerlas todas por user_id, como antes, arrastraría a la empresa activa
        # las filas que el usuario creó en OTRA empresa: mismo user_id, pero
        # contribuyente ajeno a esta cartera.
        propios = fetch_all(lambda: _q().eq("user_id", user_id).is_("client_id", "null"))
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
    ok_ids = []
    for r in rows:
        try:
            assert_client_owner(r["client_id"], user_id)
            ok_ids.append(r["id"])
        except HTTPException:
            pass
    return ok_ids
