import { useState, useEffect, useCallback } from 'react'
import {
  createInitialState,
  movePlayer,
  addRoom,
  getTileClass,
  serializeWorldState,
  TILE,
  type GameState,
  type LogEntry,
  type Position,
} from './game'
import {
  exploreDoor as apiExploreDoor,
  healthCheck,
  getHero,
  syncTurn,
  type HeroState,
  type Inspector,
  type LogEntry as ApiLogEntry,
  type Tile
} from './api'
import './index.css'

type ServiceStatus = 'connecting' | 'online' | 'offline'

function App() {
  const [gameState, setGameState] = useState<GameState>(createInitialState)
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus>('connecting')
  const [isExploring, setIsExploring] = useState(false)
  const [hero, setHero] = useState<HeroState | null>(null)
  const [overlay, setOverlay] = useState<Inspector | null>(null)

  // Multi-layered visual state orchestrator
  const [mapGrid, setMapGrid] = useState<Tile[][]>([])

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

  // Fetch available actions and FOV visibility via unified Sync endpoint
  useEffect(() => {
    if (serviceStatus !== 'online') return
    const ws = serializeWorldState(gameState)

    syncTurn(ws.playerX, ws.playerY, ws.currentEnemiesJson, 8, ws.level)
      .then((res) => {
        // Actions
        setOverlay(res.data.actions || null)

        // Map Modifiers
        const mapData = res.data.map;
        if (!mapData.merged_tiles_json) return;
        
        setMapGrid(JSON.parse(mapData.merged_tiles_json));
        
        // Dynamic map instantiation handling
        if (mapData.new_collision_tiles) {
          let rebuiltTiles = {};
          try { rebuiltTiles = JSON.parse(mapData.new_collision_tiles); } catch {}

          setGameState(prev => ({
            ...prev,
            tiles: rebuiltTiles,
            player: {
              x: mapData.new_player_x ?? prev.player.x,
              y: mapData.new_player_y ?? prev.player.y
            },
            rooms: mapData.new_rooms_json ? JSON.parse(mapData.new_rooms_json) : prev.rooms,
            enemies: mapData.updated_enemies_json ? JSON.parse(mapData.updated_enemies_json) : prev.enemies
          }));
        } else if (mapData.updated_enemies_json) {
          setGameState(prev => ({
            ...prev,
            enemies: JSON.parse(mapData.updated_enemies_json!)
          }));
        }
      })
      .catch((err) => {
        console.error('Game Sync Error:', err);
        setOverlay(null);
      });
  }, [gameState.player.x, gameState.player.y, gameState.rooms.length, gameState.exploredDoors.size, serviceStatus])

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

  const exploreDoor = useCallback(
    async (doorPos: Position) => {
      const doorKey = `${doorPos.x},${doorPos.y}`
      setGameState((prev) => {
        if (prev.exploredDoors.has(doorKey)) return prev
        return { ...prev, exploredDoors: new Set([...prev.exploredDoors, doorKey]) }
      })

      setIsExploring(true)
      addMessage('You push the door open and peer into the darkness...', 'action', 'wow')

      try {
        const ws = serializeWorldState(gameState)
        const res = await apiExploreDoor(doorPos.x, doorPos.y, ws.playerX, ws.playerY, ws.currentEnemiesJson, 8, ws.level)
        const struct = res.data
        appendServiceLogs(res.logEntries)

        // Immediately apply the composited map from dnd-service (no sync-lag blink)
        if (struct.mergedTilesJson) {
          try { setMapGrid(JSON.parse(struct.mergedTilesJson)); } catch {}
        }

        setGameState((prev) => {
          if (struct.fitSuccess === false) {
            addMessage(struct.description || 'The doorway collapses into solid rock...', 'system', 'wow')
            const newTiles = { ...prev.tiles }
            newTiles[`${doorPos.x},${doorPos.y}`] = TILE.WALL
            const newExplored = new Set(prev.exploredDoors)
            newExplored.delete(doorKey)
            return { ...prev, tiles: newTiles, exploredDoors: newExplored }
          }

          // World-service owns tile state — sync from response
          let newTiles = prev.tiles
          if (struct.newTilesJson) {
            try { newTiles = JSON.parse(struct.newTilesJson) } catch {}
          }
          let newRooms = prev.rooms
          if (struct.newRoomsJson) {
            try { newRooms = JSON.parse(struct.newRoomsJson) } catch {}
          }
          let newEnemies = prev.enemies
          if (struct.updatedEnemiesJson) {
            try { newEnemies = JSON.parse(struct.updatedEnemiesJson) } catch {}
          }

          return {
            ...prev,
            tiles: newTiles,
            rooms: newRooms,
            enemies: newEnemies,
          }
        })
      } catch {
        addMessage('The door seems stuck... (services may be offline)', 'system', 'wow')
      }
      setIsExploring(false)
    },
    [addMessage, appendServiceLogs, gameState.level]
  )

  // Keyboard handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isExploring) return

      let dx = 0, dy = 0

      // Check if the key maps to an inspector action first!
      if (overlay?.actions) {
        const action = overlay.actions.find((a) => a.key === e.key && a.enabled)
        if (action) {
          e.preventDefault()
          addMessage(`Action [${action.key}] -> ${action.label}`, 'action', 'wow')
          // TODO: Actually send action execution out to the action-service
          return
        }
      }

      switch (e.key) {
        case 'ArrowUp': case 'w': case 'W': dy = -1; break
        case 'ArrowDown': case 's': case 'S': dy = 1; break
        case 'ArrowLeft': case 'a': case 'A': dx = -1; break
        case 'ArrowRight': case 'd': case 'D': dx = 1; break
        case 'e': case 'E': {
          setGameState((prev) => {
            const { x, y } = prev.player
            const adjacent = [
              { x: x, y: y - 1 },
              { x: x, y: y + 1 },
              { x: x - 1, y: y },
              { x: x + 1, y: y },
            ]
            for (const pos of adjacent) {
              const key = `${pos.x},${pos.y}`
              if (prev.tiles[key] === TILE.DOOR || prev.tiles[key] === '+') {
                if (!prev.exploredDoors.has(key)) {
                  exploreDoor(pos)
                  return prev
                }
              }
            }
            return prev
          })
          return
        }
        default: return
      }

      e.preventDefault()

      setGameState((prev) => {
        const { state: newState, hitDoor } = movePlayer(prev, dx, dy)
        if (hitDoor && !prev.exploredDoors.has(`${hitDoor.x},${hitDoor.y}`)) {
          exploreDoor(hitDoor)
        }
        return newState
      })
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isExploring, exploreDoor])

  // Render colored ASCII map
  const renderColoredMap = () => {
    // If the base grid hasn't mounted yet, render an empty buffer
    if (!mapGrid || mapGrid.length === 0) return null;

    return mapGrid.map((row, y) => (
      <div key={y} style={{ display: 'flex' }}>
        {row.map((tile, x) => {
          let tClass = getTileClass(tile.char)
          
          // Flatten layer 10 FOV Raytracing map over the output if unseen
          if (!tile.visible) {
            tClass += ' obscured'
          } else {
            tClass += ' visible-bright'
          }
          
          return (
            <span key={x} className={tClass}>
              {tile.char}
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
        </div>
      </div>

      {/* Map Panel */}
      <div className="map-panel">
        <div className="panel-title">Dungeon — Level {gameState.level}</div>
        <div className="map-viewport">
          {isExploring ? (
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

        {/* Message Log (room descriptions etc) */}
        <div className="log-panel">
          <div className="panel-title">Message Log</div>
          <div className="log-messages">
            {gameState.messages
              .filter((m) => !m.source || m.source === 'wow' || m.source === 'system')
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

      {/* Bottom Info Panel: hero stats (left 33%) + overlay (middle 33%) + service log (right 33%) */}
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
              .filter((m) => m.source && m.source !== 'wow' && m.source !== 'system')
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
