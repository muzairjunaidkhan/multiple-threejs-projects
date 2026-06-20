/**
 * ═══════════════════════════════════════════════════════════
 * gameState.js — single source of truth for the game phase
 * ───────────────────────────────────────────────────────────
 * A tiny observable: one string drives the whole shell. Modules
 * read it (getState/isPlaying) and react to changes via
 * onStateChange(). This module imports nothing → no cycles.
 *
 * NOTE: there is also an animation `setState()` inside script.js.
 * Import THIS one aliased, e.g. `import { setState as setGameState }`.
 * ═══════════════════════════════════════════════════════════
 */

export const STATES = Object.freeze({
    MAINMENU: 'mainmenu',
    CUTSCENE: 'cutscene',
    PLAYING:  'playing',
    PAUSED:   'paused',
    DIALOGUE: 'dialogue',
})

let _current = STATES.MAINMENU
const _subs   = new Set()

export function getState() {
    return _current
}

export function isPlaying() {
    return _current === STATES.PLAYING
}

/**
 * Transition to a new state. No-op if unchanged. Subscribers are
 * called synchronously with (next, prev).
 */
export function setState(next) {
    if (next === _current) return
    const prev = _current
    _current   = next
    console.log(`[gameState] ${prev} → ${next}`)
    for (const fn of _subs) {
        try { fn(next, prev) } catch (err) { console.error('[gameState] subscriber error', err) }
    }
}

/**
 * Subscribe to state changes. Returns an unsubscribe function.
 */
export function onStateChange(fn) {
    _subs.add(fn)
    return () => _subs.delete(fn)
}
