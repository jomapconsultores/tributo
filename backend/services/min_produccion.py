"""Verificación de un RUC para la rebaja/exención de ICE.

1) Ministerio de Producción (RUM): consultaCategorizacion.jsf — dice si el RUC
   está categorizado y como qué (MICROEMPRESA, PEQUEÑA, MEDIANA, NO MIPYME…).
2) Regla de la ley (LRTI): el beneficio de ICE aplica solo si el proveedor de
   materia prima nacional es artesano, micro/pequeña/mediana empresa (MIPYME) u
   organización de la economía popular y solidaria. Una "NO MIPYME" (empresa
   grande) NO cumple aunque esté categorizada.
3) SRI: si no está categorizado (o falta el nombre), se consulta la API pública
   del SRI por RUC para obtener la razón social y el tipo de contribuyente.
"""
import re
import requests

BASE = "https://servicios.produccion.gob.ec"
CONSULTA = BASE + "/rum/publico/consultaCategorizacion.jsf"
SRI_API = ("https://srienlinea.sri.gob.ec/sri-catastro-sujeto-servicio-internet/"
           "rest/ConsolidadoContribuyente/obtenerPorNumerosRuc?ruc=")
HDRS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def _viewstate(html):
    m = re.search(r'name="javax\.faces\.ViewState"[^>]*value="([^"]+)"', html)
    return m.group(1) if m else None


def _fecha_iso(d):
    """'01/01/2024' o '01-01-2024' -> '2024-01-01'."""
    m = re.match(r"\s*(\d{1,2})[/-](\d{1,2})[/-](\d{4})", d or "")
    if m:
        return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
    return None


def cumple_ley(categoria):
    """True si la categoría del Ministerio habilita el beneficio (MIPYME/artesano/EPS).
    'NO MIPYME' (empresa grande) no cumple."""
    c = (categoria or "").upper()
    if not c:
        return False
    if "NO MIPYME" in c or "NO ES MIPYME" in c:
        return False
    return True


def consultar_sri(ruc, timeout=12):
    """Razón social y tipo de contribuyente desde la API pública del SRI."""
    try:
        r = requests.get(SRI_API + ruc, timeout=timeout, headers=HDRS)
        data = r.json()
        if isinstance(data, list) and data:
            d = data[0]
            return {
                "razon_social": d.get("razonSocial", "") or "",
                "tipo": d.get("tipoContribuyente", "") or "",
                "estado": d.get("estadoContribuyenteRuc", "") or "",
                "actividad_economica": d.get("actividadEconomicaPrincipal", "") or "",
                "regimen": d.get("regimen", "") or "",
            }
    except Exception:
        pass
    return {}


def verificar_ruc(ruc):
    ruc = (ruc or "").strip()
    if not ruc:
        return {"calificado": None, "cumple": False, "mensaje": "Ingresa un RUC."}

    res = {"calificado": None, "cumple": False, "razon_social": "", "categoria": "",
           "vigencia": "", "vigencia_inicio": None, "vigencia_fin": None,
           "tipo": "", "actividad_economica": "", "regimen": "", "estado": "",
           "fuente": "", "mensaje": ""}
    try:
        s = requests.Session()
        s.headers.update(HDRS)
        r = s.get(CONSULTA, timeout=25)
        action = re.search(r'<form[^>]*id="form"[^>]*action="([^"]+)"', r.text)
        view = _viewstate(r.text)
        if action and view:
            data = {
                "javax.faces.partial.ajax": "true",
                "javax.faces.source": "form:cmdBuscar",
                "javax.faces.partial.execute": "@all",
                "javax.faces.partial.render": "form",
                "form:cmdBuscar": "form:cmdBuscar",
                "form": "form",
                "form:ruc": ruc,
                "javax.faces.ViewState": view,
            }
            h = {"Faces-Request": "partial/ajax", "X-Requested-With": "XMLHttpRequest",
                 "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"}
            rp = s.post(BASE + action.group(1), data=data, headers=h, timeout=25)

            if "confirmacionCategorizacion.jsf?prm=" in rp.text:
                cp = s.get(BASE + "/rum/publico/confirmacionCategorizacion.jsf?prm=" + ruc, timeout=25)
                t = re.sub(r"<[^>]+>", " ", cp.text)
                t = re.sub(r"\s+", " ", t)
                rs = re.search(r"su empresa\s+(.+?)\s+esta categorizada como", t, re.I)
                cat = re.search(r"categorizada como:\s*(.+?)\s+Fecha", t, re.I)
                fi = re.search(r"Fecha inicio:\s*([0-9/\-]+)", t)
                ff = re.search(r"Fecha fin:\s*([0-9/\-]+)", t)
                categoria = cat.group(1).strip() if cat else ""
                res.update({
                    "calificado": True,
                    "categoria": categoria,
                    "razon_social": rs.group(1).strip() if rs else "",
                    "vigencia": f"{fi.group(1)} a {ff.group(1)}" if fi and ff else "",
                    "vigencia_inicio": _fecha_iso(fi.group(1)) if fi else None,
                    "vigencia_fin": _fecha_iso(ff.group(1)) if ff else None,
                    "cumple": cumple_ley(categoria),
                    "fuente": "MINISTERIO",
                })
            elif "no categorizada" in rp.text.lower():
                res.update({"calificado": False, "cumple": False, "fuente": "MINISTERIO"})
    except Exception as e:
        res["mensaje"] = "Ministerio no disponible: " + str(e)

    # SRI: siempre se consulta para traer la actividad económica (y nombre/tipo si faltan)
    sri = consultar_sri(ruc)
    if sri:
        res["actividad_economica"] = sri.get("actividad_economica", "")
        res["regimen"] = sri.get("regimen", "")
        res["estado"] = sri.get("estado", "")
        if not res["razon_social"]:
            res["razon_social"] = sri.get("razon_social", "")
            res["tipo"] = sri.get("tipo", "")
            if res["fuente"] == "":
                res["fuente"] = "SRI"

    # Mensaje resumen
    if res["calificado"] is True and res["cumple"]:
        res["mensaje"] = f"Categorizado ({res['categoria']}): cumple"
    elif res["calificado"] is True and not res["cumple"]:
        res["mensaje"] = f"Categorizado como {res['categoria']}: NO cumple (no es MIPYME)"
    elif res["calificado"] is False:
        res["mensaje"] = "No categorizado en el Ministerio (no cumple)"
    elif not res["mensaje"]:
        res["mensaje"] = "No se pudo determinar"
    return res
