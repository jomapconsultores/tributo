import { useState, useRef } from 'react'
import './UploadPanel.css'

export default function UploadPanel({ onProcessTxt, onProcessXml }) {
  const [dragActive, setDragActive] = useState(false)
  const [loading, setLoading] = useState(false)
  const txtInputRef = useRef(null)
  const xmlInputRef = useRef(null)

  const handleDrag = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }

  const handleDrop = async (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)

    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return

    setLoading(true)
    try {
      if (files[0].name.endsWith('.txt')) {
        await onProcessTxt(files[0])
      } else if (files[0].name.endsWith('.xml')) {
        await onProcessXml(files)
      }
    } finally {
      setLoading(false)
    }
  }

  const handleTxtChange = async (e) => {
    if (e.target.files?.[0]) {
      setLoading(true)
      try {
        await onProcessTxt(e.target.files[0])
      } finally {
        setLoading(false)
      }
    }
  }

  const handleXmlChange = async (e) => {
    if (e.target.files?.length > 0) {
      setLoading(true)
      try {
        await onProcessXml(Array.from(e.target.files))
      } finally {
        setLoading(false)
      }
    }
  }

  return (
    <div className="upload-panel">
      <div
        className={`drag-drop-zone ${dragActive ? 'active' : ''}`}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
      >
        <div className="drag-content">
          <p className="drag-icon">📁</p>
          <p className="drag-text">Arrastra archivos TXT o XML aquí</p>
          <p className="drag-subtext">o haz clic para seleccionar</p>
        </div>
      </div>

      <div className="upload-buttons">
        <input
          ref={txtInputRef}
          type="file"
          accept=".txt,.csv,.tsv"
          onChange={handleTxtChange}
          style={{ display: 'none' }}
        />
        <button
          onClick={() => txtInputRef.current?.click()}
          disabled={loading}
          className="upload-btn primary"
        >
          {loading ? '⏳ Procesando...' : '📥 Procesar TXT (Claves SRI)'}
        </button>

        <input
          ref={xmlInputRef}
          type="file"
          accept=".xml"
          multiple
          onChange={handleXmlChange}
          style={{ display: 'none' }}
        />
        <button
          onClick={() => xmlInputRef.current?.click()}
          disabled={loading}
          className="upload-btn primary"
        >
          {loading ? '⏳ Procesando...' : '📂 Importar XMLs'}
        </button>
      </div>
    </div>
  )
}
