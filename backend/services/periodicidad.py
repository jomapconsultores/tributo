# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Cambio de periodicidad de un CONTRIBUYENTE ya existente: mensual ⇄ semestral.

Hasta ahora la periodicidad solo se podía fijar al crear el cliente (o editando
ese registro suelto), así que para declarar semestral había que crear otro
contribuyente. Acá se convierte el que ya existe:

  · A SEMESTRAL: el período del semestre destino se re-ancla al último mes del
    semestre (6 ó 12) y queda `periodicidad='semestral'` + `periodo_semestre`.
    Si el contribuyente tenía varios MESES sueltos dentro de ese mismo semestre,
    se ofrece FUSIONARLOS en el período semestral (mover sus comprobantes), que
    es lo que hace que la declaración del semestre salga completa.
  · A MENSUAL: el período semestral vuelve a ser un mes suelto (el mes ancla),
    con `periodo_semestre = NULL`.

Los períodos ANTERIORES no se tocan: son historia ya declarada y volverlos
semestrales los etiquetaría mal. La apertura automática de período
(`/clients/abrir-periodo-vencido`) ya continúa la periodicidad de cada
contribuyente, así que de aquí en adelante se abren semestres.

Las tablas de datos del período tienen todas UNIQUE(client_id, unique_id), así
que fusionar es mover `client_id`; lo que ya existe en el destino (mismo
comprobante subido en los dos meses) NO se toca ni se borra: se informa y se
queda donde está.
"""
from database import get_supabase_client, fetch_all
from services.periodo import (rango_semestre, semestre_de_mes, mes_ancla_semestre)

# Tablas con los comprobantes del período (todas con UNIQUE(client_id, unique_id)).
TABLAS_PERIODO = [
    ("invoices", "Gastos"),
    ("sales_iva", "Ingresos IVA"),
    ("ice_sales", "Ingresos ICE"),
    ("retentions", "Retenciones recibidas"),
    ("retenciones_efectuadas", "Retenciones efectuadas"),
]

# Campos de identidad que se copian al crear el período semestral que falta.
_IDENTIDAD = ("identificacion", "nombre", "tipo_identificacion",
              "es_agente_retencion", "notas", "iva_incluido")


def _filas_del_contribuyente(sb, owner_id: str, identificacion: str) -> list:
    """Todos los períodos del MISMO contribuyente y del MISMO dueño."""
    rows = sb.table("clients").select("*").eq("user_id", owner_id).eq(
        "identificacion", identificacion).execute().data or []
    return sorted(rows, key=lambda r: (r.get("periodo_anio") or 0, r.get("periodo_mes") or 0))


def _conteos(sb, client_id: str) -> dict:
    """Cuántos comprobantes tiene el período, por tabla (solo las que no están en 0)."""
    out = {}
    for tabla, etiqueta in TABLAS_PERIODO:
        try:
            r = sb.table(tabla).select("id", count="exact").eq("client_id", client_id).limit(1).execute()
            n = r.count or 0
        except Exception:
            n = 0
        if n:
            out[etiqueta] = n
    return out


def plan_cambio(sb, client_id: str, periodicidad: str, semestre=None) -> dict:
    """Qué haría el cambio, sin ejecutarlo. Sirve para el aviso de confirmación
    (qué período queda como semestral y qué meses se fusionarían)."""
    actual = sb.table("clients").select("*").eq("id", client_id).limit(1).execute().data
    if not actual:
        raise ValueError("El contribuyente no existe.")
    actual = actual[0]
    owner = actual.get("user_id")
    ident = actual.get("identificacion")
    filas = _filas_del_contribuyente(sb, owner, ident)

    plan = {
        "client_id": client_id,
        "identificacion": ident,
        "nombre": actual.get("nombre"),
        "periodicidad_actual": actual.get("periodicidad") or "mensual",
        "semestre_actual": actual.get("periodo_semestre"),
        "periodicidad": periodicidad,
        "anio": actual.get("periodo_anio"),
        "crear_periodo": False,
        "fusionar": [],
        "avisos": [],
    }

    if periodicidad == "mensual":
        plan["destino"] = {
            "client_id": actual["id"],
            "periodo_mes": actual.get("periodo_mes"),
            "periodo_anio": actual.get("periodo_anio"),
        }
        if (actual.get("periodicidad") or "mensual") == "semestral":
            plan["avisos"].append(
                f"Los comprobantes cargados en el semestre quedan todos en el mes "
                f"{int(actual.get('periodo_mes') or 0):02d}/{actual.get('periodo_anio')}. "
                f"Si hay que separarlos por mes, hay que moverlos a mano.")
        return plan

    # --- a semestral ---------------------------------------------------------
    sem = int(semestre or semestre_de_mes(actual.get("periodo_mes") or 1))
    if sem not in (1, 2):
        raise ValueError("El semestre debe ser 1 ó 2.")
    anio = int(actual.get("periodo_anio") or 0)
    if not anio:
        raise ValueError("El contribuyente no tiene año de período definido.")
    ini, fin = rango_semestre(sem)
    ancla = mes_ancla_semestre(sem)
    plan["semestre"] = sem
    plan["anio"] = anio

    # Períodos del contribuyente que caen dentro del semestre elegido.
    del_semestre = [r for r in filas
                    if int(r.get("periodo_anio") or 0) == anio
                    and ini <= int(r.get("periodo_mes") or 0) <= fin]

    if not del_semestre:
        # No hay ningún mes de ese semestre: se abre el período del semestre
        # (no es un contribuyente nuevo, es otro período del mismo).
        plan["crear_periodo"] = True
        plan["destino"] = {"client_id": None, "periodo_mes": ancla, "periodo_anio": anio}
        plan["avisos"].append(
            f"El contribuyente no tiene ningún mes de ese semestre cargado: se abre el "
            f"período {'1er' if sem == 1 else '2do'} semestre {anio} (vacío) para trabajarlo.")
        return plan

    # Destino: el mes ancla si ya existe; si no, el mes más avanzado del semestre.
    destino = next((r for r in del_semestre if int(r.get("periodo_mes") or 0) == ancla), None)
    if destino is None:
        destino = max(del_semestre, key=lambda r: int(r.get("periodo_mes") or 0))
    plan["destino"] = {
        "client_id": destino["id"],
        "periodo_mes": ancla,
        "periodo_anio": anio,
        "periodo_mes_previo": destino.get("periodo_mes"),
        "comprobantes": _conteos(sb, destino["id"]),
    }

    for r in del_semestre:
        if r["id"] == destino["id"]:
            continue
        conteos = _conteos(sb, r["id"])
        plan["fusionar"].append({
            "client_id": r["id"],
            "periodo_mes": r.get("periodo_mes"),
            "periodo_anio": r.get("periodo_anio"),
            "comprobantes": conteos,
            "total": sum(conteos.values()),
        })
    plan["fusionar"].sort(key=lambda f: int(f.get("periodo_mes") or 0))

    con_datos = [f for f in plan["fusionar"] if f["total"]]
    if con_datos:
        meses = ", ".join(f"{int(f['periodo_mes']):02d}" for f in con_datos)
        plan["avisos"].append(
            f"Hay comprobantes cargados en los meses {meses} de ese semestre. Si no se "
            f"unen al período semestral, la declaración del semestre saldrá incompleta.")
    return plan


def _mover_comprobantes(sb, origen_id: str, destino_id: str) -> dict:
    """Mueve los comprobantes de un período a otro. Devuelve
    {tabla: {'movidos': n, 'duplicados': n}}. Los que ya existían en el destino
    (misma clave de acceso) se dejan en el origen: no se borra nada."""
    resultado = {}
    for tabla, etiqueta in TABLAS_PERIODO:
        try:
            origen = fetch_all(lambda t=tabla: sb.table(t).select("id,unique_id").eq("client_id", origen_id))
        except Exception:
            continue
        if not origen:
            continue
        try:
            destino = fetch_all(lambda t=tabla: sb.table(t).select("unique_id").eq("client_id", destino_id))
        except Exception:
            destino = []
        ya = {d.get("unique_id") for d in destino}
        mover = [o["id"] for o in origen if o.get("unique_id") not in ya]
        duplicados = len(origen) - len(mover)
        movidos = 0
        for i in range(0, len(mover), 100):
            lote = mover[i:i + 100]
            try:
                r = sb.table(tabla).update({"client_id": destino_id}).in_("id", lote).execute()
                movidos += len(r.data or [])
            except Exception as e:
                print(f"Error moviendo {tabla} de {origen_id} a {destino_id}: {e}")
        if movidos or duplicados:
            resultado[etiqueta] = {"movidos": movidos, "duplicados": duplicados}
    return resultado


def aplicar_cambio(sb, client_id: str, periodicidad: str, semestre=None,
                   fusionar: bool = False) -> dict:
    """Ejecuta el plan. Devuelve el resumen de lo hecho."""
    plan = plan_cambio(sb, client_id, periodicidad, semestre)

    if periodicidad == "mensual":
        sb.table("clients").update({
            "periodicidad": "mensual",
            "periodo_semestre": None,
            "updated_at": "now()",
        }).eq("id", plan["destino"]["client_id"]).execute()
        return {"plan": plan, "client_id": plan["destino"]["client_id"], "movidos": {}}

    sem = plan["semestre"]
    anio = plan["anio"]
    ancla = mes_ancla_semestre(sem)
    destino_id = plan["destino"]["client_id"]

    if plan["crear_periodo"]:
        base = sb.table("clients").select("*").eq("id", client_id).limit(1).execute().data[0]
        fila = {k: base.get(k) for k in _IDENTIDAD if base.get(k) is not None}
        fila.update({
            "user_id": base.get("user_id"),
            "periodo_mes": ancla,
            "periodo_anio": anio,
            "periodicidad": "semestral",
            "periodo_semestre": sem,
        })
        creado = sb.table("clients").insert(fila).execute().data
        destino_id = creado[0]["id"] if creado else None
        if not destino_id:
            raise ValueError("No se pudo abrir el período semestral.")
    else:
        sb.table("clients").update({
            "periodo_mes": ancla,
            "periodicidad": "semestral",
            "periodo_semestre": sem,
            "updated_at": "now()",
        }).eq("id", destino_id).execute()

    movidos = {}
    if fusionar:
        for f in plan["fusionar"]:
            if not f["total"]:
                continue
            res = _mover_comprobantes(sb, f["client_id"], destino_id)
            for etiqueta, datos in res.items():
                acc = movidos.setdefault(etiqueta, {"movidos": 0, "duplicados": 0})
                acc["movidos"] += datos["movidos"]
                acc["duplicados"] += datos["duplicados"]

    return {"plan": plan, "client_id": destino_id, "movidos": movidos}
