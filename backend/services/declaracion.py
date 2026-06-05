"""Cálculo de declaraciones (código SRI → valor) a partir de los datos cargados.
IVA = Formulario 104; ICE = Formulario ICE. Los mapeos de código son los
campos estándar del SRI; el contador debe verificarlos antes de presentar."""
from services.ice_calc import resumen_general as ice_audit_general


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def declaracion_iva(invoices, ventas_ice):
    """Formulario 104. Adquisiciones desde 'gastos' (facturas de compra) y
    ventas desde ventas con ICE (si las hay)."""
    base_grav = sum(_f(i.get("base_15")) + _f(i.get("base_5")) for i in invoices)
    iva_compras = sum(_f(i.get("iva_15")) + _f(i.get("iva_5")) for i in invoices)
    base_0 = sum(_f(i.get("base_0")) for i in invoices)
    no_obj = sum(_f(i.get("no_objeto_iva")) for i in invoices)
    exento = sum(_f(i.get("exento_iva")) for i in invoices)

    base_ventas = sum(_f(v.get("base_iva")) for v in ventas_ice)
    iva_ventas = sum(_f(v.get("valor_iva")) for v in ventas_ice)
    iva_pagar = max(0.0, iva_ventas - iva_compras)

    filas = [
        {"seccion": "VENTAS", "codigo": "411", "concepto": "Ventas locales gravadas tarifa dif. de 0% (valor neto)", "valor": round(base_ventas, 2)},
        {"seccion": "VENTAS", "codigo": "421", "concepto": "IVA generado en ventas", "valor": round(iva_ventas, 2)},
        {"seccion": "ADQUISICIONES", "codigo": "510", "concepto": "Adquisiciones y pagos gravados tarifa dif. de 0% (valor neto)", "valor": round(base_grav, 2)},
        {"seccion": "ADQUISICIONES", "codigo": "520", "concepto": "IVA en adquisiciones (crédito tributario)", "valor": round(iva_compras, 2)},
        {"seccion": "ADQUISICIONES", "codigo": "517", "concepto": "Adquisiciones y pagos gravados tarifa 0%", "valor": round(base_0, 2)},
        {"seccion": "ADQUISICIONES", "codigo": "—", "concepto": "Adquisiciones no objeto de IVA", "valor": round(no_obj, 2)},
        {"seccion": "ADQUISICIONES", "codigo": "—", "concepto": "Adquisiciones exentas de IVA", "valor": round(exento, 2)},
        {"seccion": "RESULTADO", "codigo": "499", "concepto": "IVA a pagar (estimado: 421 − 520)", "valor": round(iva_pagar, 2)},
    ]
    return {
        "tipo": "IVA",
        "filas": filas,
        "resumen": {"iva_ventas": round(iva_ventas, 2), "iva_compras": round(iva_compras, 2), "iva_pagar": round(iva_pagar, 2)},
    }


def declaracion_ice(ice_rows, anio):
    """Formulario ICE, a partir de las ventas de licor (ice_sales) y la
    auditoría de ICE (específico + ad-valorem) del año."""
    g = ice_audit_general(ice_rows, anio)
    base = sum(_f(r.get("base_ice")) or _f(r.get("precio_total_sin_impuesto")) for r in ice_rows)
    volumen_litros = sum((_f(r.get("unidades_botellas")) * _f(r.get("capacidad")) / 1000.0) for r in ice_rows)
    ice_esp = g.get("ice_especifico", 0.0)
    ice_adv = g.get("ice_advalorem", 0.0)
    total_ice = g.get("total_ice", 0.0)

    filas = [
        {"seccion": "AD VALOREM", "codigo": "303", "concepto": "Base imponible bruta", "valor": round(base, 2)},
        {"seccion": "AD VALOREM", "codigo": "309", "concepto": "ICE causado ad valorem", "valor": round(ice_adv, 2)},
        {"seccion": "ESPECÍFICO", "codigo": "313", "concepto": "Volumen bruto (litros)", "valor": round(volumen_litros, 2)},
        {"seccion": "ESPECÍFICO", "codigo": "319", "concepto": "ICE causado específico", "valor": round(ice_esp, 2)},
        {"seccion": "RESULTADO", "codigo": "399", "concepto": "TOTAL ICE CAUSADO", "valor": round(total_ice, 2)},
        {"seccion": "RESULTADO", "codigo": "499", "concepto": "TOTAL ICE A PAGAR", "valor": round(total_ice, 2)},
    ]
    return {
        "tipo": "ICE",
        "filas": filas,
        "resumen": {"ice_especifico": round(ice_esp, 2), "ice_advalorem": round(ice_adv, 2), "total_ice": round(total_ice, 2)},
    }
