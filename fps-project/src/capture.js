/**
 * ═══════════════════════════════════════════════════════════
 * capture.js — loading-screen art shooter (dev only)
 * ───────────────────────────────────────────────────────────
 * Flies a free camera through the Dead Mesa map and writes
 * 1920×1080 JPEGs into static/loading/ as slide-1 … slide-5.jpg,
 * via the POST /__shot/N endpoint (vite-plugin-shot-writer.js).
 *
 * This page loads the MAP ONLY. It never imports FBXLoader and
 * never touches static/character/Y Bot.fbx, so the character
 * cannot appear in the art — that is structural, not a filter.
 *
 * Scene setup mirrors script.js so the stills look like the game:
 *   fog/background  script.js:65-66      lights  script.js:251-264
 *   camera fov 70   script.js:79         city    script.js:1220
 *
 * Served at /capture.html in dev. Vite's only build entry is
 * index.html, so this never ships in dist/.
 * ═══════════════════════════════════════════════════════════
 */

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

// ─────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────
const OUT_W         = 1920
const OUT_H         = 1080
const JPEG_QUALITY  = 0.82     // ~150-400KB on this flat-shaded art; drop to 0.78 if a slide >450KB
const SETTLE_FRAMES = 3        // frames to let texture uploads catch up before grabbing
const STORAGE_KEY   = 'deadmesa.capture.shots.v2'

const FLY_SPEED     = 8        // units/sec (a person is 0.96 tall in this world)
const SPRINT_MUL    = 4
const SLOW_MUL      = 0.25
const YAW_SENS      = 0.0035   // CAM.yawSensitivity   — script.js:74
const PITCH_SENS    = 0.003    // CAM.pitchSensitivity — script.js:75

/**
 * Every shot this tool produces. `file` is both the slot's filename
 * (static/loading/<file>.jpg) and its POST target, so the two can't drift.
 *
 * `overlay` picks what the G safe-zone preview draws on top, matching where
 * text really lands on each image:
 *   slide  — caption bottom-left, as .loading-slide does (style.css:167-175)
 *   center — centred block: the menu panel, or the cutscene's cards
 *
 * Framings measured off scene.gltf (post 0.5 scale): ground/street is
 * y ≈ -22.1, buildings are ~6.4 tall, a person would be 0.96 tall.
 * The sun sits at (8,14,6) with no shadows, so only faces pointing +x/+z are
 * lit — every preset therefore looks toward -x/-z at lit facades.
 * yaw = atan2(-d.x, -d.z), pitch = asin(d.y/|d|) for a pos→target pair.
 */
const SHOTS = [
    { file: 'slide-1',  label: 'DEAD MESA',             overlay: 'slide',
      pos: [  2.0,  -9.0,  22.0 ], yaw: 0.785, pitch: -0.266 },  // wide: town core + buttes
    { file: 'slide-2',  label: 'A Town With No Law',    overlay: 'slide',
      pos: [-21.0, -20.9,   6.0 ], yaw: 0.000, pitch:  0.015 },  // down main street (-z)
    { file: 'slide-3',  label: 'Every Door Has a Story',overlay: 'slide',
      pos: [-22.3, -20.9,   5.3 ], yaw: 0.770, pitch: -0.020 },  // saloon swinging doors
    { file: 'slide-4',  label: 'Ride Into the Dust',    overlay: 'slide',
      pos: [ 11.0, -20.3,  15.0 ], yaw: 1.520, pitch: -0.110 },  // west along the rails
    { file: 'slide-5',  label: 'Welcome to the Frontier', overlay: 'slide',
      pos: [  0.0, -18.6, -15.0 ], yaw: 2.000, pitch: -0.080 },  // NW over the flats at the town
    // ── Shell art (not part of the loading slideshow) ─────────────────────
    { file: 'menu',     label: 'DEAD MESA · menu',      overlay: 'center',
      pos: [ 18.0, -14.0,   6.0 ], yaw: 1.382, pitch: -0.117 },  // hero vista behind the menu panel
    { file: 'cutscene', label: 'New Mexico Territory, 1887', overlay: 'center',
      pos: [ -2.0, -20.6, -14.0 ], yaw: 1.951, pitch:  0.020 },  // town from the SE — intro sepia still
]
const N = SHOTS.length

// ─────────────────────────────────────────
// DOM
// ─────────────────────────────────────────
const canvas  = document.getElementById('canvas')
const hudEl   = document.getElementById('hud')
const logEl   = document.getElementById('log')
const safeEl   = document.getElementById('safe')
const capEl    = safeEl.querySelector('.safe-caption')
const centerEl = safeEl.querySelector('.safe-center')
const banner   = document.getElementById('banner')

// ─────────────────────────────────────────
// SCENE — mirrors script.js:64-66
// ─────────────────────────────────────────
const scene = new THREE.Scene()
scene.background = new THREE.Color(0xc9a96e)
scene.fog        = new THREE.FogExp2(0xc9a96e, 0.012)

// script.js:79 — same fov/near/far, but aspect is pinned to 16:9 forever
const camera = new THREE.PerspectiveCamera(70, OUT_W / OUT_H, 0.05, 300)
camera.rotation.order = 'YXZ'

// ─────────────────────────────────────────
// RENDERER
// The drawing buffer is fixed at output size from the first frame and CSS
// scales it (capture.html #frame), so the preview IS the export — no resize
// dance at capture time, which is where this kind of tool usually goes wrong.
// ─────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true,
    powerPreference: 'high-performance',
    stencil: false,
    preserveDrawingBuffer: true,   // capture-only; no effect on rendered pixels
})
renderer.setPixelRatio(1)                    // must precede setSize — setSize multiplies by it
renderer.setSize(OUT_W, OUT_H, false)        // false = leave CSS size alone
renderer.shadowMap.enabled = false           // SHADOW.enabled — script.js:87
// no toneMapping / outputColorSpace overrides: r165 defaults, same as the game

// ─────────────────────────────────────────
// LIGHTING — script.js:251-264 (shadows off)
// ─────────────────────────────────────────
scene.add(new THREE.AmbientLight(0xffffff, 0.45))
const sunLight = new THREE.DirectionalLight(0xffeedd, 1.3)
sunLight.position.set(8, 14, 6)
sunLight.castShadow = false
scene.add(sunLight)

// ─────────────────────────────────────────
// STATE
// ─────────────────────────────────────────
let city       = null
let cityReady  = false
let exporting  = false
let slot       = 0
let showSafe   = false
let hudVisible = true
let locked     = false
let yaw = SHOTS[0].yaw
let pitch = SHOTS[0].pitch
let derived = new Set()          // slots that failed sanity-check and were auto-placed

/** The framing a slot ships with, detached from its label/filename. */
const shotDefault = (i) => ({ pos: [...SHOTS[i].pos], yaw: SHOTS[i].yaw, pitch: SHOTS[i].pitch })
const allDefaults = () => SHOTS.map((_, i) => shotDefault(i))

const cloudObjects = []
const keys = Object.create(null)

// ─────────────────────────────────────────
// CITY LOAD
// Plain GLTF — no Rapier colliders, no InstancedMesh bucketing, no
// mergeGeometries. Those are draw-call optimisations in the game; they produce
// pixel-identical output, and a still doesn't care about throughput.
// ─────────────────────────────────────────
async function loadCity() {
    const loader = new GLTFLoader()
    const gltf = await new Promise((res, rej) =>
        loader.load('/map/scene.gltf', res,
            (e) => {
                if (e.total) banner.textContent =
                    `LOADING MAP… ${(e.loaded / 1048576).toFixed(1)} / ${(e.total / 1048576).toFixed(1)} MB`
            },
            rej))

    city = gltf.scene
    city.scale.setScalar(0.5)        // script.js:1220

    const maxAniso = renderer.capabilities.getMaxAnisotropy()
    const seenTex  = new Set()

    city.traverse(c => {
        if (c.name?.startsWith('SM_Env_Cloud')) {    // HIDEABLE_PREFIXES — script.js:1203
            cloudObjects.push(c)
            c.visible = false
            return
        }
        if (!c.isMesh) return
        c.castShadow = c.receiveShadow = false

        // The game drops mipmaps here for framerate (script.js:1278-1281). A still
        // is the worst case for that: distant roofs and road tiles sample far below
        // one texel per pixel, and JPEG turns the resulting noise into blocks AND
        // spends bits on it. Keep the loader's defaults, and add anisotropy for the
        // grazing-angle ground in the street/rail shots.
        for (const m of (Array.isArray(c.material) ? c.material : [c.material])) {
            const t = m?.map
            if (t && !seenTex.has(t)) { seenTex.add(t); t.anisotropy = maxAniso; t.needsUpdate = true }
        }
    })

    scene.add(city)
    cityReady = true
}

/**
 * Bounding box of the town's STRUCTURES only.
 * Box3.setFromObject(city) is useless here: the symmetric 2193×2365 sand plane
 * and the cloud layer put its centre at exactly (0,0,0), which is ~22 units of
 * empty air above the desert. A camera aimed there sees sky.
 */
function townBox(root) {
    const box = new THREE.Box3().makeEmpty()
    const tmp = new THREE.Box3()
    root.traverse(o => {
        if (!o.isMesh) return
        if (!/^SM_(Bld|Building)/.test(o.name || '')) return
        box.union(tmp.setFromObject(o))
    })
    if (box.isEmpty()) {                       // map swapped for something else entirely
        box.setFromObject(root)
        const c = box.getCenter(new THREE.Vector3())
        box.setFromCenterAndSize(c, box.getSize(new THREE.Vector3()).multiplyScalar(0.25))
    }
    return box
}

/** Safety net: one orbiting view per slot around the structures, if a preset is bad. */
function deriveDefaults(box) {
    const c = box.getCenter(new THREE.Vector3())
    const s = box.getSize(new THREE.Vector3())
    const ground = box.min.y
    const r = Math.max(s.x, s.z) * 0.8
    // Sit on the +x/+z (lit) side and look back toward -x/-z.
    const rings = [
        { ang: Math.PI * 0.25, dist: r * 1.10, h: s.y * 2.0 },
        { ang: Math.PI * 0.00, dist: r * 0.45, h: 1.2 },
        { ang: Math.PI * 0.20, dist: r * 0.25, h: 1.0 },
        { ang: Math.PI * 0.55, dist: r * 1.30, h: 1.1 },
        { ang: Math.PI * 0.80, dist: r * 1.20, h: 2.0 },
        { ang: Math.PI * 0.40, dist: r * 1.15, h: s.y * 1.4 },   // menu
        { ang: Math.PI * 0.65, dist: r * 1.45, h: 1.3 },         // cutscene
    ].slice(0, N)
    return rings.map(({ ang, dist, h }) => {
        const pos = new THREE.Vector3(c.x + Math.sin(ang) * dist, ground + h, c.z + Math.cos(ang) * dist)
        const tgt = new THREE.Vector3(c.x, ground + Math.min(h, s.y * 0.5), c.z)
        const d   = tgt.clone().sub(pos)
        return { pos: pos.toArray(), yaw: Math.atan2(-d.x, -d.z), pitch: Math.asin(d.y / d.length()) }
    })
}

// ─────────────────────────────────────────
// SHOT SLOTS (persisted — a reload must never cost you the framing,
// because it also costs another 40MB glTF load)
// ─────────────────────────────────────────
let shots = allDefaults()

const sane = s => !!s && Array.isArray(s.pos) && s.pos.length === 3 &&
                  s.pos.every(Number.isFinite) &&
                  Number.isFinite(s.yaw) && Number.isFinite(s.pitch)

function loadShots() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY))
        if (!Array.isArray(raw) || raw.length !== N) return allDefaults()
        return raw.map((s, i) => sane(s) ? s : shotDefault(i))
    } catch { return allDefaults() }
}

function saveShots() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(shots)) } catch { /* private mode */ }
}

/** Reject slots that sit outside a generous box around the town, and derive those. */
function validateShots() {
    if (!city) return
    const town     = townBox(city)
    const fallback = deriveDefaults(town)
    const box      = town.clone().expandByScalar(
        Math.max(60, town.getSize(new THREE.Vector3()).length()))
    derived = new Set()
    shots = shots.map((s, i) => {
        if (sane(s) && box.containsPoint(new THREE.Vector3().fromArray(s.pos))) return s
        derived.add(i)
        return fallback[i]
    })
}

function applyShot(s) {
    camera.position.fromArray(s.pos)
    yaw = s.yaw
    pitch = s.pitch
    camera.rotation.set(pitch, yaw, 0)
    camera.updateMatrixWorld(true)
}

function storeShot(i) {
    shots[i] = { pos: camera.position.toArray(), yaw, pitch }
    derived.delete(i)
    saveShots()
    log(`slot ${i + 1} stored`)
}

// ─────────────────────────────────────────
// CONTROLS — pointer lock, same idiom as script.js:648-658
// ─────────────────────────────────────────
canvas.addEventListener('click', () => { if (!locked) canvas.requestPointerLock() })
document.addEventListener('pointerlockchange', () => { locked = document.pointerLockElement === canvas })

document.addEventListener('mousemove', (e) => {
    if (!locked || exporting) return
    yaw   -= e.movementX * YAW_SENS
    // NOTE the sign: the game uses += because its camera ORBITS the player
    // (script.js:1443) — raising pitch lifts the camera and it looks back down.
    // A first-person free-fly camera needs -= so mouse-down looks down.
    pitch -= e.movementY * PITCH_SENS
    pitch  = THREE.MathUtils.clamp(pitch, -1.5, 1.5)
})

document.addEventListener('keydown', (e) => {
    keys[e.code] = true
    if (e.repeat) return

    // Slot recall works without pointer lock, so you can frame from a preset
    // and only then click in to fly.
    if (e.code.startsWith('Digit')) {
        const n = +e.code.slice(5)
        if (n >= 1 && n <= N) { slot = n - 1; applyShot(shots[slot]); syncCaption(); return }
    }

    switch (e.code) {
        case 'Enter':        storeShot(slot); break
        case 'BracketLeft':  slot = (slot + N - 1) % N; applyShot(shots[slot]); syncCaption(); break
        case 'BracketRight': slot = (slot + 1) % N;     applyShot(shots[slot]); syncCaption(); break
        case 'KeyP':         exportSlots([slot]); break
        case 'KeyX':         exportSlots(SHOTS.map((_, i) => i)); break
        case 'KeyG':         showSafe = !showSafe; safeEl.classList.toggle('on', showSafe); break
        case 'KeyC':         cloudObjects.forEach(c => c.visible = !c.visible); break
        case 'KeyH':         hudVisible = !hudVisible
                             hudEl.classList.toggle('off', !hudVisible)
                             logEl.classList.toggle('off', !hudVisible); break
        case 'KeyR':
            if (e.shiftKey) { shots = allDefaults(); validateShots(); log('all slots reset') }
            else            { shots[slot] = shotDefault(slot); log(`slot ${slot + 1} reset`) }
            applyShot(shots[slot]); saveShots(); break
        default: return
    }
    e.preventDefault()
})
document.addEventListener('keyup', (e) => { keys[e.code] = false })

const WORLD_UP = new THREE.Vector3(0, 1, 0)
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _move = new THREE.Vector3()

function fly(dt) {
    if (exporting) return
    camera.rotation.set(pitch, yaw, 0)

    const f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0)
    const r = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0)
    const u = (keys.KeyE ? 1 : 0) - (keys.KeyQ ? 1 : 0)
    if (!f && !r && !u) return

    camera.getWorldDirection(_fwd)
    _right.crossVectors(_fwd, WORLD_UP).normalize()

    _move.set(0, 0, 0)
        .addScaledVector(_fwd,   f)
        .addScaledVector(_right, r)
        .addScaledVector(WORLD_UP, u)

    const mul = (keys.ShiftLeft || keys.ShiftRight) ? SPRINT_MUL
              : (keys.ControlLeft || keys.ControlRight) ? SLOW_MUL : 1
    camera.position.addScaledVector(_move.normalize(), FLY_SPEED * mul * dt)
}

// ─────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────
const nextFrame = () => new Promise(r => requestAnimationFrame(r))

/**
 * Render and snapshot in ONE synchronous block. With preserveDrawingBuffer the
 * buffer survives compositing anyway, but keeping the pair atomic is what makes
 * this correct rather than lucky — `render(); await x; toBlob()` yields black.
 */
function grabJpeg() {
    renderer.render(scene, camera)
    return new Promise((res, rej) =>
        canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob returned null')),
                      'image/jpeg', JPEG_QUALITY))
}

async function exportSlots(indices) {
    if (!cityReady) { log('map still loading — wait', 'warn'); return }
    if (exporting)  return

    exporting = true                           // stops the rAF loop rendering underneath us
    const restore = { pos: camera.position.toArray(), yaw, pitch }

    try {
        for (const i of indices) {
            applyShot(shots[i])
            // First visit to a viewpoint is where newly-unculled meshes upload their
            // textures. Without these frames a slide can ship missing a building.
            for (let f = 0; f < SETTLE_FRAMES; f++) { renderer.render(scene, camera); await nextFrame() }

            const blob = await grabJpeg()
            const kb   = (blob.size / 1024).toFixed(1)
            const file = SHOTS[i].file

            const res = await fetch(`/__shot/${file}`, {
                method: 'POST',
                headers: { 'Content-Type': 'image/jpeg' },
                body: blob,
            })

            if (res.ok) {
                log(`${file}.jpg  ${kb} KB  ✓${blob.size > 450 * 1024 ? '  (large — try quality 0.78)' : ''}`)
            } else {
                log(`${file}.jpg  ✗ ${res.status} ${(await res.text()).slice(0, 60)}`, 'err')
                break
            }
        }
    } catch (err) {
        log(`export failed: ${err.message}`, 'err')
    } finally {
        exporting = false
        applyShot(restore)
    }
}

// ─────────────────────────────────────────
// HUD
// ─────────────────────────────────────────
const logLines = []
function log(msg, cls = '') {
    logLines.push(cls ? `<span class="${cls}">${msg}</span>` : msg)
    while (logLines.length > 8) logLines.shift()
    logEl.innerHTML = logLines.join('\n')
    logEl.classList.toggle('off', !hudVisible)
}

/** Point the safe-zone preview at the current slot: caption text + which
 *  overlay layout actually sits on this image once it ships. */
function syncCaption() {
    const s = SHOTS[slot]
    capEl.textContent = s.label
    centerEl.textContent = s.label
    safeEl.dataset.overlay = s.overlay
}

const f2 = n => (n < 0 ? '' : ' ') + n.toFixed(2)
function drawHud() {
    const p = camera.position
    hudEl.innerHTML =
`<span class="k">SLOT ${slot + 1}/${N}</span>  ${SHOTS[slot].file}.jpg${derived.has(slot) ? ' <span class="warn">[derived]</span>' : ''}
<span class="dim">"${SHOTS[slot].label}"</span>
pos ${f2(p.x)},${f2(p.y)},${f2(p.z)}
yaw ${f2(yaw)}   pitch ${f2(pitch)}   ${locked ? 'flying' : '<span class="dim">click canvas to fly</span>'}
<span class="dim">──────────────────────────────────</span>
<span class="k">WASD/QE</span> fly   <span class="k">Shift</span> fast   <span class="k">Ctrl</span> slow
<span class="k">1..${N}</span> recall slot     <span class="k">[ ]</span> prev/next
<span class="dim">      1-5 slides · 6 menu · 7 cutscene</span>
<span class="k">Enter</span> store current view in slot
<span class="k">P</span> export this slot   <span class="k">X</span> export all ${N}
<span class="k">G</span> caption/safe-zone  <span class="k">C</span> clouds  <span class="k">H</span> hud
<span class="k">R</span> reset slot   <span class="k">Shift+R</span> reset all
<span class="dim">→ static/loading/*.jpg  (${OUT_W}×${OUT_H})</span>`
}

// ─────────────────────────────────────────
// LOOP
// ─────────────────────────────────────────
const clock = new THREE.Clock()
let hudTimer = 0

function tick() {
    // Clamped so a stall (the 40MB load, an alt-tab) can't teleport you into the next county.
    const dt = Math.min(clock.getDelta(), 0.1)

    fly(dt)

    hudTimer += dt
    if (hudTimer > 0.1) { hudTimer = 0; drawHud() }

    if (!exporting) renderer.render(scene, camera)
    requestAnimationFrame(tick)
}

// ─────────────────────────────────────────
// AUTOMATION HOOK
// Lets the console — or a headless browser over CDP — drive the export without
// keyboard input, e.g.  await __capture.exportAll()
// ─────────────────────────────────────────
window.__capture = {
    get ready()  { return cityReady },
    get slots()  { return shots },
    get files()  { return SHOTS.map(s => s.file) },
    exportAll:  ()  => exportSlots(SHOTS.map((_, i) => i)),
    exportSlot: (n) => exportSlots([n - 1]),
    setShot:    (n, pos, y, p) => { shots[n - 1] = { pos, yaw: y, pitch: p }; saveShots() },
}

// ─────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────
shots = loadShots()
applyShot(shots[slot])
syncCaption()
drawHud()
tick()

loadCity()
    .then(() => {
        validateShots()
        applyShot(shots[slot])
        banner.classList.add('off')
        log(`map ready — ${N} slots, press X to export all`)
        if (derived.size) log(`slots ${[...derived].map(i => i + 1).join(',')} auto-placed`, 'warn')
    })
    .catch(err => {
        banner.textContent = 'MAP FAILED TO LOAD — see console'
        console.error('[capture] map load failed', err)
    })
