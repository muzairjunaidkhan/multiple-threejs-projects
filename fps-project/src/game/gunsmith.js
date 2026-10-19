/**
 * ═══════════════════════════════════════════════════════════
 * gunsmith.js — the AMMUNITION store's counter
 * ───────────────────────────────────────────────────────────
 * Talk to the gunsmith on the store's porch ([E]) and this panel opens: guns
 * with their stats and prices, and boxes of each ammo type up to what you can
 * carry. The world freezes while it is open (script.js treats it as time ×0)
 * and the pointer is released so the buttons can be clicked. Esc / E / Leave
 * closes it.
 *
 * Money goes through the injected { getMoney, spend(n) → bool }, so purchases
 * use script.js's own cash display and its red "−$" cue.
 * ═══════════════════════════════════════════════════════════
 */

import * as W from './weapons.js'
import * as combat from './combat.js'
import * as audio from './audio.js'

let api = null
let root = null, listEl = null, cashEl = null, noteEl = null
let tab = 'weapons', openFlag = false, noteTimer = null

// stat bars are relative to the best gun in the shop
const MAX = {
    damage: Math.max(...Object.values(W.WEAPONS).map(w => w.damage * (w.pellets ?? 1))),
    rate:   Math.max(...Object.values(W.WEAPONS).map(w => 1 / w.interval)),
    range:  Math.max(...Object.values(W.WEAPONS).map(w => w.range)),
    mag:    Math.max(...Object.values(W.WEAPONS).map(w => w.mag)),
}

export function initGunsmith(shopApi) {
    api = shopApi
    root = document.createElement('div')
    root.id = 'gunsmith'
    root.innerHTML = `
        <div class="gs-panel">
            <div class="gs-head">
                <div><div class="gs-title">Gunsmith</div><div class="gs-sub">Dead Mesa · Arms &amp; Ammunition</div></div>
                <div class="gs-cash"></div>
            </div>
            <div class="gs-tabs">
                <button data-tab="weapons">Weapons</button>
                <button data-tab="ammo">Ammunition</button>
            </div>
            <div class="gs-list"></div>
            <div class="gs-foot"><span class="gs-note"></span><button class="gs-leave">Leave <kbd>Esc</kbd></button></div>
        </div>`
    document.body.appendChild(root)
    listEl = root.querySelector('.gs-list')
    cashEl = root.querySelector('.gs-cash')
    noteEl = root.querySelector('.gs-note')
    root.querySelectorAll('.gs-tabs button').forEach(b => b.addEventListener('click', () => {
        tab = b.dataset.tab
        audio.playUI('ui_move', { volume: 0.5 })
        render()
    }))
    root.querySelector('.gs-leave').addEventListener('click', () => close())
    listEl.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-buy]')
        if (!b || b.disabled) return
        const [kind, key] = b.dataset.buy.split(':')
        if (kind === 'weapon') buyWeapon(key)
        else buyAmmo(key)
    })
}

export const isOpen = () => openFlag

export function open() {
    if (openFlag) return
    openFlag = true
    root.classList.add('open')
    if (document.pointerLockElement) document.exitPointerLock()
    audio.playUI('board_open', { volume: 0.6 })
    render()
}

export function close() {
    if (!openFlag) return
    openFlag = false
    root.classList.remove('open')
    audio.playUI('board_close', { volume: 0.5 })
    api.onClose?.()
}

function note(text) {
    noteEl.textContent = text
    clearTimeout(noteTimer)
    noteTimer = setTimeout(() => { noteEl.textContent = '' }, 2600)
}

function buyWeapon(id) {
    const w = W.WEAPONS[id]
    if (W.owns(id) || !api.spend(w.price)) return
    W.give(id)
    combat.ensureModel(id)
    combat.updateHud()
    note(`Bought the ${w.name}. It's loaded — pick it on the weapon wheel (Tab).`)
    render()
}

function buyAmmo(type) {
    const a = W.AMMO[type]
    if (W.ammoRoom(type) <= 0 || !api.spend(a.price)) return
    const got = W.addAmmo(type, a.box)
    combat.updateHud()
    note(`+${got} ${a.name.toLowerCase()}`)
    render()
}

const bar = (label, k) => `<div class="gs-stat"><span>${label}</span><i><b style="width:${Math.round(Math.min(1, k) * 100)}%"></b></i></div>`

function render() {
    if (!openFlag) return
    const cash = api.getMoney()
    cashEl.textContent = `$${cash.toLocaleString('en-US')}`
    root.querySelectorAll('.gs-tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab))
    if (tab === 'weapons') {
        listEl.innerHTML = Object.entries(W.WEAPONS).map(([id, w]) => {
            const owned = W.owns(id), afford = cash >= w.price
            const btn = owned ? `<button disabled class="owned">Owned</button>`
                : `<button data-buy="weapon:${id}" ${afford ? '' : 'disabled'}>${afford ? 'Buy' : 'Need'} $${w.price}</button>`
            return `<div class="gs-row${owned ? ' is-owned' : ''}">
                <div class="gs-icon"><img src="./weapons/icons/${id}.png" alt=""></div>
                <div class="gs-info">
                    <div class="gs-name">${w.name} <span class="gs-cat">${W.CATEGORY_LABEL[w.category]} · ${W.AMMO[w.ammo].name}</span></div>
                    <div class="gs-blurb">${w.blurb}</div>
                    <div class="gs-stats">${bar('Damage', w.damage * (w.pellets ?? 1) / MAX.damage)}${bar('Fire rate', 1 / w.interval / MAX.rate)}${bar('Range', w.range / MAX.range)}${bar('Capacity', w.mag / MAX.mag)}</div>
                </div>
                <div class="gs-buy">${btn}</div>
            </div>`
        }).join('')
    } else {
        listEl.innerHTML = Object.entries(W.AMMO).map(([type, a]) => {
            const room = W.ammoRoom(type), afford = cash >= a.price
            const users = Object.values(W.WEAPONS).filter(w => w.ammo === type).map(w => w.name).join(', ')
            const btn = room <= 0 ? `<button disabled class="owned">Full</button>`
                : `<button data-buy="ammo:${type}" ${afford ? '' : 'disabled'}>${afford ? 'Buy' : 'Need'} $${a.price}</button>`
            return `<div class="gs-row">
                <div class="gs-icon gs-ammo-icon ${type}"></div>
                <div class="gs-info">
                    <div class="gs-name">${a.name} <span class="gs-cat">box of ${a.box}</span></div>
                    <div class="gs-blurb">For: ${users}</div>
                    <div class="gs-carry">Carrying <b>${W.reserve(type)}</b> / ${a.cap}</div>
                </div>
                <div class="gs-buy">${btn}</div>
            </div>`
        }).join('')
    }
}

export const debug = {
    open, close, buyWeapon, buyAmmo,
    state: () => ({ open: openFlag, tab, note: noteEl?.textContent }),
    setTab: (t) => { tab = t; render() },
}
