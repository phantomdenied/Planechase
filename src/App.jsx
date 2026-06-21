import { useState, useEffect } from 'react'
import Planechase from './components/Planechase'
import './App.css'

export default function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem('planechase-theme') ?? 'dark')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('planechase-theme', theme)
  }, [theme])

  return (
    <div className="app">
      <header className="app-header">
        <h1>Planechase</h1>
        <button
          className="theme-toggle"
          onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? '☀' : '🌙'}
        </button>
      </header>
      <main>
        <Planechase />
      </main>
    </div>
  )
}
