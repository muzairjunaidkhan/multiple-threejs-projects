/**
 * ═══════════════════════════════════════════════════════════
 * deadeye.js — Red Dead's Dead Eye
 * ───────────────────────────────────────────────────────────
 * Q while aiming: the world slows to 0.3 (script.js scales its delta by
 * timeScale()), the screen goes sepia and a heartbeat thumps. Each click
 * paints a red X on whoever is under the crosshair — the X rides that NPC —
 * up to the rounds in the gun. Q again, letting go of right mouse, running out
 * of rounds to mark, or the meter emptying then fires at every mark in quick
 * succession, each a sure hit unless something stands in the way.
 *
 * The meter drains while active (in real time, so slow motion can't stretch
 * it) and refills from hits and kills, and slowly on its own once the guns
 * have been quiet a while.
 * ═══════════════════════════════════════════════════════════
 */

import * as THREE from 'three'
import * as combat from './combat.js'
import * as W from './weapons.js'
import * as audio from './audio.js'
import * as npc from './npc.js'

export const DEAD_EYE = {
    max:        100,
    minToStart: 15,
    drain:      12,       // per real second while active
    perHit:     3,
    perKill:    10,
    regen:      1.5,      // per second, after …
    regenDelay: 5,        // … this long without firing
    timeScale:  0.3,
    shotGap:    0.08,     // s between the marked shots
    heartGap:   0.6,
}

let api = null
const s = {
    meter: DEAD_EYE.max, active: false, executing: false,
    marks: [],            // { npc, sprite }
    shotT: 0, heartT: 0, sinceFire: 99,
}
let overlay = null, markTex = null

export function initDeadEye(worldApi) {
    api = worldApi
    overlay = document.createElement('div')
    overlay.id = 'deadeye-overlay'
    document.body.appendChild(overlay)
    combat.onHit(({ killed }) => {
        if (s.active) return                     // Dead Eye's own shots don't refill it
        s.meter = Math.min(DEAD_EYE.max, s.meter + (killed ? DEAD_EYE.perKill : DEAD_EYE.perHit))
    })
    combat.onShot(() => { s.sinceFire = 0 })     // the slow refill waits for the guns to go quiet
    combat.setDeadEyeBar(s.meter / DEAD_EYE.max, false)
}

export const isActive = () => s.active
export const timeScale = () => (s.active ? DEAD_EYE.timeScale : 1)
export const getMeter = () => s.meter
export function setMeter(v) {
    s.meter = THREE.MathUtils.clamp(Number.isFinite(v) ? v : DEAD_EYE.max, 0, DEAD_EYE.max)
    combat.setDeadEyeBar(s.meter / DEAD_EYE.max, s.active)
}

/** Q: start (while aiming with a loaded gun and enough meter), or let the marks fly. */
export function toggle() {
    if (s.active) { execute(); return }
    const id = W.equipped()
    if (!id || !combat.isAiming() || combat.isDead() || s.meter < DEAD_EYE.minToStart) {
        if (s.meter < DEAD_EYE.minToStart && combat.isAiming()) audio.play2D('dry_fire', { volume: 0.4 })
        return
    }
    if (W.loaded(id) <= 0) { combat.reload(); return }
    s.active = true
    s.executing = false
    s.heartT = 0
    audio.play2D('deadeye_in', { volume: 0.7 })
    document.getElementById('canvas')?.classList.add('deadeye')
    overlay.classList.add('show')
}

/**
 * Left click while active: mark the NPC under the crosshair. Returns true when Dead Eye
 * took the click (so it does not also fire a normal shot).
 */
export function click() {
    if (!s.active) return false
    if (s.executing) return true
    const id = W.equipped()
    if (!id || s.marks.length >= W.loaded(id)) return true
    const hit = combat.aimHit()
    if (!hit || hit.npc.state === 'dead') return true
    addMark(hit.npc, hit.point)
    audio.play2D('deadeye_mark', { volume: 0.6 })
    if (s.marks.length >= W.loaded(id)) execute()        // every round spoken for
    return true
}

/** Right mouse released while active: fire what's marked. */
export function releaseAim() { if (s.active && !s.executing) execute() }

function execute() {
    if (!s.active || s.executing) return
    if (!s.marks.length) { stop(); return }
    s.executing = true
    s.shotT = 0
}

function stop() {
    s.active = false
    s.executing = false
    for (const m of s.marks) m.sprite.removeFromParent()
    s.marks.length = 0
    audio.play2D('deadeye_out', { volume: 0.5 })
    document.getElementById('canvas')?.classList.remove('deadeye')
    overlay.classList.remove('show')
    combat.setDeadEyeBar(s.meter / DEAD_EYE.max, false)
}

// ── marks: a red X riding the marked NPC at the spot that was under the crosshair ──
function markTexture() {
    if (markTex) return markTex
    const c = document.createElement('canvas'); c.width = c.height = 64
    const g = c.getContext('2d')
    g.strokeStyle = '#d8261b'; g.lineWidth = 10; g.lineCap = 'round'
    g.shadowColor = 'rgba(0,0,0,0.7)'; g.shadowBlur = 4
    g.beginPath(); g.moveTo(14, 14); g.lineTo(50, 50); g.moveTo(50, 14); g.lineTo(14, 50); g.stroke()
    markTex = new THREE.CanvasTexture(c)
    markTex.colorSpace = THREE.SRGBColorSpace
    return markTex
}
const _wp = new THREE.Vector3()
function addMark(n, point) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: markTexture(), depthTest: false, transparent: true, fog: false }))
    sprite.renderOrder = 999
    n.root.add(sprite)
    sprite.position.copy(n.root.worldToLocal(_wp.copy(point)))
    sprite.scale.setScalar(0.07 / n.root.scale.x)          // ~0.07 u on screen whatever the root's scale
    s.marks.push({ npc: n, sprite })
}

/** Real-time update (script.js passes the unscaled delta). */
export function updateDeadEye(dt) {
    if (!s.active) {
        s.sinceFire += dt
        if (s.sinceFire > DEAD_EYE.regenDelay && s.meter < DEAD_EYE.max) {
            s.meter = Math.min(DEAD_EYE.max, s.meter + DEAD_EYE.regen * dt)
            combat.setDeadEyeBar(s.meter / DEAD_EYE.max, false)
        }
        return
    }
    s.sinceFire = 0
    if (combat.isDead() || !W.equipped()) { stop(); return }
    s.meter = Math.max(0, s.meter - DEAD_EYE.drain * dt)
    combat.setDeadEyeBar(s.meter / DEAD_EYE.max, true)
    if ((s.heartT -= dt) <= 0) { audio.play2D('heartbeat', { volume: 0.8 }); s.heartT = DEAD_EYE.heartGap }
    if (!s.executing && s.meter <= 0) execute()
    if (!s.executing) return

    if ((s.shotT -= dt) > 0) return
    const m = s.marks.shift()
    if (!m) { stop(); return }
    m.sprite.getWorldPosition(_wp)
    m.sprite.removeFromParent()
    if (m.npc.state !== 'dead') combat.fireAt(_wp)
    s.shotT = DEAD_EYE.shotGap
    if (!s.marks.length) s.shotT = 0.25                    // let the last shot land before time resumes
}

/** New Game / respawn / load: off, full meter unless told otherwise. */
export function resetDeadEye(meter = DEAD_EYE.max) {
    if (s.active) stop()
    s.sinceFire = 99
    setMeter(meter)
}

export const debug = {
    state: () => ({ meter: +s.meter.toFixed(1), active: s.active, executing: s.executing, marks: s.marks.map(m => m.npc.def.name) }),
    /** Mark an NPC by name at its chest (tests can't aim a real mouse). */
    markNpc(name) {
        const n = npc.npcByName(name)
        if (!s.active || !n) return false
        addMark(n, n.root.position.clone().add(new THREE.Vector3(0, 0.55, 0)))
        return true
    },
}
