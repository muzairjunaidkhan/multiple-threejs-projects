/**
 * ═══════════════════════════════════════════════════════════
 * player.js — the player's body and how it moves
 * ───────────────────────────────────────────────────────────
 * The body is static/character/cast/player.glb and the clips come from Mixamo
 * (see cast.js). script.js owns physics and input: each frame it reports what
 * the player is doing (update), and it calls the events (fire, reload, roll,
 * jump …). This module picks the clips.
 *
 * Two layers:
 *   BASE     drives the whole body: locomotion, a roll, an emote, the fall.
 *   OVERLAY  can take the upper body (spine and up) while the legs keep the
 *            base: aiming, firing, reloading, punching.
 * AnimationMixer has no bone masks, so every clip is split in two, a lower
 * part (hips + legs) and an upper part, and the weights are mixed here.
 *
 * After the mixer, combat.js still lays the arms exactly onto the aim line
 * (its two-bone reach); the overlay clips give the stance around them.
 * ═══════════════════════════════════════════════════════════
 */

import * as THREE from 'three'
import * as cast from './cast.js'

export const HEIGHT = 0.96                        // world units; the capsule is 0.96 tall
export const SCALE  = HEIGHT / cast.BODY_HEIGHT

const FADE      = 0.18          // s — base cross-fade
const OVER_FADE = 0.12          // s — overlay in / out
// Locomotion picks by ground speed (u/s), with hysteresis so it doesn't flicker at a threshold.
const GAIT = { walkIn: 0.25, walkOut: 0.12, runIn: 2.2, runOut: 1.8 }
const TS_RANGE = [0.55, 1.8]    // a clip played faster or slower than this looks wrong; let the feet slide

// Footfalls, as fractions of each locomotion cycle (char-prep.js footContacts).
const STEPS = {
    'Walking': [0.31, 0.81], 'Running': [0.30, 0.79], 'Crouched Walking': [0.22, 0.76],
    'Walking Backwards': [0.18, 0.67], 'Left Strafe Walking': [0.28, 0.77], 'Right Strafe Walking': [0.23, 0.74],
}

// Full-body actions: [clip, start (clip s), how long (clip s), timeScale, loops]. All hold the
// player in place (script.js), and moving ends all but the roll and the landing.
const ACTIONS = {
    roll:    ['Stand To Roll',   0.30, 1.75, 1.55, false],
    land:    ['Hard Landing',    0.00, 1.25, 1.6,  false],
    pickup:  ['Picking Up',      0.00, 3.40, 1.8,  false],
    wave:    ['Waving',          0.00, 1.60, 1.0,  true],      // a 0.53 s wave, three times
    dance:   ['Hip Hop Dancing', 0.00, 6.30, 1.0,  false],
    sit:     ['Sitting Idle',    0.00, Infinity, 1.0, true],    // until you move
    cower:   ['Terrified',       0.00, 5.00, 1.0,  true],
}
export const EMOTES = ['wave', 'dance', 'sit', 'cower']
// Unarmed blows: [clip, start, end, timeScale, when the fist lands (clip s: the right hand's
// farthest reach, measured)]
const PUNCHES = [['Punching', 0.0, 0.95, 1.25, 0.40], ['Cross Punch', 0.25, 1.55, 1.5, 1.13]]

const LOWER = /^mixamorig(Hips|LeftUpLeg|LeftLeg|LeftFoot|LeftToe|RightUpLeg|RightLeg|RightFoot|RightToe)/
// The left arm is its own layer so a rider can keep it on the reins (the base's seated hands)
// while the overlay aims the revolver with the right.
const LEFT_ARM = /^mixamorigLeft(Shoulder|Arm|ForeArm|Hand)/
// Mixamo's Shooting is a two-handed stance with the gun arm ~30° left of the chest: a revolver
// aim turns the body this much to the right of the target so the gun points at it unaided.
export const PISTOL_ARM_YAW = 0.51
// A long gun is held side-on: the body turned right of the target so the left shoulder comes
// forward and the left hand reaches the fore-end with a bent elbow.
export const RIFLE_BODY_YAW = 0.6

let model = null, mixer = null, clips = null
const parts = new Map()          // clip name → { lower, upper, dur, wBase, wOver, ts, running }
let base = 'Idle', over = null, overW = 0, overFade = OVER_FADE
let action = null                // { key, clip, t (clip s played), len, onEnd }
let dead = false
let fireT = 0, reloadT = 0, punch = null, punchIdx = 0, jumpT = 0, flinchT = 0
const bones = {}
const stepListeners = []
let lastBaseTime = 0

/** Load the body and the clips; adds the model to `scene`. Returns the model (or null on failure). */
export async function loadPlayer(scene) {
    try {
        const [body, set] = await Promise.all([cast.loadBody('player.glb'), cast.loadClips()])
        clips = cast.clipsFor(body, set)
        model = body
    } catch (err) {
        console.error('[player] body or clips failed to load', err)
        return null
    }
    model.scale.setScalar(SCALE)
    scene.add(model)
    mixer = new THREE.AnimationMixer(model)
    for (const n of ['Spine', 'Spine1', 'Spine2', 'Neck', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'Hips'])
        bones[n] = model.getObjectByName(`mixamorig${n}`)
    setBase('Idle', 0)
    return model
}
export const getModel = () => model

// ─────────────────────────────────────────
// LAYERS
// ─────────────────────────────────────────
function part(name) {
    let p = parts.get(name)
    if (p) return p
    const clip = clips?.[name]
    if (!clip) return null
    const lo = [], up = [], la = []
    for (const t of clip.tracks) (LOWER.test(t.name) ? lo : LEFT_ARM.test(t.name) ? la : up).push(t)
    p = {
        name, dur: clip.duration, wBase: 0, wOver: 0, ts: 1, running: false, once: false,
        lower: mixer.clipAction(new THREE.AnimationClip(`${name}:lower`, clip.duration, lo)),
        upper: mixer.clipAction(new THREE.AnimationClip(`${name}:upper`, clip.duration, up)),
        larm:  mixer.clipAction(new THREE.AnimationClip(`${name}:larm`, clip.duration, la)),
    }
    p.actions = [p.lower, p.upper, p.larm]
    parts.set(name, p)
    return p
}

function setLoop(p, once) {
    for (const a of p.actions) {
        a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity)
        a.clampWhenFinished = once
    }
    p.once = once
}
function setTime(p, t) { for (const a of p.actions) { a.time = t; a.paused = false } }
const timeOf = (p) => p.lower.time

let baseFade = FADE
/** Make `name` the base clip. `restart` replays it from `from` even if it is already the base. */
function setBase(name, fade = FADE, { restart = false, from = 0, once = false } = {}) {
    const p = part(name)
    if (!p) return
    if (base === name && !restart) return
    base = name
    baseFade = fade
    setLoop(p, once)
    if (!p.running || restart || p.wBase < 0.05) { start(p); setTime(p, from) }
}
function setOverlay(name, { fade = OVER_FADE, restart = false, from = 0, once = false } = {}) {
    overFade = fade
    if (!name) { over = null; return }
    const p = part(name)
    if (!p) { over = null; return }
    if (over !== name || restart) {
        setLoop(p, once)
        if (!p.running || restart || p.wOver < 0.05) { start(p); setTime(p, from) }
    }
    over = name
}
function start(p) {
    if (p.running) return
    for (const a of p.actions) a.reset().play()
    p.running = true
}

const approach = (v, to, step) => (v < to ? Math.min(to, v + step) : Math.max(to, v - step))

let leftFree = 1                 // 0..1: how much the overlay may take the left arm (0 = it stays on the reins)

/** Mix the layer weights (call once per frame, before the mixer). */
function mixWeights(dt) {
    let overSum = 0
    for (const p of parts.values()) {
        p.wBase = baseFade > 0 ? approach(p.wBase, p.name === base ? 1 : 0, dt / baseFade) : (p.name === base ? 1 : 0)
        p.wOver = approach(p.wOver, p.name === over ? overW : 0, dt / overFade)
        overSum += p.wOver
    }
    overSum = Math.min(1, overSum)
    const leftSum = overSum * leftFree
    for (const p of parts.values()) {
        const lw = p.wBase, uw = p.wBase * (1 - overSum) + p.wOver
        const aw = p.wBase * (1 - leftSum) + p.wOver * leftFree
        if (lw <= 0 && uw <= 0 && aw <= 0) {
            if (p.running) { for (const a of p.actions) a.stop(); p.running = false }
            continue
        }
        start(p)
        p.lower.setEffectiveWeight(lw)
        p.upper.setEffectiveWeight(uw)
        p.larm.setEffectiveWeight(aw)
        for (const a of p.actions) a.setEffectiveTimeScale(p.ts)
    }
}

// ─────────────────────────────────────────
// EVENTS (from script.js / combat.js)
// ─────────────────────────────────────────
/** Start a full-body action ('roll', 'land', 'pickup', an emote). Returns false when it can't. */
export function act(key, onEnd = null) {
    if (dead || !model || !ACTIONS[key]) return false
    const [clip, from, len, ts, loop] = ACTIONS[key]
    const p = part(clip)
    if (!p) return false
    action = { key, clip, t: 0, len: loop ? len : Math.min(len, p.dur - from), onEnd }
    p.ts = ts
    setBase(clip, 0.12, { restart: true, from, once: !loop })
    return true
}
export const actionKey = () => action?.key ?? null
/** A full-body action holds the player in place (script.js stops the capsule's own steering). */
export const locked = () => dead || !!action
/** Movement keys end a sit (the only action that never ends on its own). */
export function cancelAction() {
    if (!action) return
    const done = action.onEnd
    action = null
    done?.()
}
/** 0..1 through the roll's tumble (script.js pushes the capsule while it's > 0). */
export function rollPush() {
    if (action?.key !== 'roll') return 0
    const t = timeOf(part(action.clip))
    return t < 0.45 || t > 1.45 ? 0 : 1
}

export function jump() { jumpT = 0.55 }

/** Landed after `air` seconds airborne at `impact` u/s: a big drop stumbles into a crouch. */
export function land(impact, air) {
    if (dead || action) return
    if (impact > 9 && air > 0.6) act('land')
}

/** The trigger was pulled with a gun held as `hold` ('pistol' | 'rifle'). */
export function fire(hold) {
    if (hold === 'rifle') fireT = 0.27
    else {
        fireT = 0.9
        const p = part('Shooting')
        if (p) setTime(p, 0.2)          // the clip's own kick starts ~0.25 s in
    }
}
/** A reload of `seconds` (combat.js's own timer) with a `hold` gun: its clip is fitted to that time. */
export function reload(hold, seconds) {
    const name = hold === 'rifle' ? 'Reload' : 'Reloading'
    const p = part(name)
    if (!p) return
    reloadT = seconds
    p.ts = THREE.MathUtils.clamp(p.dur / Math.max(0.3, seconds), 0.8, 2.5)
    setOverlay(name, { restart: true, once: true })
}
export function cancelReload() { reloadT = 0 }

/** Unarmed: throw a punch. Returns the delay (s) until the fist lands, or null if busy. */
export function throwPunch() {
    if (dead || punch || action || !model) return null
    const [clip, from, end, ts, hitAt] = PUNCHES[punchIdx++ % PUNCHES.length]
    const p = part(clip)
    if (!p) return null
    p.ts = ts
    punch = { clip, end }
    setOverlay(clip, { restart: true, from, once: true, fade: 0.08 })
    return (hitAt - from) / ts
}

/** Hit by a bullet: a quick flinch of the chest (no clip; the Mixamo hit reaction is a crouched one). */
export function hit() { if (!dead) flinchT = 0.32 }

export function die() {
    if (dead) return
    dead = true
    action = null
    punch = null
    reloadT = fireT = 0
    over = null
    part('Dying') && (part('Dying').ts = 1)
    setBase('Dying', 0.15, { restart: true, once: true })
}
export function revive() {
    dead = false
    action = null
    punch = null
    reloadT = fireT = jumpT = flinchT = 0
    over = null
    for (const p of parts.values()) { p.wBase = p.wOver = 0; for (const a of p.actions) a.stop(); p.running = false }
    setBase('Idle', 0, { restart: true })
}
export const isDead = () => dead

/** Subscribe to footfalls: fn({ clip, volume }). */
export function onFootstep(fn) { stepListeners.push(fn) }

// ─────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────
let gait = 'Idle'

/**
 * Pick the clips for this frame. `s`:
 *   speed (u/s, smoothed), fwd / side (u/s along the body's forward / right), grounded,
 *   air (s airborne), crouch, aim (combat's aim blend 0..1), hold ('pistol' | 'rifle' | null),
 *   mounted (riding: the base is the saddle pose)
 */
export function update(dt, s) {
    if (!model) return
    // in the saddle the left hand keeps the reins: aiming, firing and reloading use the right
    leftFree = approach(leftFree, s.mounted ? 0 : 1, dt / 0.25)
    fireT = Math.max(0, fireT - dt)
    jumpT = Math.max(0, jumpT - dt)
    flinchT = Math.max(0, flinchT - dt)
    if (reloadT > 0 && (reloadT -= dt) <= 0) reloadT = 0

    if (!dead) {
        if (action && (action.t += dt * part(action.clip).ts) >= action.len) {
            const done = action.onEnd
            action = null
            done?.()
        }
        if (!action) pickBase(s)
        pickOverlay(s)
    }
    mixWeights(dt)
    footsteps()
}

function pickBase(s) {
    if (s.mounted) { setBase('Sitting Idle', 0.25); part('Sitting Idle').ts = 1; return }
    // a jump plays from the moment it's taken; stepping off a ledge only shows the fall once
    // it is clearly a fall, not a kerb
    if (jumpT > 0) { setBase('Jump', 0.08, { from: 0.12 }); part('Jump').ts = 1.25; gait = 'Idle'; return }
    if (!s.grounded && s.air > 0.25) { setBase('Falling Idle', 0.3); gait = 'Idle'; return }
    const v = s.speed
    let name, along = v
    if (s.crouch) name = v > 0.12 ? 'Crouched Walking' : 'Crouch Idle'
    else if (s.aim > 0.3 && v > 0.2) {
        // aimed movement faces the crosshair: back-pedal and side-step instead of turning
        if (Math.abs(s.side) > Math.abs(s.fwd) * 1.2) { name = s.side > 0 ? 'Right Strafe Walking' : 'Left Strafe Walking'; along = Math.abs(s.side) }
        else if (s.fwd < 0) { name = 'Walking Backwards'; along = -s.fwd }
        else name = 'Walking'
    } else {
        if (gait === 'Running') gait = v < GAIT.runOut ? (v < GAIT.walkOut ? 'Idle' : 'Walking') : 'Running'
        else if (gait === 'Walking') gait = v > GAIT.runIn ? 'Running' : v < GAIT.walkOut ? 'Idle' : 'Walking'
        else gait = v > GAIT.runIn ? 'Running' : v > GAIT.walkIn ? 'Walking' : 'Idle'
        name = gait
    }
    setBase(name, name === 'Idle' || base === 'Idle' ? 0.22 : FADE)
    const p = part(name)
    if (p && cast.CLIP_SPEED[name]) p.ts = THREE.MathUtils.clamp(along / (cast.CLIP_SPEED[name] * SCALE), ...TS_RANGE)
    else if (p) p.ts = 1
}

function pickOverlay(s) {
    if (punch) {
        const p = part(punch.clip)
        if (timeOf(p) >= punch.end - 1e-3) { punch = null }
        else { overW = 1; return }
    }
    if (reloadT > 0) { overW = 1; return }                     // setOverlay(reload) already chose it
    if (s.hold && s.aim > 0.01) {
        overW = s.aim
        if (s.hold === 'rifle') {
            if (fireT > 0) { setOverlay('Firing Rifle', { fade: 0.05, once: true, restart: over !== 'Firing Rifle' }); part('Firing Rifle').ts = 1 }
            else setOverlay('Rifle Aiming Idle', { fade: 0.1 })
        } else {
            setOverlay('Shooting', { fade: 0.1 })
            const p = part('Shooting')
            if (fireT > 0) p.ts = 1
            else { p.ts = 0; setTime(p, 0) }                     // the arm out, between shots
        }
        return
    }
    overW = 0
    if (over && part(over).wOver <= 0) over = null
}

/** Footfalls of the base locomotion clip: when its time crosses a contact fraction. */
let lastBase = null
function footsteps() {
    const steps = STEPS[base]
    const p = part(base)
    const switched = base !== lastBase
    lastBase = base
    if (!steps || !p || !stepListeners.length || switched) { lastBaseTime = p ? timeOf(p) : 0; return }
    const t = timeOf(p) / p.dur, t0 = lastBaseTime / p.dur
    lastBaseTime = timeOf(p)
    if (p.wBase < 0.5) return
    for (const c of steps) {
        const crossed = t0 <= t ? (c > t0 && c <= t) : (c > t0 || c <= t)
        if (crossed) for (const fn of stepListeners) fn({ clip: base, run: base === 'Running' })
    }
}

// ─────────────────────────────────────────
// AFTER THE MIXER — small corrections the clips don't have
// ─────────────────────────────────────────
const _q = new THREE.Quaternion(), _ax = new THREE.Vector3(), _mq = new THREE.Quaternion(), _pq = new THREE.Quaternion()

/** Rotate `bone` by `angle` about the WORLD axis `axis` (keeps its children's pose). */
function rotateWorld(bone, axis, angle) {
    bone.parent.getWorldQuaternion(_pq)
    _q.setFromAxisAngle(_ax.copy(axis).applyQuaternion(_pq.invert()), angle)
    bone.quaternion.premultiply(_q)
}

let clean = null                 // [bone, quaternion, position] as the mixer last left them
function snapshotClean() {
    if (!clean) {
        clean = []
        model.traverse(o => { if (o.isBone) clean.push([o, new THREE.Quaternion(), new THREE.Vector3()]) })
    }
    for (const [b, q, p] of clean) { q.copy(b.quaternion); p.copy(b.position) }
}
function restoreClean() {
    if (clean) for (const [b, q, p] of clean) { b.quaternion.copy(q); b.position.copy(p) }
}

const _right = new THREE.Vector3(), _fwd = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0)
export const MAX_TWIST = 1.6                  // rad the back turns in the saddle (23° a bone; the shoulders get ¾)
const TWIST_BONES = ['Spine', 'Spine1', 'Spine2', 'Neck']
/**
 * Mixer + corrections. `rider`: the saddle leg pose ({ spread, thigh, shin } rad), or null;
 * `aimYaw`: where a rider aims, rad from the horse's heading (+ = left), weighted by `aim` (0..1).
 */
export function animate(dt, { rider = null, aimYaw = 0, aim = 0 } = {}) {
    // the chest turns so the revolver arm (PISTOL_ARM_YAW left of it in the clip) lines up
    const twist = aim > 0 ? THREE.MathUtils.clamp(aimYaw - PISTOL_ARM_YAW, -MAX_TWIST, MAX_TWIST) * aim : 0
    if (!mixer) return
    // AnimationMixer only writes a bone when its animated value CHANGES. A held frame (the aim
    // pose between shots) or a near-still clip (sitting in the saddle) leaves bones unwritten, and
    // the corrections made after the mixer (here and in combat.js) would pile up frame on frame,
    // bending and wringing the body further each time. So every frame starts from the clean
    // animated pose: restored before the mixer, snapshotted right after it.
    restoreClean()
    mixer.update(dt)
    snapshotClean()
    model.updateMatrixWorld(true)
    model.getWorldQuaternion(_mq)
    _fwd.set(0, 0, 1).applyQuaternion(_mq)
    _right.set(-1, 0, 0).applyQuaternion(_mq)
    if (flinchT > 0 && bones.Spine2) {
        const k = Math.sin((1 - flinchT / 0.32) * Math.PI)       // 0 → 1 → 0
        rotateWorld(bones.Spine2, _right, 0.28 * k)               // chest snaps back (+ about the right axis = back)
    }
    if (twist) {
        // a turn in the saddle, spread thin over the back and neck (much more than ~25° on any one
        // bone and the skin wrings like a towel); past MAX_TWIST the aiming arm does the rest
        const t = twist / TWIST_BONES.length
        for (const n of TWIST_BONES) {
            bones[n].parent.updateWorldMatrix(true, false)
            rotateWorld(bones[n], _up, t)
        }
    }
    if (rider) {
        // Sitting Idle is a chair: thighs together, level, pointing forward. On a horse the knees
        // part round its barrel (a turn about the vertical: left knee toward +x, the body's left),
        // the thighs angle down (− about the right axis) and the shins hang (`shin`, same axis).
        model.updateMatrixWorld(true)
        for (const [side, s] of [['Left', 1], ['Right', -1]]) {
            const up = bones[`${side}UpLeg`], low = bones[`${side}Leg`]
            if (!up || !low) continue
            rotateWorld(up, _up, s * rider.spread)
            rotateWorld(up, _right, -rider.thigh)
            up.updateMatrixWorld(true)
            rotateWorld(low, _right, rider.shin)
        }
    }
    model.updateMatrixWorld(true)
}

export const debug = {
    state: () => ({
        base, over, overW: +overW.toFixed(2), action: action?.key ?? null, dead, gait,
        parts: [...parts.values()].filter(p => p.running).map(p => `${p.name} b${p.wBase.toFixed(2)} o${p.wOver.toFixed(2)} ts${p.ts.toFixed(2)} t${timeOf(p).toFixed(2)}`),
    }),
}
