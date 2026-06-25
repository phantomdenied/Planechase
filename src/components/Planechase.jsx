import { useState, useEffect } from 'react'
import { PLANES_ONLY, PHENOMENA, SET_LABELS } from '../data/planes.js'
import { DevPasswordModal, DevCardEditor, loadDevOverrides, STORAGE_KEY } from './DevEditor'
import repoOverrides from '../data/plane-overrides.json'
import chaosIcon from '../assets/chaos-icon-white.png'
import planewalkIcon from '../assets/planeswalk-icon-white.png'
import './Planechase.css'

const ALL_CARDS = [...PLANES_ONLY, ...PHENOMENA]
const DIE_FACES = ['blank', 'blank', 'blank', 'planeswalk', 'chaos', 'blank']

function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function dedupeByCanonId(cards) {
  return cards.reduce((acc, card) => {
    const key = card.canonId ?? card.id
    if (!acc.some(existing => (existing.canonId ?? existing.id) === key)) {
      acc.push(card)
    }
    return acc
  }, [])
}

const imgCache = {}

function usePlaneImage(planeName, scryfallSet) {
  const [url, setUrl] = useState(imgCache[planeName] ?? null)
  const [loading, setLoading] = useState(!imgCache[planeName] && !!planeName)

  useEffect(() => {
    if (!planeName) return
    if (imgCache[planeName]) { setUrl(imgCache[planeName]); setLoading(false); return }
    setLoading(true)
    setUrl(null)
    let cancelled = false
    const extractImg = card =>
      card.image_uris?.large ??
      card.image_uris?.normal ??
      card.card_faces?.[0]?.image_uris?.large ??
      card.card_faces?.[0]?.image_uris?.normal ??
      null

    const searchFallback = () => {
      const q = encodeURIComponent(`!"${planeName}" (t:plane or t:phenomenon)`)
      return fetch(`https://api.scryfall.com/cards/search?q=${q}&unique=prints&order=released`)
        .then(r => r.ok ? r.json() : Promise.reject(new Error('not found')))
        .then(resp => { const c = resp.data?.[0]; if (!c) throw new Error('not found'); return c })
    }

    fetch('https://api.scryfall.com/cards/named?fuzzy=' + encodeURIComponent(planeName))
      .then(r => r.ok ? r.json() : Promise.reject(new Error('not found')))
      .then(card => /\b(plane|phenomenon)\b/i.test(card.type_line ?? '') ? card : searchFallback())
      .catch(searchFallback)
      .then(card => {
        const img = extractImg(card)
        if (!cancelled) {
          if (img) imgCache[planeName] = img
          setUrl(img)
        }
      })
      .catch(() => { if (!cancelled) setUrl(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [planeName])

  return { url, loading }
}

export default function Planechase() {
  const [deck, setDeck] = useState(() => shuffle(dedupeByCanonId(ALL_CARDS)))
  const [deckIndex, setDeckIndex] = useState(0)
  const [history, setHistory] = useState([])
  const [dieResult, setDieResult] = useState(null)
  const [rolling, setRolling] = useState(false)
  const [chaosTriggers, setChaosTriggers] = useState(0)
  const [counters, setCounters] = useState({})
  const [filterSets, setFilterSets] = useState(new Set(['PC1', 'PC2', 'MOC', 'WHO', 'PUNK']))
  const [showDeckConfig, setShowDeckConfig] = useState(false)
  const [includePhenomena, setIncludePhenomena] = useState(true)
  const [showText, setShowText] = useState(false)
  const [devAuth, setDevAuth] = useState(false)
  const [devOverrides, setDevOverrides] = useState(() => loadDevOverrides())
  const [showDevUnlock, setShowDevUnlock] = useState(false)
  const [showDevEditor, setShowDevEditor] = useState(false)

  const currentPlane = deck[deckIndex] ?? null
  const displayPlane = currentPlane
    ? { ...currentPlane, ...(repoOverrides[currentPlane.id] ?? {}), ...(devOverrides[currentPlane.id] ?? {}) }
    : null
  const isCurrentPhenomenon = displayPlane?.type === 'phenomenon'
  const currentCounters = counters[currentPlane?.id] ?? 0
  const { url: cardImg, loading: imgLoading } = usePlaneImage(currentPlane?.name, currentPlane?.scryfallSet)

  function buildDeck(pool) {
    const d = shuffle(dedupeByCanonId(pool ?? ALL_CARDS))
    setDeck(d)
    setDeckIndex(0)
    setHistory([])
    setCounters({})
    setDieResult(null)
    setChaosTriggers(0)
  }

  function rollDie() {
    setRolling(true)
    setDieResult(null)
    setTimeout(() => {
      const face = DIE_FACES[Math.floor(Math.random() * DIE_FACES.length)]
      setDieResult(face)
      if (face === 'planeswalk') planeswalk()
      else if (face === 'chaos') setChaosTriggers(n => n + 1)
      setRolling(false)
    }, 350)
  }

  function planeswalk(targetIndex = null) {
    const next = targetIndex ?? (deckIndex + 1) % deck.length
    setHistory(h => [currentPlane, ...h].slice(0, 20))
    setDeckIndex(next)
    setChaosTriggers(0)
    setDieResult(null)
  }

  function planewalkBack() {
    if (history.length === 0) return
    const prev = history[0]
    const idx = deck.findIndex(p => p.id === prev.id)
    if (idx !== -1) setDeckIndex(idx)
    setHistory(h => h.slice(1))
    setChaosTriggers(0)
  }

  function adjustCounter(delta) {
    if (!currentPlane) return
    setCounters(c => ({
      ...c,
      [currentPlane.id]: Math.max(0, (c[currentPlane.id] ?? 0) + delta),
    }))
  }

  function applyConfig() {
    let pool = PLANES_ONLY.filter(p => filterSets.has(p.set))
    if (includePhenomena) {
      const phen = PHENOMENA.filter(p => filterSets.has(p.set))
      pool = [...pool, ...phen]
    }
    buildDeck(pool.length > 0 ? pool : ALL_CARDS)
    setShowDeckConfig(false)
  }

  function handleDevFab() {
    if (!currentPlane) return
    if (!devAuth) setShowDevUnlock(true)
    else setShowDevEditor(true)
  }

  function handleDevAuth() {
    setDevAuth(true)
    setShowDevUnlock(false)
    if (currentPlane) setShowDevEditor(true)
  }

  function saveDevOverride(id, edit) {
    setDevOverrides(prev => {
      const next = { ...prev, [id]: edit }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }

  function clearDevOverride(id) {
    setDevOverrides(prev => {
      const next = { ...prev }
      delete next[id]
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }

  function clearAllDevOverrides() {
    setDevOverrides({})
    localStorage.setItem(STORAGE_KEY, '{}')
  }

  function toggleSet(key) {
    setFilterSets(prev => {
      const next = new Set(prev)
      if (next.has(key)) {
        if (next.size > 1) next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const SET_KEYS = Object.keys(SET_LABELS).filter(k =>
    PLANES_ONLY.some(card => card.set === k) || PHENOMENA.some(card => card.set === k)
  )
  const setCounts = SET_KEYS.reduce((acc, key) => {
    const planeCount = PLANES_ONLY.filter(card => card.set === key).length
    const phenCount = includePhenomena ? PHENOMENA.filter(card => card.set === key).length : 0
    acc[key] = planeCount + phenCount
    return acc
  }, {})
  const needsCounter = ['aretopolis', 'kilnspire', 'naar-isle', 'mechanus'].includes(currentPlane?.id)

  return (
    <div className="planechase">
      {currentPlane && (
        <div className={'plane-card' + (isCurrentPhenomenon ? ' phenomenon' : '')}>
          <div className="plane-img-wrap">
            {imgLoading && <div className="plane-img-skeleton" />}
            {cardImg && (
              <img
                className="plane-img"
                src={cardImg}
                alt={currentPlane.name}
                loading="lazy"
              />
            )}
            {!imgLoading && !cardImg && (
              <div className="plane-img-fallback">
                <span className="plane-img-fallback-name">{displayPlane.name}</span>
              </div>
            )}

            <div className="plane-img-overlay">
              {chaosTriggers > 0 && (
                <div className="chaos-overlay">
                  {'Chaos' + (chaosTriggers > 1 ? ' x' + chaosTriggers : '') + '!'}
                </div>
              )}
              <button className="show-text-btn" onClick={() => setShowText(v => !v)}>
                {showText ? 'Hide text' : 'Show text'}
              </button>
            </div>
          </div>

          {showText && (
            <div className="plane-text-block">
              <p className="plane-name">{displayPlane.name}</p>
              <div className="plane-text static-text">{displayPlane.static}</div>
              {displayPlane.chaos && (
                <div className="plane-text chaos-text">
                  <span className="chaos-icon">Chaos:</span> {displayPlane.chaos}
                </div>
              )}
              {isCurrentPhenomenon && (
                <div className="phen-note">Encounter -- resolve effect immediately.</div>
              )}
            </div>
          )}

          {needsCounter && (
            <div className="plane-counters">
              <span className="counter-key-label">Counters</span>
              <button className="counter-adj" onClick={() => adjustCounter(-1)} disabled={currentCounters <= 0}>-</button>
              <span className="counter-val">{currentCounters}</span>
              <button className="counter-adj" onClick={() => adjustCounter(1)}>+</button>
            </div>
          )}
        </div>
      )}

      {dieResult && (
        <div className={'die-result die-' + dieResult}>
          {dieResult === 'planeswalk' && (
            <><img className="die-icon" src={planewalkIcon} alt="" /><span>Planeswalk!</span></>
          )}
          {dieResult === 'chaos' && (
            <><img className="die-icon" src={chaosIcon} alt="" /><span>Chaos!</span></>
          )}
          {dieResult === 'blank' && <span>No effect</span>}
        </div>
      )}

      <div className="plane-controls">
        <button className="plane-btn secondary" onClick={planewalkBack} disabled={history.length === 0}>Back</button>
        <button
          className={'plane-btn die-btn-big' + (rolling ? ' rolling' : '')}
          onClick={rollDie}
          disabled={rolling}
        >
          {rolling ? '...' : 'Roll Planar Die'}
        </button>
        <button className="plane-btn primary" onClick={() => planeswalk()}>Planeswalk</button>
      </div>

      <div className="plane-controls secondary-row">
        <button className="plane-btn small" onClick={() => setShowDeckConfig(v => !v)}>
          Deck ({deck.length})
        </button>
        <span className="plane-progress">Plane {deckIndex + 1} / {deck.length}</span>
        <button className="plane-btn small danger" onClick={() => buildDeck()}>Reshuffle</button>
      </div>

      {showDeckConfig && (
        <div className="deck-config">
          <div className="deck-config-section">
            <span className="config-label">Set Filter</span>
            <div className="filter-buttons">
              {SET_KEYS.map(k => (
                <button
                  key={k}
                  className={'filter-btn' + (filterSets.has(k) ? ' active' : '')}
                  onClick={() => toggleSet(k)}
                >
                  {SET_LABELS[k]} ({setCounts[k] ?? 0})
                </button>
              ))}
            </div>
          </div>
          <label className="config-toggle">
            <input type="checkbox" checked={includePhenomena} onChange={e => setIncludePhenomena(e.target.checked)} />
            Include Phenomena
          </label>
          <button className="plane-btn primary" onClick={applyConfig}>Apply and Reshuffle</button>
        </div>
      )}

      {history.length > 0 && (
        <div className="plane-history">
          <span className="history-label">Previously visited</span>
          <div className="history-chips">
            {history.slice(0, 6).map((p, i) => (
              <span key={i} className={'history-chip' + (p.type === 'phenomenon' ? ' phen' : '')}>{p.name}</span>
            ))}
          </div>
        </div>
      )}

      <button
        className={'dev-mode-fab' + (devAuth ? ' unlocked' : '')}
        onClick={handleDevFab}
        title="Developer mode"
      >
        DEV
      </button>

      {showDevUnlock && (
        <DevPasswordModal
          onAuth={handleDevAuth}
          onClose={() => setShowDevUnlock(false)}
        />
      )}

      {showDevEditor && currentPlane && (
        <DevCardEditor
          plane={currentPlane}
          override={devOverrides[currentPlane.id]}
          allOverrides={devOverrides}
          onSave={saveDevOverride}
          onClear={clearDevOverride}
          onClearAll={clearAllDevOverrides}
          onClose={() => setShowDevEditor(false)}
        />
      )}
    </div>
  )
}
