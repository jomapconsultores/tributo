"""Validación de período: las facturas de venta, gastos y retenciones deben
pertenecer al MES EN PROCESO del cliente (clients.periodo_mes / periodo_anio).
Las que tienen otra fecha NO se toman en cuenta y se informan al usuario.

La fecha de los comprobantes viene en formato 'dd/mm/yyyy' (fechaEmision del SRI);
también se tolera 'yyyy-mm-dd'."""
import re


def mes_anio_de_fecha(fecha):
    """De una fecha 'dd/mm/yyyy' (o 'yyyy-mm-dd') devuelve (mes, anio) como int,
    o (None, None) si no se pudo interpretar."""
    if not fecha:
        return None, None
    s = str(fecha).strip()
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})", s)
    if m:
        return int(m.group(2)), int(m.group(3))
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        return int(m.group(2)), int(m.group(1))
    return None, None


def periodo_cliente(supabase, client_id):
    """(periodo_mes, periodo_anio) del cliente, o (None, None) si no está fijado
    o no se pudo leer. Si es (None, None) NO se valida el período (se acepta todo)."""
    try:
        c = supabase.table("clients").select("periodo_mes,periodo_anio").eq("id", client_id).limit(1).execute()
        if c.data:
            return c.data[0].get("periodo_mes"), c.data[0].get("periodo_anio")
    except Exception:
        pass
    return None, None


def es_de_otro_periodo(fecha, periodo_mes, periodo_anio) -> bool:
    """True si la fecha del comprobante NO pertenece al período (mes/año) del
    cliente. Si el cliente no tiene período fijado, o la fecha no es legible,
    devuelve False (no se descarta por período)."""
    if not periodo_mes or not periodo_anio:
        return False
    fmes, fanio = mes_anio_de_fecha(fecha)
    if fmes is None:
        return False
    return (fmes, fanio) != (int(periodo_mes), int(periodo_anio))


def etiqueta_periodo(periodo_mes, periodo_anio) -> str:
    """'MM/AAAA' para mostrar al usuario, o '' si no hay período."""
    if not periodo_mes or not periodo_anio:
        return ""
    return f"{str(periodo_mes).zfill(2)}/{periodo_anio}"
