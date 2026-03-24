import { useRef, useEffect } from 'react'

// Seeded PRNG for deterministic generation
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

// Draw a pixelated circle by iterating the pixel grid directly
// (no snap-rounding, so no missing chunks)
function drawPixelPlanet(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
  ps: number,
  colorFn: (dx: number, dy: number, dist: number) => string | null,
) {
  // Grid-aligned top-left of bounding box
  const startX = Math.floor((cx - r) / ps) * ps
  const startY = Math.floor((cy - r) / ps) * ps
  const endX = Math.ceil((cx + r) / ps) * ps
  const endY = Math.ceil((cy + r) / ps) * ps

  for (let gy = startY; gy <= endY; gy += ps) {
    for (let gx = startX; gx <= endX; gx += ps) {
      // Center of this grid cell
      const cellCx = gx + ps / 2
      const cellCy = gy + ps / 2
      const dx = cellCx - cx
      const dy = cellCy - cy
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist > r) continue

      const color = colorFn(dx, dy, dist)
      if (!color) continue
      ctx.fillStyle = color
      ctx.fillRect(gx, gy, ps, ps)
    }
  }
}

function generateScene(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const w = canvas.width
  const h = canvas.height
  const ps = 3 // pixel size

  const rand = mulberry32(42)

  // Black space background
  ctx.fillStyle = '#050810'
  ctx.fillRect(0, 0, w, h)

  // Stars
  const starCount = Math.floor((w * h) / 400)
  for (let i = 0; i < starCount; i++) {
    const sx = Math.floor(rand() * w / ps) * ps
    const sy = Math.floor(rand() * h / ps) * ps
    const brightness = 40 + Math.floor(rand() * 180)
    const twinkle = rand()
    if (twinkle > 0.95) {
      const hue = Math.floor(rand() * 360)
      ctx.fillStyle = `hsla(${hue}, 60%, ${50 + Math.floor(rand() * 30)}%, 0.9)`
      ctx.fillRect(sx, sy, ps, ps)
    } else {
      ctx.fillStyle = `rgba(${brightness}, ${brightness}, ${brightness + 20}, ${0.3 + rand() * 0.7})`
      ctx.fillRect(sx, sy, ps, ps)
    }
  }

  // Distant nebula glow
  for (let n = 0; n < 3; n++) {
    const nx = rand() * w
    const ny = rand() * h
    const nr = 80 + rand() * 150
    const hue = [260, 320, 200][n]
    const grad = ctx.createRadialGradient(nx, ny, 0, nx, ny, nr)
    grad.addColorStop(0, `hsla(${hue}, 80%, 30%, 0.08)`)
    grad.addColorStop(0.5, `hsla(${hue}, 60%, 20%, 0.04)`)
    grad.addColorStop(1, 'transparent')
    ctx.fillStyle = grad
    ctx.fillRect(nx - nr, ny - nr, nr * 2, nr * 2)
  }

  // Planets
  const planets = [
    { cx: w * 0.15, cy: h * 0.3, radius: 45, baseHue: 25, rings: false, moons: 1 },
    { cx: w * 0.78, cy: h * 0.25, radius: 60, baseHue: 210, rings: true, moons: 0 },
    { cx: w * 0.5, cy: h * 0.7, radius: 35, baseHue: 140, rings: false, moons: 2 },
    { cx: w * 0.88, cy: h * 0.72, radius: 22, baseHue: 350, rings: false, moons: 0 },
  ]

  for (const planet of planets) {
    const { cx: pcx, cy: pcy, radius, baseHue, rings, moons } = planet

    // Planet body
    drawPixelPlanet(ctx, pcx, pcy, radius, ps, (dx, dy, dist) => {
      const norm = dist / radius
      const lightAngle = Math.atan2(dy, dx) + Math.PI * 0.75
      const lightFactor = Math.cos(lightAngle) * 0.4 + 0.6
      const depthFactor = 1 - norm * 0.3

      const bandNoise = Math.sin(dy * 0.3 + dx * 0.05) * 10
      const lightness = Math.max(8, Math.min(55, 30 * lightFactor * depthFactor + bandNoise))
      const sat = 50 + Math.floor(bandNoise * 2)

      if (lightFactor < 0.35) {
        return `hsl(${baseHue}, ${sat * 0.3}%, ${lightness * 0.2}%)`
      }

      if (norm > 0.85) {
        const glowAlpha = (norm - 0.85) / 0.15
        const glowL = lightness + glowAlpha * 15
        return `hsl(${(baseHue + 30) % 360}, ${sat + 10}%, ${Math.min(60, glowL)}%)`
      }

      return `hsl(${baseHue}, ${sat}%, ${lightness}%)`
    })

    // Rings (drawn on top of planet body)
    if (rings) {
      const ringInner = radius * 1.3
      const ringOuter = radius * 1.9
      const startX = Math.floor((pcx - ringOuter) / ps) * ps
      const startY = Math.floor((pcy - ringOuter) / ps) * ps
      const endX = Math.ceil((pcx + ringOuter) / ps) * ps
      const endY = Math.ceil((pcy + ringOuter) / ps) * ps

      for (let gy = startY; gy <= endY; gy += ps) {
        for (let gx = startX; gx <= endX; gx += ps) {
          const rx = gx + ps / 2 - pcx
          const ry = gy + ps / 2 - pcy
          // Elliptical: stretch Y so ring is thin
          const ex = rx
          const ey = ry * 3
          const dist = Math.sqrt(ex * ex + ey * ey)
          if (dist < ringInner || dist > ringOuter) continue
          // Skip pixels that overlap the planet body (front half)
          if (ry >= 0 && Math.sqrt(rx * rx + ry * ry) < radius) continue

          const ringNorm = (dist - ringInner) / (ringOuter - ringInner)
          const alpha = (1 - Math.abs(ringNorm - 0.5) * 2) * 0.6
          ctx.fillStyle = `hsla(${baseHue + 40}, 30%, 60%, ${alpha})`
          ctx.fillRect(gx, gy, ps, ps)
        }
      }
    }

    // Moons
    for (let m = 0; m < moons; m++) {
      const moonAngle = (m * 2.4) + 0.8
      const moonDist = radius * (1.8 + m * 0.7)
      const mx = pcx + Math.cos(moonAngle) * moonDist
      const my = pcy + Math.sin(moonAngle) * moonDist * 0.6
      const moonR = 5 + m * 2

      drawPixelPlanet(ctx, mx, my, moonR, ps, (dx, dy, dist) => {
        const norm = dist / moonR
        const light = Math.cos(Math.atan2(dy, dx) + Math.PI * 0.75) * 0.4 + 0.6
        const l = Math.max(15, 45 * light * (1 - norm * 0.3))
        return `hsl(${baseHue + 60}, 15%, ${l}%)`
      })
    }
  }
}

export default function StarfieldBg() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const resize = () => {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
      generateScene(canvas)
    }

    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
      }}
    />
  )
}
