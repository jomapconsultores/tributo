"""Cálculo de declaraciones (código SRI → valor) a partir de los datos cargados.
IVA = Formulario 104; ICE = Formulario ICE. Los mapeos de código son los
campos estándar del SRI; el contador debe verificarlos antes de presentar."""
from services.ice_calc import resumen_general as ice_audit_general
from services.ice_data import tax_params


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def declaracion_iva(invoices, ventas_ice):
    """Formulario 104. Adquisiciones desde 'gastos' (facturas de compra) y
    ventas desde ventas con ICE (si las hay)."""
    base_15 = sum(_f(i.get("base_15")) for i in invoices)
    iva_15 = sum(_f(i.get("iva_15")) for i in invoices)
    base_5 = sum(_f(i.get("base_5")) for i in invoices)
    iva_5 = sum(_f(i.get("iva_5")) for i in invoices)
    base_0 = sum(_f(i.get("base_0")) for i in invoices)
    no_obj = sum(_f(i.get("no_objeto_iva")) for i in invoices)
    exento = sum(_f(i.get("exento_iva")) for i in invoices)
    credito = iva_15 + iva_5  # IVA pagado en compras (crédito tributario)

    base_ventas = sum(_f(v.get("base_iva")) for v in ventas_ice)
    iva_ventas = sum(_f(v.get("valor_iva")) for v in ventas_ice)
    iva_pagar = max(0.0, iva_ventas - credito)

    filas = [
        {"seccion": "VENTAS", "codigo": "411", "concepto": "Ventas locales gravadas tarifa dif. de 0% (valor neto)", "valor": round(base_ventas, 2)},
        {"seccion": "VENTAS", "codigo": "421", "concepto": "IVA generado en ventas", "valor": round(iva_ventas, 2)},
        {"seccion": "ADQUISICIONES", "codigo": "510", "concepto": "Adquisiciones gravadas 15% con derecho a crédito (valor neto)", "valor": round(base_15, 2)},
        {"seccion": "ADQUISICIONES", "codigo": "520", "concepto": "IVA en adquisiciones 15%", "valor": round(iva_15, 2)},
        {"seccion": "ADQUISICIONES", "codigo": "550", "concepto": "Adquisiciones gravadas 5% con derecho a crédito (valor neto)", "valor": round(base_5, 2)},
        {"seccion": "ADQUISICIONES", "codigo": "560", "concepto": "IVA en adquisiciones 5%", "valor": round(iva_5, 2)},
        {"seccion": "ADQUISICIONES", "codigo": "517", "concepto": "Adquisiciones y pagos gravados tarifa 0%", "valor": round(base_0, 2)},
        {"seccion": "ADQUISICIONES", "codigo": "—", "concepto": "Adquisiciones no objeto / exentas de IVA", "valor": round(no_obj + exento, 2)},
        {"seccion": "RESULTADO", "codigo": "564", "concepto": "Crédito tributario por adquisiciones (IVA compras)", "valor": round(credito, 2)},
        {"seccion": "RESULTADO", "codigo": "499", "concepto": "IVA a pagar estimado (421 − crédito 564)", "valor": round(iva_pagar, 2)},
    ]
    return {
        "tipo": "IVA",
        "filas": filas,
        "resumen": {"iva_ventas": round(iva_ventas, 2), "iva_compras": round(iva_compras, 2), "iva_pagar": round(iva_pagar, 2)},
    }


def declaracion_ice(ice_rows, anio):
    """Formulario ICE para bebidas alcohólicas (SRI).
    - ICE específico: tarifa por litro de alcohol puro × litros de alcohol puro.
    - ICE ad valorem: 75% del exceso del precio/litro sobre el umbral.
    Se apoya en la auditoría de ICE (específico + ad valorem) del año."""
    g = ice_audit_general(ice_rows, anio)
    tax = tax_params(anio)
    esp = tax.get("esp", 0.0)
    # Base imponible (ad valorem) = precio ex-fábrica de venta
    base = sum(_f(r.get("base_ice")) or _f(r.get("precio_total_sin_impuesto")) for r in ice_rows)
    # Volumen = LITROS DE ALCOHOL PURO (litros de bebida × grado/100)
    litros_alcohol = sum(
        _f(r.get("unidades_botellas")) * (_f(r.get("capacidad")) / 1000.0) * (_f(r.get("grado_alcoholico")) / 100.0)
        for r in ice_rows
    )
    ice_esp = g.get("ice_especifico", 0.0)
    ice_adv = g.get("ice_advalorem", 0.0)
    total_ice = g.get("total_ice", 0.0)

    filas = [
        {"seccion": "AD VALOREM", "codigo": "303", "concepto": "Base imponible bruta (precio ex-fábrica)", "valor": round(base, 2)},
        {"seccion": "AD VALOREM", "codigo": "305", "concepto": "Porcentaje tarifa ad valorem", "valor": 0.75},
        {"seccion": "AD VALOREM", "codigo": "309", "concepto": "ICE causado ad valorem", "valor": round(ice_adv, 2)},
        {"seccion": "ESPECÍFICO", "codigo": "314", "concepto": "Volumen neto (litros de alcohol puro)", "valor": round(litros_alcohol, 4)},
        {"seccion": "ESPECÍFICO", "codigo": "315", "concepto": "Tarifa específica (por litro de alcohol puro)", "valor": round(esp, 2)},
        {"seccion": "ESPECÍFICO", "codigo": "319", "concepto": "ICE causado específico", "valor": round(ice_esp, 2)},
        {"seccion": "RESULTADO", "codigo": "399", "concepto": "TOTAL ICE CAUSADO", "valor": round(total_ice, 2)},
        {"seccion": "RESULTADO", "codigo": "499", "concepto": "TOTAL ICE A PAGAR", "valor": round(total_ice, 2)},
    ]
    return {
        "tipo": "ICE",
        "filas": filas,
        "resumen": {"ice_especifico": round(ice_esp, 2), "ice_advalorem": round(ice_adv, 2), "total_ice": round(total_ice, 2)},
    }
