"""Cálculo de declaraciones (código SRI → valor) a partir de los datos cargados.
IVA = Formulario 104; ICE = Formulario ICE. Los mapeos de código son los
campos estándar del SRI; el contador debe verificarlos antes de presentar."""
from services.ice_calc import resumen_general as ice_audit_general
from services.ice_data import tax_params
from services.xml_parser import GASTOS_PERSONALES


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _es_personal(inv):
    return (inv.get("clasificacion") or "").upper() in GASTOS_PERSONALES


def _agg(invoices, key):
    """Suma el campo y cuenta cuántos comprobantes tienen valor > 0 en él."""
    total = 0.0
    n = 0
    for i in invoices:
        v = _f(i.get(key))
        if v > 0:
            total += v
            n += 1
    return total, n


def declaracion_iva(invoices, ventas_ice, ventas_iva=None, retentions=None,
                    credito_mes_anterior_adquisiciones=0, credito_mes_anterior_retenciones=0,
                    pagos_aplazados_vencen_este_periodo=None,
                    diferir_meses=0):
    """Formulario 104.

    Compras: solo gastos del EJERCICIO (con derecho a crédito). Personales van al IR.

    Ventas: dos fuentes que se SUMAN — ambas declaran al mismo formulario:
    - ventas_ice (tabla ice_sales): base_iva ya incluye el ICE (regla SRI).
    - ventas_iva (tabla sales_iva): facturas SIN ICE, desglose por tarifa.

    Crédito tributario mes anterior: viene de la declaración del mes anterior
    (saldos remanentes 605/606). El backend lo precarga del histórico y el
    usuario puede sobrescribirlo si no hay historial.

    Retenciones del período (609): se computa sumando ret_iva del listado de
    retentions del cliente para el período.

    Aplazamiento (Art. 67 LRTI): si diferir_meses > 0, las ventas se reportan
    en el casillero 481 (ventas con cobro diferido > N meses) y el IVA
    correspondiente en 484. El impuesto causado neto = 421+422 − 484, por lo
    que el saldo puede quedar a favor (crédito tributario) si las compras
    tienen más IVA que las ventas no diferidas.

    Pagos aplazados vencen: cuando vence un aplazamiento de meses anteriores,
    su IVA entra al casillero 480 (suma al impuesto causado).
    """
    if ventas_iva is None:
        ventas_iva = []
    if retentions is None:
        retentions = []
    if pagos_aplazados_vencen_este_periodo is None:
        pagos_aplazados_vencen_este_periodo = []

    invoices = [i for i in invoices if (i.get("estado") or "OK") == "OK"]
    ejercicio = [i for i in invoices if not _es_personal(i)]
    personales_excluidos = sum(1 for i in invoices if _es_personal(i))

    # ── Compras del EJERCICIO (con derecho a crédito) ────────────────────
    c_base_15, c_n_base_15 = _agg(ejercicio, "base_15")
    c_iva_15, _            = _agg(ejercicio, "iva_15")
    c_base_5, c_n_base_5   = _agg(ejercicio, "base_5")
    c_iva_5, _             = _agg(ejercicio, "iva_5")
    c_base_0, c_n_base_0   = _agg(ejercicio, "base_0")
    c_no_obj, c_n_no_obj   = _agg(ejercicio, "no_objeto_iva")
    c_exento, c_n_exento   = _agg(ejercicio, "exento_iva")
    iva_compras = c_iva_15 + c_iva_5  # crédito tributario del período actual

    # ── Ventas con ICE (tabla ice_sales) ─────────────────────────────────
    v_ice_solo_ok = [v for v in ventas_ice if (v.get("estado") or "OK") == "OK"]
    v_ice_base_15 = sum(_f(v.get("base_iva")) for v in v_ice_solo_ok)
    v_ice_iva_15  = sum(_f(v.get("valor_iva")) for v in v_ice_solo_ok)
    n_ventas_ice  = sum(1 for v in v_ice_solo_ok if _f(v.get("base_iva")) > 0 or _f(v.get("valor_iva")) > 0)

    # ── Ventas sin ICE (tabla sales_iva) ─────────────────────────────────
    v_iva_solo_ok = [v for v in ventas_iva if (v.get("estado") or "OK") == "OK"]
    v_base_15, v_n_base_15 = _agg(v_iva_solo_ok, "base_15")
    v_iva_15,  _           = _agg(v_iva_solo_ok, "iva_15")
    v_base_5,  v_n_base_5  = _agg(v_iva_solo_ok, "base_5")
    v_iva_5,   _           = _agg(v_iva_solo_ok, "iva_5")
    v_base_0,  v_n_base_0  = _agg(v_iva_solo_ok, "base_0")
    v_no_obj,  v_n_no_obj  = _agg(v_iva_solo_ok, "no_objeto_iva")
    v_exento,  v_n_exento  = _agg(v_iva_solo_ok, "exento_iva")

    # ── Totales de ventas ────────────────────────────────────────────────
    t_base_15 = v_ice_base_15 + v_base_15      # 411
    t_iva_15  = v_ice_iva_15 + v_iva_15        # 421
    t_base_5  = v_base_5                       # 412
    t_iva_5   = v_iva_5                        # 422
    t_base_0  = v_base_0                       # 413
    t_exento  = v_exento                       # 414
    t_no_obj  = v_no_obj                       # 415
    iva_ventas = t_iva_15 + t_iva_5

    # ── Retenciones del período (609) ────────────────────────────────────
    # Suma de ret_iva de la tabla retentions del cliente en el período.
    ret_ok = [r for r in retentions if (r.get("estado") or "OK") == "OK"]
    ret_iva_periodo = sum(_f(r.get("ret_iva")) for r in ret_ok)
    n_retenciones = sum(1 for r in ret_ok if _f(r.get("ret_iva")) > 0)

    # ── Aplazamiento: si diferir_meses > 0, todo el IVA generado se mueve al 484 ──
    # 481 = total ventas con cobro diferido (base imponible)
    # 484 = IVA correspondiente al 481 (= iva_ventas total para nuestra simplificación)
    diferir_meses = max(0, min(3, int(diferir_meses or 0)))
    if diferir_meses > 0:
        iva_diferido_actual = iva_ventas
        ventas_diferidas_monto = t_base_15 + t_base_5  # base imponible de ventas
    else:
        iva_diferido_actual = 0.0
        ventas_diferidas_monto = 0.0

    # 480 = IVA diferido de meses anteriores que VENCE este período (entra al causado)
    iva_recibido_aplazado = sum(_f(p.get("monto")) for p in pagos_aplazados_vencen_este_periodo)
    monto_aplazados_que_vencen = iva_recibido_aplazado  # alias

    # ── Cálculo del impuesto a pagar ─────────────────────────────────────
    # Impuesto causado neto = (421+422) + 480 − 484
    impuesto_causado_neto = iva_ventas + iva_recibido_aplazado - iva_diferido_actual

    # Crédito total = compras + 605 + 606 + 609
    credito_total = (iva_compras
                     + _f(credito_mes_anterior_adquisiciones)
                     + _f(credito_mes_anterior_retenciones)
                     + ret_iva_periodo)

    # Resultado: si crédito ≥ causado_neto → SALDO A FAVOR (crédito tributario)
    #            si crédito < causado_neto → IVA A PAGAR
    iva_a_pagar = max(0.0, impuesto_causado_neto - credito_total)
    saldo_a_favor = max(0.0, credito_total - impuesto_causado_neto)
    total_a_pagar = iva_a_pagar

    def fila(seccion, codigo, concepto, valor, n=None):
        f = {"seccion": seccion, "codigo": codigo, "concepto": concepto, "valor": round(valor, 2)}
        if n is not None:
            f["num_comprobantes"] = n
        return f

    filas = [
        # ── VENTAS ──
        fila("VENTAS", "411", "Ventas locales gravadas 15% (valor neto, ICE+IVA incluido)", t_base_15, n_ventas_ice + v_n_base_15),
        fila("VENTAS", "412", "Ventas locales gravadas 5% (valor neto)", t_base_5, v_n_base_5),
        fila("VENTAS", "413", "Ventas locales con tarifa 0%", t_base_0, v_n_base_0),
        fila("VENTAS", "414", "Ventas exentas de IVA", t_exento, v_n_exento),
        fila("VENTAS", "415", "Ventas no objeto del IVA", t_no_obj, v_n_no_obj),
        fila("VENTAS", "421", "IVA generado en ventas 15%", t_iva_15),
        fila("VENTAS", "422", "IVA generado en ventas 5%", t_iva_5),

        # ── ADQUISICIONES ──
        fila("ADQUISICIONES", "510", "Adquisiciones gravadas 15% con derecho a crédito (valor neto)", c_base_15, c_n_base_15),
        fila("ADQUISICIONES", "520", "IVA en adquisiciones 15%", c_iva_15),
        fila("ADQUISICIONES", "550", "Adquisiciones gravadas 5% con derecho a crédito (valor neto)", c_base_5, c_n_base_5),
        fila("ADQUISICIONES", "560", "IVA en adquisiciones 5%", c_iva_5),
        fila("ADQUISICIONES", "517", "Adquisiciones y pagos gravados tarifa 0%", c_base_0, c_n_base_0),
        fila("ADQUISICIONES", "518", "Adquisiciones no objeto del IVA", c_no_obj, c_n_no_obj),
        fila("ADQUISICIONES", "519", "Adquisiciones exentas de IVA", c_exento, c_n_exento),

        # ── RESULTADO ──
        fila("RESULTADO", "601", "IVA generado en ventas (421+422)", iva_ventas),
    ]
    # ── Aplazamiento — entra ANTES del crédito (afecta causado neto) ──
    if iva_recibido_aplazado > 0:
        filas.append(fila("RESULTADO", "480", "IVA diferido de períodos anteriores que vence ahora (entra al causado)",
                          iva_recibido_aplazado, len(pagos_aplazados_vencen_este_periodo)))
    if diferir_meses > 0:
        filas.append(fila("RESULTADO", "481", f"Ventas con cobro diferido (plazo > {diferir_meses} mes{'es' if diferir_meses > 1 else ''})",
                          ventas_diferidas_monto, v_n_base_15 + v_n_base_5 + n_ventas_ice))
        filas.append(fila("RESULTADO", "484", "IVA correspondiente al 481 (no se causa este período)",
                          iva_diferido_actual))
    filas.append(fila("RESULTADO", "609.X", "Impuesto causado NETO (601 + 480 − 484)", impuesto_causado_neto))
    filas.extend([
        fila("RESULTADO", "602", "Crédito tributario por adquisiciones del período (520+560)", iva_compras, c_n_base_15 + c_n_base_5),
        fila("RESULTADO", "605", "Saldo crédito tributario mes anterior por adquisiciones (editable)", _f(credito_mes_anterior_adquisiciones)),
        fila("RESULTADO", "606", "Saldo crédito tributario mes anterior por retenciones (editable)", _f(credito_mes_anterior_retenciones)),
        fila("RESULTADO", "609", "Retenciones de IVA del período (de comprobantes)", ret_iva_periodo, n_retenciones),
        fila("RESULTADO", "619", "Total crédito tributario disponible (602+605+606+609)", credito_total),
    ])
    if saldo_a_favor > 0:
        filas.append(fila("RESULTADO", "699", "✓ Saldo crédito tributario para el siguiente mes (crédito > causado neto)", saldo_a_favor))
        filas.append(fila("RESULTADO", "902", "IVA a pagar del período", 0.0))
    else:
        filas.append(fila("RESULTADO", "902", "IVA a pagar del período (causado neto − crédito)", iva_a_pagar))

    return {
        "tipo": "IVA",
        "filas": filas,
        "resumen": {
            "iva_ventas": round(iva_ventas, 2),
            "iva_compras": round(iva_compras, 2),
            "credito_mes_anterior_adquisiciones": round(_f(credito_mes_anterior_adquisiciones), 2),
            "credito_mes_anterior_retenciones": round(_f(credito_mes_anterior_retenciones), 2),
            "ret_iva_periodo": round(ret_iva_periodo, 2),
            "credito_total": round(credito_total, 2),
            "impuesto_causado_neto": round(impuesto_causado_neto, 2),
            "iva_a_pagar": round(iva_a_pagar, 2),
            "saldo_a_favor_proximo_mes": round(saldo_a_favor, 2),
            "monto_aplazados_vencen": round(monto_aplazados_que_vencen, 2),
            "total_a_pagar": round(total_a_pagar, 2),
            "diferir_meses": diferir_meses,
            "iva_diferido_actual": round(iva_diferido_actual, 2),
            "ventas_diferidas_monto": round(ventas_diferidas_monto, 2),
            "num_facturas_ejercicio": len(ejercicio),
            "num_facturas_personales_excluidas": personales_excluidos,
            "num_ventas_ice": n_ventas_ice,
            "num_ventas_iva_solo": len(v_iva_solo_ok),
            "num_retenciones_periodo": n_retenciones,
            "num_aplazados_vencen": len(pagos_aplazados_vencen_este_periodo),
        },
    }


def declaracion_ice(ice_rows, anio, pagos_aplazados_vencen_este_periodo=None):
    """Formulario ICE para bebidas alcohólicas (SRI).
    - ICE específico: tarifa por litro de alcohol puro × litros de alcohol puro.
    - ICE ad valorem: 75% del exceso del precio/litro sobre el umbral.

    Aplazamientos: ICE permite hasta 1 mes adicional cuando hay compras a crédito
    de procesos productivos (regla SRI). Si hay aplazamientos vencidos este
    período, se suman al casillero 902 (a pagar)."""
    if pagos_aplazados_vencen_este_periodo is None:
        pagos_aplazados_vencen_este_periodo = []

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

    monto_aplazados_que_vencen = sum(_f(p.get("monto")) for p in pagos_aplazados_vencen_este_periodo)
    total_a_pagar = total_ice + monto_aplazados_que_vencen

    filas = [
        {"seccion": "AD VALOREM", "codigo": "303", "concepto": "Base imponible bruta (precio ex-fábrica)", "valor": round(base, 2)},
        {"seccion": "AD VALOREM", "codigo": "305", "concepto": "Porcentaje tarifa ad valorem", "valor": 0.75},
        {"seccion": "AD VALOREM", "codigo": "309", "concepto": "ICE causado ad valorem", "valor": round(ice_adv, 2)},
        {"seccion": "ESPECÍFICO", "codigo": "314", "concepto": "Volumen neto (litros de alcohol puro)", "valor": round(litros_alcohol, 4)},
        {"seccion": "ESPECÍFICO", "codigo": "315", "concepto": "Tarifa específica (por litro de alcohol puro)", "valor": round(esp, 2)},
        {"seccion": "ESPECÍFICO", "codigo": "319", "concepto": "ICE causado específico", "valor": round(ice_esp, 2)},
        {"seccion": "RESULTADO", "codigo": "399", "concepto": "TOTAL ICE CAUSADO", "valor": round(total_ice, 2)},
        {"seccion": "RESULTADO", "codigo": "499", "concepto": "TOTAL ICE A PAGAR (período actual)", "valor": round(total_ice, 2)},
    ]
    if monto_aplazados_que_vencen > 0:
        filas.append({"seccion": "RESULTADO", "codigo": "903",
                      "concepto": "Pagos aplazados que vencen este período",
                      "valor": round(monto_aplazados_que_vencen, 2),
                      "num_comprobantes": len(pagos_aplazados_vencen_este_periodo)})
        filas.append({"seccion": "RESULTADO", "codigo": "904",
                      "concepto": "Total a pagar (499 + 903)",
                      "valor": round(total_a_pagar, 2)})
    return {
        "tipo": "ICE",
        "filas": filas,
        "resumen": {
            "ice_especifico": round(ice_esp, 2),
            "ice_advalorem": round(ice_adv, 2),
            "total_ice": round(total_ice, 2),
            "ice_a_pagar": round(total_ice, 2),  # alias para que la UI detecte hayMontoAPagar
            "monto_aplazados_vencen": round(monto_aplazados_que_vencen, 2),
            "total_a_pagar": round(total_a_pagar, 2),
            "num_aplazados_vencen": len(pagos_aplazados_vencen_este_periodo),
        },
    }
