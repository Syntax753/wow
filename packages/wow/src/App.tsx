import { useState, useEffect, useCallback, useRef } from 'react'
import {
  createInitialState,
  getTileClass,
  serializeWorldState,
  type GameState,
  type LogEntry,
} from './game'
import {
  healthCheck,
  getHero,
  syncTurn,
  sendInput,
  type HeroState,
  type Inspector,
  type LogEntry as ApiLogEntry,
  type Tile
} from './api'
import './index.css'

type ServiceStatus = 'connecting' | 'online' | 'offline'

// Keys that should be routed to the server-side input-service
const INPUT_KEYS = new Set([
  'w', 'W', 'a', 'A', 's', 'S', 'd', 'D',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'o', 'O', 'e', 'E', '.',
])

function App() {
  const [gameState, setGameState] = useState<GameState>(createInitialState)
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus>('connecting')
  const [processing, setProcessing] = useState(false)
  const [hero, setHero] = useState<HeroState | null>(null)
  const [overlay, setOverlay] = useState<Inspector | null>(null)

  // Multi-layered visual state orchestrator
  const [mapGrid, setMapGrid] = useState<Tile[][]>([])

  // Track whether initial sync has completed
  const initialSyncDone = useRef(false)

  useEffect(() => {
    getHero()
      .then((res) => setHero(res.data))
      .catch(() => {})
  }, [])

  // Check service health
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        await healthCheck()
        if (!cancelled) setServiceStatus('online')
      } catch {
        if (!cancelled) setServiceStatus('offline')
      }
    }
    check()
    const interval = setInterval(check, 5000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  // Initial sync — render the world on first load
  useEffect(() => {
    if (serviceStatus !== 'online' || initialSyncDone.current) return
    initialSyncDone.current = true

    const ws = serializeWorldState(gameState)
    syncTurn(ws.playerX, ws.playerY, ws.currentEnemiesJson, 8, ws.level)
      .then((res) => {
        setOverlay(res.data.actions || null)

        const mapData = res.data.map
        if (!mapData.merged_tiles_json) return

        setMapGrid(JSON.parse(mapData.merged_tiles_json))

        setGameState(prev => {
          const update: Partial<GameState> = {}
          if (mapData.new_collision_tiles) {
            try { update.tiles = JSON.parse(mapData.new_collision_tiles) } catch {}
          }
          if (mapData.new_rooms_json) {
            try { update.rooms = JSON.parse(mapData.new_rooms_json) } catch {}
          }
          if (mapData.updated_enemies_json) {
            try { update.enemies = JSON.parse(mapData.updated_enemies_json) } catch {}
          }
          if (mapData.new_player_x !== undefined && mapData.new_player_x !== 0) {
            update.player = { x: mapData.new_player_x, y: mapData.new_player_y ?? prev.player.y }
          }
          return { ...prev, ...update }
        })
      })
      .catch((err) => {
        console.error('Initial sync error:', err)
        initialSyncDone.current = false // retry on next render
      })
  }, [serviceStatus])

  /** Append log entries from an API response into the game state */
  const appendServiceLogs = useCallback((apiLogs: ApiLogEntry[]) => {
    if (!apiLogs || apiLogs.length === 0) return
    setGameState((prev) => ({
      ...prev,
      messages: [
        ...prev.messages,
        ...apiLogs.map((l) => ({
          text: l.text,
          type: l.type as LogEntry['type'],
          source: l.source,
          timestamp: l.timestamp || Date.now(),
        })),
      ],
    }))
  }, [])

  const addMessage = useCallback((text: string, type: LogEntry['type'] = 'info', source = 'wow') => {
    setGameState((prev) => ({
      ...prev,
      messages: [...prev.messages, { text, type, source, timestamp: Date.now() }],
    }))
  }, [])

  // Unified input handler — sends keypress to server
  const handleInput = useCallback(async (key: string) => {
    if (processing || serviceStatus !== 'online') return

    setProcessing(true)
    try {
      const ws = serializeWorldState(gameState)
      const res = await sendInput(key, ws.currentEnemiesJson, 8, ws.level)
      const data = res.data

      appendServiceLogs(res.logEntries)

      // Update rendered map
      if (data.map.merged_tiles_json) {
        setMapGrid(JSON.parse(data.map.merged_tiles_json))
      }

      // Update game state from server response
      setGameState(prev => {
        const update: Partial<GameState> = {}

        // Server is authoritative for player position
        if (data.player) {
          update.player = { x: data.player.x, y: data.player.y }
        }
        if (data.map.new_collision_tiles) {
          try { update.tiles = JSON.parse(data.map.new_collision_tiles) } catch {}
        }
        if (data.map.new_rooms_json) {
          try { update.rooms = JSON.parse(data.map.new_rooms_json) } catch {}
        }
        if (data.map.updated_enemies_json) {
          try { update.enemies = JSON.parse(data.map.updated_enemies_json) } catch {}
        }

        // Add server message to log
        const messages = [...prev.messages]
        if (data.message) {
          messages.push({
            text: data.message,
            type: data.action === 'blocked' ? 'combat' as const : 'action' as const,
            source: 'dnd',
            timestamp: Date.now(),
          })
        }

        return { ...prev, ...update, messages }
      })

      // Update action overlay
      setOverlay(data.actions || null)
    } catch (err) {
      console.error('Input error:', err)
      addMessage('Connection lost... (services may be offline)', 'system', 'wow')
    }
    setProcessing(false)
  }, [processing, serviceStatus, gameState, appendServiceLogs, addMessage])

  // Keyboard handler — routes all game keys to server
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Map 'e'/'E' to 'o' (open door) for backwards compatibility
      let key = e.key
      if (key === 'e' || key === 'E') key = 'o'

      if (INPUT_KEYS.has(key) || INPUT_KEYS.has(e.key)) {
        e.preventDefault()
        handleInput(key)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleInput])

  // Render colored ASCII map
  const renderColoredMap = () => {
    if (!mapGrid || mapGrid.length === 0) return null

    return mapGrid.map((row, y) => (
      <div key={y} style={{ display: 'flex' }}>
        {row.map((tile, x) => {
          let tClass = getTileClass(tile.char)

          if (tile.visible) {
            tClass += ' visible-bright'
          } else if (tile.revealed) {
            tClass += ' fog-of-war'
          } else {
            tClass += ' obscured'
          }

          return (
            <span key={x} className={tClass}>
              {tile.visible || tile.revealed ? tile.char : ' '}
            </span>
          )
        })}
      </div>
    ))
  }

  const heroName = hero?.name || 'Adventurer'
  const heroClass = hero?.heroClass || 'Fighter'
  const stats = {
    STR: hero?.strength ?? 10,
    VIT: hero?.vitality ?? 10,
    AGI: hero?.agility ?? 10,
    WIS: hero?.wisdom ?? 10,
    LCK: hero?.luck ?? 10,
  }
  const ac = hero?.armorClass ?? 10

  return (
    <div className="game-container">
      {/* Header */}
      <div className="header-bar">
        <h1>⚔ World of WoW ⚔</h1>
        <div className="status-indicators">
          <span className={`status-dot ${serviceStatus}`}>dice</span>
          <span className={`status-dot ${serviceStatus}`}>dnd</span>
          <span className={`status-dot ${serviceStatus}`}>hero</span>
          <span className={`status-dot ${serviceStatus}`}>inv</span>
          <span className={`status-dot ${serviceStatus}`}>act</span>
          <span className={`status-dot ${serviceStatus}`}>room</span>
          <span className={`status-dot ${serviceStatus}`}>shd</span>
          <span className={`status-dot ${serviceStatus}`}>rnd</span>
          <span className={`status-dot ${serviceStatus}`}>enm</span>
          <span className={`status-dot ${serviceStatus}`}>wld</span>
          <span className={`status-dot ${serviceStatus}`}>inp</span>
        </div>
      </div>

      {/* Map Panel */}
      <div className="map-panel">
        <div className="panel-title">Dungeon — Level {gameState.level}</div>
        <div className="map-viewport">
          {processing && mapGrid.length === 0 ? (
            <div className="loading-overlay">
              <div className="loading-spinner" />
              <span>Generating dungeon...</span>
            </div>
          ) : (
            <pre className="ascii-map">{renderColoredMap()}</pre>
          )}
        </div>
      </div>

      {/* Side Panel */}
      <div className="side-panel">
        {/* Stats */}
        <div className="stats-panel">
          <div className="panel-title">Status</div>
          <div className="stat-row">
            <span className="stat-label">Position</span>
            <span className="stat-value">
              ({gameState.player.x}, {gameState.player.y})
            </span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Level</span>
            <span className="stat-value highlight">{gameState.level}</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Rooms</span>
            <span className="stat-value">{gameState.rooms.length}</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">HP</span>
            <span className="stat-value">{hero?.hp ?? 20}/{hero?.maxHp ?? 20}</span>
          </div>
        </div>

        {/* Message Log */}
        <div className="log-panel">
          <div className="panel-title">Message Log</div>
          <div className="log-messages">
            {gameState.messages
              .filter((m) => !m.source || m.source === 'wow' || m.source === 'system' || m.source === 'dnd')
              .reverse()
              .slice(0, 20)
              .map((msg, i) => (
                <div key={i} className={`log-entry ${msg.type}`}>
                  <span className="log-prefix">{'>'} </span>
                  {msg.text}
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* Bottom Info Panel */}
      <div className="info-panel">

        {/* Left third: Stats grid */}
        <div className="hero-stats">
          <div className="hero-stat">
            <span className="tag">Name</span>
            <span className="val name-val">{heroName}</span>
          </div>
          <div className="hero-stat">
            <span className="tag">Class</span>
            <span className="val">{heroClass}</span>
          </div>
          <div className="hero-stat">
            <span className="tag">AC</span>
            <span className="val">{ac}</span>
          </div>
          {Object.entries(stats).map(([key, val]) => (
            <div className="hero-stat" key={key}>
              <span className="tag">{key}</span>
              <span className="val">{val}</span>
            </div>
          ))}
        </div>

        {/* Middle third: Dynamic overlay */}
        <div className="middle-overlay">
          {overlay ? (
            <>
              <div className="overlay-title">{overlay.title}</div>
              <div className="overlay-content">
                <div style={{ marginBottom: 16 }}>{overlay.description}</div>
                {overlay.actions && overlay.actions.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {overlay.actions.map((a, i) => (
                      <div key={i} className="stat-row" style={{ opacity: a.enabled ? 1 : 0.4, padding: 0 }}>
                        <span className="stat-label">[{a.key}]</span>
                        <span className="stat-value">{a.label}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="overlay-title">Inspect Overlay</div>
              <div className="overlay-content">
                <span style={{ color: 'var(--terminal-dim)' }}>No active overlays</span>
              </div>
            </>
          )}
        </div>

        {/* Right third: Service log */}
        <div className="service-log">
          <div className="service-log-title">Service Log</div>
          <div className="service-log-messages">
            {gameState.messages
              .filter((m) => m.source && m.source !== 'wow' && m.source !== 'system' && m.source !== 'dnd')
              .reverse()
              .slice(0, 20)
              .map((msg, i) => (
                <div key={i} className={`slog-entry ${msg.type}`}>
                  <span className="slog-source">[{msg.source}]</span>
                  {msg.text}
                </div>
              ))}
          </div>
        </div>

      </div>
    </div>
  )
}

export default App
