/**
 * ═══════════════════════════════════════════════════════════
 * menu.js — main menu, pause menu, load/save & credits screens
 * ───────────────────────────────────────────────────────────
 * Generates its own DOM (instant, no 3D dependency); styling lives
 * in style.css. Reacts to gameState via onStateChange:
 *   MAINMENU → main menu   PAUSED → pause menu   else → hidden.
 *
 * Talks UP to script.js through the injected `hooks`:
 *   startNewGame, continueGame, loadSlot(slot), saveToSlot(slot),
 *   resume, quitToMenu, openSettings, closeSettings
 *
 * Settings reuses the existing lil-gui (script.js owns show/hide).
 * ═══════════════════════════════════════════════════════════
 */

import { STATES, getState, onStateChange } from './gameState.js'
import * as save from './saveSystem.js'

let _hooks    = {}
let _root     = null            // #menu-root container
let _screens  = {}              // name → element
let _active   = null            // active screen name or null
let _return   = 'main'          // where load/save/settings return to
let _selIndex = 0

// ── Screen definitions: list-style menus ───────────────────
const MAIN_ITEMS = [
    { action: 'continue', label: 'CONTINUE' },
    { action: 'newgame',  label: 'NEW GAME' },
    { action: 'load',     label: 'LOAD GAME' },
    { action: 'settings', label: 'SETTINGS' },
    { action: 'credits',  label: 'CREDITS' },
    { action: 'quit',     label: 'QUIT' },
]
const PAUSE_ITEMS = [
    { action: 'resume',   label: 'RESUME' },
    { action: 'map',      label: 'MAP' },
    { action: 'save',     label: 'SAVE GAME' },
    { action: 'load',     label: 'LOAD GAME' },
    { action: 'settings', label: 'SETTINGS' },
    { action: 'quitmenu', label: 'QUIT TO MENU' },
]

function isTyping() {
    const el = document.activeElement
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

// ═══════════════════════════════════════════════════════════
export function initMenu(hooks) {
    _hooks = hooks || {}

    _root = document.createElement('div')
    _root.id = 'menu-root'
    document.body.appendChild(_root)

    _screens.main     = buildListScreen('main', 'DEAD MESA', MAIN_ITEMS, true)
    _screens.pause    = buildListScreen('pause', 'PAUSED', PAUSE_ITEMS, false)
    _screens.load     = buildSlotScreen('load')
    _screens.save     = buildSlotScreen('save')
    _screens.credits  = buildCredits()
    _screens.settings = buildSettingsBar()

    for (const name in _screens) {
        _screens[name].classList.add('hidden')
        _root.appendChild(_screens[name])
    }

    window.addEventListener('keydown', onKeyDown)

    onStateChange((next) => {
        if (next === STATES.MAINMENU)    showScreen('main')
        else if (next === STATES.PAUSED) showScreen('pause')
        else                             hideAll()
    })
}

export function showMainMenu()  { showScreen('main') }
export function showPauseMenu() { showScreen('pause') }
export function hideAllMenus()  { hideAll() }

// ── Screen builders ────────────────────────────────────────
function buildListScreen(kind, title, items, withBg) {
    const el = document.createElement('div')
    el.className = `menu-screen menu-list ${kind === 'main' ? 'menu-main' : 'menu-pause'}`
    el.innerHTML = `
        ${withBg ? '<div class="menu-bg"></div><div class="menu-grain"></div>' : ''}
        <div class="menu-panel">
            <h1 class="menu-title">${title}</h1>
            <div class="menu-rule"></div>
            <nav class="menu-items"></nav>
        </div>`
    const nav = el.querySelector('.menu-items')
    items.forEach((it, i) => {
        const b = document.createElement('button')
        b.className = 'menu-btn'
        b.dataset.action = it.action
        b.dataset.index  = i
        b.textContent = it.label
        b.addEventListener('mouseenter', () => { _selIndex = i; refreshSelection() })
        b.addEventListener('click', () => { _selIndex = i; activate(it.action) })
        nav.appendChild(b)
    })
    return el
}

function buildSlotScreen(mode) {
    const el = document.createElement('div')
    el.className = 'menu-screen menu-slots'
    el.innerHTML = `
        <div class="menu-panel">
            <h2 class="menu-subtitle">${mode === 'save' ? 'SAVE GAME' : 'LOAD GAME'}</h2>
            <div class="menu-rule"></div>
            <div class="slot-list"></div>
            <div class="slot-status"></div>
            <button class="menu-btn slot-back" data-action="back">BACK</button>
        </div>`
    return el
}

function buildCredits() {
    const el = document.createElement('div')
    el.className = 'menu-screen menu-credits'
    el.innerHTML = `
        <div class="menu-panel">
            <h2 class="menu-subtitle">CREDITS</h2>
            <div class="menu-rule"></div>
            <p class="credits-body">
                DEAD MESA<br><br>
                A Three.js · Rapier project<br>
                by M Uzair Junaid<br><br>
                <span class="credits-dim">Press any key to return</span>
            </p>
        </div>`
    return el
}

function buildSettingsBar() {
    const el = document.createElement('div')
    el.className = 'menu-screen menu-settings'
    el.innerHTML = `
        <div class="settings-bar">
            <span>SETTINGS — adjust in the panel · </span>
            <button class="menu-btn settings-back" data-action="back">BACK</button>
        </div>`
    el.querySelector('.settings-back').addEventListener('click', () => activate('back'))
    return el
}

// ── Slot rendering (load/save) ─────────────────────────────
function renderSlots(mode) {
    const screen = _screens[mode]
    const list   = screen.querySelector('.slot-list')
    const status = screen.querySelector('.slot-status')
    status.textContent = ''
    list.innerHTML = ''
    const slots = save.listSlots()
    slots.forEach((s) => {
        const card = document.createElement('div')
        card.className = 'slot-card'
        if (s.empty) {
            card.classList.add('slot-empty')
            card.innerHTML = `<span class="slot-title">Slot ${s.slot}</span><span class="slot-meta">— Empty —</span>`
        } else {
            const when = new Date(s.timestamp).toLocaleString()
            card.innerHTML = `
                <span class="slot-title">Slot ${s.slot} · ${s.missionName}</span>
                <span class="slot-meta">${s.location} · ${when}</span>`
        }
        // Primary action: save into / load from
        card.addEventListener('click', () => onSlotActivate(mode, s))

        // Delete button for occupied slots
        if (!s.empty) {
            const del = document.createElement('button')
            del.className = 'slot-del'
            del.textContent = '✕'
            del.title = 'Delete save'
            del.addEventListener('click', (e) => {
                e.stopPropagation()
                save.deleteSlot(s.slot)
                renderSlots(mode)
            })
            card.appendChild(del)
        }
        list.appendChild(card)
    })
}

function onSlotActivate(mode, s) {
    const status = _screens[mode].querySelector('.slot-status')
    if (mode === 'save') {
        const ok = _hooks.saveToSlot?.(s.slot)
        status.textContent = ok === false ? 'Save failed — storage unavailable.' : `Saved to slot ${s.slot}.`
        renderSlots('save')
    } else {
        if (s.empty) { status.textContent = 'Empty slot.'; return }
        _hooks.loadSlot?.(s.slot)
    }
}

// ── Screen switching ───────────────────────────────────────
function showScreen(name) {
    _active = name
    for (const k in _screens) _screens[k].classList.toggle('hidden', k !== name)
    if (name === 'load' || name === 'save') renderSlots(name)
    if (name === 'main') refreshContinueState()
    _selIndex = 0
    refreshSelection()
}

function hideAll() {
    _active = null
    for (const k in _screens) _screens[k].classList.add('hidden')
}

function refreshContinueState() {
    const btn = _screens.main.querySelector('[data-action="continue"]')
    if (btn) btn.classList.toggle('disabled', !save.anySave())
}

// Buttons eligible for keyboard selection on the active list screen.
function navButtons() {
    if (_active !== 'main' && _active !== 'pause') return []
    return [..._screens[_active].querySelectorAll('.menu-btn')]
        .filter(b => !b.classList.contains('disabled'))
}

function refreshSelection() {
    const btns = navButtons()
    if (!btns.length) return
    _selIndex = (_selIndex + btns.length) % btns.length
    btns.forEach((b, i) => b.classList.toggle('selected', i === _selIndex))
}

// ── Actions ────────────────────────────────────────────────
function activate(action) {
    switch (action) {
        case 'continue': if (save.anySave()) _hooks.continueGame?.(); break
        case 'newgame':  _hooks.startNewGame?.(); break
        case 'resume':   _hooks.resume?.(); break
        case 'map':      _hooks.openMap?.(); break
        case 'quitmenu': _hooks.quitToMenu?.(); break
        case 'load':     _return = _active; showScreen('load'); break
        case 'save':     _return = _active; showScreen('save'); break
        case 'credits':  _return = _active; showScreen('credits'); break
        case 'settings': openSettings(); break
        case 'quit':     _hooks.quitToMenu?.(); break   // no real tab-close; back to menu
        case 'back':     closeSubScreen(); break
    }
}

function openSettings() {
    _return = _active
    _hooks.openSettings?.()
    showScreen('settings')
}

function closeSubScreen() {
    if (_active === 'settings') _hooks.closeSettings?.()
    showScreen(_return === 'pause' ? 'pause' : 'main')
}

// ── Keyboard ───────────────────────────────────────────────
function onKeyDown(e) {
    const st = getState()
    if (st !== STATES.MAINMENU && st !== STATES.PAUSED) return
    if (isTyping()) return
    if (!_active) return

    // Credits / settings: any key (or Escape) returns.
    if (_active === 'credits') { closeSubScreen(); e.preventDefault(); return }
    if (_active === 'settings') {
        if (e.key === 'Escape') { closeSubScreen(); e.preventDefault() }
        return
    }

    switch (e.key) {
        case 'ArrowUp': case 'w': case 'W':
            _selIndex--; refreshSelection(); e.preventDefault(); break
        case 'ArrowDown': case 's': case 'S':
            _selIndex++; refreshSelection(); e.preventDefault(); break
        case 'Enter': case ' ': {
            const btns = navButtons()
            if (btns[_selIndex]) activate(btns[_selIndex].dataset.action)
            e.preventDefault(); break
        }
        case 'Escape':
            if (_active === 'load' || _active === 'save') closeSubScreen()
            else if (_active === 'pause') _hooks.resume?.()
            // main-menu root: Escape does nothing
            e.preventDefault(); break
    }
}
