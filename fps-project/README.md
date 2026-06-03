# Animated Character — Three.js Project

> **Concepts:** Models · Ray-caster · Physics (Rapier3D)

## Setup

```bash
npm install
npm run dev
```

## Adding Your Character Model

1. Download a GLB from [Sketchfab](https://sketchfab.com) — choose one with multiple animation clips embedded (Idle, Walk, Run, Jump, etc.)
2. Place it at: `static/models/character.glb`
3. The scene auto-discovers all animation clips — no code changes needed

If no GLB is provided, a fallback capsule mesh is shown so the scene always runs.

## Controls

| Input | Action |
|---|---|
| `Click on character` | Cycle animations (raycaster) |
| `W / A / S / D` | Move character |
| `Space` | Jump |
| `Mouse drag` | Orbit camera |

## Mini-Game

Collect all 5 golden coins scattered around the scene (+100 pts each).  
Two coins sit on elevated platforms — you'll need to navigate up to reach them.

## Project Structure

```
src/
  index.html   — HTML entry + HUD overlay (student name / project name)
  style.css    — HUD, overlay, loading screen styles
  script.js    — All Three.js + Rapier + raycaster logic (heavily commented)
static/
  models/      — Place character.glb here
vite.config.js
package.json
```

## Objectives Checklist

- [x] Plane with physics (static rigid body ground)
- [x] Character model loaded via GLTFLoader
- [x] Multiple animation clips auto-registered
- [x] Raycaster → click model → cycle animations
- [x] Physics: gravity, dynamic rigid body, capsule collider
- [x] Mini-game: WASD movement + jump + coin collecting
- [x] Name + project overlay (mandatory)
- [x] Vite dev server

## Bonus

- [x] Physics-based character with jump impulse
- [x] Elevated platforms as obstacles
- [x] Spinning torus obstacle decoration
- [x] Score system with coin collection
- [x] Smooth animation blending (fadeIn/fadeOut)
- [x] Animation state machine (Idle → Walk → Jump)
