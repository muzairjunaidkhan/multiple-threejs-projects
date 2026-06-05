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
import RAPIER from '@dimforge/rapier3d-compat'
import GUI from 'lil-gui'

// ─────────────────────────────────────────
// TUNING CONSTANTS
// ─────────────────────────────────────────
const FIXED_TIME_STEP = 1 / 60        // physics runs at a fixed 60 Hz
const MAX_SUBSTEPS = 5                 // clamp catch-up steps after a stall

const GRAVITY = -24                    // m/s² (snappier than real 9.81)

// Capsule dimensions. CAPSULE_BOTTOM = distance from body centre to the feet.
const CAPSULE_RADIUS = 0.3
const CAPSULE_HALF_HEIGHT = 0.45
const CAPSULE_BOTTOM = CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS   // 0.75

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

// ─────────────────────────────────────────
// LEVEL DEFINITION
// ─────────────────────────────────────────
const LEVEL_PLATFORMS = [
    { x: -5, y: 0.8, z: -5, w: 4, h: 0.4, d: 4 },
    { x: 5, y: 2, z: -5, w: 4, h: 0.4, d: 4 },
    { x: 0, y: 0.6, z: 5, w: 6, h: 0.4, d: 2 },
    { x: -8, y: 1.2, z: 0, w: 3, h: 0.4, d: 3 },
]
const LEVEL_BOXES = [
    { x: 3, y: 0.5, z: 0, w: 1, h: 1, d: 1 },
    { x: -3, y: 0.5, z: 2, w: 1, h: 1, d: 1 },
    { x: 0, y: 1, z: -2, w: 1, h: 2, d: 1, color: 0x3a3a4a },
]

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
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x1a1a2e)
scene.fog = new THREE.FogExp2(0x1a1a2e, 0.04)

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
// RENDERER
// ─────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap

// ─────────────────────────────────────────
// LIGHTING
// ─────────────────────────────────────────
scene.add(new THREE.AmbientLight(0xffffff, 0.45))

const sunLight = new THREE.DirectionalLight(0xffeedd, 1.3)
sunLight.position.set(8, 14, 6)
sunLight.castShadow = true
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
const groundMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: 0x2d4a3e, roughness: 0.9 })
)
groundMesh.rotation.x = -Math.PI / 2
groundMesh.receiveShadow = true
scene.add(groundMesh)

const grid = new THREE.GridHelper(60, 60, 0x3a5a4a, 0x2a4a3a)
grid.position.y = 0.002
scene.add(grid)

const platformMat = new THREE.MeshStandardMaterial({ color: 0x5c4033, roughness: 0.8 })
function makePlatform(p) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(p.w, p.h, p.d), platformMat)
    m.position.set(p.x, p.y, p.z)
    m.castShadow = true
    m.receiveShadow = true
    scene.add(m)
}
LEVEL_PLATFORMS.forEach(makePlatform)

function makeBox(b) {
    const m = new THREE.Mesh(
        new THREE.BoxGeometry(b.w, b.h, b.d),
        new THREE.MeshStandardMaterial({ color: b.color ?? 0x4a3020, roughness: 0.85 })
    )
    m.position.set(b.x, b.y, b.z)
    m.castShadow = true
    m.receiveShadow = true
    scene.add(m)
}
LEVEL_BOXES.forEach(makeBox)

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

    // Ground (large static slab centred at y=0; top surface at y≈0.05)
    const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    world.createCollider(RAPIER.ColliderDesc.cuboid(30, 0.05, 30), groundBody)

    LEVEL_PLATFORMS.forEach(p => addStaticBox(p.x, p.y, p.z, p.w / 2, p.h / 2, p.d / 2))
    LEVEL_BOXES.forEach(b => addStaticBox(b.x, b.y, b.z, b.w / 2, b.h / 2, b.d / 2))

    // Character: dynamic capsule, rotation locked so it never tips over.
    // No linear damping — air momentum is preserved for natural jump arcs;
    // ground velocity is set explicitly every step so damping is irrelevant there.
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

function addStaticBox(x, y, z, hw, hh, hd) {
    const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z))
    world.createCollider(RAPIER.ColliderDesc.cuboid(hw, hh, hd), b)
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
    characterModel.scale.setScalar(0.01)          // FBX is in cm → metres
    characterModel.traverse(c => {
        if (c.isMesh) { c.castShadow = true; c.receiveShadow = true }
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
    characterModel.castShadow = true
    scene.add(characterModel)
    if (animLabel) animLabel.textContent = 'Fallback capsule'
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
    renderer.render(scene, camera)
}

// ─────────────────────────────────────────
// BOOTSTRAP
// ─────────────────────────────────────────
async function init() {
    setLoading(15)
    await initPhysics()
    setLoading(50)
    await loadCharacter()
    setLoading(100)

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
