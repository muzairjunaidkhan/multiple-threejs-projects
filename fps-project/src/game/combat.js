/**
 * ═══════════════════════════════════════════════════════════
 * combat.js — the player's guns
 * ───────────────────────────────────────────────────────────
 * Whatever weapons.js says is equipped: revolvers, shotguns (a cone of
 * pellets), rifles, a scoped rifle. Hitscan. Click fires, right mouse holds
 * aim, R reloads from the reserve of that ammo type.
 *
 * Firing or aiming eases the camera into an over-the-shoulder rig (script.js
 * owns the camera; it asks aimBlend() how far along it is and aimFov() what
 * FOV to use, and reports the rig's pose through setAimPose()), and the bullet
 * goes down that pose's centre line — exactly where the crosshair settles.
 *
 * Carrying: the selected sidearm rides in the right hip holster and the last
 * long gun is slung across the back; the equipped one comes to the hands while
 * aiming (and stays there through a reload). player.js plays the Mixamo aiming,
 * firing and reloading clips on the upper body; after the mixer, this bends the
 * chest toward the aim's height and lays the arms exactly on the aim line: a
 * pistol-held gun swings the right arm onto it, a rifle-held one is set
 * butt-to-shoulder on it and both arms reach for it (a two-bone solve per arm).
 *
 * Also the player's health: bandit hits call damagePlayer(); health creeps
 * back after a few quiet seconds; at zero, onPlayerDeath() hands over to
 * script.js, which respawns the player (and calls resetCombat()).
 *
 * World access is injected (initCombat), not imported:
 *   { scene, camera, world, RAPIER, getPlayerCollider, getPlayerPos, getModel, kick,
 *     onPlayerDeath, hint(text), body (player.js: fire / reload / cancelReload / hit),
 *     canAim() (false mid-roll or mid-emote), isMounted() (one-handed revolver in the saddle) }
 * ═══════════════════════════════════════════════════════════
 */

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import * as audio from './audio.js'
import * as npc from './npc.js'
import * as W from './weapons.js'

export const PLAYER = {
    maxHp:      100,
    regenDelay: 6,        // s without being hit before health creeps back …
    regenRate:  4,        // … at this many HP per second
}
const AIM_HOLD    = 1.4   // s the aim rig stays up after a shot
const AIM_EASE    = 14    // damping rate of the aim blend
const AIM_FOV     = 55    // the shoulder rig's FOV (script.js syncCamera reads aimFov())
const EQUIP_TIME  = 0.3   // s to swap weapons, no firing meanwhile
const GUN_SCALE   = 0.5   // the GLBs are in metres; the town is modelled at half scale
const KICK = { revolver: 0.035, shotgun: 0.08, rifle: 0.05 }   // rad of camera climb per shot, by sound profile

let api = null
const meshes = new Map()    // weapon id → THREE.Mesh (once loaded)
const loading = new Map()   // weapon id → Promise
let bones = null            // { hips, upLeg, spine1, spine, neck, head, shoulder, arm, fore, hand, lArm, lFore, lHand, hands }

const state = {
    cooldown: 0, reloadT: 0, reload: null,          // reload = { id, n, tube, next, step }
    autoReload: false, equipT: 0, cycleT: 0, cycleSound: null,
    aimHeld: false, aimHold: 0, blend: 0, reach: 0, scoped: false,      // reach: how far the arms are laid on the aim line
    hp: PLAYER.maxHp, sinceHit: 99, dead: false,
}

// aim pose, from script.js each frame (the shoulder rig's TARGET pose, not the eased one)
const aimOrigin = new THREE.Vector3()
const aimDir    = new THREE.Vector3(0, 0, -1)
const aimPoint  = new THREE.Vector3()

export function initCombat(worldApi) { api = worldApi }

// ─────────────────────────────────────────
// LOAD
// ─────────────────────────────────────────
export async function loadCombat() {
    buildHud()
    buildEffects()
    await ensureModels()
}

/** Load weapon `id`'s mesh (once). Meshes live in the scene; placeWeapons() moves them. */
export function ensureModel(id) {
    if (meshes.has(id)) return Promise.resolve(meshes.get(id))
    if (!loading.has(id)) {
        loading.set(id, new GLTFLoader().loadAsync(`./weapons/${W.WEAPONS[id].model}`).then(gltf => {
            let m = null
            gltf.scene.traverse(o => { if (o.isMesh && !m) m = o })
            m.removeFromParent()
            m.frustumCulled = false
            m.visible = false
            m.scale.setScalar(GUN_SCALE)
            api.scene.add(m)
            meshes.set(id, m)
            return m
        }).catch(err => { console.error(`[combat] ${id} failed to load`, err); loading.delete(id) }))
    }
    return loading.get(id)
}
/** Every owned weapon's mesh (after a load / purchase). */
export function ensureModels() {
    return Promise.all(Object.keys(W.WEAPONS).filter(W.owns).map(ensureModel))
}

/** Find the player's Mixamo bones ("mixamorig:RightArm" loads as "mixamorigRightArm"). */
function findBones(model) {
    const get = (re) => { let b = null; model.traverse(o => { if (!b && o.isBone && re.test(o.name)) b = o }); return b }
    const b = {
        hips: get(/Hips$/), upLeg: get(/RightUpLeg$/), spine1: get(/Spine1$/), spine: get(/Spine2$/),
        neck: get(/Neck$/), head: get(/Head$/), shoulder: get(/RightShoulder$/),
        arm: get(/RightArm$/), fore: get(/RightForeArm$/), hand: get(/RightHand$/),
        lArm: get(/LeftArm$/), lFore: get(/LeftForeArm$/), lHand: get(/LeftHand$/),
    }
    if (!Object.values(b).every(Boolean)) return null
    const idx = (side) => [1, 2, 3].map(k => get(new RegExp(`${side}HandIndex${k}$`))).filter(Boolean)
    b.hands = {
        right: calibrateHand(model, { name: 'right', up: b.arm, low: b.fore, hand: b.hand, idx: idx('Right') }, -1),
        left:  calibrateHand(model, { name: 'left', up: b.lArm, low: b.lFore, hand: b.lHand, idx: idx('Left') }, 1),
    }
    return b
}

// ─────────────────────────────────────────
// INPUT (script.js routes these only while PLAYING with the pointer locked)
// ─────────────────────────────────────────
const weapon = () => W.equippedWeapon()

export function triggerDown() {
    const w = weapon()
    if (state.dead || !w) return
    state.aimHold = AIM_HOLD
    if (state.reloadT > 0 || state.cooldown > 0 || state.equipT > 0) return
    if (W.loaded(W.equipped()) <= 0) {          // click on empty: dry fire, then reload
        audio.play2D('dry_fire', { volume: 0.7 })
        state.cooldown = 0.25
        reload()
        return
    }
    fire()
}
export function setAimHeld(v) {
    state.aimHeld = v && !state.dead && !!weapon()
    if (state.aimHeld) state.aimHold = Math.max(state.aimHold, 0.2)
}

export function reload() {
    const id = W.equipped(), w = weapon()
    if (state.dead || !w || state.reloadT > 0) return
    const missing = w.mag - W.loaded(id)
    if (missing <= 0) return
    const n = Math.min(missing, W.reserve(w.ammo))
    if (n <= 0) {
        audio.play2D('dry_fire', { volume: 0.6 })
        api.hint?.(`Out of ${W.AMMO[w.ammo].name.toLowerCase()} — visit the gunsmith`)
        return
    }
    state.reloadT = W.reloadTime(w, n)
    const tube = w.reloadSound === 'reload_tube'
    state.reload = { id, n, tube, next: w.reload[0], step: w.reload[1], done: 0, elapsed: 0 }
    if (!tube) audio.play2D(w.reloadSound, { volume: 0.7 })
    api.body?.reload(w.hold, state.reloadT)
    updateHud()
}

/** Swap to `id` (null = holster everything). Cancels a reload in progress. */
export function equip(id) {
    if (id === W.equipped() || state.dead) return false
    if (!W.equip(id)) return false
    state.reloadT = 0
    state.reload = null
    api.body?.cancelReload()
    state.cycleT = 0
    state.equipT = id ? EQUIP_TIME : 0
    if (id) {
        ensureModel(id)
        audio.play2D('latch_click', { volume: 0.5, rateJitter: 0.1 })
    } else {
        state.aimHeld = false
        state.aimHold = 0
    }
    updateHud()
    return true
}
/** Mouse wheel outside the weapon wheel: next / previous owned weapon (unarmed included). */
export const cycleWeapon = (dir) => equip(W.cycled(dir))

/** How far into the shoulder rig the camera should be (0 = normal orbit, 1 = aiming). */
export function aimBlend() { return state.blend }
export function isAiming() { return !state.dead && !!weapon() && (state.aimHeld || state.aimHold > 0) }
/** The aim rig's FOV: narrowed while a scoped rifle is fully up. */
export function aimFov() { return state.scoped ? weapon().zoomFov : AIM_FOV }
export function isScoped() { return state.scoped }

// ─────────────────────────────────────────
// PLAYER HEALTH
// ─────────────────────────────────────────
export function isDead() { return state.dead }
export function getHealth() { return state.hp }
export function setHealth(v) { state.hp = THREE.MathUtils.clamp(v ?? PLAYER.maxHp, 1, PLAYER.maxHp); updateHud() }

/** A bandit's bullet found the player. `from` (world pos) is only used for the cue. */
export function damagePlayer(amount, from = null) {
    if (state.dead) return
    state.hp = Math.max(0, state.hp - amount)
    state.sinceHit = 0
    audio.play2D('hit', { volume: 0.75, rateJitter: 0.08 })
    api.body?.hit()
    flashVignette(amount)
    updateHud()
    if (state.hp <= 0) {
        state.dead = true
        state.aimHeld = false
        state.aimHold = 0
        api.onPlayerDeath?.()
    }
}
export function setAimPose(origin, dir) { aimOrigin.copy(origin); aimDir.copy(dir).normalize() }

// ─────────────────────────────────────────
// FIRE
// ─────────────────────────────────────────
const _ray = { origin: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 0 } }
let _rapierRay = null

/** First thing along `dir` from the aim origin (city or NPC capsule; never the player). */
function castFrom(dir, maxDist, outPoint) {
    const { world, RAPIER } = api
    _rapierRay ??= new RAPIER.Ray(_ray.origin, _ray.dir)
    _ray.origin.x = aimOrigin.x; _ray.origin.y = aimOrigin.y; _ray.origin.z = aimOrigin.z
    _ray.dir.x = dir.x; _ray.dir.y = dir.y; _ray.dir.z = dir.z
    const hit = world.castRay(_rapierRay, maxDist, true, undefined, undefined, api.getPlayerCollider())
    outPoint.copy(aimOrigin).addScaledVector(dir, hit ? hit.toi : maxDist)
    return hit
}
/** The crosshair's target right now (updates aimPoint). */
function castAim(maxDist = weapon()?.range ?? 60) { return castFrom(aimDir, maxDist, aimPoint) }

/** What the crosshair is on: { npc, point } (point is a fresh vector), or null. Dead Eye uses this. */
export function aimHit() {
    const hit = castAim()
    const n = hit && npc.npcForCollider(hit.collider)
    return n ? { npc: n, point: aimPoint.clone() } : null
}

const stats = { shots: 0, hits: 0, kills: 0, heads: 0, last: null }
const hitListeners = [], shotListeners = []
/** Subscribe to the player's hits: fn({ killed, head }) once per NPC hit per shot. */
export function onHit(fn) { hitListeners.push(fn) }
/** Subscribe to every trigger pull: fn(weaponId). */
export function onShot(fn) { shotListeners.push(fn) }

const _pd = new THREE.Vector3(), _pp = new THREE.Vector3(), _u = new THREE.Vector3(), _v = new THREE.Vector3()

/** Random direction in a cone of half-angle `deg` around `dir`. */
function coneDir(dir, deg, out) {
    if (!deg) return out.copy(dir)
    _u.set(Math.abs(dir.y) < 0.9 ? 0 : 1, Math.abs(dir.y) < 0.9 ? 1 : 0, 0).cross(dir).normalize()
    _v.crossVectors(dir, _u)
    const r = Math.tan(THREE.MathUtils.degToRad(deg)) * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2
    return out.copy(dir).addScaledVector(_u, Math.cos(a) * r).addScaledVector(_v, Math.sin(a) * r).normalize()
}

/** Shotgun damage over range: full inside 40 % of it, down to ×0.2 at its end. */
function falloff(w, dist) {
    if (!w.falloff) return 1
    const near = w.range * 0.4
    return THREE.MathUtils.clamp(1 - 0.8 * (dist - near) / (w.range - near), 0.2, 1)
}

function fire() {
    const id = W.equipped(), w = weapon()
    W.setLoaded(id, W.loaded(id) - 1)
    state.cooldown = w.interval
    if (w.cycle && W.loaded(id) > 0) { state.cycleT = Math.min(0.28, w.interval * 0.4); state.cycleSound = w.cycle }
    state.autoReload = W.loaded(id) === 0                // the last round: reload once the shot settles
    stats.shots++
    for (const fn of shotListeners) fn(id)
    api.body?.fire(w.hold)
    const player = api.getPlayerPos()

    audio.play2D(`gunshot_${w.sound}`, { volume: w.sound === 'revolver' ? 0.85 : 0.95, rateJitter: 0.04 })
    npc.onGunshot(player)
    api.kick?.(KICK[w.sound] ?? 0.04)
    showFlash()

    // every pellet (one for a rifle) is its own ray; damage is summed per NPC, so each
    // NPC flinches or dies once per trigger pull
    const pellets = w.pellets ?? 1
    const perNpc = new Map()            // npc → { dmg, head }
    let puffs = 0
    for (let k = 0; k < pellets; k++) {
        coneDir(aimDir, w.spread ?? 0, _pd)
        const hit = castFrom(_pd, w.range, _pp)
        if (k < 3) showTracer(_pp)
        if (k === 0) aimPoint.copy(_pp)
        const target = hit && npc.npcForCollider(hit.collider)
        if (target) {
            const head = npc.isHeadshot(target, _pp)
            const e = perNpc.get(target) ?? { dmg: 0, head: false }
            e.dmg += w.damage * (head ? W.HEAD_MUL : 1) * falloff(w, hit.toi)
            e.head ||= head
            perNpc.set(target, e)
        } else if (hit && puffs < 4) {
            showPuff(_pp)
            if (puffs++ === 0) audio.playAt(_pp.clone(), 'bullet', { volume: 0.7, rateJitter: 0.1 })
        }
    }
    let best = null
    const shot = { weapon: id, pellets, npcs: [] }
    for (const [target, e] of perNpc) {
        const res = npc.damage(target, Math.round(e.dmg), { head: e.head, from: player })
        if (!res) continue
        stats.hits++
        if (e.head) stats.heads++
        if (res.killed) stats.kills++
        shot.npcs.push({ name: target.def.name, dmg: Math.round(e.dmg), head: e.head, killed: res.killed })
        best = res.killed ? 'kill' : best ?? 'hit'
        for (const fn of hitListeners) fn({ killed: res.killed, head: e.head })
    }
    stats.last = shot
    if (best) marker(best)
    updateHud()
    return shot
}

/**
 * Dead Eye: one shot straight at `point` (ignores the fire interval). Returns the shot,
 * or null if the equipped gun is empty.
 */
export function fireAt(point) {
    const id = W.equipped()
    if (!id || state.dead || W.loaded(id) <= 0) return null
    aimDir.subVectors(point, aimOrigin).normalize()
    state.aimHold = AIM_HOLD
    return fire()
}

// ─────────────────────────────────────────
// UPDATE — after the mixer, so the arm pose sticks. Real time (not slowed by Dead Eye).
// ─────────────────────────────────────────
export function updateCombat(dt) {
    state.cooldown = Math.max(0, state.cooldown - dt)
    state.aimHold  = Math.max(0, state.aimHold - dt)
    state.equipT   = Math.max(0, state.equipT - dt)
    state.sinceHit += dt
    if (!state.dead && state.hp < PLAYER.maxHp && state.sinceHit > PLAYER.regenDelay) {
        state.hp = Math.min(PLAYER.maxHp, state.hp + PLAYER.regenRate * dt)
        updateHud()
    }
    if (state.cycleT > 0 && (state.cycleT -= dt) <= 0) audio.play2D(state.cycleSound, { volume: 0.55, rateJitter: 0.05 })
    if (state.autoReload && state.cooldown <= 0) {
        state.autoReload = false
        if (W.equipped() && W.reserve(weapon().ammo) > 0) reload()
    }
    updateReload(dt)

    const w = weapon()
    const want = isAiming() && state.reloadT <= 0 && (api.canAim?.() ?? true) ? 1 : 0
    state.blend = THREE.MathUtils.damp(state.blend, want, AIM_EASE, dt)
    if (state.blend < 0.001) state.blend = 0
    state.scoped = !!(w?.zoomFov && want && state.blend > 0.9)

    const model = api.getModel()
    if (model && !bones) bones = findBones(model)
    if (model && bones) {
        model.visible = !state.scoped                  // the scope view is the rifle's, not over the shoulder
        model.updateMatrixWorld(true)
        state.reach = 0
        if (state.blend > 0 && w) {
            castAim()                                  // where the crosshair sits right now
            // Only lay the arms on the aim line once the chest faces it: swinging an arm round to a
            // target behind the body (the body still turning, or a rider aiming backwards) wrings the
            // shoulder and the skin. Until then the aiming clip holds the arms out in front.
            state.reach = state.blend * facingAim()
            if (probe.on) { probe.before = armDirs(); probe.hands = {} }
            if (state.reach > 0) {
                bendSpine(state.reach, w.hold === 'rifle' ? RIFLE_LEAN : PISTOL_LEAN)
                holdGun(w, state.reach)
            }
        }
        if (probe.on) probe.after = armDirs()
        placeWeapons(model)
    }
    updateEffects(dt)
    if (scopeEl) scopeEl.classList.toggle('show', state.scoped)
}

/** Reloads finish all at once; a tube magazine clicks in one round at a time as it goes. */
function updateReload(dt) {
    const r = state.reload
    if (!r || state.reloadT <= 0) return
    state.reloadT -= dt
    r.elapsed += dt
    if (r.tube) while (r.done < r.n && r.elapsed >= r.next) {
        audio.play2D('reload_tube', { volume: 0.6, rateJitter: 0.08 })
        r.done++
        r.next += r.step
    }
    if (state.reloadT <= 0) {
        const w = W.WEAPONS[r.id]
        const got = W.takeAmmo(w.ammo, r.n)
        W.setLoaded(r.id, W.loaded(r.id) + got)
        state.reloadT = 0
        state.reload = null
        updateHud()
    }
}

// ── arms onto the gun ──
const _o = new THREE.Vector3(), _t = new THREE.Vector3(), _d = new THREE.Vector3(), _want = new THREE.Vector3()
const _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _bq = new THREE.Quaternion(), _keep = new THREE.Quaternion()

/** Rotate `bone` (in world terms) so the direction bone→`tip` becomes `dir`, blended by w. */
function swing(bone, tip, dir, w) {
    bone.getWorldPosition(_o)
    tip.getWorldPosition(_t)
    _d.subVectors(_t, _o).normalize()
    _q.setFromUnitVectors(_d, dir)
    bone.parent.getWorldQuaternion(_pq)
    bone.getWorldQuaternion(_bq)
    _keep.copy(bone.quaternion)
    bone.quaternion.copy(_pq.invert().multiply(_q.multiply(_bq)))
    if (w < 1) bone.quaternion.copy(_keep.slerp(bone.quaternion, w))
    bone.updateMatrixWorld(true)
}

const _sa = new THREE.Vector3(), _ha = new THREE.Vector3(), _cf = new THREE.Vector3(), _ad = new THREE.Vector3()
/**
 * How far the right arm has to swing to reach the aim, as a 0..1 weight: the aiming clip's own
 * arm direction (shoulder → hand, after a rider's twist) against the aim, horizontally. Full
 * within ~65° (an arm swings that far cleanly; a strafing clip turns the chest about that much),
 * none beyond ~85°.
 */
function facingAim() {
    bones.arm.getWorldPosition(_sa)
    bones.hand.getWorldPosition(_ha)
    _cf.subVectors(_ha, _sa).setY(0).normalize()
    _ad.subVectors(aimPoint, aimOrigin).setY(0).normalize()
    return THREE.MathUtils.smoothstep(_cf.dot(_ad), 0.09, 0.42)
}

const _bq2 = new THREE.Quaternion(), _sd = new THREE.Vector3()
// rad, + = back: Mixamo's Shooting hunches the upper back ~38° forward and Rifle Aiming Idle ~27°;
// these bring them to a firm lean into the gun of ~20° (measured: Spine2 from vertical)
const RIFLE_LEAN = 0.2, PISTOL_LEAN = 0.3
/**
 * The Mixamo aim clips hold the gun level; for a shot up a balcony or down a slope the chest
 * leans with it (half the elevation, split over two spine bones), and the arms finish the job.
 * `lean` adds a steady forward lean into the gun.
 */
function bendSpine(w, lean = 0) {
    frame()
    const elev = Math.asin(THREE.MathUtils.clamp(_sd.subVectors(aimPoint, aimOrigin).normalize().y, -1, 1))
    const angle = (THREE.MathUtils.clamp(elev, -0.8, 0.9) * 0.5 + lean) * w
    for (const b of [bones.spine1, bones.spine]) {
        b.parent.getWorldQuaternion(_pq)
        // about the body's right axis: + leans back (the chest comes up)
        _bq2.setFromAxisAngle(_sd.copy(_right).applyQuaternion(_pq.invert()), angle / 2)
        b.quaternion.premultiply(_bq2)
        b.updateMatrixWorld(true)
    }
}

const _ia = new THREE.Vector3(), _ib = new THREE.Vector3(), _ic = new THREE.Vector3()
const _it = new THREE.Vector3(), _ip = new THREE.Vector3(), _ie = new THREE.Vector3(), _iv = new THREE.Vector3()

/**
 * Two-bone reach: bend upper→lower→end so `end` lands on `target`, the elbow toward
 * `pole`. Law of cosines for the elbow, then two swings.
 */
function reach(upper, lower, end, target, pole, w) {
    upper.getWorldPosition(_ia); lower.getWorldPosition(_ib); end.getWorldPosition(_ic)
    const l1 = _ia.distanceTo(_ib), l2 = _ib.distanceTo(_ic)
    _it.subVectors(target, _ia)
    const d = THREE.MathUtils.clamp(_it.length(), Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4)
    _it.normalize()
    const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - x * x))
    _ip.copy(pole).addScaledVector(_it, -pole.dot(_it)).normalize()
    _ie.copy(_ia).addScaledVector(_it, x).addScaledVector(_ip, h)
    swing(upper, lower, _iv.subVectors(_ie, _ia).normalize(), w)
    lower.getWorldPosition(_ib)
    swing(lower, end, _iv.subVectors(target, _ib).normalize(), w)
}

// ─────────────────────────────────────────
// HOLDING A GUN
// The gun's pose comes first (on the aim line, inside a comfortable reach); the hands are then
// solved onto it. Each hand has a grip frame on the gun: where its palm rests, which way its
// fingers (wrist → knuckles) and its palm face. The arm is bent so the WRIST lands where that
// puts it (the hand bone is the wrist joint: aiming it at the grip would leave the palm past
// it), the hand is turned to match with part of its roll handed to the forearm (so the wrist
// doesn't wring), and the fingers close. The drawn gun is always the right hand × a fixed grip
// matrix, so hand and gun can't disagree — aiming, reloading, or in between.
// ─────────────────────────────────────────

// Grip frames in the gun's own frame and metres (×GUN_SCALE in the world): +z down the barrel,
// +y the sights, +x the gun's left. The guns' origins sit at the top of the grip (revolvers) or
// the wrist of the stock (long guns); the left palm on a long gun is relative to its `fore`.
const GRIP = {
    pistol: {
        right: { palm: [-0.014, -0.022, -0.016], fingers: [0.45, -0.5, 0.75], faces: [1, 0, 0] },
        left:  { palm: [0.012, -0.052, -0.004], fingers: [-0.3, -0.35, 0.9], faces: [-0.55, 0.8, 0] },
    },
    rifle: {
        right: { palm: [-0.016, -0.03, -0.032], fingers: [0.4, -0.65, 0.65], faces: [1, 0, 0] },
        left:  { palm: [0.004, -0.03, 0], fingers: [-0.65, 0.15, 0.75], faces: [0.25, 1, 0] },
    },
}
const CURL = { right: [0.95, 1.1, 0.8], left: [0.8, 0.95, 0.7] }      // rad, Index1..3 closing on the grip
const TWIST_TO_FOREARM = 0.6        // share of the hand's roll about the forearm that the forearm takes
const PISTOL_REACH = 0.8            // the pistol's grip sits this share of the arm's length from the shoulder
// Elbow poles (in the body's frame: right, up, forward).
const POLES = {
    pistol: { right: [0.35, -1, -0.1], left: [-0.6, -1, 0] },
    rifle:  { right: [0.8, -0.6, -0.2], left: [-0.25, -1, 0.1] },
}

const _r0 = new THREE.Matrix4(), _r1 = new THREE.Matrix4()
/**
 * A hand's axes in its own bone frame, read from the skin's rest (bind) pose: the finger axis
 * (wrist → first index knuckle), the palm's normal (the thin axis of the vertices skinned to the
 * hand, its sign facing down and in toward the body as hands hang in a T or A pose), and the
 * palm's centre on its surface. Also each index bone's rest rotation and curl axis.
 * `inSign`: which way is "in" (toward the body's midline) along x for this hand at rest.
 */
function calibrateHand(model, H, inSign) {
    let mesh = null
    model.traverse(o => { if (o.isSkinnedMesh && o.skeleton.bones.includes(H.hand)) mesh = o })
    const sk = mesh.skeleton, ix = (b) => sk.bones.indexOf(b)
    const restWorld = (b) => new THREE.Matrix4().copy(sk.boneInverses[ix(b)]).invert()
    const toHand = sk.boneInverses[ix(H.hand)]
    const F = new THREE.Vector3().setFromMatrixPosition(restWorld(H.idx[0] ?? H.hand)).applyMatrix4(toHand).normalize()
    // vertices skinned mostly to the hand, in its local frame
    const g = mesh.geometry, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight
    const hi = ix(H.hand), m = new THREE.Matrix4().multiplyMatrices(toHand, mesh.bindMatrix), pts = [], v = new THREE.Vector3()
    for (let i = 0; i < pos.count; i++) {
        let w = 0
        for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === hi) w += sw.getComponent(i, k)
        if (w > 0.6) pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(m).clone())
    }
    const c = new THREE.Vector3()
    for (const p of pts) c.add(p)
    c.divideScalar(Math.max(1, pts.length))
    // the thin axis across the finger axis: 2D PCA in the plane normal to F
    const u = new THREE.Vector3(1, 0, 0)
    if (Math.abs(u.dot(F)) > 0.9) u.set(0, 1, 0)
    u.addScaledVector(F, -u.dot(F)).normalize()
    const t = new THREE.Vector3().crossVectors(F, u)
    let suu = 0, stt = 0, sut = 0
    for (const p of pts) { const d = v.subVectors(p, c), a = d.dot(u), b = d.dot(t); suu += a * a; stt += b * b; sut += a * b }
    const ang = 0.5 * Math.atan2(2 * sut, suu - stt)              // major axis of the cross-section
    const N = new THREE.Vector3().addScaledVector(u, -Math.sin(ang)).addScaledVector(t, Math.cos(ang)).normalize()   // minor
    // sign: the palm faces down and in, at rest
    const ref = new THREE.Vector3(inSign * 0.7, -1, 0).normalize().transformDirection(toHand)
    if (N.dot(ref) < 0) N.negate()
    let snn = 0
    for (const p of pts) { const d = v.subVectors(p, c).dot(N); snn += d * d }
    const palm = c.clone().addScaledVector(N, Math.sqrt(snn / Math.max(1, pts.length)))
    const B = new THREE.Matrix4().makeBasis(F, N, new THREE.Vector3().crossVectors(F, N))
    // curl: each index bone turns about F × N (that takes the fingers toward the palm), from its rest
    const axisWorld = new THREE.Vector3().crossVectors(F, N).transformDirection(restWorld(H.hand))
    const fingers = H.idx.map(bone => {
        const rw = restWorld(bone), rp = restWorld(bone.parent)
        const restLocal = new THREE.Quaternion().setFromRotationMatrix(_r0.copy(rp).invert().multiply(rw))
        const axis = axisWorld.clone().transformDirection(_r1.copy(rw).invert())
        return { bone, restLocal, axis }
    })
    return { ...H, F, N, palm, basis: B, fingers, verts: pts.length }
}

const _hq = new THREE.Quaternion(), _hm = new THREE.Matrix4(), _hm2 = new THREE.Matrix4()
const _fw = new THREE.Vector3(), _nw = new THREE.Vector3(), _bw = new THREE.Vector3()
const _pw = new THREE.Vector3(), _wt = new THREE.Vector3(), _ws = new THREE.Vector3(), _tmp = new THREE.Vector3()

/** gun-frame vector `a` → world, by the gun basis (gx, gy, gz) */
const gunDir = (a, out) => out.copy(gun.x).multiplyScalar(a[0]).addScaledVector(gun.y, a[1]).addScaledVector(gun.z, a[2])

/** The world rotation that puts hand `H`'s finger axis on `fw` and its palm normal on `nw`. */
function handRotation(H, fw, nw, out) {
    _nw.copy(nw).addScaledVector(fw, -nw.dot(fw)).normalize()
    _hm.makeBasis(fw, _nw, _bw.crossVectors(fw, _nw))
    _hm2.copy(H.basis).transpose()
    return out.setFromRotationMatrix(_hm.multiply(_hm2))
}

const _tw = new THREE.Quaternion(), _ta = new THREE.Vector3(), _ti = new THREE.Quaternion(), _qc = new THREE.Quaternion()
/**
 * Hand `H` onto the grip frame `G` of the gun posed in `gun` (palm point offset by `base`, in gun
 * metres), its elbow toward `pole` (world), weight `w`. Returns where its palm should be.
 */
function placeHand(H, G, base, pole, curl, w) {
    // where the palm goes, and how the hand must be turned
    gunDir(G.fingers, _fw).normalize()
    gunDir(G.faces, _nw).normalize()
    const qR = handRotation(H, _fw, _nw, _hq)
    _pw.set(base[0] + G.palm[0], base[1] + G.palm[1], base[2] + G.palm[2])
    gunDir(_pw.toArray(), _tmp).multiplyScalar(GUN_SCALE).add(gun.pos)
    _pw.copy(_tmp)
    H.hand.getWorldScale(_ws)
    _wt.copy(H.palm).multiplyScalar(_ws.x).applyQuaternion(qR)
    _wt.subVectors(_pw, _wt)                                            // the wrist's target
    reach(H.up, H.low, H.hand, _wt, pole, w)
    // turn the hand (from the clip's): it gets there at half the blend, ahead of the arm, so a gun
    // being raised swings onto the line early instead of hanging from the clip's wrist
    const wr = Math.min(1, w * 2)
    H.low.getWorldQuaternion(_pq)
    _qc.copy(_pq).invert().multiply(qR)
    H.hand.quaternion.slerp(_qc, wr)
    // hand most of its roll about the forearm to the forearm, so the wrist doesn't wring
    _ta.copy(H.hand.position).normalize()
    const q = H.hand.quaternion, d = q.x * _ta.x + q.y * _ta.y + q.z * _ta.z
    _tw.set(_ta.x * d, _ta.y * d, _ta.z * d, q.w).normalize()
    _ti.identity().slerp(_tw, TWIST_TO_FOREARM)
    H.low.quaternion.multiply(_ti)
    H.hand.quaternion.premultiply(_ti.invert())
    // close the fingers on the grip
    H.fingers.forEach((f, k) => {
        _qc.setFromAxisAngle(f.axis, (curl[k] ?? 0)).premultiply(f.restLocal)
        f.bone.quaternion.slerp(_qc, wr)
    })
    H.up.updateMatrixWorld(true)
    if (probe.on) probe.hands[H.name] = handReport(H, _pw)
    return _pw
}

/** Probe: how well hand H sits on its target palm point `pw`. */
function handReport(H, pw) {
    const palm = H.palm.clone().applyMatrix4(H.hand.matrixWorld)
    const a = H.up.getWorldPosition(new THREE.Vector3()), b = H.low.getWorldPosition(new THREE.Vector3()), c = H.hand.getWorldPosition(new THREE.Vector3())
    const elbow = THREE.MathUtils.radToDeg(a.sub(b).angleTo(c.clone().sub(b)))
    const q = H.hand.quaternion, ax = H.hand.position.clone().normalize()
    const twist = THREE.MathUtils.radToDeg(2 * Math.atan2(Math.abs(q.x * ax.x + q.y * ax.y + q.z * ax.z), Math.abs(q.w)))
    return { palmErr: +palm.distanceTo(pw).toFixed(4), elbow: +elbow.toFixed(0), wristTwist: +twist.toFixed(0),
             palm: palm.toArray().map(v => +v.toFixed(3)) }
}

// the gun's pose in the world (the right hand is solved from it, then the gun is re-read from the hand)
const gun = { pos: new THREE.Vector3(), x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3() }
const _sh = new THREE.Vector3(), _pole = new THREE.Vector3(), _sh2 = new THREE.Vector3()
const ZERO = [0, 0, 0]

function gunBasis(from) {
    gun.z.subVectors(aimPoint, from).normalize()
    gun.x.crossVectors(_up, gun.z).normalize()
    gun.y.crossVectors(gun.z, gun.x)
}
/** a pole in the body's frame (right, up, forward) → world */
const bodyDir = (a, out) => out.copy(_right).multiplyScalar(a[0]).addScaledVector(_up, a[1]).addScaledVector(_fwd, a[2]).normalize()

/**
 * Hold the equipped gun on the aim line, weight `w`: a pistol out in front at most of an arm's
 * length (two hands on foot, one in the saddle); a long gun butt in the shoulder pocket, cheek
 * down to the stock.
 */
function holdGun(wpn, w) {
    frame()
    const rifleHold = wpn.hold === 'rifle'
    if (rifleHold) {
        // the pocket: between the collarbone's end and the shoulder joint, a little forward
        bones.shoulder.getWorldPosition(_sh2)
        bones.arm.getWorldPosition(_sh)
        _sh.lerp(_sh2, 0.45).addScaledVector(_fwd, 0.025).addScaledVector(_up, -0.012)
        gunBasis(_sh)
        const [, by, bz] = wpn.butt
        gun.pos.copy(_sh).addScaledVector(gun.y, -by * GUN_SCALE).addScaledVector(gun.z, -bz * GUN_SCALE)
        cheekWeld(w)
    } else {
        bones.arm.getWorldPosition(_sh)
        bones.fore.getWorldPosition(_ib); bones.hand.getWorldPosition(_ic)
        const len = (_sh.distanceTo(_ib) + _ib.distanceTo(_ic)) * PISTOL_REACH
        gun.pos.subVectors(aimPoint, _sh).normalize().multiplyScalar(len).add(_sh)
        gunBasis(gun.pos)
    }
    const g = GRIP[rifleHold ? 'rifle' : 'pistol'], poles = POLES[rifleHold ? 'rifle' : 'pistol']
    placeHand(bones.hands.right, g.right, ZERO, bodyDir(poles.right, _pole), CURL.right, w)
    // the support hand goes onto the gun where the right hand actually put it
    readGun(wpn.hold)
    if (rifleHold || !api.isMounted?.()) {
        const base = rifleHold ? wpn.fore : ZERO
        placeHand(bones.hands.left, g.left, base, bodyDir(poles.left, _pole), CURL.left, w)
    }
}

const _gm = new THREE.Matrix4(), _gs = new THREE.Vector3(1, 1, 1).multiplyScalar(GUN_SCALE)
const gripLocal = {}                 // hold → the gun in the right hand's frame (fixed: built from GRIP)
/** The gun in the right hand's frame, for `hold`: the inverse of where GRIP puts the hand on a gun at the origin. */
function gripMatrix(hold) {
    if (gripLocal[hold]) return gripLocal[hold]
    const H = bones.hands.right, G = GRIP[hold].right
    const fw = new THREE.Vector3(...G.fingers).normalize(), nw = new THREE.Vector3(...G.faces).normalize()
    const q = handRotation(H, fw, nw, new THREE.Quaternion())
    H.hand.getWorldScale(_ws)
    const palm = new THREE.Vector3(...G.palm).multiplyScalar(GUN_SCALE)
    const wrist = palm.clone().sub(H.palm.clone().multiplyScalar(_ws.x).applyQuaternion(q))
    const handM = new THREE.Matrix4().compose(wrist, q, _ws)
    const gunM = new THREE.Matrix4().compose(new THREE.Vector3(), new THREE.Quaternion(), _gs)
    return (gripLocal[hold] = handM.invert().multiply(gunM))
}
/** The gun's pose as the right hand now holds it (into `gun`). */
function readGun(hold) {
    _gm.multiplyMatrices(bones.hand.matrixWorld, gripMatrix(hold))
    gun.x.setFromMatrixColumn(_gm, 0).normalize()
    gun.y.setFromMatrixColumn(_gm, 1).normalize()
    gun.z.setFromMatrixColumn(_gm, 2).normalize()
    gun.pos.setFromMatrixPosition(_gm)
}

/** A long gun: the head comes down and over to the stock (a little, by w). */
function cheekWeld(w) {
    for (const [b, k] of [[bones.neck, 0.4], [bones.head, 0.6]]) {
        b.parent.updateWorldMatrix(true, false)
        b.parent.getWorldQuaternion(_pq).invert()
        _bq2.setFromAxisAngle(_sd.copy(_right).applyQuaternion(_pq), -0.16 * k * w)      // chin down
        b.quaternion.premultiply(_bq2)
        _bq2.setFromAxisAngle(_sd.copy(_fwd).applyQuaternion(_pq), 0.14 * k * w)         // tilt toward the right cheek (+ about forward = toward the body's right)
        b.quaternion.premultiply(_bq2)
    }
    bones.neck.updateMatrixWorld(true)
}

// ── where each gun is drawn ──
const _m = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0), _fwd = new THREE.Vector3(), _right = new THREE.Vector3()
const _handPos = new THREE.Vector3(), _gunPos = new THREE.Vector3()
const _mq = new THREE.Quaternion()

/** The cowboy's forward and right (it faces +z, right hand toward -x = fwd × up). */
function frame() {
    api.getModel().getWorldQuaternion(_mq)
    _fwd.set(0, 0, 1).applyQuaternion(_mq)
    _right.crossVectors(_fwd, _up)
}

function setPose(mesh, pos, x, y, z) {
    _m.makeBasis(x, y, z)
    mesh.quaternion.setFromRotationMatrix(_m)
    mesh.position.copy(pos)
    mesh.visible = true
}

/** In hand (while aiming), sidearm on the right hip, long gun across the back; the rest hidden. */
function placeWeapons(model) {
    frame()
    const id = W.equipped(), w = weapon()
    // In the hands while aiming and through a reload (the reload clip works the gun); always the
    // right hand × the hold's grip matrix, so the gun sits in the palm whatever the arm is doing.
    // (raising it, it leaves the holster once the arms are half onto the aim: before that the
    // hand still has the clip's grip, and the gun would hang from it at any angle)
    const inHand = w && ((state.blend > 0.5 && state.reach > 0.5) || state.reloadT > 0) ? id : null
    const hip = W.selectedIn('sidearm'), back = W.slung()
    for (const m of meshes.values()) m.visible = false
    if (!model.visible) return

    if (inHand && meshes.has(inHand)) {
        const m = meshes.get(inHand)
        _m.multiplyMatrices(bones.hand.matrixWorld, gripMatrix(w.hold))
        _m.decompose(m.position, m.quaternion, m.scale)
        m.visible = true
    }
    if (hip && hip !== inHand && meshes.has(hip)) {
        // holster on the right hip: barrel down, sights to the rear, grip forward of the hip
        bones.upLeg.getWorldPosition(_gunPos)
        _gunPos.addScaledVector(_right, 0.075).addScaledVector(_up, -0.03).addScaledVector(_fwd, -0.01)
        _z.set(0, -1, 0).addScaledVector(_fwd, 0.18).normalize()
        _y.copy(_fwd).negate()
        _x.crossVectors(_y, _z).normalize()
        _y.crossVectors(_z, _x)
        setPose(meshes.get(hip), _gunPos, _x, _y, _z)
    }
    if (back && back !== inHand && meshes.has(back)) {
        // slung diagonally across the back, muzzle up over the right shoulder, sights outward
        const bw = W.WEAPONS[back]
        bones.spine.getWorldPosition(_gunPos)
        _gunPos.addScaledVector(_fwd, -0.075)
        _z.copy(_up).multiplyScalar(0.85).addScaledVector(_right, 0.5).normalize()
        _y.copy(_fwd).negate()
        _x.crossVectors(_y, _z).normalize()
        _y.crossVectors(_z, _x)
        const mid = ((bw.butt?.[2] ?? -0.03) + bw.muzzle[2]) / 2       // centre the gun on the back
        _gunPos.addScaledVector(_z, -mid * GUN_SCALE)
        setPose(meshes.get(back), _gunPos, _x, _y, _z)
    }
}

/** World position of the equipped gun's muzzle (for the flash and tracer). */
function muzzleWorld(out) {
    const id = W.equipped(), m = id && meshes.get(id)
    // no gun drawn (scoped, or still loading): half a unit down the aim line, never AT the camera
    if (!m || !m.visible) return out.copy(aimOrigin).addScaledVector(aimDir, 0.5)
    return out.fromArray(W.WEAPONS[id].muzzle).applyQuaternion(m.quaternion).multiplyScalar(GUN_SCALE).add(m.position)
}

// ─────────────────────────────────────────
// EFFECTS — muzzle flash sprite, tracer line, dust puffs (pooled, no lights:
// a PointLight would re-light every material in the town)
// ─────────────────────────────────────────
const flashes = [], tracers = [], puffs = []        // pools; .userData.t = time left
let playerFlash = null                             // the flash riding the player's muzzle
const FLASH_T = 0.05, TRACER_T = 0.06, PUFF_T = 0.45

function radialTexture(stops) {
    const c = document.createElement('canvas'); c.width = c.height = 64
    const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32)
    for (const [t, col] of stops) gr.addColorStop(t, col)
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
}

function buildEffects() {
    const flashTex = radialTexture([[0, 'rgba(255,250,220,1)'], [0.25, 'rgba(255,200,90,0.95)'], [0.6, 'rgba(255,120,30,0.35)'], [1, 'rgba(255,90,0,0)']])
    const puffTex  = radialTexture([[0, 'rgba(170,140,100,0.9)'], [0.5, 'rgba(150,125,95,0.5)'], [1, 'rgba(140,120,90,0)']])
    for (let i = 0; i < 8; i++) {
        const f = new THREE.Sprite(new THREE.SpriteMaterial({
            map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }))
        const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3))
        const t = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 0.8, depthWrite: false }))
        t.frustumCulled = false
        const p = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, depthWrite: false, transparent: true }))
        for (const [o, pool] of [[f, flashes], [t, tracers], [p, puffs]]) {
            o.visible = false
            o.userData.t = 0
            api.scene.add(o)
            pool.push(o)
        }
    }
}

const takeFx = (pool) => pool.reduce((a, b) => (a.userData.t <= b.userData.t ? a : b))

function flashAt(pos, size) {
    const f = takeFx(flashes)
    f.position.copy(pos)
    f.scale.setScalar(size * (1 + Math.random() * 0.5))
    f.material.rotation = Math.random() * Math.PI
    f.userData.t = FLASH_T
    f.visible = true
    return f
}
function tracerFrom(from, to) {
    const t = takeFx(tracers)
    const p = t.geometry.attributes.position
    p.setXYZ(0, from.x, from.y, from.z); p.setXYZ(1, to.x, to.y, to.z); p.needsUpdate = true
    t.userData.t = TRACER_T
    t.visible = true
}
function showPuff(at) {
    const s = takeFx(puffs)
    s.position.copy(at)
    s.userData.t = PUFF_T
    s.visible = true
}

const _mz = new THREE.Vector3()
function showFlash() { playerFlash = flashAt(muzzleWorld(_mz), weapon()?.sound === 'shotgun' ? 0.18 : 0.12) }
function showTracer(to) { tracerFrom(muzzleWorld(_mz), to) }

/**
 * Someone else's shot (npc.js, for bandits): flash at `from`, tracer to `to`, and a
 * dust puff there when `puff` (a miss that found the ground or a wall).
 */
export function fxShot(from, to, { puff = false } = {}) {
    flashAt(from, 0.1)
    tracerFrom(from, to)
    if (puff) showPuff(to)
}

function updateEffects(dt) {
    for (const f of flashes) if (f.userData.t > 0 && (f.userData.t -= dt) <= 0) f.visible = false
    if (playerFlash?.visible) muzzleWorld(playerFlash.position)   // ride the recoiling gun
    for (const t of tracers) {
        if (t.userData.t <= 0) continue
        t.userData.t -= dt
        t.material.opacity = Math.max(0, t.userData.t / TRACER_T) * 0.8
        if (t.userData.t <= 0) t.visible = false
    }
    for (const s of puffs) {
        if (s.userData.t <= 0) continue
        s.userData.t -= dt
        const k = 1 - s.userData.t / PUFF_T
        s.scale.setScalar(0.06 + k * 0.22)
        s.material.opacity = (1 - k) * 0.85
        s.position.y += dt * 0.15
        if (s.userData.t <= 0) s.visible = false
    }
}

// ─────────────────────────────────────────
// HUD — health + Dead Eye bars, weapon name, rounds loaded (pips) and in reserve, under
// the cash; damage vignette; death card; scope; crosshair hit markers
// ─────────────────────────────────────────
let hud = null, hpFill = null, deFill = null, nameEl = null, pipsEl = null, reserveEl = null, markerTimer = null
let vignette = null, deathCard = null, scopeEl = null

function buildHud() {
    hud = document.createElement('div')
    hud.id = 'ammo'
    hud.innerHTML = `<span class="hp-bar"><span class="hp-fill"></span></span>`
        + `<span class="de-bar"><span class="de-fill"></span></span>`
        + `<span class="wpn-name"></span>`
        + `<span class="ammo-row"><span class="ammo-pips"></span><span class="ammo-reserve"></span></span>`
        + `<span class="ammo-reload">RELOADING</span>`
    document.body.appendChild(hud)
    hpFill = hud.querySelector('.hp-fill')
    deFill = hud.querySelector('.de-fill')
    nameEl = hud.querySelector('.wpn-name')
    pipsEl = hud.querySelector('.ammo-pips')
    reserveEl = hud.querySelector('.ammo-reserve')

    vignette = document.createElement('div')
    vignette.id = 'damage-vignette'
    document.body.appendChild(vignette)

    deathCard = document.createElement('div')
    deathCard.id = 'death-card'
    deathCard.innerHTML = '<div class="death-title">You Died</div><div class="death-sub"></div>'
    document.body.appendChild(deathCard)

    scopeEl = document.createElement('div')
    scopeEl.id = 'scope'
    document.body.appendChild(scopeEl)
    updateHud()
}

export function updateHud() {
    if (!hud) return
    const id = W.equipped(), w = weapon()
    nameEl.textContent = w ? w.name : 'Unarmed'
    const mag = w ? w.mag : 0, n = w ? W.loaded(id) : 0
    if (pipsEl.childElementCount !== mag) pipsEl.innerHTML = '<i></i>'.repeat(mag)
    ;[...pipsEl.children].forEach((p, i) => p.classList.toggle('spent', i >= n))
    pipsEl.classList.toggle('shells', w?.ammo === 'shotgun')
    reserveEl.textContent = w ? `${W.reserve(w.ammo)}` : ''
    hud.classList.toggle('reloading', state.reloadT > 0)
    const k = state.hp / PLAYER.maxHp
    hpFill.style.width = `${(k * 100).toFixed(1)}%`
    hud.classList.toggle('hp-low', k < 0.3)
}
export function setHudVisible(v) { if (hud) hud.style.display = v ? 'flex' : 'none' }
/** Dead Eye's meter (0..1) and whether it is running. */
export function setDeadEyeBar(k, active) {
    if (!deFill) return
    deFill.style.width = `${(THREE.MathUtils.clamp(k, 0, 1) * 100).toFixed(1)}%`
    hud.classList.toggle('de-active', !!active)
}

function flashVignette(amount) {
    if (!vignette) return
    vignette.style.setProperty('--hit', Math.min(1, 0.35 + amount / 30).toFixed(2))
    vignette.classList.remove('flash')
    void vignette.offsetWidth
    vignette.classList.add('flash')
}

/** Show / hide the death card (script.js drives the timing). */
export function showDeathCard(sub) {
    if (!deathCard) return
    deathCard.querySelector('.death-sub').textContent = sub ?? ''
    deathCard.classList.add('show')
}
export function hideDeathCard() { deathCard?.classList.remove('show') }

function marker(kind) {
    const ch = document.getElementById('crosshair')
    if (!ch) return
    ch.classList.remove('hit', 'kill')
    void ch.offsetWidth
    ch.classList.add(kind)
    clearTimeout(markerTimer)
    markerTimer = setTimeout(() => ch.classList.remove('hit', 'kill'), kind === 'kill' ? 420 : 180)
}

// ─────────────────────────────────────────
// RESET — health and timers. The inventory (weapons.js) is separate: New Game resets
// it there; a respawn keeps it.
// ─────────────────────────────────────────
export function resetCombat() {
    state.cooldown = state.reloadT = state.aimHold = state.equipT = state.cycleT = 0
    state.reload = null
    state.autoReload = false
    state.aimHeld = false
    state.blend = 0
    state.scoped = false
    state.hp = PLAYER.maxHp
    state.sinceHit = 99
    state.dead = false
    hideDeathCard()
    updateHud()
}

// ─────────────────────────────────────────
// DEBUG — headless checks
// ─────────────────────────────────────────
// dev probe: the arms' world directions before and after the aim IK, last frame
const probe = { on: false, before: null, after: null, hands: {} }
function armDirs() {
    const d = (a, b) => { const p = a.getWorldPosition(new THREE.Vector3()), q = b.getWorldPosition(new THREE.Vector3()); return q.sub(p).normalize().toArray().map(v => +v.toFixed(2)) }
    frame()
    return { R: d(bones.arm, bones.hand), L: d(bones.lArm, bones.lHand), aim: _sd.subVectors(aimPoint, aimOrigin).normalize().toArray().map(v => +v.toFixed(2)),
             body: _fwd.toArray().map(v => +v.toFixed(2)), reach: +state.reach.toFixed(2) }
}

export const debug = {
    probe: (on) => {
        probe.on = on
        const cal = bones && Object.fromEntries(Object.entries(bones.hands).map(([k, H]) => [k, { F: H.F.toArray().map(v => +v.toFixed(2)), N: H.N.toArray().map(v => +v.toFixed(2)), palm: H.palm.toArray().map(v => +v.toFixed(2)), verts: H.verts, fingers: H.fingers.length }]))
        const g = W.equipped() && meshes.get(W.equipped())
        return { before: probe.before, after: probe.after, hands: { ...probe.hands }, cal, gun: g && { pos: g.position.toArray().map(v => +v.toFixed(3)), barrel: new THREE.Vector3(0, 0, 1).applyQuaternion(g.quaternion).toArray().map(v => +v.toFixed(2)) } }
    },
    state: () => ({ ...state, reload: state.reload && { ...state.reload }, stats: { ...stats }, bones: !!bones,
                    equipped: W.equipped(), loaded: W.equipped() ? W.loaded(W.equipped()) : 0,
                    meshes: [...meshes.keys()], aimPoint: aimPoint.toArray().map(v => +v.toFixed(2)) }),
    /** Aim straight at a world point from the current aim origin and fire once (respects the interval). */
    fireAt(x, y, z) {
        aimDir.set(x, y, z).sub(aimOrigin).normalize()
        state.aimHold = AIM_HOLD
        const id = W.equipped()
        if (!id || state.reloadT > 0 || state.cooldown > 0 || state.equipT > 0 || W.loaded(id) <= 0) return false
        return fire()
    },
    hurt: (n) => damagePlayer(n),
    /** How far each spine bone, the neck and head lean from vertical (deg), and the hips' height. */
    pose: () => bones && Object.fromEntries(['hips', 'spine1', 'spine', 'neck', 'head'].map(k => {
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(bones[k].getWorldQuaternion(new THREE.Quaternion()))
        return [k, +THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(up.y, -1, 1))).toFixed(1)]
    })),
}
