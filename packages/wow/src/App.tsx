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
  getInventory,
  syncTurn,
  sendInput,
  getKeymap,
  getCampaign,
  getGameState,
  startNewAdventure,
  logout,
  joinGame,
  leaveGame,
  setPlayerId,
  getPlayerId,
  type HeroState,
  type Inspector,
  type LogEntry as ApiLogEntry,
  type Tile,
  type InventoryState,
} from './api'
import StarfieldBg from './StarfieldBg'
import InventoryModal from './InventoryModal'
import './index.css'

type ServiceStatus = 'connecting' | 'online' | 'offline'
type Screen = 'login' | 'splash' | 'settings' | 'game'



function App() {
  const [screen, setScreen] = useState<Screen>('login')
  const [gameState, setGameState] = useState<GameState>(createInitialState)
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus>('connecting')
  const [processing, setProcessing] = useState(false)
  const [hero, setHero] = useState<HeroState | null>(null)
  const [overlay, setOverlay] = useState<Inspector | null>(null)

  const [defaultKeymap, setDefaultKeymap] = useState<Record<string, any>>({})
  const [keymap, setKeymap] = useState<Record<string, any>>({})
  const [, setCampaigns] = useState<any[]>([])
  const [levelName, setLevelName] = useState<string>('')
  const [showInventory, setShowInventory] = useState(false)
  const [inventory, setInventory] = useState<InventoryState | null>(null)
  const [playerName, setPlayerName] = useState('')
  const [isMultiplayer, setIsMultiplayer] = useState(false)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [authProvider, setAuthProvider] = useState<'github' | 'guest' | null>(null)

  // Multi-layered visual state orchestrator
  const [mapGrid, setMapGrid] = useState<Tile[][]>([])

  // Track whether initial sync has completed
  const initialSyncDone = useRef(false)

  // Check for existing player session on mount
  useEffect(() => {
    const pidMatch = document.cookie.match(/(?:^|; )wow_player_id=([^;]*)/)
    const nameMatch = document.cookie.match(/(?:^|; )wow_player_name=([^;]*)/)
    const avatarMatch = document.cookie.match(/(?:^|; )wow_github_avatar=([^;]*)/)
    if (pidMatch && nameMatch) {
      const pid = decodeURIComponent(pidMatch[1])
      const pname = decodeURIComponent(nameMatch[1])
      setPlayerId(pid)
      setPlayerName(pname)
      setAuthProvider(pid.startsWith('gh-') ? 'github' : 'guest')
      if (avatarMatch) setAvatarUrl(decodeURIComponent(avatarMatch[1]))
      // Validate session — if hero exists, go to splash
      getHero().then((res) => {
        setHero(res.data)
        setScreen('splash')
      }).catch(() => {
        // Server restarted, need to re-login
        setScreen('login')
      })
    }
  }, [])

  useEffect(() => {
    if (!getPlayerId()) return
    getHero().then((res) => setHero(res.data)).catch(() => {})
    getInventory().then((res) => setInventory(res.data)).catch(() => {})
  }, [playerName])

  // Leave game on tab close
  useEffect(() => {
    const handleUnload = () => {
      const pid = getPlayerId()
      if (pid) {
        navigator.sendBeacon('/api/leave', new Blob([JSON.stringify({ playerId: pid })], { type: 'application/json' }))
      }
    }
    window.addEventListener('beforeunload', handleUnload)
    return () => window.removeEventListener('beforeunload', handleUnload)
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

  // Load configuration
  useEffect(() => {
    if (serviceStatus !== 'online') return
    Promise.all([getKeymap(), getCampaign()]).then(([keyRes, campRes]) => {
      const defaults = JSON.parse((keyRes.data as any).keymapJson || '{}')
      const campData = JSON.parse((campRes.data as any).campaignJson || '{}')
      setDefaultKeymap(defaults)
      setCampaigns([campData])

      const cookieMatch = document.cookie.match(/(?:^|; )wow_settings=([^;]*)/)
      let overrides = {}
      if (cookieMatch) {
         try { overrides = JSON.parse(decodeURIComponent(cookieMatch[1])) } catch {}
      }

      const merged = { ...defaults }
      for (const [id, overrideObj] of Object.entries(overrides)) {
        if (merged[id]) merged[id] = { ...merged[id], ...(overrideObj as any) }
      }
      setKeymap(merged)
    }).catch(console.error)
  }, [serviceStatus])

  // Initial sync — render the world on first load
  useEffect(() => {
    if (screen !== 'game' || serviceStatus !== 'online' || initialSyncDone.current) return
    initialSyncDone.current = true

    const ws = serializeWorldState(gameState)
    syncTurn(ws.playerX, ws.playerY, ws.currentEnemiesJson, 8, ws.level)
      .then(async (res) => {
        applyOverlay(res.data.actions || null)

        const mapData = res.data.map
        if (!mapData.merged_tiles_json) return

        setMapGrid(JSON.parse(mapData.merged_tiles_json))

        // Fetch game state for level name
        try {
          const gsRes = await getGameState()
          if (gsRes.data.levelName) setLevelName(gsRes.data.levelName)
        } catch {}

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
  }, [serviceStatus, screen])

  // Multiplayer polling — refresh map every 2s to see other players move
  const gameStateRef = useRef(gameState)
  gameStateRef.current = gameState

  useEffect(() => {
    if (screen !== 'game' || !isMultiplayer || serviceStatus !== 'online') return
    const interval = setInterval(async () => {
      try {
        const ws = serializeWorldState(gameStateRef.current)
        const res = await syncTurn(ws.playerX, ws.playerY, ws.currentEnemiesJson, 8, ws.level)
        const mapData = res.data.map
        if (mapData?.merged_tiles_json) {
          setMapGrid(JSON.parse(mapData.merged_tiles_json))
        }
        if (res.data.actions) applyOverlay(res.data.actions)
      } catch { /* ignore sync errors */ }
    }, 2000)
    return () => clearInterval(interval)
  }, [screen, isMultiplayer, serviceStatus])

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

  const applyOverlay = useCallback((apiOverlay: Inspector | null) => {
    if (!apiOverlay) {
      setOverlay(null)
      return
    }
    const mapped = { ...apiOverlay }
    if (mapped.actions) {
      mapped.actions = mapped.actions.map(a => {
        let actionId = null;
        for (const [id, def] of Object.entries(defaultKeymap)) {
          if (def.key === a.key) { actionId = id; break; }
        }
        return { ...a, key: actionId && keymap[actionId] ? keymap[actionId].key : a.key }
      })
    }
    setOverlay(mapped)
  }, [defaultKeymap, keymap])

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

      applyOverlay(data.actions || null)

      // Refresh inventory + hero after each action
      getInventory().then((r) => setInventory(r.data)).catch(() => {})
      getHero().then((r) => setHero(r.data)).catch(() => {})
    } catch (err) {
      console.error('Input error:', err)
      addMessage('Connection lost... (services may be offline)', 'system', 'wow')
    }
    setProcessing(false)
  }, [processing, serviceStatus, gameState, appendServiceLogs, addMessage, applyOverlay])

  // Keyboard handler — routes all game keys to server
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (screen !== 'game' || serviceStatus !== 'online') return

      // Inventory modal intercepts its own keys
      if (showInventory) return

      if (processing) return

      let key = e.key

      // Arrow keys → numpad equivalents
      const arrowMap: Record<string, string> = {
        ArrowUp: '8', ArrowDown: '2', ArrowLeft: '4', ArrowRight: '6',
      }
      if (arrowMap[key]) key = arrowMap[key]

      let actionId = null

      for (const [id, def] of Object.entries(keymap)) {
        if (def.key === key) {
          actionId = id
          break
        }
      }

      // Intercept inventory action — open modal instead of sending to server
      if (actionId === 'inventory') {
        e.preventDefault()
        setShowInventory(true)
        return
      }

      if (actionId) {
        e.preventDefault()
        // Send the default key backwards to backend
        const defaultKey = defaultKeymap[actionId]?.key || key
        handleInput(defaultKey)
      }
    }

    if (screen === 'game') {
      window.addEventListener('keydown', handleKeyDown)
    }
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleInput, screen, keymap, defaultKeymap, processing, serviceStatus, showInventory])

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

          const tileStyle = tile.color ? { color: tile.color } : undefined
          return (
            <span key={x} className={tClass} style={tileStyle}>
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

  if (screen === 'login') {
    return (
      <div className="game-container splash-screen" style={{ flexDirection: 'column', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
        <StarfieldBg />
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <pre className="ascii-title" style={{ color: 'var(--terminal-accent)', textShadow: '0 0 30px var(--terminal-accent), 0 0 60px rgba(255,180,84,0.3)', userSelect: 'none', fontSize: '3em', lineHeight: 1.2, fontFamily: 'var(--font-mono)' }}>{
`\u2588   \u2588  \u2588\u2588\u2588  \u2588   \u2588
\u2588   \u2588 \u2588   \u2588 \u2588   \u2588
\u2588 \u2588 \u2588 \u2588   \u2588 \u2588 \u2588 \u2588
\u2588\u2588 \u2588\u2588 \u2588   \u2588 \u2588\u2588 \u2588\u2588
\u2588   \u2588  \u2588\u2588\u2588  \u2588   \u2588`
          }</pre>
          <div style={{ color: 'var(--terminal-dim)', fontSize: '12px', letterSpacing: '6px', textTransform: 'uppercase', marginTop: '8px' }}>
            World of WoW
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '50px', width: '320px' }}>
            <a
              href="/api/auth/github"
              className="splash-btn"
              style={{
                textDecoration: 'none',
                textAlign: 'center',
                pointerEvents: serviceStatus !== 'online' ? 'none' : 'auto',
                opacity: serviceStatus !== 'online' ? 0.5 : 1,
              }}
            >
              Login with GitHub
            </a>
          </div>
          <div style={{ marginTop: '30px', fontSize: '12px', color: 'var(--terminal-dim)' }}>
            Service Status: <span className={`status-dot ${serviceStatus}`} />
          </div>
        </div>
      </div>
    )
  }

  if (screen === 'splash') {
    return (
      <div className="game-container splash-screen" style={{ flexDirection: 'column', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
        <StarfieldBg />
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <pre className="ascii-title" style={{ color: 'var(--terminal-accent)', textShadow: '0 0 30px var(--terminal-accent), 0 0 60px rgba(255,180,84,0.3)', userSelect: 'none', fontSize: '3em', lineHeight: 1.2, fontFamily: 'var(--font-mono)' }}>{
`\u2588   \u2588  \u2588\u2588\u2588  \u2588   \u2588
\u2588   \u2588 \u2588   \u2588 \u2588   \u2588
\u2588 \u2588 \u2588 \u2588   \u2588 \u2588 \u2588 \u2588
\u2588\u2588 \u2588\u2588 \u2588   \u2588 \u2588\u2588 \u2588\u2588
\u2588   \u2588  \u2588\u2588\u2588  \u2588   \u2588`
          }</pre>
          <div className="splash-subtitle" style={{ color: 'var(--terminal-dim)', fontSize: '12px', letterSpacing: '6px', textTransform: 'uppercase', marginTop: '8px' }}>
            World of WoW
          </div>
          {playerName && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '12px' }}>
              {avatarUrl && (
                <img
                  src={avatarUrl}
                  alt=""
                  style={{ width: 28, height: 28, borderRadius: '50%', border: '1px solid var(--terminal-accent)' }}
                />
              )}
              <span style={{ color: 'var(--terminal-accent)', fontSize: '14px', letterSpacing: '2px' }}>
                {playerName}
              </span>
              <button
                onClick={async () => {
                  await logout().catch(() => {})
                  setPlayerId(null)
                  setPlayerName('')
                  setAvatarUrl(null)
                  setAuthProvider(null)
                  setHero(null)
                  document.cookie = 'wow_player_id=; path=/; max-age=0'
                  document.cookie = 'wow_player_name=; path=/; max-age=0'
                  document.cookie = 'wow_github_avatar=; path=/; max-age=0'
                  setScreen('login')
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--terminal-dim)',
                  cursor: 'pointer',
                  fontSize: '12px',
                  textDecoration: 'underline',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                logout
              </button>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '50px', width: '320px' }}>
            <button
              className="splash-btn"
              onClick={() => setScreen('game')}
              disabled={serviceStatus !== 'online'}
            >
              Continue
            </button>
            <button
              className="splash-btn"
              onClick={async () => {
                initialSyncDone.current = false
                setMapGrid([])
                setGameState(createInitialState())
                setHero(null)
                setOverlay(null)
                setLevelName('')
                try {
                  setIsMultiplayer(false)
                  await startNewAdventure('default', playerName || 'Adventurer')
                  const heroRes = await getHero()
                  setHero(heroRes.data)
                  // Set player position to spawn point from hero-service
                  if (heroRes.data) {
                    setGameState(prev => ({
                      ...prev,
                      player: {
                        x: heroRes.data.positionX ?? prev.player.x,
                        y: heroRes.data.positionY ?? prev.player.y,
                      }
                    }))
                  }
                } catch (err) {
                  console.error('New adventure error:', err)
                }
                setScreen('game')
              }}
              disabled={serviceStatus !== 'online' || processing}
            >
              New Adventure
            </button>
            <button
              className="splash-btn"
              onClick={async () => {
                initialSyncDone.current = false
                setMapGrid([])
                setGameState(createInitialState())
                setHero(null)
                setOverlay(null)
                setLevelName('')
                try {
                  setIsMultiplayer(true)
                  const joinRes = await joinGame()
                  const heroRes = await getHero()
                  setHero(heroRes.data)
                  // Set spawn position from server
                  if (joinRes.data.spawnX !== undefined) {
                    setGameState(prev => ({
                      ...prev,
                      player: { x: joinRes.data.spawnX!, y: joinRes.data.spawnY! }
                    }))
                  }
                } catch (err) {
                  console.error('Online join error:', err)
                }
                setScreen('game')
              }}
              disabled={serviceStatus !== 'online' || processing}
            >
              Online
            </button>
            <button
              className="splash-btn"
              onClick={() => setScreen('settings')}
              disabled={serviceStatus !== 'online'}
            >
              Settings
            </button>
          </div>
          <div style={{ marginTop: '30px', fontSize: '12px', color: 'var(--terminal-dim)' }}>
            Service Status: <span className={`status-dot ${serviceStatus}`} />
          </div>
        </div>
      </div>
    )
  }

  if (screen === 'settings') {
    const saveSettings = () => {
      const overrides: Record<string, any> = {}
      for (const [k, v] of Object.entries(keymap)) {
         overrides[k] = { key: v.key }
      }
      document.cookie = `wow_settings=${encodeURIComponent(JSON.stringify(overrides))}; path=/; max-age=31536000`
      setScreen('splash')
    }

    return (
      <div className="game-container settings-screen" style={{ flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '50px', position: 'relative' }}>
         <StarfieldBg />
         <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
           <h1 style={{ color: 'var(--terminal-accent)', marginBottom: '30px' }}>Settings</h1>
           <div className="settings-form" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', width: '600px', overflowY: 'auto' }}>
             {Object.entries(keymap).map(([mapId, mapDef]) => (
               <div key={mapId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(10,14,20,0.7)', padding: '10px', borderRadius: '4px', border: '1px solid var(--terminal-border)' }}>
                  <span style={{ color: 'var(--terminal-dim)', fontSize: '13px' }}>{mapDef.label || mapId}</span>
                  <input
                    style={{ width: '40px', background: 'transparent', border: '1px solid var(--terminal-dim)', color: 'var(--terminal-bright)', textAlign: 'center', padding: '5px', fontFamily: 'var(--font-mono)', borderRadius: '3px' }}
                    value={mapDef.key}
                    maxLength={1}
                    onChange={(e) => setKeymap(prev => ({ ...prev, [mapId]: { ...prev[mapId], key: e.target.value } }))}
                  />
               </div>
             ))}
           </div>
           <div style={{ marginTop: '20px', display: 'flex', gap: '20px' }}>
             <button className="splash-btn" onClick={saveSettings}>
               Save and Return
             </button>
           </div>
         </div>
      </div>
    )
  }

  return (
    <div className="game-container">
      {/* Header */}
      <div className="header-bar">
        <h1 style={{ cursor: 'pointer' }} onClick={() => { leaveGame().catch(() => {}); setScreen('splash') }}>⚔ World of WoW ⚔</h1>
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
          <span className={`status-dot ${serviceStatus}`}>gam</span>
        </div>
      </div>

      {/* Map Panel */}
      <div className="map-panel">
        <div className="panel-title">Dungeon — {levelName || `Level ${gameState.level}`}</div>
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

        {/* Character */}
        <div className="log-panel">
          <div className="panel-title">Character</div>
          <div className="character-body">
            <pre className="body-ascii">{[
'    ┌───┐    ',
'    │o o│    ',
'    │ ▲ │    ',
'    └─┬─┘    ',
'      │      ',
'  ┌───┼───┐  ',
'  │   │   │  ',
'──┤   │   ├──',
'  │   │   │  ',
'  └───┼───┘  ',
'      │      ',
'  ┌───┴───┐  ',
'  │       │  ',
'  │       │  ',
'  └──┬─┬──┘  ',
'     │ │     ',
'     │ │     ',
'    ─┘ └─    ',
            ].join('\n')}</pre>
            <div className="equip-slots">
              {([
                ['head',       'Head    '],
                ['neck',       'Neck    '],
                ['chest',      'Chest   '],
                ['right hand', 'R.Hand  '],
                ['left hand',  'L.Hand  '],
                ['legs',       'Legs    '],
                ['feet',       'Feet    '],
                ['finger',     'Finger  '],
              ] as const).map(([slot, label]) => {
                const items = inventory?.items || []
                const equipped = items.find(it =>
                  it.canFit && it.canFit.includes(slot)
                )
                return (
                  <div key={slot} className={`equip-row ${equipped ? 'filled' : ''}`}>
                    <span className="equip-label">{label}</span>
                    <span className="equip-item">{equipped ? equipped.name : '---'}</span>
                  </div>
                )
              })}
            </div>
            <div className="equip-divider" />
            <div className="equip-gold">Gold: {inventory?.gold ?? 0}</div>
            <div className="equip-capacity">Backpack: {inventory?.items.length ?? 0}/{inventory?.capacity ?? 20}</div>
            <div className="inv-items-list">
              {(inventory?.items || []).map((item, i) => {
                const icon = item.itemType === 'weapon' ? '/' : item.itemType === 'armor' ? '[' : item.itemType === 'potion' ? '!' : item.itemType === 'scroll' ? '?' : '*'
                return (
                  <div key={item.itemId || i} className="inv-item-row">
                    <span className="inv-item-icon">{icon}</span>
                    <span className="inv-item-name">{item.name}</span>
                    {item.quantity > 1 && <span className="inv-item-qty">x{item.quantity}</span>}
                  </div>
                )
              })}
              {(inventory?.items || []).length === 0 && (
                <div className="inv-item-row empty">Backpack is empty</div>
              )}
            </div>
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

        {/* Right third: Event log */}
        <div className="service-log">
          <div className="service-log-title">Event Log</div>
          <div className="service-log-messages">
            {gameState.messages
              .slice()
              .reverse()
              .slice(0, 30)
              .map((msg, i) => (
                <div key={i} className={`log-entry ${msg.type}`}>
                  <span className="log-prefix">{'>'} </span>
                  {msg.text}
                </div>
              ))}
          </div>
        </div>

      </div>

      {/* Inventory Modal */}
      {showInventory && (
        <InventoryModal onClose={() => setShowInventory(false)} />
      )}
    </div>
  )
}

export default App
