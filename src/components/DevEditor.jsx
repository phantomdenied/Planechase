import { useState } from 'react'
import './DevEditor.css'

const DEV_PASSWORD = 'phantomdev'
export const STORAGE_KEY = 'planechase-dev-overrides'
const GH_TOKEN_KEY = 'planechase-gh-token'
const GH_OWNER = 'phantomdenied'
const GH_REPO = 'Planechase'
const GH_BRANCH = 'claude/planechase-app-migration-7ejfvc'
const GH_OVERRIDES_PATH = 'src/data/plane-overrides.json'

export function loadDevOverrides() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

async function commitToGitHub(token, overrides) {
  const base = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_OVERRIDES_PATH}`

  const getResp = await fetch(`${base}?ref=${GH_BRANCH}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' },
  })
  if (!getResp.ok) {
    const e = await getResp.json().catch(() => ({}))
    throw new Error(e.message ?? `Could not read file (${getResp.status})`)
  }
  const { sha } = await getResp.json()

  const jsonStr = JSON.stringify(overrides, null, 2) + '\n'
  const bytes = new TextEncoder().encode(jsonStr)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  const content = btoa(binary)

  const putResp = await fetch(base, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: 'Manual plane text corrections via dev mode',
      content,
      sha,
      branch: GH_BRANCH,
    }),
  })
  if (!putResp.ok) {
    const e = await putResp.json().catch(() => ({}))
    throw new Error(e.message ?? `Push failed (${putResp.status})`)
  }
}

export function DevPasswordModal({ onAuth, onClose }) {
  const [pw, setPw] = useState('')
  const [error, setError] = useState(false)

  function submit(e) {
    e.preventDefault()
    if (pw === DEV_PASSWORD) {
      onAuth()
    } else {
      setError(true)
      setPw('')
    }
  }

  return (
    <div className="dev-overlay" onClick={onClose}>
      <div className="dev-dialog" onClick={e => e.stopPropagation()}>
        <p className="dev-title">Developer Mode</p>
        <form onSubmit={submit}>
          <input
            type="password"
            className="dev-input"
            value={pw}
            onChange={e => { setPw(e.target.value); setError(false) }}
            placeholder="Enter password"
            autoFocus
          />
          {error && <p className="dev-error">Incorrect password</p>}
          <div className="dev-btn-row">
            <button type="button" className="dev-btn secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="dev-btn primary">Unlock</button>
          </div>
        </form>
      </div>
    </div>
  )
}

export function DevCardEditor({ plane, override, allOverrides, onSave, onClear, onClearAll, onClose }) {
  const merged = { ...plane, ...(override ?? {}) }
  const [type, setType] = useState(merged.type ?? 'plane')
  const [world, setWorld] = useState(merged.world ?? '')
  const [staticText, setStaticText] = useState(merged.static ?? '')
  const [chaosText, setChaosText] = useState(merged.chaos ?? '')

  const [ghToken, setGhToken] = useState(() => localStorage.getItem(GH_TOKEN_KEY) ?? '')
  const [pushStatus, setPushStatus] = useState(null) // null | 'pushing' | 'success' | Error

  const isPhen = type === 'phenomenon'

  function currentEdit() {
    return {
      type,
      world: isPhen ? null : (world.trim() || null),
      static: staticText.trim() || null,
      chaos: isPhen ? null : (chaosText.trim() || null),
    }
  }

  // Combined: all existing overrides + current unsaved edit for this card
  function combinedOverrides() {
    return { ...allOverrides, [plane.id]: currentEdit() }
  }

  const fixCount = Object.keys(combinedOverrides()).length

  function saveLocally() {
    onSave(plane.id, currentEdit())
    onClose()
  }

  async function pushToGitHub() {
    const token = ghToken.trim()
    if (!token) return
    localStorage.setItem(GH_TOKEN_KEY, token)
    // Save current edit to local state too so it's included in combined
    onSave(plane.id, currentEdit())
    setPushStatus('pushing')
    try {
      await commitToGitHub(token, combinedOverrides())
      setPushStatus('success')
      onClearAll()
    } catch (e) {
      setPushStatus(e)
    }
  }

  return (
    <div className="dev-overlay" onClick={onClose}>
      <div className="dev-editor" onClick={e => e.stopPropagation()}>
        <p className="dev-title">Edit Card</p>
        <p className="dev-card-name">{plane.name}</p>

        <label className="dev-label">
          Type
          <select className="dev-select" value={type} onChange={e => setType(e.target.value)}>
            <option value="plane">Plane</option>
            <option value="phenomenon">Phenomenon</option>
          </select>
        </label>

        {!isPhen && (
          <label className="dev-label">
            World
            <input
              className="dev-input"
              value={world}
              onChange={e => setWorld(e.target.value)}
              placeholder="Leave blank for none"
            />
          </label>
        )}

        <label className="dev-label">
          Static text
          <textarea
            className="dev-textarea"
            rows={5}
            value={staticText}
            onChange={e => setStaticText(e.target.value)}
          />
        </label>

        {!isPhen && (
          <label className="dev-label">
            Chaos text
            <textarea
              className="dev-textarea"
              rows={3}
              value={chaosText}
              onChange={e => setChaosText(e.target.value)}
              placeholder="Leave blank for none"
            />
          </label>
        )}

        <div className="dev-btn-row">
          <button className="dev-btn danger" onClick={() => { onClear(plane.id); onClose() }}>
            Reset
          </button>
          <div className="dev-btn-right">
            <button className="dev-btn secondary" onClick={onClose}>Cancel</button>
            <button className="dev-btn primary" onClick={saveLocally}>Save locally</button>
          </div>
        </div>

        <div className="dev-divider" />

        <div className="dev-section-header">
          <p className="dev-section-title">Commit to repo</p>
          {fixCount > 0 && <span className="dev-badge">{fixCount} pending</span>}
        </div>

        <p className="dev-hint">
          Writes fixes permanently to the codebase and triggers a redeploy (~2 min).
          Requires a GitHub PAT with <code>repo</code> write access.
        </p>

        <label className="dev-label">
          GitHub token
          <input
            type="password"
            className="dev-input"
            value={ghToken}
            onChange={e => { setGhToken(e.target.value); setPushStatus(null) }}
            placeholder="ghp_..."
          />
        </label>

        {pushStatus === 'success' && (
          <p className="dev-push-ok">Pushed! Site will update in ~2 minutes.</p>
        )}
        {pushStatus instanceof Error && (
          <p className="dev-error">{pushStatus.message}</p>
        )}

        <button
          className="dev-btn primary"
          style={{ width: '100%' }}
          onClick={pushToGitHub}
          disabled={!ghToken.trim() || pushStatus === 'pushing' || fixCount === 0}
        >
          {pushStatus === 'pushing'
            ? 'Pushing…'
            : `Push ${fixCount} fix${fixCount !== 1 ? 'es' : ''} to GitHub`}
        </button>
      </div>
    </div>
  )
}
