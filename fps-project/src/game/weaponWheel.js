/**
 * ═══════════════════════════════════════════════════════════
 * weaponWheel.js — Red Dead's weapon wheel
 * ───────────────────────────────────────────────────────────
 * Hold Tab: a ring of five slots (Unarmed, Sidearm, Shotgun, Rifle, Sniper)
 * opens and the world slows to a quarter (script.js scales its delta by
 * timeScale()). The pointer stays locked — mouse movement steers a cursor
 * that picks the slot, it does not turn the camera. The mouse wheel steps
 * through the guns you own in the highlighted slot. Let go of Tab to equip.
 *
 * Reads and writes the inventory through weapons.js; equips through
 * combat.equip() so the swap delay and sounds apply.
 * ═══════════════════════════════════════════════════════════
 */

import * as W from './weapons.js'
import * as combat from './combat.js'
import * as audio from './audio.js'

const SLOW = 0.25
const DEADZONE = 28        // px of cursor travel before a slot is picked
const RADIUS = 120         // the cursor is clamped to this

let root = null, centre = null
const segs = {}            // category → element
const s = { open: false, hover: null, cx: 0, cy: 0 }

const angleOf = (i) => -90 + i * (360 / W.CATEGORIES.length)       // Unarmed at the top, clockwise

export function initWeaponWheel() {
    root = document.createElement('div')
    root.id = 'weapon-wheel'
    W.CATEGORIES.forEach((cat, i) => {
        const el = document.createElement('div')
        el.className = 'ww-seg'
        const a = angleOf(i) * Math.PI / 180
        el.style.left = `${50 + Math.cos(a) * 36}%`
        el.style.top  = `${50 + Math.sin(a) * 36}%`
        el.innerHTML = `<span class="ww-icon"></span><span class="ww-cat">${W.CATEGORY_LABEL[cat]}</span><span class="ww-ammo"></span>`
        root.appendChild(el)
        segs[cat] = el
    })
    centre = document.createElement('div')
    centre.className = 'ww-centre'
    root.appendChild(centre)
    document.body.appendChild(root)
}

export const isOpen = () => s.open
export const timeScale = () => (s.open ? SLOW : 1)

const categoryOf = (id) => (id ? W.WEAPONS[id].category : 'unarmed')

export function open() {
    if (s.open) return
    s.open = true
    s.cx = s.cy = 0
    s.hover = categoryOf(W.equipped())
    root.classList.add('open')
    audio.play2D('ui_move', { volume: 0.4 })
    render()
}

/** Close; with `apply`, equip what is highlighted. */
export function close(apply = true) {
    if (!s.open) return
    s.open = false
    root.classList.remove('open')
    if (!apply) return
    const id = s.hover === 'unarmed' ? null : W.selectedIn(s.hover)
    if (s.hover === 'unarmed' || (id && W.owns(id))) combat.equip(id)
}

/** Pointer-locked mouse movement while open steers the cursor. */
export function move(dx, dy) {
    if (!s.open) return
    s.cx += dx * 0.6
    s.cy += dy * 0.6
    const r = Math.hypot(s.cx, s.cy)
    if (r > RADIUS) { s.cx *= RADIUS / r; s.cy *= RADIUS / r }
    if (r < DEADZONE) return
    const deg = Math.atan2(s.cy, s.cx) * 180 / Math.PI
    const step = 360 / W.CATEGORIES.length
    const i = ((Math.round((deg + 90) / step) % W.CATEGORIES.length) + W.CATEGORIES.length) % W.CATEGORIES.length
    const cat = W.CATEGORIES[i]
    if (cat !== s.hover) { s.hover = cat; audio.play2D('ui_move', { volume: 0.25 }); render() }
}

/** Mouse wheel while open: the next / previous owned gun in the highlighted slot. */
export function scroll(dir) {
    if (!s.open || s.hover === 'unarmed') return
    const list = W.ownedIn(s.hover)
    if (list.length < 2) return
    const i = Math.max(0, list.indexOf(W.selectedIn(s.hover)))
    W.selectWithin(s.hover, list[(i + dir + list.length) % list.length])
    audio.play2D('ui_move', { volume: 0.3 })
    render()
}

/** Pick a slot directly (debug / number keys while open). */
export function hover(cat) { if (W.CATEGORIES.includes(cat)) { s.hover = cat; render() } }

function render() {
    for (const cat of W.CATEGORIES) {
        const el = segs[cat]
        const id = cat === 'unarmed' ? null : W.selectedIn(cat)
        const owned = cat === 'unarmed' || (id && W.owns(id))
        el.classList.toggle('hover', cat === s.hover)
        el.classList.toggle('locked', !owned)
        el.classList.toggle('equipped', categoryOf(W.equipped()) === cat)
        const icon = el.querySelector('.ww-icon')
        const want = owned && id ? `./weapons/icons/${id}.png` : ''
        if (icon.dataset.src !== want) {
            icon.dataset.src = want
            icon.innerHTML = want ? `<img src="${want}" alt="">` : (cat === 'unarmed' ? '✋' : '')
        }
        el.querySelector('.ww-ammo').textContent = owned && id ? `${W.loaded(id)} | ${W.reserve(W.WEAPONS[id].ammo)}` : ''
    }
    const cat = s.hover, id = cat === 'unarmed' ? null : W.selectedIn(cat)
    if (cat === 'unarmed') centre.innerHTML = `<div class="ww-name">Unarmed</div><div class="ww-sub">Holster your guns</div>`
    else if (!id || !W.owns(id)) centre.innerHTML = `<div class="ww-name">${W.CATEGORY_LABEL[cat]}</div><div class="ww-sub">Buy one at the gunsmith</div>`
    else {
        const w = W.WEAPONS[id], list = W.ownedIn(cat)
        centre.innerHTML = `<div class="ww-name">${w.name}</div>`
            + `<div class="ww-sub">${W.loaded(id)} loaded · ${W.reserve(w.ammo)} ${W.AMMO[w.ammo].name.toLowerCase()}</div>`
            + (list.length > 1 ? `<div class="ww-hint">Scroll to switch (${list.indexOf(id) + 1}/${list.length})</div>` : '')
    }
}

export const debug = { state: () => ({ ...s }) }
