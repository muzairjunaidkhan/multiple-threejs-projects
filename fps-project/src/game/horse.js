/**
 * ═══════════════════════════════════════════════════════════
 * horse.js — horses to ride
 * ───────────────────────────────────────────────────────────
 * The model is static/character/cast/horse.glb: "Horse" by Henry S
 * (Sketchfab @henry_7), CC-BY 4.0, rigged and animated (walk, gallop with left/right
 * turning variants, three idles, eating, rearing …). It was slimmed by a
 * scratchpad tool: 15 of its 28 clips, textures down to 2048 at most.
 *
 * Two horses wait in town. [E] mounts. While you ride, script.js's capsule
 * carries horse and rider (a wider collider is swapped in); this module turns
 * the horse toward where you steer (horses don't strafe), picks walk / canter /
 * gallop, and says where the saddle is so the rider can sit in it.
 *
 * World access is injected (initHorses):
 *   { scene, world, RAPIER, groundAt(x, z, fromY), colliderGroups, sound(name, target, opts),
 *     sound2D(name, opts) }
 * ═══════════════════════════════════════════════════════════
 */

import * as THREE from 'three'
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

export const SCALE = 0.062            // raw model units → world (a horse's back at ~0.85 u; the player is 0.96 u tall)
// Ground speed of the clips at timeScale 1, in raw model units/s: the planted hooves' backward
// slide (measured on the rig). A gait plays at timeScale = speed / (HOOF_SPEED × SCALE).
const HOOF_SPEED = { Walk: 10.3, Gallop: 43.2 }
// Hoof sounds, as fractions of each cycle: a walk lands one hoof at a time (a single clop each);
// a gallop plays one recorded stride (all four beats) as the cycle starts.
const HOOF_BEATS = { Walk: { at: [0.05, 0.3, 0.55, 0.8], sound: 'hoof' }, Gallop: { at: [0.06], sound: 'gallop' } }

export const GAITS = { walk: 0.9, canter: 3.6, gallop: 5.4 }        // u/s
const TURN  = { walk: 2.6, canter: 2.0, gallop: 1.5 }                // rad/s at that gait
const ACCEL = 3.2, BRAKE = 6.0                                       // u/s²
const FADE  = 0.3

// Where they wait: a hitching post on Main Street's east side, and the trough at the east end of
// town where the road comes in from the hills. yaw: 0 = facing +z (toward the post / the trough).
const PLACES = [
    { name: 'Main Street', x: -19.75, z: 2.75, y: -22, yaw: Math.PI / 2, idle: 'Idle' },
    { name: 'East trough', x: -3.35,  z: 0.8,  y: -22, yaw: -Math.PI / 2, idle: 'Eat' },
]
const BODY = { hx: 0.19, hy: 0.42, hz: 0.68 }                        // the parked horse's blocking box (u)
const SADDLE_BONE = 'BN_Spine_02_04_04'

let api = null, asset = null
const herd = []
let ridden = null

export function initHorses(worldApi) { api = worldApi }

export async function loadHorses() {
    if (asset) return true
    try {
        asset = await new GLTFLoader().loadAsync('./character/cast/horse.glb')
    } catch (err) {
        console.error('[horse] model failed to load — no horses', err)
        return false
    }
    asset.scene.traverse(o => { if (o.isSkinnedMesh) o.frustumCulled = false })
    for (const place of PLACES) herd.push(spawn(place))
    console.log(`[horse] ${herd.length} waiting`)
    return true
}

function spawn(place) {
    const root = SkeletonUtils.clone(asset.scene)
    root.name = `Horse:${place.name}`
    const body = new THREE.Group()                // root carries position + yaw; body the model's scale
    body.add(root)
    root.scale.setScalar(SCALE)
    api.scene.add(body)
    const mixer = new THREE.AnimationMixer(root)
    const actions = Object.fromEntries(asset.animations.map(c => [c.name, mixer.clipAction(c)]))
    const { world, RAPIER } = api
    const rb = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased())
    // in the NPCs' collision group: it blocks the player, but ground probes (its own included) look through it
    const desc = RAPIER.ColliderDesc.cuboid(BODY.hx, BODY.hy, BODY.hz).setTranslation(0, BODY.hy, 0)
    if (api.colliderGroups != null) desc.setCollisionGroups(api.colliderGroups)
    const col = world.createCollider(desc, rb)
    const h = {
        place, body, root, mixer, actions, rb, col, saddle: root.getObjectByName(SADDLE_BONE),
        pos: new THREE.Vector3(), yaw: 0, speed: 0, yawRate: 0, current: null, idleT: 0, beatT: 0,
    }
    park(h)
    return h
}

/** Back to its post: standing, idle, blocking. */
function park(h, at = h.place) {
    h.pos.set(at.x, 0, at.z)
    // Rapier indexes a new collider for queries only on world.step(), so at load this can miss;
    // updateHorses() retries until it lands
    const g = api.groundAt(at.x, at.z, (at.y ?? h.pos.y) + 1.5)
    h.pos.y = g ?? at.y ?? 0
    h.needGround = g == null
    h.yaw = at.yaw ?? h.yaw
    h.speed = 0
    h.yawRate = 0
    h.col.setEnabled(true)
    play(h, h.place.idle, 0, true)
    sync(h)
}

function play(h, name, fade = FADE, randomPhase = false) {
    if (h.current === name) return h.actions[name]
    const next = h.actions[name], prev = h.current && h.actions[h.current]
    if (!next) return null
    next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play()
    if (randomPhase) next.time = Math.random() * next.getClip().duration
    if (prev && fade > 0) prev.crossFadeTo(next, fade, false)
    else if (prev) prev.stop()
    h.current = name
    return next
}

function sync(h) {
    h.body.position.copy(h.pos)
    h.body.rotation.set(0, h.yaw, 0)
    h.rb.setNextKinematicTranslation({ x: h.pos.x, y: h.pos.y, z: h.pos.z })
    h.rb.setNextKinematicRotation(h.body.quaternion)
}

// ─────────────────────────────────────────
// RIDING
// ─────────────────────────────────────────
export const herdList = () => herd
export const riding = () => ridden

/** Climb on `h`: the horse stops blocking (the capsule takes over) and the rider is placed on it. */
export function mount(h) {
    if (ridden || !h) return false
    ridden = h
    h.col.setEnabled(false)
    api.sound?.('hoof', h.body, { volume: 0.5 })
    return true
}

/** Climb off on the horse's left. Returns where the rider stands (world x/z, y of the horse's feet). */
export function dismount() {
    const h = ridden
    if (!h) return null
    ridden = null
    h.speed = 0
    h.yawRate = 0
    const at = { x: h.pos.x + Math.cos(h.yaw) * 0.55, y: h.pos.y, z: h.pos.z - Math.sin(h.yaw) * 0.55, yaw: h.yaw }
    // the horse stays where it was left, facing the same way
    h.col.setEnabled(true)
    play(h, 'Idle')
    sync(h)
    return at
}

/** Everyone home (New Game, a load, the rider died). */
export function resetHorses() {
    ridden = null
    for (const h of herd) park(h)
}

const _wish = new THREE.Vector3()
/**
 * Steer the ridden horse for one physics step. `wish`: the move direction (camera-relative,
 * normalised, or zero); `gait`: 'walk' | 'canter' | 'gallop'. Returns the horizontal velocity
 * for the capsule ({ x, z }); the horse only ever moves the way it faces.
 */
export function steer(dt, wish, gait) {
    const h = ridden
    if (!h) return { x: 0, z: 0 }
    const want = wish.lengthSq() > 0
    let target = 0
    if (want) {
        const wantYaw = Math.atan2(wish.x, wish.z)
        const d = Math.atan2(Math.sin(wantYaw - h.yaw), Math.cos(wantYaw - h.yaw))
        const rate = TURN[gait] * (h.speed < 0.3 ? 1.4 : 1)
        const turn = THREE.MathUtils.clamp(d, -rate * dt, rate * dt)
        h.yaw += turn
        h.yawRate = THREE.MathUtils.lerp(h.yawRate, turn / dt, 0.2)
        // a sharp turn reins it in (wheeling round on the spot rather than drawing a wide arc)
        target = GAITS[gait] * THREE.MathUtils.clamp(Math.cos(d) * 0.7 + 0.3, 0.25, 1)
    } else h.yawRate = THREE.MathUtils.lerp(h.yawRate, 0, 0.2)
    h.speed = target > h.speed ? Math.min(target, h.speed + ACCEL * dt) : Math.max(target, h.speed - BRAKE * dt)
    return { x: Math.sin(h.yaw) * h.speed, z: Math.cos(h.yaw) * h.speed }
}

/** Where the ridden horse stands this frame: under the rider's capsule (its feet at `footY`). */
export function follow(x, footY, z, actualSpeed) {
    const h = ridden
    if (!h) return
    h.pos.set(x, footY, z)
    // a horse pressed against a wall walks on the spot; show the speed it actually makes
    h.shown = actualSpeed
}

// ─────────────────────────────────────────
// UPDATE — animation, hooves, the parked ones' idles
// ─────────────────────────────────────────
export function updateHorses(dt) {
    for (const h of herd) {
        if (h.needGround && h !== ridden) {
            const g = api.groundAt(h.pos.x, h.pos.z, (h.place.y ?? h.pos.y) + 1.5)
            if (g != null) { h.pos.y = g; h.needGround = false }
        }
        if (h === ridden) animateRidden(h, dt)
        else if (h.current === h.place.idle || h.current?.startsWith('Idle')) {
            // shuffle through the idles now and then
            if ((h.idleT -= dt) <= 0) {
                h.idleT = THREE.MathUtils.randFloat(6, 12)
                const pick = h.place.idle === 'Eat' ? (Math.random() < 0.7 ? 'Eat' : 'Idle2') : ['Idle', 'Idle2', 'Idle3'][Math.floor(Math.random() * 3)]
                play(h, pick, 0.6)
            }
        }
        sync(h)
        h.mixer.update(dt)
    }
}

function animateRidden(h, dt) {
    const v = h.shown ?? h.speed
    let name, ts = 1, beats = null
    const turn = h.yawRate > 0.6 ? 'L' : h.yawRate < -0.6 ? 'R' : ''
    if (v < 0.12) name = 'Idle'
    else if (v < 1.7) {
        name = 'Walk' + turn
        ts = THREE.MathUtils.clamp(v / (HOOF_SPEED.Walk * SCALE), 0.6, 2.0)
        beats = HOOF_BEATS.Walk
    } else {
        name = 'Gallop' + turn
        ts = THREE.MathUtils.clamp(v / (HOOF_SPEED.Gallop * SCALE), 0.85, 1.75)
        beats = HOOF_BEATS.Gallop
    }
    const a = play(h, name, name.startsWith(h.current?.slice(0, 4) ?? '-') ? 0.25 : FADE)
    if (a) a.timeScale = ts
    // hoofbeats on the clip's own beats
    if (beats && a) {
        const dur = a.getClip().duration, t = (a.time % dur) / dur, t0 = h.beatT
        h.beatT = t
        for (const c of beats.at) {
            const crossed = t0 <= t ? (c > t0 && c <= t) : (c > t0 || c <= t)
            if (crossed) api.sound2D?.(beats.sound, { volume: beats.sound === 'gallop' ? 0.6 : 0.4, rateJitter: 0.06 })
        }
    }
}

const _sp = new THREE.Vector3()
/**
 * The rider's root, for this frame (call after updateHorses): on the saddle bone, so the
 * rider rises and falls with the gait, facing where the horse faces.
 */
export function seat(out) {
    const h = ridden
    if (!h || !h.saddle) return null
    h.body.updateMatrixWorld(true)
    h.saddle.getWorldPosition(_sp)
    out.position.set(_sp.x - Math.sin(h.yaw) * SEAT.back, _sp.y + SEAT.drop, _sp.z - Math.cos(h.yaw) * SEAT.back)
    out.yaw = h.yaw
    return out
}
// The rider's root relative to the saddle bone (which runs inside the horse's back): seated, the
// hips are ~0.3 u above the root, and they rest on the saddle ~0.18 u above the bone.
export const SEAT = { drop: -0.13, back: 0.13 }

export const debug = {
    list: () => herd.map(h => ({ name: h.place.name, x: +h.pos.x.toFixed(2), y: +h.pos.y.toFixed(2), z: +h.pos.z.toFixed(2),
        yaw: +h.yaw.toFixed(2), speed: +h.speed.toFixed(2), anim: h.current, ridden: h === ridden })),
}
