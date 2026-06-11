"""Almacenamiento de los XML originales subidos, para poder re-descargarlos
después con nombre Tipo_RUC_nombre_mes_año. Se guarda el contenido tal cual,
deduplicado por md5. Nunca interrumpe la carga: cualquier error se ignora."""
import hashlib


def guardar_xml_original(sb, user_id, client_id, modulo, xml_content):
    """Guarda (upsert) un XML original. modulo: gasto | ingreso_ice |
    ingreso_iva | retencion. Idempotente por md5 del contenido."""
    if not xml_content:
        return
    try:
        h = hashlib.md5(xml_content.encode("utf-8", "ignore")).hexdigest()
        sb.table("xml_originales").upsert({
            "user_id": user_id,
            "client_id": client_id,
            "modulo": modulo,
            "unique_id": h,
            "xml_content": xml_content,
        }, on_conflict="user_id,client_id,modulo,unique_id").execute()
    except Exception as e:
        print(f"[xml_store] no se pudo guardar XML original ({modulo}): {e}")
