import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import { AuthContext, checkAuth } from './hooks/useAuth';
import { WebSocketProvider } from './hooks/useWebSocket';

export default function App() {
  // null = loading, false = unauthenticated, { username } = authenticated
  const [auth, setAuth] = useState(null);

  useEffect(() => {
    checkAuth()
      .then(data => setAuth(data.authenticated ? { username: data.username } : false))
      .catch(() => setAuth(false));
  }, []);

  if (auth === null) {
    return (
      <div className="boot-screen">
        <div className="boot-logo">Sentinel</div>
        <div className="boot-spinner" />
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ auth, setAuth }}>
      <BrowserRouter>
        <Routes>
          <Route
            path="/login"
            element={auth ? <Navigate to="/" replace /> : <Login />}
          />
          <Route
            path="/*"
            element={
              auth ? (
                <WebSocketProvider>
                  <Dashboard />
                </WebSocketProvider>
              ) : (
                <Navigate to="/login" replace />
              )
            }
          />
        </Routes>
      </BrowserRouter>
    </AuthContext.Provider>
  );
}
