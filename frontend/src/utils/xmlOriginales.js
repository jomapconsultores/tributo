import { xmlOriginalesAPI, downloadBlob } from '../services/api'

// Descarga el ZIP de XML originales subidos, nombrado Tipo_RUC_nombre_mes_año.
// `modulo` es el que espera el backend: 'gasto' | 'ingreso_ice' | 'ingreso_iva' | 'retencion'.
export const descargarXmlsOriginales = async (cliente, clientId, tipo, modulo) => {
  try {
    const nom = (cliente?.nombre || '').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 20)
    const nombre = `${tipo}_${cliente?.identificacion || ''}_${nom}_${String(cliente?.periodo_mes || '').padStart(2, '0')}_${cliente?.periodo_anio || ''}.zip`
    const res = await xmlOriginalesAPI.descargar(clientId, modulo)
    downloadBlob(res.data, nombre, 'application/zip')
  } catch (err) {
    if (err.response?.status === 404) alert('Aún no hay XML guardados para este período. Se guardan automáticamente al subir nuevos XML.')
    else alert('Error: ' + (err.response?.data?.detail || err.message))
  }
}
