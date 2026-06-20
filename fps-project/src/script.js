/**
 * ═══════════════════════════════════════════════════════════
 * script.js — Third-Person Animated Character Controller
 * ───────────────────────────────────────────────────────────
 * Tech: Three.js · Rapier3D · lil-gui · Vite
 * ═══════════════════════════════════════════════════════════
 */

import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import RAPIER from '@dimforge/rapier3d-compat'
import GUI from 'lil-gui'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// ── Game shell (state machine, menu, saves, missions, cutscene) ──
import { STATES, getState, isPlaying, setState as setGameState, onStateChange } from './game/gameState.js'
import * as saveSystem from './game/saveSystem.js'
import * as missions from './game/missions.js'
import { initMenu, showMainMenu, showPauseMenu, hideAllMenus } from './game/menu.js'
import { initCutscene, playIntro } from './game/cutscene.js'

// ─────────────────────────────────────────
// TUNING CONSTANTS
// ─────────────────────────────────────────
const FIXED_TIME_STEP    = 1 / 60
const MAX_SUBSTEPS       = 4
const GRAVITY            = -24
const CAPSULE_RADIUS     = 0.16
const CAPSULE_HALF_HEIGHT= 0.32
const CAPSULE_BOTTOM     = CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS  // 0.63
const RAY_ORIGIN_OFFSET  = 0.40
const RAY_LENGTH         = CAPSULE_BOTTOM + 0.15                 // 0.90
const WALK_SPEED         = 2.2
const RUN_SPEED          = 4.5
const JUMP_SPEED         = 7.0
const AIR_CONTROL        = 0.12
const COYOTE_TIME        = 0.10
const JUMP_BUFFER        = 0.12
const FADE               = 0.2

const SPEED = {
    walkEnter: 0.6,
    walkExit:  0.3,
    runEnter:  3.6,
    runExit:   3.0,
}

const cloudObjects = []
const SPAWN = { x: 0, y: 1.5, z: 0 }

// ─────────────────────────────────────────
// DOM
// ─────────────────────────────────────────
const canvas        = document.getElementById('canvas')
const loadingScreen = document.getElementById('loading-screen')
const loadingBar    = document.getElementById('loading-bar')
const animLabel     = document.getElementById('anim-name')
const setLoading    = (pct) => { if (loadingBar) loadingBar.style.width = `${pct}%` }

// ─────────────────────────────────────────
// SCENE
// ─────────────────────────────────────────
const scene = new THREE.Scene()
scene.background = new THREE.Color(0xc9a96e)
scene.fog        = new THREE.FogExp2(0xc9a96e, 0.012)

// ─────────────────────────────────────────
// CAMERA
// ─────────────────────────────────────────
const CAM = {
    distance:         1.5,
    height:           0.5,
    yawSensitivity:   0.0035,
    pitchSensitivity: 0.003,
    fov:              70,
    damping:          12,
}
const camera = new THREE.PerspectiveCamera(CAM.fov, window.innerWidth / window.innerHeight, 0.05, 300)
let camYaw = 0, targetYaw = 0
let camPitch = 0.4, targetPitch = 0.4

// ─────────────────────────────────────────
// SHADOW SETTINGS
// ─────────────────────────────────────────
const SHADOW = {
    enabled:          false,
    lightCastShadow:  false,
    meshCastShadow:   false,
    meshReceiveShadow:false,
}

// ─────────────────────────────────────────
// RENDERER
// ─────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true,
    powerPreference: 'high-performance',   // prefer the discrete GPU on dual-GPU laptops
    stencil: false,                        // no stencil buffer used → skip allocating one
})
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.shadowMap.enabled = SHADOW.enabled
renderer.shadowMap.type    = THREE.PCFSoftShadowMap
renderer.info.autoReset    = false   // minimap renders a 2nd time/frame; we reset manually

// ─────────────────────────────────────────
// DEBUG FLAGS
// ─────────────────────────────────────────
const DEBUG = { showCapsule: false, showDoorColliders: false }

// ─────────────────────────────────────────
// CAPSULE HELPER
// ─────────────────────────────────────────
let capsuleHelper = null

function createCapsuleHelper() {
    const group  = new THREE.Group()
    const wireMat = new THREE.MeshBasicMaterial({
        color: 0x00ff88, wireframe: true, depthTest: false, transparent: true, opacity: 0.7,
    })

    group.add(new THREE.Mesh(
        new THREE.CylinderGeometry(CAPSULE_RADIUS, CAPSULE_RADIUS, CAPSULE_HALF_HEIGHT * 2, 16, 1, true),
        wireMat
    ))

    const topHemi = new THREE.Mesh(
        new THREE.SphereGeometry(CAPSULE_RADIUS, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), wireMat
    )
    topHemi.position.y = CAPSULE_HALF_HEIGHT
    group.add(topHemi)

    const botHemi = new THREE.Mesh(
        new THREE.SphereGeometry(CAPSULE_RADIUS, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), wireMat
    )
    botHemi.position.y = -CAPSULE_HALF_HEIGHT
    group.add(botHemi)

    const crossMat  = new THREE.LineBasicMaterial({ color: 0xff0000, depthTest: false })
    const cs        = 0.15
    const crossGeo  = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-cs,0,0), new THREE.Vector3(cs,0,0),
        new THREE.Vector3(0,-cs,0), new THREE.Vector3(0,cs,0),
        new THREE.Vector3(0,0,-cs), new THREE.Vector3(0,0,cs),
    ])
    crossGeo.setIndex([0,1,2,3,4,5])
    group.add(new THREE.LineSegments(crossGeo, crossMat))

    const footMat = new THREE.LineBasicMaterial({ color: 0xffff00, depthTest: false })
    const footGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-0.2,-CAPSULE_BOTTOM,0), new THREE.Vector3(0.2,-CAPSULE_BOTTOM,0),
        new THREE.Vector3(0,-CAPSULE_BOTTOM,-0.2), new THREE.Vector3(0,-CAPSULE_BOTTOM,0.2),
    ])
    footGeo.setIndex([0,1,2,3])
    group.add(new THREE.LineSegments(footGeo, footMat))

    const rayMat   = new THREE.LineBasicMaterial({ color: 0xff8800, depthTest: false })
    const rayStart = -(CAPSULE_BOTTOM - RAY_ORIGIN_OFFSET)
    const rayGeo   = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, rayStart, 0),
        new THREE.Vector3(0, rayStart - RAY_LENGTH, 0),
    ])
    group.add(new THREE.Line(rayGeo, rayMat))

    group.visible = DEBUG.showCapsule
    scene.add(group)
    return group
}

function updateCapsuleHelper() {
    if (!capsuleHelper || !characterBody) return
    const p = characterBody.translation()
    capsuleHelper.position.set(p.x, p.y, p.z)
}

// ─────────────────────────────────────────
// DOOR COLLIDER HELPERS
// Cyan wireframe box  = exact physics cuboid
// Yellow cross        = hinge / pivot point
// Red arrow           = panel local +Z (swing face)
// ─────────────────────────────────────────
const _doorHelpers = []

function createDoorHelpers() {
    _doorHelpers.forEach(({ group }) => scene.remove(group))
    _doorHelpers.length = 0

    for (const entry of interactables) {
        if (!entry._physicsBody || !entry._colliderHalfExtents) continue

        const group = new THREE.Group()
        const he    = entry._colliderHalfExtents

        // Wireframe box
        group.add(new THREE.Mesh(
            new THREE.BoxGeometry(he.x * 2, he.y * 2, he.z * 2),
            new THREE.MeshBasicMaterial({ color: 0x00ccff, wireframe: true, depthTest: false, transparent: true, opacity: 0.8 })
        ))

        // Hinge cross (offset from collider centre to pivot world pos)
        const pivotPos      = new THREE.Vector3()
        const colliderCentre= new THREE.Vector3()
        entry.object.getWorldPosition(pivotPos)
        const t = entry._physicsBody.translation()
        colliderCentre.set(t.x, t.y, t.z)

        const cs       = 0.12
        const pivotGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(-cs,0,0), new THREE.Vector3(cs,0,0),
            new THREE.Vector3(0,-cs,0), new THREE.Vector3(0,cs,0),
            new THREE.Vector3(0,0,-cs), new THREE.Vector3(0,0,cs),
        ])
        pivotGeo.setIndex([0,1,2,3,4,5])
        const cross = new THREE.LineSegments(pivotGeo, new THREE.LineBasicMaterial({ color: 0xffff00, depthTest: false }))
        cross.position.copy(pivotPos.clone().sub(colliderCentre))
        group.add(cross)

        // +Z normal arrow
        const arrowGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0,0,0), new THREE.Vector3(0,0,he.z + 0.25),
        ])
        group.add(new THREE.Line(arrowGeo, new THREE.LineBasicMaterial({ color: 0xff4444, depthTest: false })))

        group.visible = DEBUG.showDoorColliders
        scene.add(group)
        _doorHelpers.push({ group, entry })

        console.log(
            `[doorHelper] ${entry.object.name.padEnd(48)}` +
            `  type:${entry.type.padEnd(14)}` +
            `  he:(${he.x.toFixed(3)}, ${he.y.toFixed(3)}, ${he.z.toFixed(3)})`
        )
    }
}

function updateDoorHelpers() {
    if (!DEBUG.showDoorColliders) return
    for (const { group, entry } of _doorHelpers) {
        if (!entry._physicsBody) continue
        const t = entry._physicsBody.translation()
        const r = entry._physicsBody.rotation()
        group.position.set(t.x, t.y, t.z)
        group.quaternion.set(r.x, r.y, r.z, r.w)
    }
}

// ─────────────────────────────────────────
// LIGHTING
// ─────────────────────────────────────────
scene.add(new THREE.AmbientLight(0xffffff, 0.45))

const sunLight = new THREE.DirectionalLight(0xffeedd, 1.3)
sunLight.position.set(8, 14, 6)
sunLight.castShadow = SHADOW.lightCastShadow
sunLight.shadow.mapSize.set(2048, 2048)
sunLight.shadow.camera.near   = 0.5
sunLight.shadow.camera.far    = 50
sunLight.shadow.camera.left   = -20
sunLight.shadow.camera.right  = 20
sunLight.shadow.camera.top    = 20
sunLight.shadow.camera.bottom = -20
sunLight.shadow.bias          = -0.0005
scene.add(sunLight)

// ─────────────────────────────────────────
// CROSSHAIR
// ─────────────────────────────────────────
const crosshair = document.createElement('div')
crosshair.style.cssText = `
    position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
    width:6px;height:6px;background:rgba(255,255,255,0.85);
    border-radius:50%;pointer-events:none;z-index:200;display:none;`
document.body.appendChild(crosshair)

// ─────────────────────────────────────────
// INTERACTION SYSTEM
// ─────────────────────────────────────────
const INTERACT_RADIUS = 1.5
const interactables   = []
const INTERACT_HZ     = 12      // proximity scan rate; 60Hz is wasteful for a prompt
let   _interactTimer  = 0

// ─────────────────────────────────────────
// INTERACTABLE ENABLE CONFIG
//
//  INTERACTABLE_ENABLED      — per-category on/off, read once at LOAD time.
//                              A disabled category is never registered, so it
//                              costs nothing per frame (no prompt, no anim, no
//                              kinematic collider). It still renders + collides
//                              statically — it just can't be interacted with.
//  INTERACTABLE_ITEM_OVERRIDES — per-item on/off by mesh-name prefix. Longest
//                              match wins, so you can flip a whole prefix or a
//                              single instance. Overrides the category setting.
//  INTERACT_ACTIVE           — runtime per-category toggle (Settings → Interactables).
//                              Only hides/shows interaction for already-registered
//                              items; it can't bring back a load-disabled category.
// ─────────────────────────────────────────
const INTERACTABLE_ENABLED = {
    door:          true,
    door_vault:    true,
    door_swinging: true,
    messageboard:  true,
    suitcase_lid:  true,
    cash_register: true,
    ladder:        false,   // stub handler — off by default
    piano:         false,   // stub handler — off by default
}

const INTERACTABLE_ITEM_OVERRIDES = {
    // 'SM_Building_Single_FrontDoor_05': false,   // disable one specific door
    // 'SM_Prop_Piano_01':                true,    // enable one item in an off category
}

function isInteractableEnabled(name, type) {
    let v, best = -1
    for (const k in INTERACTABLE_ITEM_OVERRIDES) {
        if (name.startsWith(k) && k.length > best) { v = INTERACTABLE_ITEM_OVERRIDES[k]; best = k.length }
    }
    return v !== undefined ? v : (INTERACTABLE_ENABLED[type] ?? true)
}

// Runtime per-category gate, seeded from the load-time config.
const INTERACT_ACTIVE = { ...INTERACTABLE_ENABLED }

const _interactPrompt = document.createElement('div')
_interactPrompt.style.cssText = `
    position:fixed;bottom:22%;left:50%;transform:translateX(-50%);
    background:rgba(0,0,0,0.65);color:#fff;font:13px/1 monospace;
    padding:7px 16px;border-radius:4px;pointer-events:none;z-index:201;display:none;
    border:1px solid rgba(255,255,255,0.15);letter-spacing:0.04em;`
document.body.appendChild(_interactPrompt)

let nearestInteractable = null
const _charPos3 = new THREE.Vector3()
const _objPos3  = new THREE.Vector3()

function updateInteraction(dt = 0) {
    if (!characterBody || interactables.length === 0) return

    _interactTimer += dt
    if (_interactTimer < 1 / INTERACT_HZ) return
    _interactTimer = 0

    const cp = characterBody.translation()
    _charPos3.set(cp.x, cp.y, cp.z)

    let closest     = null
    let closestDist = INTERACT_RADIUS

    for (const entry of interactables) {
        if (INTERACT_ACTIVE[entry.type] === false || entry._active === false) continue
        entry.object.getWorldPosition(_objPos3)
        const d = _charPos3.distanceTo(_objPos3)
        if (d < closestDist) { closestDist = d; closest = entry }
    }

    const SWITCH_MARGIN = 0.15
    if (closest !== nearestInteractable) {
        if (!nearestInteractable || !closest) {
            nearestInteractable = closest
        } else {
            nearestInteractable.object.getWorldPosition(_objPos3)
            const curDist = _charPos3.distanceTo(_objPos3)
            closest.object.getWorldPosition(_objPos3)
            if (curDist - _charPos3.distanceTo(_objPos3) > SWITCH_MARGIN) nearestInteractable = closest
        }
        if (nearestInteractable) {
            _interactPrompt.textContent = interactLabel(nearestInteractable.type)
            _interactPrompt.style.display = 'block'
        } else {
            _interactPrompt.style.display = 'none'
        }
    }
}

function interactLabel(type) {
    return ({
        door:          '[E] Open Door',
        door_vault:    '[E] Open Vault',
        door_swinging: '[E] Push Open',
        ladder:        '[E] Climb',
        messageboard:  '[E] Read',
        piano:         '[E] Play',
        suitcase_lid:  '[E] Open',
        cash_register: '[E] Open Register',
    })[type] ?? '[E] Interact'
}

function triggerInteract(entry) {
    // Runtime gate (GUI). A disabled category or individual item does nothing.
    if (INTERACT_ACTIVE[entry.type] === false || entry._active === false) return
    switch (entry.type) {
        case 'door':          interactDoor(entry);              break
        case 'door_vault':    interactDoor(entry, 2.1);         break
        case 'door_swinging': interactDoor(entry, SWING_ANGLE); break
        case 'suitcase_lid':  interactSuitcaseLid(entry);       break
        case 'messageboard':  interactMessageBoard(entry);      break
        case 'cash_register': interactCashRegister(entry);      break
        case 'ladder': console.log('[interact] ladder — Phase 5'); break
        case 'piano':  console.log('[interact] piano  — Phase 7'); break
        default: console.log(`[interact] unhandled type: ${entry.type}`); break
    }
    // Let missions observe this interaction (additive; dormant when disabled).
    missions.handleInteractTrigger(entry)
}

// ─────────────────────────────────────────
// CASH REGISTER
//
// The prop is a single mesh (no separate drawer geometry), so we just nudge
// the whole mesh a small amount along its local Z as a "drawer pops" cue.
// ─────────────────────────────────────────
const CASH_REGISTER_SLIDE = 0.1   // metres — small nudge

function interactCashRegister(entry) {
    if (entry._animating) return
    const mesh = entry.object
    if (entry.closedZ === undefined) entry.closedZ = mesh.position.z
    if (entry.openZ   === undefined) entry.openZ   = entry.closedZ + CASH_REGISTER_SLIDE
    entry._drawerMesh = mesh
    entry._targetZ    = entry.state === 'closed' ? entry.openZ : entry.closedZ
    entry.state       = entry.state === 'closed' ? 'open' : 'closed'
    entry._animating  = true
    entry._animAxis   = 'posZ'
    _propAnims.push(entry)
}

// ─────────────────────────────────────────
// DOOR DIRECTION — how swing direction works
//
//  Lookup: longest matching key in DOOR_DIRECTION_OVERRIDES wins, else
//          DOOR_FIXED_DIRECTION. Keys may be a broad prefix (applies to every
//          instance) OR a specific instance name (overrides the prefix), so a
//          single door that swings the wrong way can be fixed on its own.
//
//  +1 = positive local-Y rotation (CCW when viewed from above)
//  -1 = negative local-Y rotation (CW  when viewed from above)
//
//  To fix a door that swings the wrong way (collider ends up on the wrong side):
//    1. Turn on Debug → Show Door Colliders
//    2. Press E on the door — watch which way it swings
//    3. Copy the name from the [door] <name> … console log and add it here
//       with the flipped value, e.g. 'SM_Building_Single_FrontDoor_02': -1
// ─────────────────────────────────────────
const DOOR_SWING_ANGLE   = Math.PI / 2   // 90° — standard hinged door
const DOOR_ANIM_SPEED    = 4.0           // rad/s

// Fallback for any prefix not listed in overrides below
const DOOR_FIXED_DIRECTION = 1

const DOOR_DIRECTION_OVERRIDES = {
    // ── JAIL ──────────────────────────────────────────────────────────────
    // Cell bars door — heavy, opens inward toward the cell interior
    'SM_Bld_Jail_Door_'              :  1,
    // Jail building street-facing main entrance — opens outward to street
    'SM_Building_Jail_FrontDoor_'    :  1,
    // Jail rear/alley exit — swing away from alley wall
    'SM_Bld_Jail_BackDoor_'          :  1,

    // ── SALOON ROOMS ──────────────────────────────────────────────────────
    // Upstairs guest-room doors inside the saloon building
    'SM_Bld_Saloon_RoomDoor_'        :  1,
    // Door at the head of the saloon staircase, opens onto upper landing
    'SM_Bld_Saloon_UpstairsDoor_'    :  1,

    // ── GENERIC BUILDINGS ─────────────────────────────────────────────────
    // Double-leaf front door (bank, hotel) — right-hand leaf, opens outward
    'SM_Bld_Double_FrontDoor_'       :  1,
    // Double-leaf rear/service door — usually mirrored from front
    'SM_Bld_Double_BackDoor_'        :  1,
    // Wide single back door on large buildings (stable, warehouse)
    'SM_Bld_Large_BackDoor_'         :  1,
    // Single front door on small/medium buildings (barber, store, office)
    'SM_Building_Single_FrontDoor_'  :  1,

    // ── TRAIN STATION ─────────────────────────────────────────────────────
    // Waiting-room door — platform side, swings toward the platform
    'SM_Bld_TrainStation_Door_'      :  1,

    // ── OUTHOUSE ──────────────────────────────────────────────────────────
    // Very narrow frame — flip to -1 if it clips the frame or wall
    'SM_Bld_Outhouse_01_Door_'       :  1,

    // ── VAULT ─────────────────────────────────────────────────────────────
    // Bank vault heavy door — 120° swing (2.1 rad), left-hinged → opens rightward
    'SM_Prop_Vault_Door_'            :  1,

    // ── SALOON SWINGING (bat-wing) ────────────────────────────────────────
    // Now a simple walk-through toggle like every other door
    'SM_Bld_Saloon_Swinging_Doors_'  :  1,

    // ── PER-INSTANCE OVERRIDES (longest match wins) ───────────────────────
    // Add specific instance names here to flip a single door, e.g.:
    // 'SM_Building_Single_FrontDoor_02': -1,
    // 'SM_Bld_Saloon_UpstairsDoor_03'  : -1,
}

// Longest-match lookup: specific instance keys beat broad prefix keys.
function doorDirection(name) {
    let dir = DOOR_FIXED_DIRECTION, best = -1
    for (const k in DOOR_DIRECTION_OVERRIDES) {
        if (name.startsWith(k) && k.length > best) { dir = DOOR_DIRECTION_OVERRIDES[k]; best = k.length }
    }
    return dir
}

// ─────────────────────────────────────────
// DOOR ANIMATION
// ─────────────────────────────────────────
const _doorAnims = []

function interactDoor(entry, swingAngle = DOOR_SWING_ANGLE) {
    if (entry._animating) return

    const pivot = entry.object

    // Longest-match override (specific instance beats prefix), else global default
    const direction = doorDirection(pivot.name)

    if (entry.closedRotY === undefined) entry.closedRotY = pivot.rotation.y

    if (entry.state === 'closed') {
        entry.openRotY    = entry.closedRotY + direction * swingAngle
        entry._targetRotY = entry.openRotY
        entry.state       = 'open'
    } else {
        entry._targetRotY = entry.closedRotY
        entry.state       = 'closed'
    }

    entry._animating = true
    _doorAnims.push(entry)

    console.log(
        `[door] ${pivot.name}` +
        `  dir:${direction > 0 ? '+1' : '-1'}` +
        `  target:${(entry._targetRotY * 180 / Math.PI).toFixed(1)}°` +
        `  state:${entry.state}`
    )
}

// ─────────────────────────────────────────
// updateDoorAnims — single toggle path for every door type.
// Swinging doors share this; they have no _physicsBody so updateDoorCollider
// is a no-op for them (they stay pass-through).
// ─────────────────────────────────────────
function updateDoorAnims(dt) {
    for (let i = _doorAnims.length - 1; i >= 0; i--) {
        const entry = _doorAnims[i]
        const pivot = entry.object
        const diff  = entry._targetRotY - pivot.rotation.y

        if (Math.abs(diff) > 0.001) {
            pivot.rotation.y += diff * Math.min(1, DOOR_ANIM_SPEED * dt)
            updateDoorCollider(entry)
        } else {
            pivot.rotation.y = entry._targetRotY
            updateDoorCollider(entry)
            entry._animating = false
            _doorAnims.splice(i, 1)
        }
    }
}

// Saloon bat-wing doors — toggle open/close like any door, but kept
// pass-through (no collider, see createDoorCollider). Smaller swing angle.
const SWING_ANGLE = Math.PI / 4   // 45°

// ─────────────────────────────────────────
// PROP ANIMATIONS
// ─────────────────────────────────────────
const PROP_ANIM_SPEED = 3.0
const _propAnims      = []

function interactSuitcaseLid(entry) {
    if (entry._animating) return
    const lid = entry.object
    if (entry.closedRotX === undefined) entry.closedRotX = lid.rotation.x
    if (entry.openRotX   === undefined) entry.openRotX   = entry.closedRotX - (2 * Math.PI / 3)
    entry._targetRotX = entry.state === 'closed' ? entry.openRotX : entry.closedRotX
    entry.state       = entry.state === 'closed' ? 'open' : 'closed'
    entry._animating  = true
    entry._animAxis   = 'rotX'
    _propAnims.push(entry)
}

function updatePropAnims(dt) {
    for (let i = _propAnims.length - 1; i >= 0; i--) {
        const entry = _propAnims[i]
        if (entry._animAxis === 'rotX') {
            const obj  = entry.object
            const diff = entry._targetRotX - obj.rotation.x
            if (Math.abs(diff) < 0.001) {
                obj.rotation.x   = entry._targetRotX
                entry._animating = false
                _propAnims.splice(i, 1)
            } else {
                obj.rotation.x += diff * Math.min(1, PROP_ANIM_SPEED * dt)
            }
        } else if (entry._animAxis === 'posZ') {
            const drawer = entry._drawerMesh
            if (!drawer) { _propAnims.splice(i, 1); continue }
            const diff = entry._targetZ - drawer.position.z
            if (Math.abs(diff) < 0.001) {
                drawer.position.z = entry._targetZ
                entry._animating  = false
                _propAnims.splice(i, 1)
            } else {
                drawer.position.z += diff * Math.min(1, PROP_ANIM_SPEED * dt)
            }
        }
    }
}

// ─────────────────────────────────────────
// MESSAGE BOARD
// ─────────────────────────────────────────
const BOARD_MESSAGES = [
    'WANTED\nDead or Alive\nReward: $500',
    'TOWN NOTICE\nNo shooting inside\nthe saloon after midnight.',
    'FOR SALE\nOne horse, barely used.\nAsk at the stable.',
    'SHERIFF\'S OFFICE\nAll disputes settled\nby law or lead.',
    'DANCE TONIGHT\nAt the Golden Spur Saloon\nAdmission: 10¢',
]

const _boardOverlay = document.createElement('div')
_boardOverlay.style.cssText = `
    position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
    background:rgba(20,12,4,0.92);color:#e8d5a3;
    font:15px/1.7 'Courier New',monospace;padding:28px 36px;border-radius:6px;
    border:2px solid #8b6914;pointer-events:none;z-index:400;
    display:none;white-space:pre-line;text-align:center;max-width:320px;
    box-shadow:0 0 24px rgba(0,0,0,0.8);`
document.body.appendChild(_boardOverlay)

const _boardClose = document.createElement('div')
_boardClose.style.cssText = `
    position:fixed;bottom:28%;left:50%;transform:translateX(-50%);
    background:rgba(0,0,0,0.6);color:#fff;font:12px/1 monospace;
    padding:5px 14px;border-radius:4px;pointer-events:none;z-index:401;display:none;`
_boardClose.textContent = '[E] Close'
document.body.appendChild(_boardClose)

let _boardOpen = false, _boardEntryIndex = 0

function interactMessageBoard(entry) {
    if (_boardOpen) {
        _boardOverlay.style.display = 'none'
        _boardClose.style.display   = 'none'
        _boardOpen = false
        return
    }
    _boardOverlay.textContent   = BOARD_MESSAGES[_boardEntryIndex++ % BOARD_MESSAGES.length]
    _boardOverlay.style.display = 'block'
    _boardClose.style.display   = 'block'
    _boardOpen = true
}

// ─────────────────────────────────────────
// POINTER LOCK + MOUSE LOOK
// ─────────────────────────────────────────
let isLocked = false
canvas.addEventListener('click', () => { if (isPlaying() && !isLocked && !wheelOpen) canvas.requestPointerLock() })
document.addEventListener('pointerlockchange', () => {
    isLocked = document.pointerLockElement === canvas
    crosshair.style.display = (isLocked && isPlaying() && !wheelOpen) ? 'block' : 'none'
})
document.addEventListener('mousemove', (e) => {
    if (!isLocked || wheelOpen || !isPlaying() || mapOpen) return
    targetYaw   -= e.movementX * CAM.yawSensitivity
    targetPitch += e.movementY * CAM.pitchSensitivity
    targetPitch  = THREE.MathUtils.clamp(targetPitch, 0.08, 1.4)
})
// window.addEventListener('wheel', (e) => {
//     CAM.distance = THREE.MathUtils.clamp(CAM.distance + e.deltaY * 0.01, 1.5, 14)
// }, { passive: true })

// ─────────────────────────────────────────
// EMOTE WHEEL
// ─────────────────────────────────────────
const wheelContainer = document.getElementById('emote-wheel')
const wheelSegments  = document.querySelectorAll('.wheel-segment')
let   wheelOpen      = false

function openWheel() {
    wheelOpen = true
    wheelContainer.classList.remove('hidden')
    if (isLocked) document.exitPointerLock()
}
function closeWheel() {
    wheelOpen = false
    wheelContainer.classList.add('hidden')
    if (canvas && !isLocked) setTimeout(() => canvas.requestPointerLock(), 100)
}
function playEmote(name) {
    if (!actions[name]) return
    lastLocomotionState = currentState
    emotePlayTimer = ({ Wave: 1.0, Dance: 4.0, Celebrate: 2.8, Cry: 2.2 })[name] ?? 1.5
    isPlayingEmote = true
    setState(name)
    closeWheel()
}
wheelSegments.forEach(seg => {
    seg.addEventListener('click', (e) => {
        const n = seg.dataset.emote
        playEmote(n.charAt(0).toUpperCase() + n.slice(1))
        e.stopPropagation()
    })
})
document.addEventListener('click', (e) => {
    if (wheelOpen && !wheelContainer.contains(e.target)) closeWheel()
})

// ─────────────────────────────────────────
// INPUT
// ─────────────────────────────────────────
const keys = { forward: false, backward: false, left: false, right: false, walk: false }
let jumpBufferTimer = 0

function isTyping() {
    const el = document.activeElement
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

window.addEventListener('keydown', (e) => {
    if (isTyping()) return

    // Full map is a modal overlay: M or Escape closes it; everything else is
    // swallowed so the world stays frozen underneath while it's open.
    if (mapOpen) {
        if (e.code === 'KeyM' || e.code === 'Escape') closeMap()
        e.stopImmediatePropagation()
        e.preventDefault()
        return
    }

    // Escape: universal pause / back. While PLAYING → close board first, else
    // pause. menu.js owns Escape while paused / in menus.
    if (e.code === 'Escape') {
        if (getState() === STATES.PLAYING) {
            if (_boardOpen) {
                _boardOverlay.style.display = 'none'
                _boardClose.style.display   = 'none'
                _boardOpen = false
            } else {
                setGameState(STATES.PAUSED)
            }
            // Consume it so menu.js's keydown doesn't immediately re-toggle.
            e.stopImmediatePropagation()
        }
        return
    }

    // All other gameplay keys act only while playing.
    if (getState() !== STATES.PLAYING) return

    switch (e.code) {
        case 'KeyW': case 'ArrowUp':    keys.forward  = true; break
        case 'KeyS': case 'ArrowDown':  keys.backward = true; break
        case 'KeyA': case 'ArrowLeft':  keys.left     = true; break
        case 'KeyD': case 'ArrowRight': keys.right    = true; break
        case 'ShiftLeft': case 'ShiftRight': keys.walk = true; break
        case 'KeyV': wheelOpen ? closeWheel() : openWheel(); e.preventDefault(); break
        case 'KeyE':
            if (nearestInteractable) triggerInteract(nearestInteractable)
            break
        case 'Space':
            e.preventDefault()
            jumpBufferTimer = JUMP_BUFFER
            break
        case 'KeyM':
            openMap(false)   // open the full-screen map (Esc/M closes it)
            e.preventDefault()
            break
    }
})
window.addEventListener('keyup', (e) => {
    switch (e.code) {
        case 'KeyW': case 'ArrowUp':    keys.forward  = false; break
        case 'KeyS': case 'ArrowDown':  keys.backward = false; break
        case 'KeyA': case 'ArrowLeft':  keys.left     = false; break
        case 'KeyD': case 'ArrowRight': keys.right    = false; break
        case 'ShiftLeft': case 'ShiftRight': keys.walk = false; break
    }
})

// ─────────────────────────────────────────
// GUI
// ─────────────────────────────────────────
const gui = new GUI({ title: 'Settings' })

const cf = gui.addFolder('Camera')
cf.add(CAM, 'distance', 0.5, 14, 0.1).name('Distance').listen()
cf.add(CAM, 'height', 0.5, 3.0, 0.05).name('Look Height')
cf.add(CAM, 'fov', 50, 110, 1).name('FOV').onChange(v => { camera.fov = v; camera.updateProjectionMatrix() })
cf.add(CAM, 'yawSensitivity',   0.0005, 0.01,  0.0001).name('H Sensitivity')
cf.add(CAM, 'pitchSensitivity', 0.0005, 0.01,  0.0001).name('V Sensitivity')
cf.add(CAM, 'damping',          1,      25,    0.5   ).name('Cam Smoothing')

const sf = gui.addFolder('Shadows')
sf.add(SHADOW, 'enabled').name('Enable Shadows').onChange(v => { renderer.shadowMap.enabled = v })
sf.add(SHADOW, 'lightCastShadow').name('Sun Light').onChange(v => { sunLight.castShadow = v })
sf.add(SHADOW, 'meshCastShadow').name('Mesh Cast').onChange(v => {
    scene.traverse(o => { if (o.isMesh) o.castShadow = v })
})
sf.add(SHADOW, 'meshReceiveShadow').name('Mesh Receive').onChange(v => {
    scene.traverse(o => { if (o.isMesh) o.receiveShadow = v })
})

const sceneFolder = gui.addFolder('Scene')
const SCENE = { showClouds: false }
sceneFolder.add(SCENE, 'showClouds').name('Show Clouds').onChange(v => {
    cloudObjects.forEach(c => { c.visible = v })
})

const HUD = { minimap: true }
sceneFolder.add(HUD, 'minimap').name('Minimap').onChange(v => {
    minimapVisible = v
    const show = v && isPlaying()
    minimapContainer.style.display = show ? '' : 'none'
    compassLabel.style.display     = show ? '' : 'none'
})

// Runtime interaction toggles (behaviour only — these never change what is
// rendered, so tris/draws/geom stay the same). To actually drop draw calls,
// disable items in the load-time config (INTERACTABLE_ENABLED / ITEM_OVERRIDES);
// disabled items fall through to the city's merge/instance batch.
const INTERACT_LABELS = {
    door: 'Doors', door_vault: 'Vault Door', door_swinging: 'Saloon Doors',
    messageboard: 'Message Boards', suitcase_lid: 'Suitcases',
    cash_register: 'Cash Registers', ladder: 'Ladders', piano: 'Pianos',
}
const itf = gui.addFolder('Interactables')

// Master per-category toggles (available immediately).
for (const type of Object.keys(INTERACT_ACTIVE)) {
    itf.add(INTERACT_ACTIVE, type).name(INTERACT_LABELS[type] ?? type)
}
itf.close()

// Trim the long mesh names down to something readable in the GUI.
function shortInteractName(name) {
    return name.replace(/_PolygonWestern.*$/i, '').replace(/^SM_(Bld|Building|Prop|Env)_/, '')
}

// Built after loadCity (once `interactables` is populated): one sub-folder per
// category listing every individual instance, each with its own checkbox so a
// single item can be toggled without disabling the whole category.
function buildInteractableItemGUI() {
    const byType = {}
    for (const e of interactables) (byType[e.type] = byType[e.type] || []).push(e)
    for (const type of Object.keys(byType)) {
        const list = byType[type]
        const sub  = itf.addFolder(`${INTERACT_LABELS[type] ?? type} — items (${list.length})`)
        for (const e of list) {
            if (e._active === undefined) e._active = true
            sub.add(e, '_active').name(shortInteractName(e.object.name))
        }
        sub.close()
    }
}

const dbf = gui.addFolder('Debug')
dbf.add(DEBUG, 'showCapsule').name('Show Capsule').onChange(v => {
    if (!capsuleHelper) capsuleHelper = createCapsuleHelper()
    capsuleHelper.visible = v
})
dbf.add(DEBUG, 'showDoorColliders').name('Show Door Colliders').onChange(v => {
    if (v) { createDoorHelpers(); _doorHelpers.forEach(h => { h.group.visible = true }) }
    else    { _doorHelpers.forEach(h => { h.group.visible = false }) }
})

// ─────────────────────────────────────────
// PHYSICS WORLD
// ─────────────────────────────────────────
let world           = null
let characterBody   = null
let characterCollider = null

async function initPhysics() {
    await RAPIER.init()
    world           = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 })
    world.timestep  = FIXED_TIME_STEP

    characterBody   = world.createRigidBody(
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
// TRIMESH COLLIDER
// ─────────────────────────────────────────
const MIN_COLLIDER_SIZE  = 0.5
const INSTANCE_THRESHOLD = 2

const COLLIDER_SKIP_PREFIXES = [
    'SM_Env_Grass_',
    'SM_Prop_Bush_',
    'SM_Prop_Rope_',
    'SM_Prop_Curtain_',
    'TriggerOpen',
    'SM_Bld_Saloon_Swinging_Doors_',   // bat-wing doors are pass-through — keep out of the static trimesh
]
const COLLIDER_SKIP_MATERIALS = ['glass','water','light','melvin_was_here','chalojail']

function buildCityColliderFromArrays(vertices, indices) {
    console.log(`[physics] trimesh — ${(vertices.length/3).toLocaleString()} verts, ${(indices.length/3).toLocaleString()} tris`)
    if (!vertices.length || !indices.length)  { console.error('[physics] empty trimesh'); return }
    if (indices.length % 3 !== 0)             { console.error('[physics] index count not ÷3'); return }

    const vf = new Float32Array(vertices)
    const ui = new Uint32Array(indices)
    const maxIdx = vf.length / 3
    for (let i = 0; i < ui.length; i++) {
        if (ui[i] >= maxIdx) { console.error(`[physics] out-of-range index ${ui[i]}`); return }
    }
    const cityBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    world.createCollider(RAPIER.ColliderDesc.trimesh(vf, ui), cityBody)
    console.log('[physics] trimesh built ✓')
}

// ─────────────────────────────────────────
// DOOR PHYSICS COLLIDERS
// Swinging saloon doors intentionally skipped — they are pass-through.
// ─────────────────────────────────────────
function createDoorCollider(entry) {
    if (entry.type === 'door_swinging') {
        console.log(`[door collider] SKIP pass-through: ${entry.object.name}`)
        return
    }
    if (!world) return

    const pivot = entry.object
    pivot.updateWorldMatrix(true, true)

    const box = new THREE.Box3()
    let meshFound = false
    pivot.traverse(child => {
        if (!child.isMesh) return
        child.updateWorldMatrix(true, false)
        box.union(new THREE.Box3().setFromObject(child))
        meshFound = true
    })
    if (!meshFound || box.isEmpty()) {
        console.warn(`[door collider] no meshes: ${pivot.name}`)
        return
    }

    const size   = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const hx = Math.max(size.x / 2, 0.05)
    const hy = Math.max(size.y / 2, 0.05)
    const hz = Math.max(size.z / 2, 0.05)

    const pivotWorldPos  = new THREE.Vector3()
    const pivotWorldQuat = new THREE.Quaternion()
    pivot.getWorldPosition(pivotWorldPos)
    pivot.getWorldQuaternion(pivotWorldQuat)

    const localOffset = center.clone()
        .sub(pivotWorldPos)
        .applyQuaternion(pivotWorldQuat.clone().invert())

    entry._colliderLocalOffset = localOffset
    entry._colliderHalfExtents = { x: hx, y: hy, z: hz }

    entry._physicsBody = world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(center.x, center.y, center.z)
    )
    world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz), entry._physicsBody)

    console.log(
        `[door collider] ${pivot.name.padEnd(48)}` +
        `  type:${entry.type.padEnd(14)}` +
        `  panel:${(hx*2).toFixed(2)}×${(hy*2).toFixed(2)}×${(hz*2).toFixed(2)}`
    )
}

function updateDoorCollider(entry) {
    if (!entry._physicsBody || !entry._colliderLocalOffset) return
    const pivot = entry.object
    pivot.updateWorldMatrix(true, false)
    const pivotWorldPos  = new THREE.Vector3()
    const pivotWorldQuat = new THREE.Quaternion()
    pivot.getWorldPosition(pivotWorldPos)
    pivot.getWorldQuaternion(pivotWorldQuat)
    const worldCenter = pivotWorldPos.clone().add(
        entry._colliderLocalOffset.clone().applyQuaternion(pivotWorldQuat)
    )
    entry._physicsBody.setNextKinematicTranslation({ x: worldCenter.x, y: worldCenter.y, z: worldCenter.z })
    entry._physicsBody.setNextKinematicRotation(pivotWorldQuat)
}

// ─────────────────────────────────────────
// GROUND DETECTION
// ─────────────────────────────────────────
const _down      = { x: 0, y: -1, z: 0 }
const _rayOrigin = { x: 0, y: 0, z: 0 }
const _ray       = new RAPIER.Ray(_rayOrigin, _down)

function checkGround() {
    if (!world || !characterBody) return false
    const pos = characterBody.translation()
    _rayOrigin.x = pos.x
    _rayOrigin.y = pos.y - (CAPSULE_BOTTOM - RAY_ORIGIN_OFFSET)
    _rayOrigin.z = pos.z
    const hit = world.castRayAndGetNormal(_ray, RAY_LENGTH, false, undefined, undefined, characterCollider)
    return hit ? hit.normal.y > 0.5 : false
}

// ─────────────────────────────────────────
// MOVEMENT
// ─────────────────────────────────────────
const _moveForward = new THREE.Vector3()
const _moveRight   = new THREE.Vector3()
const _wishDir     = new THREE.Vector3()
const _yawQuat     = new THREE.Quaternion()
const _axisY       = new THREE.Vector3(0, 1, 0)

let grounded     = false
let coyoteTimer  = 0
let hasMoveInput = false

function updateMovement(dt) {
    if (!characterBody) return
    if (isPlayingEmote) {
        characterBody.setLinvel({ x: 0, y: characterBody.linvel().y, z: 0 }, true)
        return
    }

    _yawQuat.setFromAxisAngle(_axisY, camYaw)
    _moveForward.set(0, 0, -1).applyQuaternion(_yawQuat).setY(0).normalize()
    _moveRight.set(1, 0, 0).applyQuaternion(_yawQuat).setY(0).normalize()

    _wishDir.set(0, 0, 0)
    if (keys.forward)  _wishDir.add(_moveForward)
    if (keys.backward) _wishDir.sub(_moveForward)
    if (keys.right)    _wishDir.add(_moveRight)
    if (keys.left)     _wishDir.sub(_moveRight)
    hasMoveInput = _wishDir.lengthSq() > 0
    if (hasMoveInput) _wishDir.normalize()

    const speed = keys.walk ? WALK_SPEED : RUN_SPEED
    const vel   = characterBody.linvel()

    if (grounded) {
        characterBody.setLinvel({ x: _wishDir.x * speed, y: vel.y, z: _wishDir.z * speed }, true)
    } else if (hasMoveInput) {
        characterBody.setLinvel({
            x: THREE.MathUtils.lerp(vel.x, _wishDir.x * speed, AIR_CONTROL),
            y: vel.y,
            z: THREE.MathUtils.lerp(vel.z, _wishDir.z * speed, AIR_CONTROL),
        }, true)
    }

    coyoteTimer = grounded ? COYOTE_TIME : Math.max(0, coyoteTimer - dt)

    if (jumpBufferTimer > 0 && coyoteTimer > 0) {
        const v = characterBody.linvel()
        characterBody.setLinvel({ x: v.x, y: JUMP_SPEED, z: v.z }, true)
        jumpBufferTimer = 0
        coyoteTimer     = 0
    }
}

// ─────────────────────────────────────────
// ANIMATION STATE MACHINE
// ─────────────────────────────────────────
let characterModel     = null
let mixer              = null
const actions          = {}
let currentState       = ''
let currentAction      = null
let smoothedSpeed      = 0
let airborneTimer      = 0
let isPlayingEmote     = false
let lastLocomotionState= 'Idle'
let emotePlayTimer     = 0

function setState(name) {
    if (currentState === name) return
    const next = actions[name]
    if (!next) return
    const prev = currentAction
    next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(FADE).play()
    if (prev && prev !== next) prev.fadeOut(FADE)
    currentAction = next
    currentState  = name
    if (animLabel) animLabel.textContent = name
}

function pickLocomotion() {
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
    if (smoothedSpeed > SPEED.runEnter)  return 'Run'
    if (smoothedSpeed > SPEED.walkEnter) return 'Walk'
    return 'Idle'
}

function updateAnimation(dt) {
    if (!mixer || !characterBody) return
    if (isPlayingEmote) {
        emotePlayTimer -= dt
        if (emotePlayTimer <= 0) { isPlayingEmote = false; setState(lastLocomotionState) }
        return
    }
    const vel = characterBody.linvel()
    smoothedSpeed = THREE.MathUtils.lerp(smoothedSpeed, Math.hypot(vel.x, vel.z), 0.25)
    airborneTimer = grounded ? 0 : airborneTimer + dt
    if      (currentState === 'Jump' && grounded)      setState(pickLocomotion())
    else if (currentState !== 'Jump' && airborneTimer > COYOTE_TIME) setState('Jump')
    else if (currentState !== 'Jump')                  setState(pickLocomotion())
}

// ─────────────────────────────────────────
// CHARACTER LOADING
// ─────────────────────────────────────────
const ANIM_FILES = [
    { name: 'Idle',      path: './animations/Idle.fbx' },
    { name: 'Jump',      path: './animations/Jump.fbx' },
    { name: 'Run',       path: './animations/Running.fbx' },
    { name: 'Walk',      path: './animations/Walking.fbx' },
    { name: 'Wave',      path: './animations/Waving.fbx' },
    { name: 'Dance',     path: './animations/Wave Hip Hop Dance.fbx' },
    { name: 'Celebrate', path: './animations/Rallying.fbx' },
    { name: 'Cry',       path: './animations/Crying.fbx' },
]

const loadFBX = (loader, path) =>
    new Promise((res, rej) => loader.load(path, res, undefined, rej))

function makeInPlace(clip) {
    for (const track of clip.tracks) {
        if (!track.name.endsWith('.position')) continue
        const v = track.values
        const x0 = v[0], z0 = v[2]
        for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i+2] = z0 }
    }
    return clip
}

async function loadCharacter() {
    const loader = new FBXLoader()
    let fbx
    try {
        fbx = await loadFBX(loader, './character/Y Bot.fbx')
    } catch (err) {
        console.warn('[character] FBX failed, using fallback capsule', err)
        createFallbackCharacter()
        return false
    }

    characterModel = fbx
    characterModel.scale.setScalar(0.005)
    characterModel.traverse(c => {
        if (c.isMesh) { c.castShadow = SHADOW.meshCastShadow; c.receiveShadow = SHADOW.meshReceiveShadow }
    })
    scene.add(characterModel)
    mixer = new THREE.AnimationMixer(characterModel)

    let done = 0
    await Promise.all(ANIM_FILES.map(async ({ name, path }) => {
        try {
            const animFbx = await loadFBX(loader, path)
            const clip    = animFbx.animations[0]
            if (clip) {
                clip.name = name
                makeInPlace(clip)
                const action   = mixer.clipAction(clip)
                const isEmote  = ['Wave','Dance','Celebrate','Cry'].includes(name)
                action.loop    = (isEmote || name === 'Jump') ? THREE.LoopOnce : THREE.LoopRepeat
                action.clampWhenFinished = isEmote || name === 'Jump'
                actions[name]  = action
            }
        } catch (err) {
            console.warn(`[anim] failed to load ${name}`, err)
        } finally {
            setLoading(50 + (++done / ANIM_FILES.length) * 40)
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
    scene.add(characterModel)
    if (animLabel) animLabel.textContent = 'Fallback capsule'
}

// ─────────────────────────────────────────
// CITY LOADING
// ─────────────────────────────────────────
let cityModel = null

const HIDEABLE_PREFIXES = [
    { prefix: 'SM_Env_Cloud', group: cloudObjects },
]

function geometryFingerprint(geom) {
    const pos = geom.attributes.position
    const box = new THREE.Box3().setFromBufferAttribute(pos)
    const sz  = box.getSize(new THREE.Vector3())
    return `${pos.count}|${geom.index?.count??0}|${sz.length().toFixed(2)}|${pos.getX(0).toFixed(2)},${pos.getY(0).toFixed(2)},${pos.getZ(0).toFixed(2)}`
}

async function loadCity() {
    const loader = new GLTFLoader()
    try {
        const gltf = await new Promise((res, rej) => loader.load('./map/scene.gltf', res, undefined, rej))

        cityModel = gltf.scene
        cityModel.scale.setScalar(0.5)
        cityModel.updateWorldMatrix(true, true)
        const invModel = cityModel.matrixWorld.clone().invert()

        const instanceBuckets  = new Map()
        const stats            = { total: 0, meshes: 0, hidden: 0 }
        const colliderVerts    = [], colliderIdxs = []
        let collSkipPrefix = 0, collSkipMat = 0, collSkipSize = 0, collIncluded = 0

        // ── INTERACTABLE RULES ─────────────────────────────────────────────
        // Every door / prop that the player can interact with.
        // Matched by mesh name prefix; first match wins.
        // door          — hinged door with physics collider, fixed direction
        // door_vault    — heavy vault door, wider swing (2.1 rad)
        // door_swinging — saloon bat-wing doors, pass-through (no collider),
        //                 simple open/close toggle like a regular door (45°)
        // ──────────────────────────────────────────────────────────────────
        const INTERACTABLE_RULES = [
            // ── Jail ──────────────────────────────────────────────────────
            { prefix: 'SM_Bld_Jail_Door_',              type: 'door'          },  // cell bars door
            { prefix: 'SM_Building_Jail_FrontDoor_',    type: 'door'          },  // jail street entrance
            { prefix: 'SM_Bld_Jail_BackDoor_',          type: 'door'          },  // jail alley exit
            // ── Saloon ────────────────────────────────────────────────────
            { prefix: 'SM_Bld_Saloon_Swinging_Doors_',  type: 'door_swinging' },  // bat-wing pass-through panels
            { prefix: 'SM_Bld_Saloon_RoomDoor_',        type: 'door'          },  // upstairs guest-room doors
            { prefix: 'SM_Bld_Saloon_UpstairsDoor_',    type: 'door'          },  // top-of-staircase door
            // ── Generic buildings ─────────────────────────────────────────
            { prefix: 'SM_Bld_Double_FrontDoor_',       type: 'door'          },  // double-leaf street front door
            { prefix: 'SM_Bld_Double_BackDoor_',        type: 'door'          },  // double-leaf rear/service door
            { prefix: 'SM_Bld_Large_BackDoor_',         type: 'door'          },  // wide single back door (stable, warehouse)
            { prefix: 'SM_Building_Single_FrontDoor_',  type: 'door'          },  // single front door (barber, store, etc.)
            // ── Train station ─────────────────────────────────────────────
            { prefix: 'SM_Bld_TrainStation_Door_',      type: 'door'          },  // waiting-room door, platform side
            // ── Outhouse ──────────────────────────────────────────────────
            { prefix: 'SM_Bld_Outhouse_01_Door_',       type: 'door'          },  // very narrow outhouse door
            // ── Vault ─────────────────────────────────────────────────────
            { prefix: 'SM_Prop_Vault_Door_',            type: 'door_vault'    },  // bank vault, 120° swing
            // ── Props ─────────────────────────────────────────────────────
            { prefix: 'SM_Prop_Ladder_',                type: 'ladder'        },  // climbable ladder
            { prefix: 'SM_Prop_MessageBoard_',          type: 'messageboard'  },  // readable notice board
            { prefix: 'SM_Prop_Suitcase_01_Lid_',       type: 'suitcase_lid'  },  // suitcase type 1 lid
            { prefix: 'SM_Prop_Suitcase_02_Lid_',       type: 'suitcase_lid'  },  // suitcase type 2 lid
            { prefix: 'SM_Prop_Cash_Register_01_',      type: 'cash_register' },  // cash register (single mesh — small slide)
            { prefix: 'SM_Prop_Piano_',                 type: 'piano'         },  // playable piano
        ]

        cityModel.traverse(c => {
            stats.total++

            // Hideable groups (clouds etc.)
            for (const { prefix, group } of HIDEABLE_PREFIXES) {
                if (c.name?.startsWith(prefix)) {
                    group.push(c); c.visible = false; stats.hidden++; return
                }
            }
            if (!c.isMesh) return
            stats.meshes++
            c.castShadow = c.receiveShadow = false
            if (c.material?.map) {
                c.material.map.minFilter     = THREE.LinearFilter
                c.material.map.generateMipmaps = false
            }

            // ── Collider geometry collection ───────────────────────────────
            {
                const skipByPrefix = COLLIDER_SKIP_PREFIXES.some(p => c.name.startsWith(p))
                const mat0  = Array.isArray(c.material) ? c.material[0] : c.material
                const matLC = mat0?.name?.toLowerCase() ?? ''
                const skipByMat = COLLIDER_SKIP_MATERIALS.some(m => matLC.includes(m))

                if (skipByPrefix) { collSkipPrefix++; }
                else if (skipByMat) { collSkipMat++; }
                else {
                    c.updateWorldMatrix(true, false)
                    const sz = new THREE.Box3().setFromObject(c).getSize(new THREE.Vector3())
                    if (Math.max(sz.x, sz.y, sz.z) < MIN_COLLIDER_SIZE) { collSkipSize++; }
                    else {
                        collIncluded++
                        const geom = c.geometry, posA = geom.attributes.position
                        const base = colliderVerts.length / 3
                        const vv   = new THREE.Vector3()
                        if (geom.index) {
                            const idx       = geom.index.array
                            const usedVerts = new Map()
                            for (let i = 0; i < idx.length; i++) {
                                const vi = idx[i]
                                if (!usedVerts.has(vi)) {
                                    usedVerts.set(vi, base + usedVerts.size)
                                    vv.set(posA.getX(vi), posA.getY(vi), posA.getZ(vi)).applyMatrix4(c.matrixWorld)
                                    colliderVerts.push(vv.x, vv.y, vv.z)
                                }
                                colliderIdxs.push(usedVerts.get(vi))
                            }
                        } else {
                            for (let i = 0; i < posA.count; i++) {
                                vv.set(posA.getX(i), posA.getY(i), posA.getZ(i)).applyMatrix4(c.matrixWorld)
                                colliderVerts.push(vv.x, vv.y, vv.z)
                                colliderIdxs.push(base + i)
                            }
                        }
                    }
                }
            }

            // ── Interactable registration ───────────────────────────────────
            // Enabled  → registered and kept as its own standalone mesh so it can
            //            animate. This is why each interactable costs one draw call.
            // Disabled → NOT registered; falls through to the instance/merge path
            //            below so it batches with the rest of the city (fewer draw
            //            calls + geometries). It still renders and keeps its static
            //            trimesh collision — it just can't be interacted with.
            //            (Triangle count is unchanged: the mesh is still drawn.)
            {
                const rule = INTERACTABLE_RULES.find(r => c.name.startsWith(r.prefix))
                if (rule) {
                    if (isInteractableEnabled(c.name, rule.type)) {
                        if (!interactables.some(e => e.object === c)) {
                            interactables.push({ object: c, type: rule.type, state: 'closed', _active: true })
                            console.log(`[interact] ${c.name.padEnd(52)}  (${rule.type})`)
                        }
                        return
                    }
                    // disabled → fall through to instance/merge classification
                }
            }

            // ── Instance / merge classification ────────────────────────────
            const mat = Array.isArray(c.material) ? c.material[0] : c.material
            if (!mat) { c.visible = false; return }

            const iKey = `${geometryFingerprint(c.geometry)}|${mat.uuid}`
            if (!instanceBuckets.has(iKey)) {
                instanceBuckets.set(iKey, { geometry: c.geometry, material: mat, matrices: [], name: c.name })
            }
            c.updateWorldMatrix(true, false)
            instanceBuckets.get(iKey).matrices.push(c.matrixWorld.clone().premultiply(invModel))
            c.visible = false
        })

        // ── Emit InstancedMesh or merged geometry ──────────────────────────
        const remainderByMat = new Map()
        let instancedCalls = 0, mergedCalls = 0, instancedCount = 0

        for (const [, { geometry, material, matrices, name }] of instanceBuckets) {
            if (matrices.length >= INSTANCE_THRESHOLD) {
                const im = new THREE.InstancedMesh(geometry, material, matrices.length)
                im.name = `__instanced_${name}_×${matrices.length}`
                im.frustumCulled = true; im.castShadow = im.receiveShadow = false
                matrices.forEach((m, i) => im.setMatrixAt(i, m))
                im.instanceMatrix.needsUpdate = true
                cityModel.add(im)
                instancedCalls++; instancedCount += matrices.length
            } else {
                const mKey = material.uuid
                if (!remainderByMat.has(mKey)) remainderByMat.set(mKey, { geometries: [], material, name: material.name || mKey.slice(0,8) })
                matrices.forEach(m => remainderByMat.get(mKey).geometries.push(geometry.clone().applyMatrix4(m)))
            }
        }
        for (const [, { geometries, material, name }] of remainderByMat) {
            if (!geometries.length) continue
            try {
                const merged = mergeGeometries(geometries, false)
                if (!merged) { console.warn(`[merge] failed: "${name}"`); continue }
                const mesh = new THREE.Mesh(merged, material)
                mesh.name = `__merged_${name}`; mesh.frustumCulled = true
                cityModel.add(mesh); mergedCalls++
            } catch (err) { console.warn(`[merge] exception: "${name}"`, err) }
        }

        console.group('[city] optimise result')
        console.log(`  Instanced: ${instancedCalls} calls (${instancedCount} meshes)`)
        console.log(`  Merged:    ${mergedCalls} calls`)
        console.log(`  Total:     ${instancedCalls + mergedCalls}  (was ~${stats.meshes})`)
        console.log(`  Reduction: ${(((stats.meshes - instancedCalls - mergedCalls) / stats.meshes)*100).toFixed(1)}%`)
        console.groupEnd()

        scene.add(cityModel)

        // ── Full-map camera (static, city-wide, north-up) ──
        // The minimap camera is a player-following one set up at module level.
        setupMapCamera(new THREE.Box3().setFromObject(cityModel))

        console.log(`[physics] collider skip — prefix:${collSkipPrefix} mat:${collSkipMat} size:${collSkipSize} included:${collIncluded}`)
        buildCityColliderFromArrays(colliderVerts, colliderIdxs)
        console.log('[city] loaded ✓')
        return true

    } catch (err) {
        console.warn('[city] glTF failed', err)
        return false
    }
}

// ─────────────────────────────────────────
// AUTO SPAWN
// ─────────────────────────────────────────
function autoSpawn(model) {
    const box     = new THREE.Box3().setFromObject(model)
    const center  = box.getCenter(new THREE.Vector3())
    const spawnY  = box.min.y + 90.0
    characterBody.setTranslation({ x: center.x + 50, y: spawnY, z: center.z }, true)
    characterBody.setLinvel({ x: 0, y: 0, z: 0 }, true)
    console.log(`[spawn] x:${(center.x+50).toFixed(2)} y:${spawnY.toFixed(2)} z:${center.z.toFixed(2)}`)
}

// ─────────────────────────────────────────
// RESIZE
// ─────────────────────────────────────────
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight)
})

// ─────────────────────────────────────────
// CAMERA SYNC
// ─────────────────────────────────────────
const _camTarget = new THREE.Vector3()
const _camOffset = new THREE.Vector3()

function syncCamera(charPos) {
    _camTarget.set(charPos.x, charPos.y + CAM.height, charPos.z)
    const d = CAM.distance
    _camOffset.set(
        d * Math.sin(camYaw)  * Math.cos(camPitch),
        d * Math.sin(camPitch),
        d * Math.cos(camYaw)  * Math.cos(camPitch)
    )
    camera.position.copy(_camTarget).add(_camOffset)
    camera.lookAt(_camTarget)
}

// ─────────────────────────────────────────
// PERF PANEL
// ─────────────────────────────────────────
const perfPanel = document.createElement('div')
perfPanel.style.cssText = `
    position:fixed;bottom:8px;right:8px;background:rgba(0,0,0,0.6);color:#0f0;
    font:11px/1.5 monospace;padding:6px 10px;border-radius:4px;pointer-events:none;z-index:300;`
document.body.appendChild(perfPanel)
let perfFrames = 0, perfAcc = 0

// ─────────────────────────────────────────
// MINIMAP — GTA-style: a zoomed, top-down ortho camera that FOLLOWS the player
// and ROTATES so the way you're facing is always "up". Rendered into a 200×200
// region of the main canvas (after the main render); blip fixed at the centre.
// ─────────────────────────────────────────
let   minimapVisible = true
let   minimapTimer   = 0
const MINIMAP_FPS    = 20          // update 20×/sec, not 60 — named for easy tuning
const MINIMAP_SIZE   = 200
const MINIMAP_LEFT   = 16, MINIMAP_BOTTOM = 16
const MINIMAP_ZOOM   = 42          // world half-extent shown (smaller = more zoomed in)
const MINIMAP_HEIGHT = 250         // camera height above the player
const MAP_ZOOM       = 0.6         // full-map extent factor (<1 = more zoomed in)
const _blipVec       = new THREE.Vector3()
let   _mainTris = 0, _mainCalls = 0   // snapshot of the MAIN render for perfPanel

// Follows the player every refresh (position + heading set in renderMinimap).
const minimapCamera  = new THREE.OrthographicCamera(
    -MINIMAP_ZOOM, MINIMAP_ZOOM, MINIMAP_ZOOM, -MINIMAP_ZOOM, 0.1, 2000)

// Full-screen MAP (the "M" / pause-menu map): a static, city-wide top-down view.
// Camera is built once the city box is known (see loadCity → setupMapCamera).
let   mapCamera = null
let   mapOpen   = false
let   _mapFromPause = false         // remember to restore the pause menu on close
const _mapTarget = new THREE.Vector3()

// Container is a SQUARE: its radial-gradient masks the map's corners (the GL
// region lives in the main canvas and can't be CSS-clipped), a child ring draws
// the circle, and the overlay canvas holds the blip.
const minimapContainer = document.createElement('div')
minimapContainer.id = 'minimap'
minimapContainer.style.cssText = `
    position:fixed;bottom:${MINIMAP_BOTTOM}px;left:${MINIMAP_LEFT}px;
    width:${MINIMAP_SIZE}px;height:${MINIMAP_SIZE}px;z-index:150;pointer-events:none;
    background:radial-gradient(circle 100px at 50% 50%, transparent 0 98px, #0a0a0f 99px);`

const _minimapRing = document.createElement('div')
_minimapRing.style.cssText = `
    position:absolute;inset:0;border-radius:50%;
    border:2px solid rgba(255,255,255,0.3);pointer-events:none;`
minimapContainer.appendChild(_minimapRing)

const minimapOverlay = document.createElement('canvas')
minimapOverlay.id = 'minimap-overlay'
minimapOverlay.width = MINIMAP_SIZE
minimapOverlay.height = MINIMAP_SIZE
minimapOverlay.style.cssText = `position:absolute;top:0;left:0;width:${MINIMAP_SIZE}px;height:${MINIMAP_SIZE}px;pointer-events:none;`
minimapContainer.appendChild(minimapOverlay)
document.body.appendChild(minimapContainer)
const overlayCtx = minimapOverlay.getContext('2d')

// The top-down view is rendered into this offscreen target at MINIMAP_FPS, then
// blitted into the canvas corner EVERY frame (one draw call). Blitting every
// frame is required because the main render clears the whole canvas at 60fps —
// rendering the heavy scene straight into a scissor region only at 20fps would
// leave the corner showing the main view on the other 40 frames.
const _mmDPR     = Math.min(window.devicePixelRatio, 2)
const minimapRT  = new THREE.WebGLRenderTarget(MINIMAP_SIZE * _mmDPR, MINIMAP_SIZE * _mmDPR)
minimapRT.texture.colorSpace = THREE.SRGBColorSpace   // already display-encoded by the RT render

const _mmQuadScene = new THREE.Scene()
const _mmQuadCam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
const _mmQuad      = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({ map: minimapRT.texture, depthTest: false, depthWrite: false, toneMapped: false }),
)
_mmQuadScene.add(_mmQuad)

const compassLabel = document.createElement('div')
compassLabel.textContent = 'N'
compassLabel.style.cssText = `
    position:fixed;bottom:${MINIMAP_BOTTOM + MINIMAP_SIZE + 6}px;left:${MINIMAP_LEFT + MINIMAP_SIZE / 2 - 3}px;
    color:#fff;font:11px monospace;z-index:151;pointer-events:none;`
document.body.appendChild(compassLabel)

// ── Full-screen MAP overlay ────────────────────────────────
// A dimmed full-screen layer with a centred square "window" the city-wide view
// renders through (box-shadow dims everything outside the square — see below).
const mapOverlay = document.createElement('div')
mapOverlay.id = 'fullmap'
mapOverlay.style.cssText = `
    position:fixed;inset:0;z-index:210;display:none;pointer-events:auto;
    font:13px 'Courier New',monospace;color:#e8d5a3;`
mapOverlay.innerHTML = `
    <div class="map-window" style="
        position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
        border:2px solid rgba(232,213,163,0.6);border-radius:4px;
        box-shadow:0 0 0 9999px rgba(0,0,0,0.85);">
        <div class="map-blip" style="
            position:absolute;left:50%;top:50%;width:0;height:0;
            border-left:7px solid transparent;border-right:7px solid transparent;
            border-bottom:14px solid #ffffff;filter:drop-shadow(0 0 1px #000);
            transform:translate(-50%,-50%);"></div>
    </div>
    <div style="position:absolute;top:18px;left:50%;transform:translateX(-50%);
        letter-spacing:3px;font-size:16px;">MAP</div>
    <div style="position:absolute;bottom:18px;left:50%;transform:translateX(-50%);
        opacity:0.7;">[M] or [Esc] to close</div>`
document.body.appendChild(mapOverlay)
const mapWindow = mapOverlay.querySelector('.map-window')
const mapBlip   = mapOverlay.querySelector('.map-blip')

// Built once, from the city's bounding box — a fixed, north-up, city-wide camera.
function setupMapCamera(box) {
    const size   = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const halfW  = size.x / 2 * MAP_ZOOM
    const halfD  = size.z / 2 * MAP_ZOOM
    mapCamera = new THREE.OrthographicCamera(-halfW, halfW, halfD, -halfD, 0.1, 5000)
    mapCamera.up.set(0, 0, -1)                 // north (−z) up
    mapCamera.position.set(center.x, box.max.y + 500, center.z)
    mapCamera.lookAt(center.x, center.y, center.z)
    mapCamera.updateProjectionMatrix()
}

function openMap(fromPause = false) {
    if (!mapCamera) return
    _mapFromPause = fromPause
    mapOpen = true
    mapOverlay.style.display = 'block'
    // Freeze the player and free the cursor while the map is up.
    keys.forward = keys.backward = keys.left = keys.right = keys.walk = false
    if (isLocked) document.exitPointerLock()
}
function closeMap() {
    mapOpen = false
    mapOverlay.style.display = 'none'
    if (_mapFromPause) { _mapFromPause = false; showPauseMenu() }
}

function updatePerfPanel(dt) {
    perfFrames++; perfAcc += dt
    if (perfFrames >= 60) {
        const fps  = Math.round(perfFrames / perfAcc)
        const ms   = ((perfAcc / perfFrames) * 1000).toFixed(1)
        const info = renderer.info
        perfPanel.innerHTML =
            `FPS: ${fps}  |  ${ms} ms<br>` +
            `Tris: ${(_mainTris/1000).toFixed(0)}k  Draws: ${_mainCalls}<br>` +
            `Geoms: ${info.memory.geometries}  Tex: ${info.memory.textures}`
        perfFrames = 0; perfAcc = 0
    }
}

// ─────────────────────────────────────────
// GAME LOOP
// ─────────────────────────────────────────
const clock             = new THREE.Clock()
let physicsAccumulator  = 0
let hasPrevState        = false
const _prevPos          = new THREE.Vector3()
const _currPos          = new THREE.Vector3()
const _smoothPos        = new THREE.Vector3()
const _targetQuat       = new THREE.Quaternion()

function stepPhysics(dt) {
    physicsAccumulator += dt
    let steps = 0
    while (physicsAccumulator >= FIXED_TIME_STEP && steps < MAX_SUBSTEPS) {
        updateMovement(FIXED_TIME_STEP)
        world.step()
        grounded = checkGround()
        jumpBufferTimer = Math.max(0, jumpBufferTimer - FIXED_TIME_STEP)
        const p = characterBody.translation()
        _prevPos.copy(_currPos)
        _currPos.set(p.x, p.y, p.z)
        if (!hasPrevState) { _prevPos.copy(_currPos); hasPrevState = true }
        physicsAccumulator -= FIXED_TIME_STEP
        steps++
    }
    if (steps >= MAX_SUBSTEPS) physicsAccumulator = 0
}

// ─────────────────────────────────────────
// MINIMAP RENDER — runs AFTER the main render. The heavy top-down scene render
// goes into an offscreen target at MINIMAP_FPS; the cached target is then blitted
// into the canvas corner every frame (the main render clears the whole canvas).
// ─────────────────────────────────────────
function renderMinimap(delta) {
    if (!minimapVisible || !isPlaying() || mapOpen) return

    // Refresh the offscreen top-down view at MINIMAP_FPS (the expensive part).
    minimapTimer += delta
    if (minimapTimer >= 1 / MINIMAP_FPS) {
        minimapTimer = 0
        // Follow the player and rotate so their facing direction points "up".
        // up = camera-forward (horizontal) → that world direction becomes screen-up.
        minimapCamera.position.set(_smoothPos.x, _smoothPos.y + MINIMAP_HEIGHT, _smoothPos.z)
        minimapCamera.up.set(-Math.sin(camYaw), 0, -Math.cos(camYaw))
        _mapTarget.set(_smoothPos.x, _smoothPos.y, _smoothPos.z)
        minimapCamera.lookAt(_mapTarget)

        const prevFog = scene.fog
        scene.fog = null                   // FogExp2 would wash out the top-down view
        renderer.setRenderTarget(minimapRT)
        renderer.clear()
        renderer.render(scene, minimapCamera)
        renderer.setRenderTarget(null)
        scene.fog = prevFog
        renderer.setViewport(0, 0, window.innerWidth, window.innerHeight)
    }

    // Blit the cached target into the canvas corner EVERY frame — one draw call,
    // so it survives the main render's full-canvas clear.
    renderer.autoClear = false
    renderer.setViewport(MINIMAP_LEFT, MINIMAP_BOTTOM, MINIMAP_SIZE, MINIMAP_SIZE)
    renderer.setScissor (MINIMAP_LEFT, MINIMAP_BOTTOM, MINIMAP_SIZE, MINIMAP_SIZE)
    renderer.setScissorTest(true)
    renderer.render(_mmQuadScene, _mmQuadCam)
    renderer.setScissorTest(false)
    renderer.autoClear = true
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight)

    // Player blip — the map rotates under it, so the arrow is pinned to the
    // centre, always pointing up (the direction the camera is facing).
    overlayCtx.clearRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE)
    overlayCtx.save()
    overlayCtx.translate(MINIMAP_SIZE / 2, MINIMAP_SIZE / 2)
    overlayCtx.beginPath()
    overlayCtx.moveTo(0, -10)              // nose
    overlayCtx.lineTo(-5, 5)
    overlayCtx.lineTo(5, 5)
    overlayCtx.closePath()
    overlayCtx.fillStyle   = '#ffffff'
    overlayCtx.strokeStyle = 'rgba(0,0,0,0.6)'
    overlayCtx.lineWidth   = 1.5
    overlayCtx.fill()
    overlayCtx.stroke()
    overlayCtx.restore()
}

// ─────────────────────────────────────────
// FULL MAP RENDER — while open, renders the static city-wide view into a large
// centred square of the canvas every frame (it is only open when paused-ish, so
// the per-frame full render is fine). A DOM blip is positioned by projection.
// ─────────────────────────────────────────
function renderFullMap() {
    if (!mapOpen || !mapCamera) return

    const S = Math.min(window.innerWidth, window.innerHeight) * 0.8
    const x = (window.innerWidth  - S) / 2
    const y = (window.innerHeight - S) / 2   // symmetric → same in bottom-origin GL coords
    mapWindow.style.width  = `${S}px`
    mapWindow.style.height = `${S}px`

    const prevFog = scene.fog
    scene.fog = null
    renderer.autoClear = false
    renderer.setViewport(x, y, S, S)
    renderer.setScissor (x, y, S, S)
    renderer.setScissorTest(true)
    renderer.clear()
    renderer.render(scene, mapCamera)
    renderer.setScissorTest(false)
    renderer.autoClear = true
    scene.fog = prevFog
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight)

    // Player blip (DOM, positioned inside the centred window).
    _blipVec.copy(_smoothPos).project(mapCamera)
    mapBlip.style.left = `${(_blipVec.x * 0.5 + 0.5) * S}px`
    mapBlip.style.top  = `${(1 - (_blipVec.y * 0.5 + 0.5)) * S}px`
    mapBlip.style.transform = `translate(-50%,-50%) rotate(${camYaw}rad)`
}

function tick() {
    requestAnimationFrame(tick)
    const delta = Math.min(clock.getDelta(), 0.1)
    updatePerfPanel(delta)

    const playing = isPlaying()

    if (playing && world && characterBody) {
        stepPhysics(delta)

        const alpha = THREE.MathUtils.clamp(physicsAccumulator / FIXED_TIME_STEP, 0, 1)
        _smoothPos.copy(_prevPos).lerp(_currPos, alpha)

        if (characterModel) {
            characterModel.position.set(_smoothPos.x, _smoothPos.y - CAPSULE_BOTTOM, _smoothPos.z)
            updateCapsuleHelper()
            const vel = characterBody.linvel()
            if (Math.abs(vel.x) > 0.3 || Math.abs(vel.z) > 0.3) {
                _targetQuat.setFromAxisAngle(_axisY, Math.atan2(vel.x, vel.z))
                characterModel.quaternion.slerp(_targetQuat, Math.min(1, 12 * delta))
            }
        }

        camYaw   = THREE.MathUtils.damp(camYaw,   targetYaw,   CAM.damping, delta)
        camPitch = THREE.MathUtils.damp(camPitch,  targetPitch, CAM.damping, delta)
        syncCamera(_smoothPos)

        updateAnimation(delta)
        updateInteraction(delta)
        updateDoorAnims(delta)   // syncs each door's collider while it animates
        updatePropAnims(delta)
        updateDoorHelpers()
        missions.updateMissions(delta)
    } else if (world && characterBody && characterModel) {
        // Paused / dialogue / menu (with world loaded): hold the camera on the
        // frozen frame; no physics step, no animation advance.
        syncCamera(_smoothPos)
    }

    if (mixer && playing) mixer.update(delta)

    // Main render (full viewport), then the minimap region on top.
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight)
    renderer.setScissorTest(false)
    renderer.info.reset()
    renderer.render(scene, camera)
    _mainTris  = renderer.info.render.triangles   // snapshot before the minimap render
    _mainCalls = renderer.info.render.calls
    renderMinimap(delta)
    renderFullMap()
}

// ─────────────────────────────────────────
// GAME SHELL — subtitle, HUD visibility, lazy world load, state wiring
// ─────────────────────────────────────────

// Subtitle / objective toast (used by worldApi.showSubtitle)
const _subtitle = document.createElement('div')
_subtitle.style.cssText = `
    position:fixed;bottom:14%;left:50%;transform:translateX(-50%);
    background:rgba(0,0,0,0.6);color:#e8d5a3;font:14px/1.4 'Courier New',monospace;
    padding:8px 18px;border-radius:4px;pointer-events:none;z-index:202;display:none;
    border:1px solid rgba(139,105,20,0.5);text-align:center;max-width:60%;`
document.body.appendChild(_subtitle)
let _subtitleTimer = null
function showSubtitle(text, ms = 3500) {
    _subtitle.textContent = text
    _subtitle.style.display = 'block'
    clearTimeout(_subtitleTimer)
    _subtitleTimer = setTimeout(() => { _subtitle.style.display = 'none' }, ms)
}

// World HUD elements that should only show while playing.
const _hudInstructions = document.getElementById('instructions')
function setWorldHudVisible(v) {
    if (_hudInstructions) _hudInstructions.style.display = v ? '' : 'none'
    perfPanel.style.display = v ? '' : 'none'
    const showMap = v && minimapVisible
    minimapContainer.style.display = showMap ? '' : 'none'
    compassLabel.style.display     = showMap ? '' : 'none'
    if (!v) {
        crosshair.style.display       = 'none'
        _interactPrompt.style.display = 'none'
        _boardOverlay.style.display   = 'none'
        _boardClose.style.display     = 'none'
        _boardOpen = false
    }
}

// ── Lazy heavy world load (idempotent) ─────────────────────
let _worldReady    = false
let _worldStarting = null

async function startWorld() {
    if (_worldReady) return true
    if (_worldStarting) return _worldStarting
    _worldStarting = (async () => {
        if (loadingScreen) loadingScreen.classList.remove('hidden')
        setLoading(15); await initPhysics()
        setLoading(30); const cityOk = await loadCity()
        setLoading(50); await loadCharacter()
        setLoading(100)

        // Frustum cull audit
        let bad = 0
        cityModel?.traverse(c => { if (c.isMesh && !c.frustumCulled) { console.warn(`[cull] frustumCulled=false: ${c.name}`); bad++ } })
        console.log(bad ? `[cull] ✗ ${bad} violations` : '[cull] ✓ all good')

        // Door colliders (swinging doors skipped inside createDoorCollider)
        for (const entry of interactables) {
            if (entry.type === 'door' || entry.type === 'door_vault' || entry.type === 'door_swinging') {
                createDoorCollider(entry)
            }
        }

        // Per-item GUI checkboxes — append-only, so run exactly once.
        buildInteractableItemGUI()

        if (cityModel) autoSpawn(cityModel)
        const p = characterBody.translation()
        _currPos.set(p.x, p.y, p.z); _prevPos.copy(_currPos); _smoothPos.copy(_currPos); hasPrevState = true

        if (loadingScreen) loadingScreen.classList.add('hidden')
        _worldReady = true
        return cityOk
    })()
    try { return await _worldStarting } finally { _worldStarting = null }
}

// New Game when the world already exists: respawn instead of reloading.
function resetWorldToDefaultSpawn() {
    if (cityModel) autoSpawn(cityModel)
    const p = characterBody.translation()
    _currPos.set(p.x, p.y, p.z); _prevPos.copy(_currPos); _smoothPos.copy(_currPos); hasPrevState = true
    camYaw = targetYaw = 0
    camPitch = targetPitch = 0.4
}

// ── Save bridge (script.js owns the physics body) ──────────
function captureSaveFromWorld() {
    const p = characterBody.translation()
    return {
        position:    { x: p.x, y: p.y, z: p.z },
        camYaw:      targetYaw,
        camPitch:    targetPitch,
        ...missions.serializeProgress(),
        missionName: missions.getActiveMission()?.name ?? 'Free Roam',
        location:    'Dead Mesa',
    }
}

function applySaveToWorld(d) {
    characterBody.setTranslation({ x: d.position.x, y: d.position.y, z: d.position.z }, true)
    characterBody.setLinvel({ x: 0, y: 0, z: 0 }, true)
    targetYaw   = camYaw   = d.camYaw   ?? 0
    targetPitch = camPitch = d.camPitch ?? 0.4
    const p = characterBody.translation()
    _currPos.set(p.x, p.y, p.z); _prevPos.copy(_currPos); _smoothPos.copy(_currPos); hasPrevState = true   // reseed interp
    missions.restoreProgress(d)
}

// ── Hooks handed to the menu ───────────────────────────────
const hooks = {
    async startNewGame() {
        try { await startWorld() } catch (err) { console.error('[shell] startWorld failed', err) }
        resetWorldToDefaultSpawn()
        missions.restoreProgress(null)
        setGameState(STATES.CUTSCENE)
        playIntro(() => setGameState(STATES.PLAYING))
    },
    async continueGame() {
        const slot = saveSystem.mostRecentSlot()
        if (slot != null) await hooks.loadSlot(slot)
    },
    async loadSlot(slot) {
        const data = saveSystem.load(slot)
        if (!data) return
        try { await startWorld() } catch (err) { console.error('[shell] startWorld failed', err) }
        applySaveToWorld(data)
        setGameState(STATES.PLAYING)   // loads skip the intro
    },
    saveToSlot(slot) {
        return saveSystem.save(slot, captureSaveFromWorld())
    },
    resume()       { setGameState(STATES.PLAYING) },
    quitToMenu()   { setGameState(STATES.MAINMENU) },
    openSettings() { gui.show() },
    closeSettings(){ gui.hide() },
    openMap()      { hideAllMenus(); openMap(true) },   // from pause menu; Esc/M returns
}

// ── Mission → world bridge ─────────────────────────────────
const worldApi = {
    getPlayerPos() { const p = characterBody.translation(); return { x: p.x, y: p.y, z: p.z } },
    teleport(x, y, z) {
        characterBody.setTranslation({ x, y, z }, true)
        characterBody.setLinvel({ x: 0, y: 0, z: 0 }, true)
        const p = characterBody.translation()
        _currPos.set(p.x, p.y, p.z); _prevPos.copy(_currPos); hasPrevState = true
    },
    distanceTo(x, y, z) { const p = characterBody.translation(); return Math.hypot(p.x - x, p.y - y, p.z - z) },
    showSubtitle,
}

// ── State-driven side effects ──────────────────────────────
onStateChange((next) => {
    const playing = next === STATES.PLAYING
    setWorldHudVisible(playing)
    if (!playing) {
        keys.forward = keys.backward = keys.left = keys.right = keys.walk = false
        if (characterBody) characterBody.setLinvel({ x: 0, y: 0, z: 0 }, true)
        if (isLocked) document.exitPointerLock()
    }
})

// ─────────────────────────────────────────
// BOOTSTRAP — synchronous shell; the menu shows instantly,
// the 39MB world is loaded lazily on New Game / Continue.
// ─────────────────────────────────────────
function bootShell() {
    if (loadingScreen) loadingScreen.classList.add('hidden')   // reused later for world load
    gui.hide()                                                 // Settings panel hidden behind the menu
    setWorldHudVisible(false)

    missions.initMissions(worldApi)
    initCutscene()
    initMenu(hooks)

    // Initial state is already MAINMENU, so show it explicitly (setState would no-op).
    showMainMenu()

    tick()   // single rAF loop for the whole app
}

bootShell()