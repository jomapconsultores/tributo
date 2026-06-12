"""Consulta de datos básicos de un RUC/cédula en la API pública del SRI
(catastro de contribuyentes): razón social, estado, actividad económica,
régimen y obligaciones (contabilidad, agente de retención, especial)."""
import requests

BASE = "https://srienlinea.sri.gob.ec/sri-catastro-sujeto-servicio-internet/rest"
HDRS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def _si_no(v):
    return str(v).strip().upper() in ("SI", "SÍ", "S", "TRUE", "1")


def consultar_ruc(ruc):
    ruc = (ruc or "").strip()
    if len(ruc) < 10 or not ruc.isdigit():
        return {"ok": False, "error": "Ingresa un RUC (13 dígitos) o cédula (10) válida."}
    try:
        r = requests.get(f"{BASE}/ConsolidadoContribuyente/obtenerPorNumerosRuc?ruc={ruc}",
                         headers=HDRS, timeout=25)
    except Exception as e:
        return {"ok": False, "error": f"No se pudo contactar al SRI: {e}"}
    if r.status_code != 200:
        return {"ok": False, "error": f"El SRI respondió {r.status_code}. Intenta más tarde."}
    try:
        data = r.json()
    except Exception:
        return {"ok": False, "error": "El RUC no existe o el SRI no devolvió datos."}
    if not isinstance(data, list) or not data:
        return {"ok": False, "error": "No se encontraron datos para ese RUC en el SRI."}
    d = data[0]
    fechas = d.get("informacionFechasContribuyente") or {}
    # Obligaciones / características destacadas
    obligaciones = []
    if _si_no(d.get("obligadoLlevarContabilidad")):
        obligaciones.append("Obligado a llevar contabilidad")
    if _si_no(d.get("agenteRetencion")):
        obligaciones.append("Agente de retención")
    if _si_no(d.get("contribuyenteEspecial")):
        obligaciones.append("Contribuyente especial")
    if _si_no(d.get("contribuyenteFantasma")):
        obligaciones.append("⚠ Marcado como fantasma")
    if _si_no(d.get("transaccionesInexistente")):
        obligaciones.append("⚠ Transacciones inexistentes")
    return {
        "ok": True,
        "ruc": d.get("numeroRuc") or ruc,
        "razon_social": d.get("razonSocial") or "",
        "estado": d.get("estadoContribuyenteRuc") or "",
        "tipo": d.get("tipoContribuyente") or "",
        "regimen": d.get("regimen") or "",
        "actividad": d.get("actividadEconomicaPrincipal") or "",
        "obligado_contabilidad": _si_no(d.get("obligadoLlevarContabilidad")),
        "agente_retencion": _si_no(d.get("agenteRetencion")),
        "contribuyente_especial": _si_no(d.get("contribuyenteEspecial")),
        "obligaciones": obligaciones,
        "fecha_inicio": (fechas.get("fechaInicioActividades") or "")[:10],
        "fecha_cese": (fechas.get("fechaCese") or "")[:10],
        "fecha_actualizacion": (fechas.get("fechaActualizacion") or "")[:10],
    }
