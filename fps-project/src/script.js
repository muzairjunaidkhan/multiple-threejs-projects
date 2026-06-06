/**
 * ═══════════════════════════════════════════════════════════
 * script.js — Third-Person Animated Character Controller
 * ───────────────────────────────────────────────────────────
 * Tech: Three.js · Rapier3D · lil-gui · Vite
 *
 * Three systems kept in sync every frame:
 *   1. Physics body  — a Rapier capsule (gravity, collision, movement)
 *   2. Visual model  — the FBX Y-Bot mesh, follows the capsule
 *   3. Animation FSM — picks Idle / Walk / Run / Jump from real motion
 *
 * The animation state machine uses HYSTERESIS on its thresholds: the speed
 * needed to *enter* a faster state is higher than the speed needed to *leave*
 * it. That dead-band is what stops the Walk/Run clips from restarting over and
 * over when the measured speed jitters around a single threshold.
 * ═══════════════════════════════════════════════════════════
 */

import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import RAPIER from '@dimforge/rapier3d-compat'
import GUI from 'lil-gui'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// ─────────────────────────────────────────
// TUNING CONSTANTS
// ─────────────────────────────────────────
const FIXED_TIME_STEP = 1 / 60        // physics runs at a fixed 60 Hz
const MAX_SUBSTEPS = 4                 // clamp catch-up steps after a stall

const GRAVITY = -24                    // m/s² (snappier than real 9.81)

const CAPSULE_RADIUS = 0.18        // slimmer — fits through narrower doors
const CAPSULE_HALF_HEIGHT = 0.45
const CAPSULE_BOTTOM = CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS   // 0.63

// Ground ray: start just below the body centre (still inside the capsule) and
// cast straight down, excluding the character's own collider so it can't
// self-hit. The small margin lets us detect the floor a fraction before the
// feet actually touch, which feels responsive.
const RAY_ORIGIN_OFFSET = 0.40                       // up from feet, stays inside capsule
const RAY_LENGTH = CAPSULE_BOTTOM + 0.15             // 0.90

// Movement
const WALK_SPEED = 2.2
const RUN_SPEED = 5.0
const JUMP_SPEED = 8.0                 // initial upward velocity on jump
const AIR_CONTROL = 0.12               // 0 = no air steering, 1 = full instant
const COYOTE_TIME = 0.10               // grace to still jump just after leaving ground
const JUMP_BUFFER = 0.12               // remember a jump press made just before landing

// Animation crossfade duration (seconds)
const FADE = 0.2

// Locomotion speed thresholds WITH HYSTERESIS (enter > exit forms a dead-band).
const SPEED = {
    walkEnter: 0.6,    // idle → walk
    walkExit: 0.3,     // walk → idle
    runEnter: 3.6,     // walk → run
    runExit: 3.0,      // run  → walk
}
const cloudObjects = []   // filled during loadCity(), toggled by GUI


// // ─────────────────────────────────────────
// // LEVEL DEFINITION
// // ─────────────────────────────────────────
// const LEVEL_PLATFORMS = [
//     { x: -5, y: 0.8, z: -5, w: 4, h: 0.4, d: 4 },
//     { x: 5, y: 2, z: -5, w: 4, h: 0.4, d: 4 },
//     { x: 0, y: 0.6, z: 5, w: 6, h: 0.4, d: 2 },
//     { x: -8, y: 1.2, z: 0, w: 3, h: 0.4, d: 3 },
// ]
// const LEVEL_BOXES = [
//     { x: 3, y: 0.5, z: 0, w: 1, h: 1, d: 1 },
//     { x: -3, y: 0.5, z: 2, w: 1, h: 1, d: 1 },
//     { x: 0, y: 1, z: -2, w: 1, h: 2, d: 1, color: 0x3a3a4a },
// ]

const SPAWN = { x: 0, y: 1.5, z: 0 }

// ─────────────────────────────────────────
// DOM
// ─────────────────────────────────────────
const canvas = document.getElementById('canvas')
const loadingScreen = document.getElementById('loading-screen')
const loadingBar = document.getElementById('loading-bar')
const animLabel = document.getElementById('anim-name')

const setLoading = (pct) => { if (loadingBar) loadingBar.style.width = `${pct}%` }

// ─────────────────────────────────────────
// SCENE
// ─────────────────────────────────────────
// const scene = new THREE.Scene()
// scene.background = new THREE.Color(0x1a1a2e)
// scene.fog = new THREE.FogExp2(0x1a1a2e, 0.04)
const scene = new THREE.Scene()
scene.background = new THREE.Color(0xc9a96e)   // desert sky tan
scene.fog = new THREE.FogExp2(0xc9a96e, 0.012) // lighter, longer fog for open desert

// ─────────────────────────────────────────
// CAMERA (orbiting third-person)
// ─────────────────────────────────────────
const CAM = {
    distance: 4.5,
    height: 1.4,
    yawSensitivity: 0.0035,
    pitchSensitivity: 0.003,
    fov: 70,
    damping: 12,            // higher = snappier
}
const camera = new THREE.PerspectiveCamera(CAM.fov, window.innerWidth / window.innerHeight, 0.05, 300)
let camYaw = 0, targetYaw = 0
let camPitch = 0.4, targetPitch = 0.4

// ─────────────────────────────────────────
// SHADOW SETTINGS (performance tuning)
// ─────────────────────────────────────────
const SHADOW = {
    enabled: false,
    lightCastShadow: false,
    meshCastShadow: false,
    meshReceiveShadow: false,
}

// ─────────────────────────────────────────
// RENDERER
// ─────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.shadowMap.enabled = SHADOW.enabled
renderer.shadowMap.type = THREE.PCFSoftShadowMap

// ─────────────────────────────────────────
// LIGHTING
// ─────────────────────────────────────────
scene.add(new THREE.AmbientLight(0xffffff, 0.45))

const sunLight = new THREE.DirectionalLight(0xffeedd, 1.3)
sunLight.position.set(8, 14, 6)
sunLight.castShadow = SHADOW.lightCastShadow
sunLight.shadow.mapSize.set(2048, 2048)
sunLight.shadow.camera.near = 0.5
sunLight.shadow.camera.far = 50
sunLight.shadow.camera.left = -20
sunLight.shadow.camera.right = 20
sunLight.shadow.camera.top = 20
sunLight.shadow.camera.bottom = -20
sunLight.shadow.bias = -0.0005
scene.add(sunLight)

// ─────────────────────────────────────────
// WORLD GEOMETRY (visuals)
// ─────────────────────────────────────────
// const groundMesh = new THREE.Mesh(
//     new THREE.PlaneGeometry(60, 60),
//     new THREE.MeshStandardMaterial({ color: 0x2d4a3e, roughness: 0.9 })
// )
// groundMesh.rotation.x = -Math.PI / 2
// groundMesh.receiveShadow = SHADOW.meshReceiveShadow
// scene.add(groundMesh)

// const grid = new THREE.GridHelper(60, 60, 0x3a5a4a, 0x2a4a3a)
// grid.position.y = 0.002
// scene.add(grid)

// const platformMat = new THREE.MeshStandardMaterial({ color: 0x5c4033, roughness: 0.8 })
// function makePlatform(p) {
//     const m = new THREE.Mesh(new THREE.BoxGeometry(p.w, p.h, p.d), platformMat)
//     m.position.set(p.x, p.y, p.z)
//     m.castShadow = SHADOW.meshCastShadow
//     m.receiveShadow = SHADOW.meshReceiveShadow
//     scene.add(m)
// }
// LEVEL_PLATFORMS.forEach(makePlatform)

// function makeBox(b) {
//     const m = new THREE.Mesh(
//         new THREE.BoxGeometry(b.w, b.h, b.d),
//         new THREE.MeshStandardMaterial({ color: b.color ?? 0x4a3020, roughness: 0.85 })
//     )
//     m.position.set(b.x, b.y, b.z)
//     m.castShadow = SHADOW.meshCastShadow
//     m.receiveShadow = SHADOW.meshReceiveShadow
//     scene.add(m)
// }
// LEVEL_BOXES.forEach(makeBox)

// ─────────────────────────────────────────
// CROSSHAIR (visible only while pointer is locked)
// ─────────────────────────────────────────
const crosshair = document.createElement('div')
crosshair.style.cssText = `
    position:fixed;top:50%;left:50%;
    transform:translate(-50%,-50%);
    width:6px;height:6px;
    background:rgba(255,255,255,0.85);
    border-radius:50%;
    pointer-events:none;
    z-index:200;
    display:none;`
document.body.appendChild(crosshair)

// ─────────────────────────────────────────
// POINTER LOCK + MOUSE LOOK
// ─────────────────────────────────────────
let isLocked = false
canvas.addEventListener('click', () => { if (!isLocked && !wheelOpen) canvas.requestPointerLock() })

document.addEventListener('pointerlockchange', () => {
    isLocked = document.pointerLockElement === canvas
    // Show crosshair only when pointer is locked AND wheel is NOT open
    crosshair.style.display = (isLocked && !wheelOpen) ? 'block' : 'none'
})

document.addEventListener('mousemove', (e) => {
    if (!isLocked || wheelOpen) return
    targetYaw -= e.movementX * CAM.yawSensitivity
    targetPitch += e.movementY * CAM.pitchSensitivity
    targetPitch = THREE.MathUtils.clamp(targetPitch, 0.08, 1.4)
})

window.addEventListener('wheel', (e) => {
    CAM.distance = THREE.MathUtils.clamp(CAM.distance + e.deltaY * 0.01, 1.5, 14)
}, { passive: true })

// ─────────────────────────────────────────
// EMOTE WHEEL UI
// ─────────────────────────────────────────
const wheelContainer = document.getElementById('emote-wheel')
const wheelSegments = document.querySelectorAll('.wheel-segment')

function openWheel() {
    wheelOpen = true
    wheelContainer.classList.remove('hidden')
    if (isLocked) document.exitPointerLock()
}

function closeWheel() {
    wheelOpen = false
    wheelContainer.classList.add('hidden')
    if (canvas && !isLocked) {
        setTimeout(() => canvas.requestPointerLock(), 100)
    }
}

function playEmote(emoteName) {
    if (!actions[emoteName]) return
    lastLocomotionState = currentState
    const emoteDurations = { Wave: 1.0, Dance: 4.0, Celebrate: 2.8, Cry: 2.2 }
    emotePlayTimer = emoteDurations[emoteName] || 1.5
    isPlayingEmote = true
    setState(emoteName)
    closeWheel()
}

wheelSegments.forEach((segment) => {
    segment.addEventListener('click', (e) => {
        const emoteName = segment.dataset.emote
        const stateName = emoteName.charAt(0).toUpperCase() + emoteName.slice(1)
        playEmote(stateName)
        e.stopPropagation()
    })
})

document.addEventListener('click', (e) => {
    if (wheelOpen && !wheelContainer.contains(e.target)) {
        closeWheel()
    }
})

// ─────────────────────────────────────────
// INPUT
// ─────────────────────────────────────────
const keys = { forward: false, backward: false, left: false, right: false, walk: false }
let jumpBufferTimer = 0   // > 0 means "jump was requested very recently"

function isTyping() {
    const el = document.activeElement
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

window.addEventListener('keydown', (e) => {
    if (isTyping()) return
    switch (e.code) {
        case 'KeyW': case 'ArrowUp': keys.forward = true; break
        case 'KeyS': case 'ArrowDown': keys.backward = true; break
        case 'KeyA': case 'ArrowLeft': keys.left = true; break
        case 'KeyD': case 'ArrowRight': keys.right = true; break
        case 'ShiftLeft': case 'ShiftRight': keys.walk = true; break
        case 'KeyV':
            // Toggle emote wheel
            if (wheelOpen) {
                closeWheel()
            } else {
                openWheel()
            }
            e.preventDefault()
            break
        case 'Space':
            e.preventDefault()
            jumpBufferTimer = JUMP_BUFFER   // buffer the press; consumed when grounded
            break
        case 'Escape':
            document.exitPointerLock()
            break
    }
})

window.addEventListener('keyup', (e) => {
    switch (e.code) {
        case 'KeyW': case 'ArrowUp': keys.forward = false; break
        case 'KeyS': case 'ArrowDown': keys.backward = false; break
        case 'KeyA': case 'ArrowLeft': keys.left = false; break
        case 'KeyD': case 'ArrowRight': keys.right = false; break
        case 'ShiftLeft': case 'ShiftRight': keys.walk = false; break
    }
})

// ─────────────────────────────────────────
// GUI
// ─────────────────────────────────────────
const gui = new GUI({ title: 'Settings' })
const cf = gui.addFolder('Camera')
cf.add(CAM, 'distance', 1.5, 14, 0.1).name('Distance').listen()
cf.add(CAM, 'height', 0.5, 3.0, 0.05).name('Look Height')
cf.add(CAM, 'fov', 50, 110, 1).name('FOV').onChange(v => { camera.fov = v; camera.updateProjectionMatrix() })
cf.add(CAM, 'yawSensitivity', 0.0005, 0.01, 0.0001).name('H Sensitivity')
cf.add(CAM, 'pitchSensitivity', 0.0005, 0.01, 0.0001).name('V Sensitivity')
cf.add(CAM, 'damping', 1, 25, 0.5).name('Cam Smoothing')

const sf = gui.addFolder('Shadows')
sf.add(SHADOW, 'enabled').onChange(v => {
    renderer.shadowMap.enabled = v
}).name('Enable Shadows')
sf.add(SHADOW, 'lightCastShadow').onChange(v => {
    sunLight.castShadow = v
}).name('Sun Light')
sf.add(SHADOW, 'meshCastShadow').onChange(v => {
    scene.traverse(obj => {
        if (obj.isMesh) obj.castShadow = v
    })
}).name('Mesh Cast')
sf.add(SHADOW, 'meshReceiveShadow').onChange(v => {
    scene.traverse(obj => {
        if (obj.isMesh) obj.receiveShadow = v
    })
}).name('Mesh Receive')

const SCENE = { showClouds: false }   // default OFF

const scf = gui.addFolder('Scene')
scf.add(SCENE, 'showClouds').name('Show Clouds').onChange(v => {
    cloudObjects.forEach(c => { c.visible = v })
})

// ─────────────────────────────────────────
// PHYSICS WORLD
// ─────────────────────────────────────────
let world = null
let characterBody = null
let characterCollider = null   // excluded from the ground raycast

async function initPhysics() {
    await RAPIER.init()
    world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 })
    world.timestep = FIXED_TIME_STEP

    // No ground slab here — trimesh from city model handles all collision.
    // Character spawns high; autoSpawn() will reposition after city loads.
    characterBody = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(SPAWN.x, SPAWN.y, SPAWN.z)
            .lockRotations()
            .setLinearDamping(0)
    )

    characterCollider = world.createCollider(
        RAPIER.ColliderDesc.capsule(CAPSULE_HALF_HEIGHT, CAPSULE_RADIUS)
            .setFriction(0.0)
            .setRestitution(0.0),
        characterBody
    )
}

// ─────────────────────────────────────────
// TRIMESH COLLIDER — built from city geometry
// Skips tiny props (bounding box < MIN_COLLIDER_SIZE) to keep
// triangle count manageable for Rapier.
// ─────────────────────────────────────────
const MIN_COLLIDER_SIZE = 1.0   // units — tweak if small props need collision

function buildCityCollider(model) {
    const vertices = []
    const indices = []
    const vertexMap = new Map()

    model.traverse(c => {
        if (!c.isMesh) return
        if (!c.visible) return                    // ← skip hidden (clouds etc.)
        if (c.userData.isMerged) return           // ← skip merged duplicates

        // Update matrix BEFORE size check to ensure world-space dimensions are accurate
        c.updateWorldMatrix(true, false)

        // Skip tiny decorative props
        const box = new THREE.Box3().setFromObject(c)
        const size = box.getSize(new THREE.Vector3())
        if (Math.max(size.x, size.y, size.z) < MIN_COLLIDER_SIZE) return

        const geom = c.geometry
        const position = geom.attributes.position
        const matrix = c.matrixWorld

        const v = new THREE.Vector3()

        // Helper to get or create vertex index with position deduplication
        const getVertexIndex = (i) => {
            v.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(matrix)
            const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`
            if (vertexMap.has(key)) return vertexMap.get(key)
            
            const idx = vertices.length / 3
            vertices.push(v.x, v.y, v.z)
            vertexMap.set(key, idx)
            return idx
        }

        if (geom.index) {
            for (let i = 0; i < geom.index.count; i++) {
                indices.push(getVertexIndex(geom.index.array[i]))
            }
        } else {
            for (let i = 0; i < position.count; i++) {
                indices.push(getVertexIndex(i))
            }
        }
    })

    const cityBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    world.createCollider(
        RAPIER.ColliderDesc.trimesh(
            new Float32Array(vertices),
            new Uint32Array(indices)
        ),
        cityBody
    )

    console.log(`[physics] trimesh — ${(vertices.length / 3).toLocaleString()} unique verts, ${(indices.length / 3).toLocaleString()} tris`)
}

// ─────────────────────────────────────────
// GROUND DETECTION — downward raycast
//
// Start the ray inside the capsule (below centre) and cast down, excluding the
// character's own collider (arg 6 of castRay). The surface normal rejects walls
// and steep faces — only near-flat ground counts as "grounded".
// ─────────────────────────────────────────
const _down = { x: 0, y: -1, z: 0 }
const _rayOrigin = { x: 0, y: 0, z: 0 }
const _ray = new RAPIER.Ray(_rayOrigin, _down)

function checkGround() {
    if (!world || !characterBody) return false

    const pos = characterBody.translation()
    _rayOrigin.x = pos.x
    _rayOrigin.y = pos.y - (CAPSULE_BOTTOM - RAY_ORIGIN_OFFSET)
    _rayOrigin.z = pos.z

    const hit = world.castRayAndGetNormal(
        _ray, RAY_LENGTH, false,
        undefined, undefined, characterCollider
    )
    if (!hit) return false
    return hit.normal.y > 0.5   // only stand-on-able surfaces
}

// ─────────────────────────────────────────
// MOVEMENT
// ─────────────────────────────────────────
const _moveForward = new THREE.Vector3()
const _moveRight = new THREE.Vector3()
const _wishDir = new THREE.Vector3()
const _yawQuat = new THREE.Quaternion()
const _axisY = new THREE.Vector3(0, 1, 0)

let grounded = false        // updated after each physics step
let coyoteTimer = 0         // seconds of grace left to still jump after leaving ground
let hasMoveInput = false    // intent flag, read by the animation FSM

function updateMovement(dt) {
    if (!characterBody) return

    // Suppress movement input while emote is playing
    if (isPlayingEmote) {
        characterBody.setLinvel({ x: 0, y: characterBody.linvel().y, z: 0 }, true)
        return
    }

    // Camera-relative movement basis (flattened onto the XZ plane).
    _yawQuat.setFromAxisAngle(_axisY, camYaw)
    _moveForward.set(0, 0, -1).applyQuaternion(_yawQuat).setY(0).normalize()
    _moveRight.set(1, 0, 0).applyQuaternion(_yawQuat).setY(0).normalize()

    _wishDir.set(0, 0, 0)
    if (keys.forward) _wishDir.add(_moveForward)
    if (keys.backward) _wishDir.sub(_moveForward)
    if (keys.right) _wishDir.add(_moveRight)
    if (keys.left) _wishDir.sub(_moveRight)
    hasMoveInput = _wishDir.lengthSq() > 0
    if (hasMoveInput) _wishDir.normalize()

    const speed = keys.walk ? WALK_SPEED : RUN_SPEED
    const vel = characterBody.linvel()

    if (grounded) {
        // Snappy, deterministic ground control: set horizontal velocity directly.
        characterBody.setLinvel({ x: _wishDir.x * speed, y: vel.y, z: _wishDir.z * speed }, true)
    } else if (hasMoveInput) {
        // Air steering: ease toward the target but keep existing momentum.
        characterBody.setLinvel({
            x: THREE.MathUtils.lerp(vel.x, _wishDir.x * speed, AIR_CONTROL),
            y: vel.y,
            z: THREE.MathUtils.lerp(vel.z, _wishDir.z * speed, AIR_CONTROL),
        }, true)
    }
    // else: airborne with no input → keep momentum untouched (ballistic arc).

    // Coyote time: refresh while grounded, otherwise drain it.
    coyoteTimer = grounded ? COYOTE_TIME : Math.max(0, coyoteTimer - dt)

    // Jump: a buffered press + ground (or coyote grace) → launch.
    if (jumpBufferTimer > 0 && coyoteTimer > 0) {
        const v = characterBody.linvel()
        characterBody.setLinvel({ x: v.x, y: JUMP_SPEED, z: v.z }, true)
        jumpBufferTimer = 0
        coyoteTimer = 0     // consume grace so we can't double-jump
    }
}

// ─────────────────────────────────────────
// ANIMATION STATE MACHINE
//
// One enum-like string is the single source of truth for the current state.
// setState() is the ONLY place a clip starts, and it ignores requests to
// re-enter the state already playing — so a clip is never reset mid-cycle.
// Transitions between locomotion states use hysteresis thresholds, killing the
// boundary flicker that made Walk/Run restart over and over.
// ─────────────────────────────────────────
let characterModel = null
let mixer = null
const actions = {}             // name -> AnimationAction
let currentState = ''          // 'Idle' | 'Walk' | 'Run' | 'Jump' | 'Wave' | 'Dance' | 'Celebrate' | 'Cry'
let currentAction = null

let smoothedSpeed = 0          // persistent, filtered horizontal speed
let airborneTimer = 0          // seconds spent off the ground

// ─────────────────────────────────────────
// EMOTE WHEEL STATE
// ─────────────────────────────────────────
let wheelOpen = false          // whether emote wheel UI is visible
let isPlayingEmote = false     // actively playing a one-shot emote animation
let lastLocomotionState = 'Idle'  // restore to this state when emote finishes
let emotePlayTimer = 0         // countdown timer for emote duration

function setState(name) {
    if (currentState === name) return          // already playing → do nothing
    const next = actions[name]
    if (!next) return                          // clip missing → keep current

    const prev = currentAction
    next.reset()
    next.enabled = true
    next.setEffectiveTimeScale(1)
    next.setEffectiveWeight(1)
    next.fadeIn(FADE)
    next.play()
    if (prev && prev !== next) prev.fadeOut(FADE)

    currentAction = next
    currentState = name
    if (animLabel) animLabel.textContent = name
}

function pickLocomotion() {
    // Determine Idle / Walk / Run from the smoothed ground speed, using the
    // hysteresis band so we don't bounce between neighbouring states.
    if (currentState === 'Run') {
        return smoothedSpeed < SPEED.runExit
            ? (smoothedSpeed < SPEED.walkExit ? 'Idle' : 'Walk')
            : 'Run'
    }
    if (currentState === 'Walk') {
        if (smoothedSpeed > SPEED.runEnter) return 'Run'
        if (smoothedSpeed < SPEED.walkExit) return 'Idle'
        return 'Walk'
    }
    // Coming from Idle (or Jump landing): require the higher "enter" speeds.
    if (smoothedSpeed > SPEED.runEnter) return 'Run'
    if (smoothedSpeed > SPEED.walkEnter) return 'Walk'
    return 'Idle'
}

function updateAnimation(dt) {
    if (!mixer || !characterBody) return

    // Handle emote playback duration
    if (isPlayingEmote) {
        emotePlayTimer -= dt
        if (emotePlayTimer <= 0) {
            // Emote finished: return to last locomotion state
            isPlayingEmote = false
            setState(lastLocomotionState)
        }
        return  // skip locomotion state machine while emote plays
    }

    const vel = characterBody.linvel()
    const horizontalSpeed = Math.hypot(vel.x, vel.z)
    smoothedSpeed = THREE.MathUtils.lerp(smoothedSpeed, horizontalSpeed, 0.25)

    airborneTimer = grounded ? 0 : airborneTimer + dt

    // Airborne beyond the coyote window → Jump; otherwise resolve locomotion.
    // Hysteresis on the airborne side too: once in Jump, stay until grounded.
    if (currentState === 'Jump') {
        if (grounded) setState(pickLocomotion())
    } else if (airborneTimer > COYOTE_TIME) {
        setState('Jump')
    } else {
        setState(pickLocomotion())
    }
}

// ─────────────────────────────────────────
// CHARACTER LOADING (FBX)
// ─────────────────────────────────────────
const ANIM_FILES = [
    { name: 'Idle', path: './animations/Idle.fbx' },
    { name: 'Jump', path: './animations/Jump.fbx' },
    { name: 'Run', path: './animations/Running.fbx' },
    { name: 'Walk', path: './animations/Walking.fbx' },
    // Emote animations (one-shot)
    { name: 'Wave', path: './animations/Waving.fbx' },
    { name: 'Dance', path: './animations/Wave Hip Hop Dance.fbx' },
    { name: 'Celebrate', path: './animations/Rallying.fbx' },
    { name: 'Cry', path: './animations/Crying.fbx' },
]

const loadFBX = (loader, path) =>
    new Promise((resolve, reject) => loader.load(path, resolve, undefined, reject))

// Strip ROOT MOTION from a clip so it animates "in place".
//
// Mixamo locomotion clips translate the hip bone forward over the clip and snap
// back when the loop repeats. Because our PHYSICS body already drives the
// character forward, that baked-in drift shows up as a forward-lurch-then-reset
// jerk. We pin the horizontal (X/Z) channel of every position track to its
// first frame, removing the drift while keeping the vertical (Y) bob intact.
function makeInPlace(clip) {
    for (const track of clip.tracks) {
        if (!track.name.endsWith('.position')) continue   // bones only animate rotation; hips has position
        const v = track.values                            // flat [x,y,z, x,y,z, ...]
        const x0 = v[0]
        const z0 = v[2]
        for (let i = 0; i < v.length; i += 3) {
            v[i] = x0          // freeze X (no sideways drift)
            v[i + 2] = z0      // freeze Z (no forward drift)
            // v[i + 1] (Y) left untouched → keeps the natural up/down bob
        }
    }
    return clip
}

async function loadCharacter() {
    const loader = new FBXLoader()

    let fbx
    try {
        fbx = await loadFBX(loader, './character/Y Bot.fbx')
    } catch (err) {
        console.warn('[character] FBX failed to load, using fallback capsule.', err)
        createFallbackCharacter()
        return false
    }

    characterModel = fbx
    characterModel.scale.setScalar(0.005)          // FBX is in cm → metres
    characterModel.traverse(c => {
        if (c.isMesh) { c.castShadow = SHADOW.meshCastShadow; c.receiveShadow = SHADOW.meshReceiveShadow }
    })
    scene.add(characterModel)
    mixer = new THREE.AnimationMixer(characterModel)

    // Load every clip in parallel; ignore any individual failures.
    let done = 0
    await Promise.all(ANIM_FILES.map(async ({ name, path }) => {
        try {
            const animFbx = await loadFBX(loader, path)
            const clip = animFbx.animations[0]
            if (clip) {
                clip.name = name
                makeInPlace(clip)            // remove baked-in root motion
                const action = mixer.clipAction(clip)

                // Determine if this is an emote (one-shot) or locomotion (loop)
                const isEmote = ['Wave', 'Dance', 'Celebrate', 'Cry'].includes(name)
                if (isEmote || name === 'Jump') {
                    action.loop = THREE.LoopOnce
                    action.clampWhenFinished = true
                } else {
                    action.loop = THREE.LoopRepeat
                }
                actions[name] = action
            }
        } catch (err) {
            console.warn(`[anim] failed to load ${name}`, err)
        } finally {
            done++
            setLoading(50 + (done / ANIM_FILES.length) * 40)
        }
    }))

    if (actions.Idle) setState('Idle')
    else if (actions.Walk) setState('Walk')
    return true
}

function createFallbackCharacter() {
    characterModel = new THREE.Mesh(
        new THREE.CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_HALF_HEIGHT * 2, 8, 16),
        new THREE.MeshStandardMaterial({ color: 0x7dd3fc })
    )
    characterModel.castShadow = SHADOW.meshCastShadow
    scene.add(characterModel)
    if (animLabel) animLabel.textContent = 'Fallback capsule'
}

// ─────────────────────────────────────────
// CITY LOADING (glTF)
// ─────────────────────────────────────────
let cityModel = null

const hideableGroups = {
    clouds: { objects: cloudObjects, label: 'SM_Env_Cloud_*' },
    // extend here if you want to toggle other groups later
}

// Name-prefix → group bucket for toggling
const HIDEABLE_PREFIXES = [
    { prefix: 'SM_Env_Cloud', group: cloudObjects },
    // e.g. { prefix: 'SM_Env_Cactus', group: cactusObjects } if you add one
]

async function loadCity() {
    const loader = new GLTFLoader()
    try {
        const gltf = await new Promise((resolve, reject) => {
            loader.load('./map/scene.gltf', resolve, undefined, reject)
        })

        cityModel = gltf.scene
        cityModel.scale.setScalar(0.5)
        cityModel.updateWorldMatrix(true, false)
        const invModelMatrix = cityModel.matrixWorld.clone().invert()

        // ── Traversal: categorise every object ────────────────────────────
        // Buckets for geometry merging: materialKey → { geometries[], material }
        const mergeBuckets = new Map()

        // Stats for the before/after log
        const stats = {
            total: 0, meshes: 0, hidden: 0,
            buckets: {}     // materialKey → count
        }

        cityModel.traverse(c => {
            stats.total++

            // ── Hideable groups (clouds, sky, etc.) ───────────────────────
            const nameLC = c.name ? c.name.toLowerCase() : ''
            let wasHidden = false
            for (const { prefix, group } of HIDEABLE_PREFIXES) {
                if (c.name && c.name.startsWith(prefix)) {
                    group.push(c)
                    c.visible = false
                    wasHidden = true
                    stats.hidden++
                    break
                }
            }
            if (wasHidden) return   // skip further processing for hidden objects

            if (!c.isMesh) return
            stats.meshes++

            c.castShadow = false
            c.receiveShadow = false

            // Texture memory optimisation
            if (c.material && c.material.map) {
                c.material.map.minFilter = THREE.LinearFilter
                c.material.map.generateMipmaps = false
            }

            // ── Geometry merge bucketing ───────────────────────────────────
            // Key = material uuid so only meshes sharing the exact same
            // material instance get merged (safe — no cross-material batching).
            const mat = Array.isArray(c.material) ? c.material[0] : c.material
            if (!mat) return

            const key = mat.uuid
            if (!mergeBuckets.has(key)) {
                mergeBuckets.set(key, { geometries: [], material: mat, name: mat.name || key.slice(0, 8) })
                stats.buckets[mat.name || key.slice(0, 8)] = 0
            }

            // We need geometry local to cityModel for merging
            c.updateWorldMatrix(true, false)
            const localMatrix = c.matrixWorld.clone().premultiply(invModelMatrix)
            const cloned = c.geometry.clone().applyMatrix4(localMatrix)
            mergeBuckets.get(key).geometries.push(cloned)
            stats.buckets[mat.name || key.slice(0, 8)]++

            // Hide originals — merged mesh will replace them
            c.visible = false
        })

        // ── BEFORE stats ───────────────────────────────────────────────────
        console.group('[city] Scene traversal summary — BEFORE merge')
        console.log(`  Total objects : ${stats.total}`)
        console.log(`  Meshes        : ${stats.meshes}`)
        console.log(`  Hidden (clouds/sky): ${stats.hidden}`)
        console.log(`  Draw-call buckets by material:`)
        for (const [matName, count] of Object.entries(stats.buckets)) {
            console.log(`    ${matName.padEnd(48)} × ${count} meshes`)
        }

        console.log(`  Estimated draw calls BEFORE: ~${stats.meshes}`)
        console.groupEnd()

        // ── Merge each bucket into a single mesh ───────────────────────────
        let mergedDrawCalls = 0
        let mergedTrisBefore = 0
        let mergedTrisAfter = 0

        for (const [, { geometries, material, name }] of mergeBuckets) {
            if (geometries.length === 0) continue

            // Count tris before (sum of all individual meshes in this bucket)
            geometries.forEach(g => {
                mergedTrisBefore += g.index
                    ? g.index.count / 3
                    : g.attributes.position.count / 3
            })

            try {
                const merged = mergeGeometries(geometries, false)

                if (!merged) { console.warn(`[merge] failed for bucket "${name}"`); continue }

                const mesh = new THREE.Mesh(merged, material)
                mesh.name = `__merged_${name}`
                mesh.frustumCulled = true   // always leave this ON
                cityModel.add(mesh)
                mergedDrawCalls++

                mergedTrisAfter += merged.index
                    ? merged.index.count / 3
                    : merged.attributes.position.count / 3
            } catch (err) {
                console.warn(`[merge] exception in bucket "${name}"`, err)
            }
        }

        scene.add(cityModel)

        // ── AFTER stats ────────────────────────────────────────────────────
        console.group('[city] Scene traversal summary — AFTER merge')
        console.log(`  Merged draw calls : ${mergedDrawCalls}  (was ~${stats.meshes})`)
        console.log(`  Draw call reduction: ${(((stats.meshes - mergedDrawCalls) / stats.meshes) * 100).toFixed(1)}%`)
        console.log(`  Tris in merged geo : ${Math.round(mergedTrisAfter / 1000)}k  (individual sum was ${Math.round(mergedTrisBefore / 1000)}k — difference = index vs position counts)`)
        console.log(`  Hidden objects     : ${stats.hidden}  (clouds OFF by default)`)
        console.groupEnd()

        buildCityCollider(cityModel)
        
        console.log('[city] loaded successfully')
        return true

    } catch (err) {
        console.warn('[city] glTF failed to load', err)
        return false
    }
}
// ─────────────────────────────────────────
// AUTO SPAWN — reads city bounding box and
// places the character at the map centre,
// just above the lowest ground point.
// ─────────────────────────────────────────
function autoSpawn(model) {
    const box = new THREE.Box3().setFromObject(model)
    const center = box.getCenter(new THREE.Vector3())
    const groundY = box.min.y

    const spawnY = groundY + 90.0
    characterBody.setTranslation({ x: center.x, y: spawnY, z: center.z }, true)
    characterBody.setLinvel({ x: 0, y: 0, z: 0 }, true)

    console.log(`[spawn] center x:${center.x.toFixed(2)} y:${spawnY.toFixed(2)} z:${center.z.toFixed(2)}`)
    console.log(`[city]  bounds min:`, box.min, 'max:', box.max)
}

// ─────────────────────────────────────────
// RESIZE
// ─────────────────────────────────────────
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
})

// ─────────────────────────────────────────
// CAMERA SYNC (spherical orbit around the character)
// ─────────────────────────────────────────
const _camTarget = new THREE.Vector3()
const _camOffset = new THREE.Vector3()

function syncCamera(charPos) {
    _camTarget.set(charPos.x, charPos.y + CAM.height, charPos.z)
    const d = CAM.distance
    _camOffset.set(
        d * Math.sin(camYaw) * Math.cos(camPitch),
        d * Math.sin(camPitch),
        d * Math.cos(camYaw) * Math.cos(camPitch)
    )
    camera.position.copy(_camTarget).add(_camOffset)
    camera.lookAt(_camTarget)
}

// ─────────────────────────────────────────
// PERFORMANCE MONITOR (lightweight, no deps)
// ─────────────────────────────────────────
const perfPanel = document.createElement('div')
perfPanel.style.cssText = `
    position:fixed;bottom:8px;right:8px;
    background:rgba(0,0,0,0.6);color:#0f0;
    font:11px/1.5 monospace;padding:6px 10px;
    border-radius:4px;pointer-events:none;z-index:300;`
document.body.appendChild(perfPanel)

let perfFrameCount = 0
let perfAccTime = 0
let perfLastTime = performance.now()

function updatePerfPanel(delta) {
    perfFrameCount++
    perfAccTime += delta
    if (perfFrameCount >= 60) {
        const fps = Math.round(perfFrameCount / perfAccTime)
        const ms = ((perfAccTime / perfFrameCount) * 1000).toFixed(1)
        const info = renderer.info
        perfPanel.innerHTML =
            `FPS: ${fps}  |  ${ms} ms<br>` +
            `Tris: ${(info.render.triangles / 1000).toFixed(0)}k<br>` +
            `Draws: ${info.render.calls}<br>` +
            `Geoms: ${info.memory.geometries}  Tex: ${info.memory.textures}`
        perfFrameCount = 0
        perfAccTime = 0
    }
}


// ─────────────────────────────────────────
// GAME LOOP
//
// Physics steps at a fixed rate inside an accumulator; the visual position is
// interpolated between the two latest physics states so motion stays smooth
// regardless of render framerate.
// ─────────────────────────────────────────
const clock = new THREE.Clock()
let physicsAccumulator = 0
let hasPrevState = false

const _prevPos = new THREE.Vector3()
const _currPos = new THREE.Vector3()
const _smoothPos = new THREE.Vector3()
const _targetQuat = new THREE.Quaternion()

function stepPhysics(dt) {
    physicsAccumulator += dt

    let steps = 0
    while (physicsAccumulator >= FIXED_TIME_STEP && steps < MAX_SUBSTEPS) {
        updateMovement(FIXED_TIME_STEP)     // reads `grounded` from the previous step
        world.step()
        grounded = checkGround()            // refresh after integration

        jumpBufferTimer = Math.max(0, jumpBufferTimer - FIXED_TIME_STEP)

        const p = characterBody.translation()
        _prevPos.copy(_currPos)
        _currPos.set(p.x, p.y, p.z)
        if (!hasPrevState) { _prevPos.copy(_currPos); hasPrevState = true }

        physicsAccumulator -= FIXED_TIME_STEP
        steps++
    }

    // If we hit the substep ceiling (e.g. tab was backgrounded), drop the
    // backlog so we don't spiral trying to catch up.
    if (steps >= MAX_SUBSTEPS) physicsAccumulator = 0
}

function tick() {
    requestAnimationFrame(tick)
    const delta = Math.min(clock.getDelta(), 0.1)

    updatePerfPanel(delta)
    if (world && characterBody) {
        stepPhysics(delta)

        // Interpolate the render position between the two latest physics states.
        const alpha = THREE.MathUtils.clamp(physicsAccumulator / FIXED_TIME_STEP, 0, 1)
        _smoothPos.copy(_prevPos).lerp(_currPos, alpha)

        if (characterModel) {
            // Body centre → feet: drop the model by CAPSULE_BOTTOM.
            characterModel.position.set(_smoothPos.x, _smoothPos.y - CAPSULE_BOTTOM, _smoothPos.z)

            // Face the horizontal movement direction.
            const vel = characterBody.linvel()
            if (Math.abs(vel.x) > 0.3 || Math.abs(vel.z) > 0.3) {
                _targetQuat.setFromAxisAngle(_axisY, Math.atan2(vel.x, vel.z))
                characterModel.quaternion.slerp(_targetQuat, Math.min(1, 12 * delta))
            }
        }

        camYaw = THREE.MathUtils.damp(camYaw, targetYaw, CAM.damping, delta)
        camPitch = THREE.MathUtils.damp(camPitch, targetPitch, CAM.damping, delta)
        syncCamera(_smoothPos)

        updateAnimation(delta)
    }

    if (mixer) mixer.update(delta)

    // Performance monitoring (uncomment to debug):
    // console.log(`Triangles: ${renderer.info.render.triangles}, Materials: ${renderer.info.materials}`)

    renderer.render(scene, camera)
}

// ─────────────────────────────────────────
// BOOTSTRAP
// ─────────────────────────────────────────
async function init() {
    setLoading(15)
    await initPhysics()
    setLoading(30)
    await loadCity()
    setLoading(50)
    await loadCharacter()
    setLoading(100)

    // ── Frustum cull audit ─────────────────────────────────────────────────
    let cullingViolations = 0
    cityModel && cityModel.traverse(c => {
        if (c.isMesh && c.frustumCulled === false) {
            console.warn(`[frustumCull] frustumCulled=false on: ${c.name}`)
            cullingViolations++
        }
    })
    if (cullingViolations === 0) console.log('[frustumCull] ✓ all meshes have frustumCulled=true')
    else console.warn(`[frustumCull] ✗ ${cullingViolations} meshes have frustumCulled disabled — fix these`)

    // Position character at city centre, above actual ground level
    if (cityModel) autoSpawn(cityModel)

    // Seed interpolation so the model doesn't snap from the origin on frame 1.
    const p = characterBody.translation()
    _currPos.set(p.x, p.y, p.z)
    _prevPos.copy(_currPos)
    hasPrevState = true

    if (loadingScreen) loadingScreen.classList.add('hidden')
    tick()
}

init().catch(err => {
    console.error('[init] fatal error', err)
    if (animLabel) animLabel.textContent = 'Error — see console'
})