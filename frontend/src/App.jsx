import { useState, useEffect } from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Classifier from './pages/Classifier'
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
        <Route
          path="/"
          element={user ? <Dashboard user={user} onLogout={handleLogout} /> : <Navigate to="/login" />}
        />
        <Route
          path="/clasificador"
          element={user ? <Classifier user={user} onLogout={handleLogout} /> : <Navigate to="/login" />}
        />
      </Routes>
    </Router>
  )
}

export default App
