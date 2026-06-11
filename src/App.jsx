import TradingBot from './TradingBot'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import AuthGate from './components/AuthGate.jsx'

function App() {
  return (
    <ErrorBoundary>
      <AuthGate>
        <TradingBot />
      </AuthGate>
    </ErrorBoundary>
  )
}

export default App
