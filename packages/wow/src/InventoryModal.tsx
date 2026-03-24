import { useState, useEffect } from 'react'
import { getInventory, type Item } from './api'

// Equipment slot definitions with body positions
// Each slot's `bodyPart` matches the canFit values on Items
const EQUIPMENT_SLOTS = [
  { id: 'head',       label: 'Head',       bodyPart: 'head',       x: 50,  y: 4,   lineToX: 50, lineToY: 12 },
  { id: 'neck',       label: 'Neck',       bodyPart: 'neck',       x: 82,  y: 14,  lineToX: 55, lineToY: 18 },
  { id: 'chest',      label: 'Chest',      bodyPart: 'chest',      x: 14,  y: 28,  lineToX: 43, lineToY: 32 },
  { id: 'right_hand', label: 'R.Hand',     bodyPart: 'right hand', x: 14,  y: 48,  lineToX: 35, lineToY: 42 },
  { id: 'left_hand',  label: 'L.Hand',     bodyPart: 'left hand',  x: 82,  y: 42,  lineToX: 65, lineToY: 42 },
  { id: 'legs',       label: 'Legs',       bodyPart: 'legs',       x: 14,  y: 65,  lineToX: 43, lineToY: 60 },
  { id: 'feet',       label: 'Feet',       bodyPart: 'feet',       x: 82,  y: 75,  lineToX: 55, lineToY: 78 },
  { id: 'finger',     label: 'Finger',     bodyPart: 'finger',     x: 82,  y: 55,  lineToX: 65, lineToY: 50 },
] as const

type SlotId = typeof EQUIPMENT_SLOTS[number]['id']

interface Props {
  onClose: () => void
}

// ASCII body silhouette
const BODY_ART = `
      .---.
     / o o \\
     |  ^  |
      \\_-_/
       | |
   .---' '---.
  /  |     |  \\
 /   |     |   \\
      |   |
      |   |
      |   |
     /     \\
    /       \\
   /    |    \\
  /     |     \\
       / \\
      /   \\
     /     \\
    '       '
`

export default function InventoryModal({ onClose }: Props) {
  const [backpack, setBackpack] = useState<Item[]>([])
  const [equipped, setEquipped] = useState<Record<SlotId, Item | null>>({
    head: null, neck: null, chest: null, right_hand: null,
    left_hand: null, legs: null, feet: null, finger: null,
  })
  const [dragItem, setDragItem] = useState<{ item: Item; source: 'backpack' | SlotId } | null>(null)
  const [hoverSlot, setHoverSlot] = useState<string | null>(null)
  const [selectedItem, setSelectedItem] = useState<Item | null>(null)
  const [loading, setLoading] = useState(true)

  // Load inventory from server
  useEffect(() => {
    getInventory()
      .then((res) => {
        const items = res.data.items || []
        setBackpack(items)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  // Close on Escape or 'i'
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'i' || e.key === 'I') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  // Drag handlers
  const onDragStartBackpack = (e: React.DragEvent, item: Item) => {
    setDragItem({ item, source: 'backpack' })
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', item.itemId)
  }

  const onDragStartSlot = (e: React.DragEvent, slotId: SlotId, item: Item) => {
    setDragItem({ item, source: slotId })
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', item.itemId)
  }

  const onDropSlot = (e: React.DragEvent, slotId: SlotId) => {
    e.preventDefault()
    setHoverSlot(null)
    if (!dragItem) return

    const { item, source } = dragItem

    if (source === 'backpack') {
      // Move from backpack to slot
      const existingInSlot = equipped[slotId]

      setEquipped(prev => ({ ...prev, [slotId]: item }))
      setBackpack(prev => {
        const next = prev.filter(i => i.itemId !== item.itemId)
        if (existingInSlot) next.push(existingInSlot) // swap back
        return next
      })
    } else {
      // Move from one slot to another
      const existingInSlot = equipped[slotId]
      setEquipped(prev => ({
        ...prev,
        [slotId]: item,
        [source]: existingInSlot || null,
      }))
    }

    setDragItem(null)
  }

  const onDropBackpack = (e: React.DragEvent) => {
    e.preventDefault()
    if (!dragItem) return

    const { item, source } = dragItem

    if (source !== 'backpack') {
      // Unequip from slot back to backpack
      setEquipped(prev => ({ ...prev, [source]: null }))
      setBackpack(prev => [...prev, item])
    }

    setDragItem(null)
  }

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  const getItemIcon = (item: Item): string => {
    switch (item.itemType) {
      case 'weapon': return '/'
      case 'armor': return '['
      case 'potion': return '!'
      case 'scroll': return '?'
      case 'key': return '-'
      default: return '*'
    }
  }

  const getItemColor = (item: Item): string => {
    switch (item.itemType) {
      case 'weapon': return 'var(--terminal-red)'
      case 'armor': return 'var(--terminal-blue)'
      case 'potion': return 'var(--terminal-green)'
      case 'scroll': return 'var(--terminal-magenta)'
      case 'key': return 'var(--terminal-yellow)'
      default: return 'var(--terminal-accent)'
    }
  }

  return (
    <div className="inv-backdrop" onClick={onClose}>
      <div className="inv-modal" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="inv-header">
          <span className="inv-title">Inventory</span>
          <span className="inv-close" onClick={onClose}>[ESC]</span>
        </div>

        <div className="inv-body">

          {/* Left half — Equipment / Body */}
          <div className="inv-equipment">
            <div className="inv-section-title">Equipment</div>
            <div className="inv-body-area">

              {/* Ghost body silhouette */}
              <pre className="inv-silhouette">{BODY_ART}</pre>

              {/* SVG connector lines */}
              <svg className="inv-lines" viewBox="0 0 100 90" preserveAspectRatio="none">
                {EQUIPMENT_SLOTS.map(slot => (
                  <line
                    key={slot.id}
                    x1={slot.x} y1={slot.y + 4}
                    x2={slot.lineToX} y2={slot.lineToY}
                    stroke="var(--terminal-dim)"
                    strokeWidth="0.3"
                    strokeDasharray="1,1"
                    opacity={hoverSlot === slot.id ? 1 : 0.4}
                  />
                ))}
              </svg>

              {/* Equipment slots */}
              {EQUIPMENT_SLOTS.map(slot => {
                const item = equipped[slot.id]
                const isOver = hoverSlot === slot.id
                return (
                  <div
                    key={slot.id}
                    className={`inv-slot ${item ? 'filled' : 'empty'} ${isOver ? 'drag-over' : ''}`}
                    style={{ left: `${slot.x}%`, top: `${slot.y}%` }}
                    onDragOver={(e) => { onDragOver(e); setHoverSlot(slot.id) }}
                    onDragLeave={() => setHoverSlot(null)}
                    onDrop={(e) => onDropSlot(e, slot.id)}
                    onClick={() => item && setSelectedItem(item)}
                  >
                    {item ? (
                      <span
                        className="inv-slot-icon"
                        style={{ color: getItemColor(item) }}
                        draggable
                        onDragStart={(e) => onDragStartSlot(e, slot.id, item)}
                        title={item.name}
                      >
                        {getItemIcon(item)}
                      </span>
                    ) : (
                      <span className="inv-slot-label">{slot.label}</span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Right half — Backpack */}
          <div className="inv-backpack">
            <div className="inv-section-title">Backpack</div>

            {loading ? (
              <div className="inv-loading">Loading...</div>
            ) : (
              <div
                className="inv-grid"
                onDragOver={onDragOver}
                onDrop={onDropBackpack}
              >
                {backpack.map((item) => (
                  <div
                    key={item.itemId}
                    className={`inv-item ${selectedItem?.itemId === item.itemId ? 'selected' : ''}`}
                    draggable
                    onDragStart={(e) => onDragStartBackpack(e, item)}
                    onClick={() => setSelectedItem(item)}
                  >
                    <span className="inv-item-icon" style={{ color: getItemColor(item) }}>
                      {getItemIcon(item)}
                    </span>
                    <span className="inv-item-name">{item.name}</span>
                    {item.quantity > 1 && (
                      <span className="inv-item-qty">x{item.quantity}</span>
                    )}
                  </div>
                ))}

                {/* Empty grid cells to show capacity */}
                {Array.from({ length: Math.max(0, 20 - backpack.length) }).map((_, i) => (
                  <div key={`empty-${i}`} className="inv-item empty-cell" onDragOver={onDragOver} onDrop={onDropBackpack} />
                ))}
              </div>
            )}

            {/* Item detail tooltip */}
            {selectedItem && (
              <div className="inv-detail">
                <div className="inv-detail-name" style={{ color: getItemColor(selectedItem) }}>
                  {getItemIcon(selectedItem)} {selectedItem.name}
                </div>
                <div className="inv-detail-type">{selectedItem.itemType}</div>
                <div className="inv-detail-desc">{selectedItem.description}</div>
                {selectedItem.modifiers && Object.keys(selectedItem.modifiers).length > 0 && (
                  <div className="inv-detail-mods">
                    {Object.entries(selectedItem.modifiers).map(([stat, val]) => (
                      <span key={stat} className={`inv-mod ${val > 0 ? 'pos' : 'neg'}`}>
                        {stat} {val > 0 ? '+' : ''}{val}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  )
}
