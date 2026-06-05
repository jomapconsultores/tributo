import { useState, useEffect } from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import Login from './pages/Login'
import Database from './pages/Database'
import Classifier from './pages/Classifier'
import SavedData from './pages/SavedData'
import Retenciones from './pages/Retenciones'
import ICE from './pages/ICE'
import CalculoICE from './pages/CalculoICE'
import AnexoPVPICE from './pages/AnexoPVPICE'
import RecursosICE from './pages/RecursosICE'
import Declaraciones from './pages/Declaraciones'
import CatalogoProductos from './pages/CatalogoProductos'
import Layout from './components/Layout'
import { ClientProvider } from './context/ClientContext'
import './App.css'

function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = localStorage.getItem('token')
    const userId = localStorage.getItem('userId')
    const email = localStorage.getItem('email')
    if (token && userId) {
      setUser({ token, userId, email })
    }
    setLoading(false)
  }, [])

  const handleLogin = (token, userId, email) => {
    localStorage.setItem('token', token)
    localStorage.setItem('userId', userId)
    localStorage.setItem('email', email)
    setUser({ token, userId, email })
  }

  const handleLogout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('userId')
    localStorage.removeItem('email')
    localStorage.removeItem('selectedClientId')
    setUser(null)
  }

  if (loading) {
    return <div className="loading">Cargando...</div>
  }

  return (
    <Router>
      <Routes>
        <Route
          path="/login"
          element={user ? <Navigate to="/" /> : <Login onLogin={handleLogin} />}
        />
        {user ? (
          <Route
            element={
              <ClientProvider>
                <Layout user={user} onLogout={handleLogout} />
              </ClientProvider>
            }
          >
            <Route path="/" element={<Database />} />
            <Route path="/retenciones" element={<Retenciones />} />
            <Route path="/declaracion-iva" element={<Declaraciones tipo="IVA" />} />
            <Route path="/declaracion-ice" element={<Declaraciones tipo="ICE" />} />
            <Route path="/calculo-ice" element={<CalculoICE />} />
            <Route path="/anexo-pvp-ice" element={<AnexoPVPICE />} />
            <Route path="/recursos-ice" element={<RecursosICE />} />
            <Route path="/ice" element={<ICE />} />
            <Route path="/catalogo-productos" element={<CatalogoProductos />} />
            <Route path="/datos" element={<SavedData />} />
            <Route path="/clasificador" element={<Classifier />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Route>
        ) : (
          <Route path="*" element={<Navigate to="/login" />} />
        )}
      </Routes>
    </Router>
  )
}

export default App
