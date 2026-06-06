"""Verificación de categorización de un RUC en el Ministerio de Producción (RUM).
Consulta https://servicios.produccion.gob.ec/rum/publico/consultaCategorizacion.jsf
(formulario JSF, sin CAPTCHA). Si la empresa está categorizada redirige a la
página de confirmación con la razón social y la categoría; si no, devuelve un
mensaje "Empresa no categorizada"."""
import re
import requests

BASE = "https://servicios.produccion.gob.ec"
CONSULTA = BASE + "/rum/publico/consultaCategorizacion.jsf"
HDRS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def _viewstate(html):
    m = re.search(r'name="javax\.faces\.ViewState"[^>]*value="([^"]+)"', html)
    return m.group(1) if m else None


def verificar_ruc(ruc):
    ruc = (ruc or "").strip()
    if not ruc:
        return {"calificado": None, "mensaje": "Ingresa un RUC."}
    try:
        s = requests.Session()
        s.headers.update(HDRS)
        r = s.get(CONSULTA, timeout=25)
        action = re.search(r'<form[^>]*id="form"[^>]*action="([^"]+)"', r.text)
        view = _viewstate(r.text)
        if not action or not view:
            return {"calificado": None, "mensaje": "No se pudo abrir la consulta del Ministerio."}
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
            return {
                "calificado": True,
                "razon_social": rs.group(1).strip() if rs else "",
                "categoria": cat.group(1).strip() if cat else "",
                "vigencia": f"{fi.group(1)} a {ff.group(1)}" if fi and ff else "",
                "mensaje": "Empresa categorizada",
            }
        if "no categorizada" in rp.text.lower():
            return {"calificado": False, "mensaje": "Empresa no categorizada"}
        return {"calificado": None, "mensaje": "No se pudo determinar (verifica manualmente)."}
    except Exception as e:
        return {"calificado": None, "mensaje": "No se pudo consultar: " + str(e)}
