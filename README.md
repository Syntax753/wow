# World of WoW

A multiplayer ASCII dungeon crawler inspired by NetHack and classic roguelikes. Explore procedurally generated dungeons, open doors to discover new rooms, descend deeper into darkness, and see other players moving through the world in real time.

```
  ####          ####
  #..#    ##    #..#
  #..+....##....+..#
  #..#    ##    #..#
  ####    ##    ####
          ##
      ####..####
      #........#
      #...@....#
      #........#
      ####..####
```

## Play

Visit the live game or run locally:

```bash
npm install
npm run dev
```

Open `http://localhost:8080` and click **Play as Guest**. Enter a name and you're in.

## Controls

Movement uses the numpad in 8 directions:

```
7 8 9      NW  N  NE
4   6       W     E
1 2 3      SW  S  SE
```

| Key | Action |
|-----|--------|
| `o` | Open a nearby door |
| `c` | Close a nearby doorway |
| `s` | Search the area |
| `<` | Ascend stairs |
| `>` | Descend stairs |
| `i` | Open inventory |
| `5` | Wait one turn |
| `+` | Zoom in |
| `-` | Zoom out |

Context-sensitive actions appear in the sidebar when you're near interactable objects like doors or staircases.

## The Campaign: Descent into Darkness

A 10-level dungeon crawl through an ancient underground stronghold.

| Level | Name | Environment |
|-------|------|-------------|
| 0 | The Village | An open outdoor village with full visibility |
| 1 | The Entrance | Wide stone corridors and crypts |
| 2 | The Warrens | Narrow tunnels and cramped chambers |
| 3 | Flooded Crypts | Ankle-deep water and decay |
| 4 | The Forge | Ancient dwarven forges with faint embers |
| 5 | Fungal Caverns | Bioluminescent fungi in vast caverns |
| 6 | The Labyrinth | A confusing maze built to trap intruders |
| 7 | Obsidian Depths | Black volcanic glass walls |
| 8 | The Abyssal Halls | Ancient runes pulse in living darkness |
| 9 | The Dragon's Lair | Gold glitters. Something stirs. |

Each level is procedurally generated using BSP (Binary Space Partitioning) with increasing size, enemy count, and difficulty.

## Gameplay

### Exploration

You start in a village and descend through a staircase into the dungeon. Each level is generated the first time any player reaches it. Rooms are connected by corridors, and doors (`+`) block your path until you open them — revealing new rooms and corridors beyond.

### Visibility

In dungeons, you carry a limited circle of light. You can only see tiles within your light radius, computed by raycasting from your position. Walls block line of sight. Tiles you've seen before remain dimly visible as fog of war.

In outdoor areas like the village, you have full visibility across the entire map.

Items like torches can extend your light radius.

### Multiplayer

All players share the same world. When one player opens a door or descends to a new level, everyone sees the change. Other players appear as yellow `@` symbols, updated in real time via server-sent events.

### Enemies

Enemies spawn procedurally based on D&D encounter rules. Each room has a 25% chance of containing enemies, determined by a hash of the room's position. Enemy difficulty scales with dungeon level.

### Tile Reference

| Symbol | Meaning |
|--------|---------|
| `@` | You (green) or another player (yellow) |
| `.` | Floor |
| `#` | Wall |
| `+` | Closed door |
| `<` | Stairs up |
| `>` | Stairs down |
| `:` | Corridor |

## Architecture

Built as a microservices monorepo with 14 gRPC services coordinating game logic, all running in a single container on Google Cloud Run. See [CLAUDE.md](CLAUDE.md) for technical details.
