import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error) {
    console.error('Erro inesperado:', error)
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="fatal">
          <h1>Algo deu errado</h1>
          <p>Os dados salvos podem estar corrompidos. Limpe-os e recarregue a página.</p>
          <button
            className="btn btn-primary"
            onClick={() => {
              try {
                localStorage.removeItem('valorant-team-balancer:v1')
              } catch (e) {
                /* ignora */
              }
              window.location.reload()
            }}
          >
            Limpar dados e recarregar
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
