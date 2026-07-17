"""Cálculo de declaraciones (código SRI → valor) a partir de los datos cargados.
IVA = Formulario 104; ICE = Formulario ICE. Los mapeos de código son los
campos estándar del SRI; el contador debe verificarlos antes de presentar."""
from services.ice_calc import resumen_general as ice_audit_general, resumen_por_producto as ice_por_producto, audit_detail as ice_audit_detail
from services.ice_data import tax_params
import unicodedata
from services.xml_parser import GASTOS_PERSONALES


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _norm_cat(s):
    """Categoría en MAYÚSCULAS y SIN tildes, igual que el frontend
    (utils/categorias.js) y export_service. La categoría se guarda como texto
    libre con solo .upper() (routers/classification.py, invoices.py), así que
    'EDUCACION' sin tilde debe reconocerse igual que 'EDUCACIÓN'."""
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode("ascii")
    return s.upper()


_GASTOS_PERSONALES_NORM = {_norm_cat(c) for c in GASTOS_PERSONALES}


def _es_personal(inv):
    return _norm_cat(inv.get("clasificacion")) in _GASTOS_PERSONALES_NORM


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
                    diferir_meses=0,
                    override_ventas_15=None, override_ventas_5=None, override_ventas_0=None,
                    factor_prop=None, retenciones_iva_agente=None):
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

    Retenciones de IVA EFECTUADAS como agente de retención (retenciones_iva_agente,
    tabla retenciones_efectuadas): el cliente retuvo IVA a SUS proveedores. Esto es
    una obligación (dinero que debe entregar al SRI), no un crédito — se SUMA al
    IVA a pagar, no se resta. Se agrupa por porc_iva en los casilleros oficiales
    de la sección "Agente de retención del IVA" del Formulario 104 (Resolución
    NAC-DGERCGC20-00000061, reformada por NAC-DGERCGC23-00000026): 721=10%,
    723=20%, 725=30%, 727=50%, 729=70%, 731=100%; total 799; total a pagar por
    retención 801; total consolidado 859 (= 699 + 801).

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
    if retenciones_iva_agente is None:
        retenciones_iva_agente = []

    invoices = [i for i in invoices if (i.get("estado") or "OK") == "OK"]
    ejercicio = [i for i in invoices if not _es_personal(i)]
    personales_excluidos = sum(1 for i in invoices if _es_personal(i))

    # ── Compras del EJERCICIO (con derecho a crédito) ────────────────────
    c_base_15, c_n_base_15 = _agg(ejercicio, "base_15")
    c_iva_15, _            = _agg(ejercicio, "iva_15")
    c_base_8, c_n_base_8   = _agg(ejercicio, "base_8")
    c_iva_8, _             = _agg(ejercicio, "iva_8")
    c_base_5, c_n_base_5   = _agg(ejercicio, "base_5")
    c_iva_5, _             = _agg(ejercicio, "iva_5")
    c_base_0, c_n_base_0   = _agg(ejercicio, "base_0")
    c_no_obj, c_n_no_obj   = _agg(ejercicio, "no_objeto_iva")
    c_exento, c_n_exento   = _agg(ejercicio, "exento_iva")
    iva_compras = c_iva_15 + c_iva_5 + c_iva_8  # crédito tributario del período actual

    # ── Ventas con ICE (tabla ice_sales) ─────────────────────────────────
    v_ice_solo_ok = [v for v in ventas_ice if (v.get("estado") or "OK") == "OK"]
    v_ice_base_15 = sum(_f(v.get("base_iva")) for v in v_ice_solo_ok)
    v_ice_iva_15  = sum(_f(v.get("valor_iva")) for v in v_ice_solo_ok)
    # Número de FACTURAS (comprobantes distintos), no de líneas: la tabla ice_sales tiene
    # una fila por producto; el unique_id es 'claveAcceso-linea', así que la factura es la
    # clave (todo antes del último '-').
    n_ventas_ice  = len({
        str(v.get("unique_id") or "").rsplit("-", 1)[0]
        for v in v_ice_solo_ok
        if _f(v.get("base_iva")) > 0 or _f(v.get("valor_iva")) > 0
    })
    # Total de facturas ICE (comprobantes distintos) SIN el filtro de valor > 0.
    n_ventas_ice_total = len({
        str(v.get("unique_id") or "").rsplit("-", 1)[0] for v in v_ice_solo_ok
    })

    # ── Ventas sin ICE (tabla sales_iva) ─────────────────────────────────
    v_iva_solo_ok = [v for v in ventas_iva if (v.get("estado") or "OK") == "OK"]
    v_base_15, v_n_base_15 = _agg(v_iva_solo_ok, "base_15")
    v_iva_15,  _           = _agg(v_iva_solo_ok, "iva_15")
    v_base_8,  v_n_base_8  = _agg(v_iva_solo_ok, "base_8")
    v_iva_8,   _           = _agg(v_iva_solo_ok, "iva_8")
    v_base_5,  v_n_base_5  = _agg(v_iva_solo_ok, "base_5")
    v_iva_5,   _           = _agg(v_iva_solo_ok, "iva_5")
    v_base_0,  v_n_base_0  = _agg(v_iva_solo_ok, "base_0")
    v_no_obj,  v_n_no_obj  = _agg(v_iva_solo_ok, "no_objeto_iva")
    v_exento,  v_n_exento  = _agg(v_iva_solo_ok, "exento_iva")

    # ── Totales de ventas ────────────────────────────────────────────────
    t_base_15 = v_ice_base_15 + v_base_15      # 411
    t_iva_15  = v_ice_iva_15 + v_iva_15        # 421
    t_base_8  = v_base_8                       # tarifa especial 8%
    t_iva_8   = v_iva_8
    t_base_5  = v_base_5                       # 412
    t_iva_5   = v_iva_5                        # 422
    t_base_0  = v_base_0                       # 413
    t_exento  = v_exento                       # 414
    t_no_obj  = v_no_obj                       # 415
    iva_ventas = t_iva_15 + t_iva_5 + t_iva_8

    # ── Override manual de ventas (cuando no se tienen los XML) ───────────
    # Si el usuario ingresa la base de ventas a mano, esta REEMPLAZA el valor
    # de la casilla y el IVA se recalcula (15% / 5%). Todo el resultado
    # (causado, crédito, a pagar) fluye luego con estos totales.
    ventas_manual = any(x is not None for x in (override_ventas_15, override_ventas_5, override_ventas_0))
    if override_ventas_15 is not None:
        t_base_15 = _f(override_ventas_15)
        t_iva_15 = round(t_base_15 * 0.15, 2)
    if override_ventas_5 is not None:
        t_base_5 = _f(override_ventas_5)
        t_iva_5 = round(t_base_5 * 0.05, 2)
    if override_ventas_0 is not None:
        t_base_0 = _f(override_ventas_0)
    iva_ventas = t_iva_15 + t_iva_5 + t_iva_8

    # ── Retenciones del período (609) ────────────────────────────────────
    # Suma de ret_iva de la tabla retentions del cliente en el período.
    ret_ok = [r for r in retentions if (r.get("estado") or "OK") == "OK"]
    ret_iva_periodo = sum(_f(r.get("ret_iva")) for r in ret_ok)
    n_retenciones = sum(1 for r in ret_ok if _f(r.get("ret_iva")) > 0)

    # ── IVA retenido a proveedores como AGENTE de retención ──────────────
    # Obligación a pagar al SRI (no es crédito): sección "AGENTE DE RETENCIÓN
    # DEL IVA" del Formulario 104 (Resolución NAC-DGERCGC20-00000061, reformada
    # por NAC-DGERCGC23-00000026) — casilleros 721(10%)/723(20%)/725(30%)/
    # 727(50%)/729(70%)/731(100%), total 799, total a pagar por retención 801.
    # Se agrupa por porcentaje real de la resolución (no solo 30/70/100).
    ref_ok = [r for r in retenciones_iva_agente if (r.get("estado") or "OK") == "OK" and _f(r.get("ret_iva")) > 0]
    RIA_CASILLERO = {10: "721", 20: "723", 30: "725", 50: "727", 70: "729", 100: "731"}
    ref_buckets = {pct: [] for pct in RIA_CASILLERO}
    for r in ref_ok:
        pct = round(_f(r.get("porc_iva")))
        ref_buckets.setdefault(pct, []).append(r)
    ret_iva_agente_total = sum(_f(r.get("ret_iva")) for r in ref_ok)

    # ── Factor de proporcionalidad del crédito tributario ────────────────
    # Es la RELACIÓN entre los ingresos con tarifa 15% (que dan derecho a
    # crédito) y el total 15% + 0%. Solo esa proporción del IVA de compras es
    # crédito tributario; el resto NO es acreditable (va al gasto).
    #   factor = (ventas 15% + 5%) / (ventas 15% + 5% + ventas 0%)
    # SIN VENTAS en el período: el factor es 0 → NO se genera crédito tributario
    # (el IVA de compras va al gasto). Si en un caso se requiere el crédito, el
    # usuario puede fijar el factor a mano (override factor_prop).
    ventas_gravadas = t_base_15 + t_base_5 + t_base_8   # tarifa distinta de cero (dan derecho)
    ventas_factor_total = ventas_gravadas + t_base_0  # gravadas + tarifa 0%
    if factor_prop is not None:
        factor = max(0.0, min(1.0, _f(factor_prop)))
    elif ventas_factor_total > 0:
        factor = ventas_gravadas / ventas_factor_total
    else:
        factor = 0.0   # sin ventas → no hay derecho a crédito tributario
    factor = round(factor, 4)
    credito_adq_aplicable = round(iva_compras * factor, 2)          # 564 (con derecho)
    iva_no_acreditable = round(iva_compras - credito_adq_aplicable, 2)  # al costo/gasto

    # ── Aplazamiento (Art. 67 LRTI) ──────────────────────────────────────
    # 481 = ventas con cobro diferido; 484 = su IVA (no se causa hoy).
    diferir_meses = max(0, min(3, int(diferir_meses or 0)))
    if diferir_meses > 0:
        iva_diferido_actual = iva_ventas
        ventas_diferidas_monto = t_base_15 + t_base_5
    else:
        iva_diferido_actual = 0.0
        ventas_diferidas_monto = 0.0
    # 480 = IVA diferido de meses anteriores que VENCE este período (entra al causado)
    iva_recibido_aplazado = sum(_f(p.get("monto")) for p in pagos_aplazados_vencen_este_periodo)
    monto_aplazados_que_vencen = iva_recibido_aplazado

    # ── Liquidación (formulario 104) ─────────────────────────────────────
    # IVA generado del período (429), ajustado por aplazamientos.
    iva_generado_periodo = iva_ventas + iva_recibido_aplazado - iva_diferido_actual

    # 601 Impuesto causado  vs  602 Crédito del período por adquisiciones.
    diferencia = iva_generado_periodo - credito_adq_aplicable
    impuesto_causado = max(0.0, diferencia)          # 601
    credito_periodo_adq = max(0.0, -diferencia)      # 602

    # Créditos SEPARADOS por tipo (no se mezclan):
    #  · ADQUISICIONES: crédito del período (602) + saldo mes anterior (605)
    #  · RETENCIONES:   saldo mes anterior (607) + retenciones del período (609)
    credito_adq_disp = credito_periodo_adq + _f(credito_mes_anterior_adquisiciones)
    credito_ret_disp = _f(credito_mes_anterior_retenciones) + ret_iva_periodo

    # Se aplican al impuesto causado: primero adquisiciones, luego retenciones.
    causado_rest = impuesto_causado
    usa_adq = min(causado_rest, credito_adq_disp); causado_rest -= usa_adq
    sobra_adq = credito_adq_disp - usa_adq
    usa_ret = min(causado_rest, credito_ret_disp); causado_rest -= usa_ret
    sobra_ret = credito_ret_disp - usa_ret

    iva_a_pagar = round(causado_rest, 2)                 # 619 (equivale a 699 si hay agente de retención)
    credito_proximo_adq = round(sobra_adq, 2)            # 695 (próx. mes por adquisiciones)
    credito_proximo_ret = round(sobra_ret, 2)            # 697 (próx. mes por retenciones)
    saldo_a_favor = round(credito_proximo_adq + credito_proximo_ret, 2)
    total_a_pagar = round(iva_a_pagar + ret_iva_agente_total, 2)
    # Compat con el resto del sistema
    impuesto_causado_neto = round(iva_generado_periodo - credito_adq_aplicable, 2)
    credito_total = round(credito_adq_disp + credito_ret_disp, 2)

    def fila(seccion, codigo, concepto, valor, n=None):
        f = {"seccion": seccion, "codigo": codigo, "concepto": concepto, "valor": round(valor, 2)}
        if n is not None:
            f["num_comprobantes"] = n
        return f

    # Conteo de comprobantes: no aplica cuando la base se ingresó a mano.
    n411 = None if override_ventas_15 is not None else (n_ventas_ice + v_n_base_15)
    n412 = None if override_ventas_5 is not None else v_n_base_5
    n413 = None if override_ventas_0 is not None else v_n_base_0

    filas = [
        # ── VENTAS ──
        fila("VENTAS", "411", "Ventas locales gravadas 15% (valor neto, ICE+IVA incluido)", t_base_15, n411),
        fila("VENTAS", "412", "Ventas locales gravadas 5% (valor neto)", t_base_5, n412),
        *([fila("VENTAS", "411-8", "Ventas locales gravadas 8% — tarifa especial (verificar casillero oficial)", t_base_8, v_n_base_8)] if (t_base_8 or t_iva_8) else []),
        fila("VENTAS", "413", "Ventas locales con tarifa 0%", t_base_0, n413),
        fila("VENTAS", "414", "Ventas exentas de IVA", t_exento, v_n_exento),
        fila("VENTAS", "415", "Ventas no objeto del IVA", t_no_obj, v_n_no_obj),
        fila("VENTAS", "421", "IVA generado en ventas 15%", t_iva_15),
        fila("VENTAS", "422", "IVA generado en ventas 5%", t_iva_5),
        *([fila("VENTAS", "421-8", "IVA generado en ventas 8% (tarifa especial)", t_iva_8)] if (t_base_8 or t_iva_8) else []),

        # ── ADQUISICIONES ──
        fila("ADQUISICIONES", "510", "Adquisiciones gravadas 15% con derecho a crédito (valor neto)", c_base_15, c_n_base_15),
        fila("ADQUISICIONES", "520", "IVA en adquisiciones 15%", c_iva_15),
        fila("ADQUISICIONES", "550", "Adquisiciones gravadas 5% con derecho a crédito (valor neto)", c_base_5, c_n_base_5),
        fila("ADQUISICIONES", "560", "IVA en adquisiciones 5%", c_iva_5),
        *([fila("ADQUISICIONES", "510-8", "Adquisiciones gravadas 8% — tarifa especial (verificar casillero oficial)", c_base_8, c_n_base_8)] if (c_base_8 or c_iva_8) else []),
        *([fila("ADQUISICIONES", "520-8", "IVA en adquisiciones 8%", c_iva_8)] if (c_base_8 or c_iva_8) else []),
        fila("ADQUISICIONES", "517", "Adquisiciones y pagos gravados tarifa 0%", c_base_0, c_n_base_0),
        fila("ADQUISICIONES", "518", "Adquisiciones no objeto del IVA", c_no_obj, c_n_no_obj),
        fila("ADQUISICIONES", "519", "Adquisiciones exentas de IVA", c_exento, c_n_exento),

        # ── RESULTADO ──
        fila("RESULTADO", "429", "IVA generado en ventas (421+422)", iva_ventas),
    ]
    # Aplazamientos que afectan el IVA generado del período
    if iva_recibido_aplazado > 0:
        filas.append(fila("RESULTADO", "480", "(+) IVA diferido de períodos anteriores que vence ahora",
                          iva_recibido_aplazado, len(pagos_aplazados_vencen_este_periodo)))
    if diferir_meses > 0:
        filas.append(fila("RESULTADO", "481", f"Ventas con cobro diferido (plazo > {diferir_meses} mes{'es' if diferir_meses > 1 else ''})",
                          ventas_diferidas_monto, v_n_base_15 + v_n_base_5 + n_ventas_ice))
        filas.append(fila("RESULTADO", "484", "(−) IVA correspondiente al 481 (no se causa este período)",
                          iva_diferido_actual))

    # Factor de proporcionalidad y crédito por adquisiciones
    filas.append(fila("RESULTADO", "563", f"Factor de proporcionalidad — (ventas 15% + 5%) / (15% + 5% + 0%) ({factor:.2%})", round(factor, 4)))
    filas.append(fila("RESULTADO", "564", "Crédito tributario aplicable en este período (IVA compras × factor)",
                      credito_adq_aplicable, c_n_base_15 + c_n_base_5))
    if iva_no_acreditable > 0:
        filas.append(fila("RESULTADO", "565", "IVA NO considerado crédito tributario por el factor de proporcionalidad (al gasto)", iva_no_acreditable))

    # Impuesto causado / crédito del período
    filas.append(fila("RESULTADO", "601", "Impuesto causado (IVA generado − crédito por adquisiciones)", impuesto_causado))
    if credito_periodo_adq > 0:
        filas.append(fila("RESULTADO", "602", "Crédito tributario del período por adquisiciones (a favor)", credito_periodo_adq))

    # Créditos que se restan del impuesto causado — SEPARADOS por tipo (casilleros oficiales 605/606/609)
    filas.extend([
        fila("RESULTADO", "605", "(−) Saldo crédito tributario mes anterior por ADQUISICIONES (editable)", _f(credito_mes_anterior_adquisiciones)),
        fila("RESULTADO", "606", "(−) Saldo crédito tributario mes anterior por RETENCIONES (editable)", _f(credito_mes_anterior_retenciones)),
        fila("RESULTADO", "609", "(−) Retenciones de IVA que le efectuaron en el período", ret_iva_periodo, n_retenciones),
    ])

    filas.append(fila("RESULTADO", "620", "SUBTOTAL A PAGAR (impuesto causado − créditos)", iva_a_pagar))
    # Arrastre al próximo mes — SEPARADO adquisiciones (615) vs retenciones (617)
    if credito_proximo_adq > 0:
        filas.append(fila("RESULTADO", "615", "✓ Saldo crédito tributario próximo mes por ADQUISICIONES", credito_proximo_adq))
    if credito_proximo_ret > 0:
        filas.append(fila("RESULTADO", "617", "✓ Saldo crédito tributario próximo mes por RETENCIONES", credito_proximo_ret))

    # ── IVA retenido a proveedores como AGENTE de retención ──────────────
    # Obligación adicional (NO es crédito): se suma al total a pagar, no se
    # compensa con el saldo a favor de adquisiciones/retenciones anterior.
    if ref_ok:
        for pct, cod in RIA_CASILLERO.items():
            filas_pct = ref_buckets.get(pct) or []
            if not filas_pct:
                continue
            ret_pct = sum(_f(r.get("ret_iva")) for r in filas_pct)
            filas.append(fila("AGENTE DE RETENCIÓN DEL IVA",
                              cod, f"Retención del {pct}%", ret_pct, len(filas_pct)))
        filas.append(fila("AGENTE DE RETENCIÓN DEL IVA", "799",
                          "TOTAL IMPUESTO RETENIDO (721+723+725+727+729+731)", ret_iva_agente_total, len(ref_ok)))
        filas.append(fila("AGENTE DE RETENCIÓN DEL IVA", "801",
                          "TOTAL IMPUESTO A PAGAR POR RETENCIÓN", ret_iva_agente_total, len(ref_ok)))
        filas.append(fila("RESULTADO", "859", "TOTAL CONSOLIDADO DE IVA (699 + 801)", total_a_pagar))

    return {
        "tipo": "IVA",
        "filas": filas,
        "resumen": {
            "iva_ventas": round(iva_ventas, 2),
            # Bases de ventas (para edición manual cuando no hay XML)
            "ventas_15": round(t_base_15, 2),
            "ventas_5": round(t_base_5, 2),
            "ventas_0": round(t_base_0, 2),
            "ventas_8": round(t_base_8, 2),
            "iva_ventas_15": round(t_iva_15, 2),
            "iva_ventas_5": round(t_iva_5, 2),
            "iva_ventas_8": round(t_iva_8, 2),
            "ventas_manual": ventas_manual,
            "iva_compras": round(iva_compras, 2),
            # Factor de proporcionalidad y crédito acreditable
            "factor_proporcionalidad": factor,
            "credito_adq_aplicable": round(credito_adq_aplicable, 2),
            "iva_no_acreditable": round(iva_no_acreditable, 2),
            "impuesto_causado": round(impuesto_causado, 2),
            "credito_periodo_adquisiciones": round(credito_periodo_adq, 2),
            "credito_mes_anterior_adquisiciones": round(_f(credito_mes_anterior_adquisiciones), 2),
            "credito_mes_anterior_retenciones": round(_f(credito_mes_anterior_retenciones), 2),
            "ret_iva_periodo": round(ret_iva_periodo, 2),
            "credito_total": round(credito_total, 2),
            "impuesto_causado_neto": round(impuesto_causado_neto, 2),
            "iva_a_pagar": round(iva_a_pagar, 2),
            # Arrastre al próximo mes SEPARADO por tipo de crédito
            "credito_proximo_mes_adquisiciones": round(credito_proximo_adq, 2),
            "credito_proximo_mes_retenciones": round(credito_proximo_ret, 2),
            "saldo_a_favor_proximo_mes": round(saldo_a_favor, 2),
            "monto_aplazados_vencen": round(monto_aplazados_que_vencen, 2),
            "ret_iva_agente_total": round(ret_iva_agente_total, 2),
            "num_retenciones_iva_agente": len(ref_ok),
            "total_a_pagar": round(total_a_pagar, 2),
            "diferir_meses": diferir_meses,
            "iva_diferido_actual": round(iva_diferido_actual, 2),
            "ventas_diferidas_monto": round(ventas_diferidas_monto, 2),
            "num_facturas_ejercicio": len(ejercicio),
            "num_facturas_personales_excluidas": personales_excluidos,
            # TOTAL de compras cargadas del período (incluye las personales excluidas
            # del ejercicio). El "parcial" (num_facturas_ejercicio) son las que entran
            # a la declaración; este total es todo lo cargado (estado OK).
            "num_facturas_compras_total": len(invoices),
            "num_ventas_ice": n_ventas_ice,
            "num_ventas_iva_solo": len(v_iva_solo_ok),
            # TOTAL de ventas/ingresos cargados (ICE con y sin valor + IVA sin ICE).
            "num_ventas_total": n_ventas_ice_total + len(v_iva_solo_ok),
            "num_retenciones_periodo": n_retenciones,
            "num_aplazados_vencen": len(pagos_aplazados_vencen_este_periodo),
        },
    }


def declaracion_ice(ice_rows, anio, pagos_aplazados_vencen_este_periodo=None,
                    rebajas_productos=None, override_rebaja=None, override_exencion=None,
                    marcar_rebaja=False, marcar_exencion=False):
    """Formulario ICE para bebidas alcohólicas (SRI).
    - ICE específico: tarifa por litro de alcohol puro × litros de alcohol puro.
    - ICE ad valorem: 75% del exceso del precio/litro sobre el umbral.

    Rebajas y exenciones según LRTI y su Reglamento:
    - REBAJA (Art. 82 LRTI / Art. 199.5 RLRTI): 50% de la tarifa específica para
      bebidas con ≥70% de ingredientes nacionales (sin contar agua) de
      artesanos/MIPYME/EPS. Para CERVEZAS solo aplica a NUEVAS MARCAS.
    - EXENCIÓN (Art. 77.1 LRTI / Art. 199.4 RLRTI): mismas condiciones de la
      rebaja + cupo anual del SRI; se aplica por producto sobre el ICE calculado
      sin beneficio alguno (un producto exento no recibe además la rebaja).

    `rebajas_productos` viene del módulo Rebajas y exenciones:
    {PRODUCTO: {pct, cumple, es_cerveza, nueva_marca, cupo_anual_sri}}.

    Aplicación manual (con advertencia en resumen["advertencias"]):
    - `marcar_rebaja` / `marcar_exencion`: casillas "aplica" sin cálculo del
      módulo → rebaja = 50% del específico total; exención = ICE restante.
    - `override_rebaja` / `override_exencion`: montos escritos a mano (tienen
      prioridad sobre las casillas y sobre el cálculo automático).

    Aplazamientos: ICE permite hasta 1 mes adicional cuando hay compras a crédito
    de procesos productivos (regla SRI). Si hay aplazamientos vencidos este
    período, se suman al casillero 902 (a pagar)."""
    if pagos_aplazados_vencen_este_periodo is None:
        pagos_aplazados_vencen_este_periodo = []

    # audit_detail se calcula UNA sola vez y se reutiliza en resumen_general y
    # resumen_por_producto (antes cada uno lo recalculaba por su cuenta: 2-3
    # pasadas completas sobre las mismas filas).
    det = ice_audit_detail(ice_rows, anio)
    g = ice_audit_general(ice_rows, anio, det=det)
    tax = tax_params(anio)
    esp = tax.get("esp", 0.0)
    # Base imponible ad valorem (303): SOLO las ventas cuyo precio por litro
    # supera el umbral (si ninguna cumple, el casillero queda en 0)
    base = sum(_f(d.get("subtotal")) for d in det if d.get("aplica_adv"))
    # El ICE a declarar = el FACTURADO (lo que consta en las facturas, suma de valor_ice),
    # para que la declaración COINCIDA con las facturas. El ad-valorem se toma de la auditoría
    # y el específico = facturado − ad-valorem. El volumen (litros de alcohol puro, casilla
    # 314) se deriva del específico para que cuadre 314 × 315 = 319.
    ice_adv = g.get("ice_advalorem", 0.0)
    ice_facturado = sum(
        _f(r.get("valor_ice")) for r in ice_rows if (r.get("estado") or "OK") == "OK"
    )
    ice_esp = round(ice_facturado - ice_adv, 2)
    total_ice = round(ice_facturado, 2)
    litros_alcohol = round(ice_esp / esp, 4) if esp else 0.0

    # ── Rebaja y exención por producto (módulo Rebajas y exenciones) ─────
    # Elegibilidad según la normativa:
    #  - rebaja: cumple ≥70% nacional Y (no es cerveza O es nueva marca)
    #  - exención: lo anterior Y cupo anual del SRI (Art. 199.4 RLRTI)
    rebajas_productos = rebajas_productos or {}
    cumplen = {p: d for p, d in rebajas_productos.items() if d.get("cumple")}
    productos_con_rebaja = []
    productos_exentos = []
    rebaja_auto = 0.0
    exencion_auto = 0.0
    if cumplen:
        for fp in ice_por_producto(ice_rows, anio, det=det):
            nombre = (fp.get("producto") or "").upper().strip()
            for p, d in cumplen.items():
                pn = p.upper().strip()
                if not (pn and nombre and (pn in nombre or nombre in pn)):
                    continue
                marca_ok = (not d.get("es_cerveza")) or d.get("nueva_marca")
                if not marca_ok:  # cerveza sin nueva marca: sin beneficio (Art. 199.5)
                    break
                if d.get("cupo_anual_sri"):
                    # Exención por producto, sobre su ICE sin beneficio alguno
                    exencion_auto += _f(fp.get("total_ice"))
                    productos_exentos.append({"producto": fp.get("producto"),
                                              "pct": round(_f(d.get("pct")), 2)})
                else:
                    rebaja_auto += 0.5 * _f(fp.get("ice_especifico"))
                    productos_con_rebaja.append({"producto": fp.get("producto"),
                                                 "pct": round(_f(d.get("pct")), 2)})
                break
    rebaja_auto = round(min(rebaja_auto, ice_esp * 0.5), 2)
    exencion_auto = round(min(exencion_auto, total_ice), 2)

    # Prioridad: monto manual (override) > casilla "aplica" (marcar_*) > automático
    advertencias = []
    if override_rebaja is not None:
        rebaja = _f(override_rebaja)
        advertencias.append("⚠ Rebaja ingresada manualmente: el valor no está determinado "
                            "con el cálculo correspondiente (Art. 82 LRTI / Art. 199.5 RLRTI). "
                            "Verifique los requisitos antes de declarar.")
    elif marcar_rebaja:
        rebaja = 0.5 * ice_esp
        advertencias.append("⚠ Rebaja aplicada por casilla manual (50% de la tarifa específica "
                            "total): el valor no está determinado con el cálculo correspondiente "
                            "del módulo Rebajas y exenciones (Art. 82 LRTI / Art. 199.5 RLRTI — "
                            "≥70% de ingredientes nacionales de artesanos/MIPYME/EPS; cervezas "
                            "solo nuevas marcas). Verifique los requisitos antes de declarar.")
    else:
        rebaja = rebaja_auto

    if override_exencion is not None:
        exencion = _f(override_exencion)
        advertencias.append("⚠ Exención ingresada manualmente: el valor no está determinado "
                            "con el cálculo correspondiente (Art. 77.1 LRTI / Art. 199.4 RLRTI). "
                            "Verifique el cupo anual del SRI antes de declarar.")
    elif marcar_exencion:
        exencion = max(0.0, total_ice - max(0.0, min(rebaja, total_ice)))
        advertencias.append("⚠ Exención aplicada por casilla manual (ICE restante del período): "
                            "el valor no está determinado con el cálculo correspondiente del "
                            "módulo Rebajas y exenciones (Art. 77.1 LRTI / Art. 199.4 RLRTI — "
                            "requiere cupo anual del SRI, ≥70% de ingredientes nacionales y, en "
                            "cervezas, nueva marca). Verifique los requisitos antes de declarar.")
    else:
        exencion = exencion_auto

    rebaja = max(0.0, min(rebaja, total_ice))
    exencion = max(0.0, min(exencion, total_ice - rebaja))
    ice_neto = max(0.0, total_ice - rebaja - exencion)

    monto_aplazados_que_vencen = sum(_f(p.get("monto")) for p in pagos_aplazados_vencen_este_periodo)
    total_a_pagar = ice_neto + monto_aplazados_que_vencen

    filas = [
        {"seccion": "AD VALOREM", "codigo": "303", "concepto": "Base imponible ad valorem (solo ventas con precio/litro sobre el umbral; 0 si ninguna)", "valor": round(base, 2)},
        {"seccion": "AD VALOREM", "codigo": "305", "concepto": "Porcentaje tarifa ad valorem", "valor": 0.75},
        {"seccion": "AD VALOREM", "codigo": "309", "concepto": "ICE causado ad valorem", "valor": round(ice_adv, 2)},
        {"seccion": "ESPECÍFICO", "codigo": "314", "concepto": "Volumen neto (litros de alcohol puro)", "valor": round(litros_alcohol, 4)},
        {"seccion": "ESPECÍFICO", "codigo": "315", "concepto": "Tarifa específica (por litro de alcohol puro)", "valor": round(esp, 2)},
        {"seccion": "ESPECÍFICO", "codigo": "319", "concepto": "ICE causado específico", "valor": round(ice_esp, 2)},
        {"seccion": "RESULTADO", "codigo": "399", "concepto": "TOTAL ICE CAUSADO", "valor": round(total_ice, 2)},
        {"seccion": "RESULTADO", "codigo": "R-50",
         "concepto": "(−) Rebaja tarifa específica 50% — Art. 82 LRTI / Art. 199.5 RLRTI"
                     + (" · ingresada manualmente (verificar)" if override_rebaja is not None
                        else " · casilla manual (verificar)" if marcar_rebaja
                        else (" · " + ", ".join(f"{x['producto']} ({x['pct']}%)" for x in productos_con_rebaja)
                              if productos_con_rebaja else "")),
         "valor": round(rebaja, 2)},
        {"seccion": "RESULTADO", "codigo": "EXE",
         "concepto": "(−) Exención — Art. 77.1 LRTI / Art. 199.4 RLRTI"
                     + (" · ingresada manualmente (verificar)" if override_exencion is not None
                        else " · casilla manual (verificar)" if marcar_exencion
                        else (" · " + ", ".join(f"{x['producto']} ({x['pct']}%)" for x in productos_exentos)
                              if productos_exentos else "")),
         "valor": round(exencion, 2)},
        {"seccion": "RESULTADO", "codigo": "499", "concepto": "TOTAL ICE A PAGAR (399 − rebajas − exenciones)", "valor": round(ice_neto, 2)},
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
            "rebaja_ice": round(rebaja, 2),
            "exencion_ice": round(exencion, 2),
            "rebaja_ice_auto": round(rebaja_auto, 2),
            "exencion_ice_auto": round(exencion_auto, 2),
            "rebaja_origen": ("manual" if override_rebaja is not None
                              else "casilla" if marcar_rebaja else "auto"),
            "exencion_origen": ("manual" if override_exencion is not None
                                else "casilla" if marcar_exencion else "auto"),
            "productos_con_rebaja": productos_con_rebaja,
            "productos_exentos": productos_exentos,
            "advertencias": advertencias,
            "ice_a_pagar": round(ice_neto, 2),  # alias para que la UI detecte hayMontoAPagar
            "monto_aplazados_vencen": round(monto_aplazados_que_vencen, 2),
            "total_a_pagar": round(total_a_pagar, 2),
            "num_aplazados_vencen": len(pagos_aplazados_vencen_este_periodo),
            "num_registros": len([r for r in ice_rows if (r.get("estado") or "OK") == "OK"]),
        },
    }


def declaracion_103(rows, anio, mes):
    """Formulario 103 — Retenciones en la Fuente del Impuesto a la Renta.

    El cliente actúa como AGENTE de retención hacia sus propios proveedores
    (tabla retenciones_efectuadas). Se agrupa por concepto_renta (etiqueta del
    catálogo de conceptos, ver routers/retenciones_efectuadas.py::CONCEPTOS_RENTA)
    — el contador debe verificar el casillero exacto por concepto (303, 304, 307...)
    antes de presentar, igual que ya se advierte para ICE, porque el instructivo
    disponible del SRI es anterior a la reforma de tramos de la Resolución
    NAC-DGERCGC26-00000009 (vigente desde 1-mar-2026) y no garantiza que el SRI
    no haya reordenado casilleros por concepto. Los TOTALES estructurales (349,
    399, 499) sí están verificados contra el instructivo oficial y una
    declaración F103 real."""
    ok = [r for r in rows if (r.get("estado") or "OK") == "OK" and _f(r.get("ret_renta")) > 0]

    por_concepto = {}
    orden = []
    for r in ok:
        concepto = (r.get("concepto_renta") or "").strip() or "Sin concepto especificado"
        if concepto not in por_concepto:
            por_concepto[concepto] = {"base": 0.0, "ret": 0.0, "n": 0}
            orden.append(concepto)
        por_concepto[concepto]["base"] += _f(r.get("base_renta"))
        por_concepto[concepto]["ret"] += _f(r.get("ret_renta"))
        por_concepto[concepto]["n"] += 1

    total_base = sum(_f(r.get("base_renta")) for r in ok)
    total_ret = sum(_f(r.get("ret_renta")) for r in ok)

    def fila(seccion, codigo, concepto, valor, n=None):
        f = {"seccion": seccion, "codigo": codigo, "concepto": concepto, "valor": round(valor, 2)}
        if n is not None:
            f["num_comprobantes"] = n
        return f

    filas = []
    for i, concepto in enumerate(orden, start=1):
        d = por_concepto[concepto]
        filas.append(fila("RETENCIONES EN LA FUENTE DE IMPUESTO A LA RENTA",
                          f"RF-{i}", f"Base imponible — {concepto}", d["base"], d["n"]))
        filas.append(fila("RETENCIONES EN LA FUENTE DE IMPUESTO A LA RENTA",
                          f"RF-{i}-R", f"Retenido — {concepto}", d["ret"], d["n"]))
    filas.append(fila("RESULTADO", "349", "SUBTOTAL base imponible, operaciones en el país", total_base, len(ok)))
    filas.append(fila("RESULTADO", "499", "TOTAL DE RETENCIÓN DEL IMPUESTO A LA RENTA (399+498)", total_ret, len(ok)))

    return {
        "tipo": "103",
        "filas": filas,
        "resumen": {
            "total_base_renta": round(total_base, 2),
            "total_ret_renta": round(total_ret, 2),
            "total_a_pagar": round(total_ret, 2),
            "num_comprobantes": len(ok),
            "por_concepto": [
                {"concepto": c, "base": round(por_concepto[c]["base"], 2),
                 "retenido": round(por_concepto[c]["ret"], 2), "num_comprobantes": por_concepto[c]["n"]}
                for c in orden
            ],
        },
    }
