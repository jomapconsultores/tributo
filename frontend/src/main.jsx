/* ------------------------------------------------------------
 * Desarrollado por Marco Antonio Posligua San Martín
 * ------------------------------------------------------------ */
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
// Lenguaje visual común de las pantallas (cabeceras, indicadores, tablas…).
// Va después de index.css y antes que el CSS de cada pantalla, para que una
// pantalla pueda seguir afinando lo suyo por encima.
import './styles/ui.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
