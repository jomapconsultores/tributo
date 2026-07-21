"""Validación de período: las facturas de venta, gastos y retenciones deben
pertenecer al MES EN PROCESO del cliente (clients.periodo_mes / periodo_anio).
Las que tienen otra fecha NO se toman en cuenta y se informan al usuario.

La fecha de los comprobantes viene en formato 'dd/mm/yyyy' (fechaEmision del SRI);
también se tolera 'yyyy-mm-dd'."""
import re
from datetime import datetime, timezone, timedelta

# Ecuador (UTC-5, sin horario de verano). Igual criterio que routers/reportes.py.
EC_TZ = timezone(timedelta(hours=-5))


def periodo_anterior(mes, anio):
    """(mes, anio) del mes inmediatamente anterior. Enero → diciembre del año previo."""
    mes = int(mes)
    anio = int(anio)
    if mes <= 1:
        return 12, anio - 1
    return mes - 1, anio


def periodo_a_declarar(hoy=None):
    """Período (mes, anio) que se debe declarar AHORA: en Ecuador se declara el mes
    ANTERIOR (declaración mes vencido). En julio → junio. Hora Ecuador (UTC-5).
    Espejo de utils/declaracionSRI.js::periodoADeclarar en el frontend."""
    now = hoy or datetime.now(EC_TZ)
    return periodo_anterior(now.month, now.year)


# --- Semestral (IVA Form. 104 semestral) -----------------------------------
# 1er semestre = ENE–JUN, se declara en JULIO.
# 2do semestre = JUL–DIC, se declara en ENERO del año siguiente.
# Se usa el ÚLTIMO mes del semestre (6 ó 12) como ANCLA en periodo_mes, para que
# el orden cronológico por (anio, mes) y el arrastre de crédito sigan intactos.

def rango_semestre(semestre):
    """(mes_inicio, mes_fin) del semestre. 1 → (1, 6); 2 → (7, 12)."""
    return (7, 12) if int(semestre or 1) == 2 else (1, 6)


def semestre_de_mes(mes):
    """Semestre (1 ó 2) al que pertenece un mes 1–12."""
    return 1 if int(mes or 1) <= 6 else 2


def mes_ancla_semestre(semestre):
    """Mes ancla (último del semestre) que se guarda en periodo_mes: 1 → 6; 2 → 12."""
    return 6 if int(semestre or 1) == 1 else 12


def semestre_anterior(semestre, anio):
    """(semestre, anio) del semestre inmediatamente anterior. 1 → (2, anio-1); 2 → (1, anio)."""
    return (2, anio - 1) if int(semestre) == 1 else (1, anio)


def semestre_a_declarar(hoy=None):
    """Semestre (semestre, anio) que se declara AHORA. En JULIO se declara el 1er
    semestre (ENE–JUN) del año en curso; en ENERO se declara el 2do semestre
    (JUL–DIC) del año anterior. Fuera de esos meses, devuelve el semestre ya
    terminado más reciente (útil como valor por defecto). Hora Ecuador (UTC-5)."""
    now = hoy or datetime.now(EC_TZ)
    m, a = now.month, now.year
    if m == 1:
        return 2, a - 1              # enero → 2do semestre del año pasado
    if m <= 6:
        return 2, a - 1              # aún en el 1er semestre → el último cerrado es el 2do del año pasado
    return 1, a                      # jul–dic → 1er semestre de este año ya cerrado


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


def periodo_cliente_ext(supabase, client_id):
    """(periodo_mes, periodo_anio, periodicidad, periodo_semestre) del cliente.
    Para contribuyentes semestrales la validación de facturas acepta CUALQUIER mes
    del semestre. Si no se pudo leer devuelve (None, None, 'mensual', None)."""
    try:
        c = supabase.table("clients").select(
            "periodo_mes,periodo_anio,periodicidad,periodo_semestre"
        ).eq("id", client_id).limit(1).execute()
        if c.data:
            r = c.data[0]
            return (r.get("periodo_mes"), r.get("periodo_anio"),
                    (r.get("periodicidad") or "mensual"), r.get("periodo_semestre"))
    except Exception:
        pass
    return None, None, "mensual", None


def solo_digitos(s):
    """Solo los dígitos de un identificador (RUC/cédula), para comparar sin
    ceros/espacios/guiones."""
    return re.sub(r"\D", "", str(s or ""))


def identificacion_cliente(supabase, client_id):
    """Identificación (RUC/cédula) del contribuyente del cliente, o '' si no se
    pudo leer. Se usa para validar que las ventas las emita el propio
    contribuyente y que las compras las haga él (identificacionComprador)."""
    try:
        c = supabase.table("clients").select("identificacion").eq("id", client_id).limit(1).execute()
        if c.data:
            return (c.data[0].get("identificacion") or "").strip()
    except Exception:
        pass
    return ""


def identificacion_no_coincide(id_comprobante, id_cliente) -> bool:
    """True si el identificador del comprobante (emisor en ventas / comprador en
    compras) NO coincide con el del contribuyente. Compara solo dígitos; si falta
    alguno de los dos, NO advierte (no hay con qué comparar)."""
    a = solo_digitos(id_comprobante)
    b = solo_digitos(id_cliente)
    if not a or not b:
        return False
    # Un lado puede ser RUC (13) y el otro cédula (10): coincide si el RUC empieza
    # con la cédula (persona natural con RUC = cédula + '001').
    if a == b:
        return False
    if len(a) == 13 and len(b) == 10 and a.startswith(b):
        return False
    if len(b) == 13 and len(a) == 10 and b.startswith(a):
        return False
    return True


def es_de_otro_periodo(fecha, periodo_mes, periodo_anio,
                       periodicidad="mensual", periodo_semestre=None) -> bool:
    """True si la fecha del comprobante NO pertenece al período del cliente.

    · Mensual: el mes/año debe coincidir exactamente con (periodo_mes, periodo_anio).
    · Semestral: basta que el mes caiga dentro del semestre (ENE–JUN ó JUL–DIC) del
      año del período. Así se aceptan las facturas de los 6 meses del semestre.

    Si el cliente no tiene período fijado, o la fecha no es legible, devuelve False
    (no se descarta por período)."""
    if not periodo_anio:
        return False
    fmes, fanio = mes_anio_de_fecha(fecha)
    if fmes is None:
        return False
    if (periodicidad or "mensual") == "semestral":
        # El semestre se toma de periodo_semestre; si falta, se deduce del mes ancla.
        sem = int(periodo_semestre) if periodo_semestre else semestre_de_mes(periodo_mes or 1)
        ini, fin = rango_semestre(sem)
        return not (fanio == int(periodo_anio) and ini <= fmes <= fin)
    if not periodo_mes:
        return False
    return (fmes, fanio) != (int(periodo_mes), int(periodo_anio))


def etiqueta_periodo(periodo_mes, periodo_anio,
                     periodicidad="mensual", periodo_semestre=None) -> str:
    """Etiqueta legible del período, o '' si no hay período.
    · Mensual:   'MM/AAAA'.
    · Semestral: '1er semestre AAAA (ENE–JUN)' / '2do semestre AAAA (JUL–DIC)'."""
    if not periodo_anio:
        return ""
    if (periodicidad or "mensual") == "semestral":
        sem = int(periodo_semestre) if periodo_semestre else semestre_de_mes(periodo_mes or 1)
        rango = "ENE–JUN" if sem == 1 else "JUL–DIC"
        ord_ = "1er" if sem == 1 else "2do"
        return f"{ord_} semestre {periodo_anio} ({rango})"
    if not periodo_mes:
        return ""
    return f"{str(periodo_mes).zfill(2)}/{periodo_anio}"
