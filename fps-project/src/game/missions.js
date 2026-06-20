/**
 * ═══════════════════════════════════════════════════════════
 * missions.js — data-driven mission scaffold
 * ───────────────────────────────────────────────────────────
 * Ships DISABLED (MISSIONS_ENABLED = false): all the plumbing is
 * here and wired into script.js, but no mission runs until story
 * content is added and the flag is flipped on.
 *
 * No THREE import — the world is reached only through the injected
 * `worldApi` { getPlayerPos, teleport, distanceTo, showSubtitle }.
 *
 * Mission shape:
 *   {
 *     id, name, description,
 *     trigger: { type:'auto' | 'zone' | 'interact', ... },
 *       - 'auto'     → starts as soon as no mission is active
 *       - 'zone'     → { x, y, z, radius } player proximity
 *       - 'interact' → { interactablePrefix } pressing E on a match
 *     objectives: [ { id, text, check(api)→bool, done } ],
 *     onStart(api), onComplete(api),
 *     next,        // id of mission to auto-start after completion (or null)
 *   }
 * ═══════════════════════════════════════════════════════════
 */

export const MISSIONS_ENABLED = false

// Placeholder. Real story missions get appended here later.
export const MISSIONS = [
    {
        id:          'mission_intro',
        name:        'A New Arrival',
        description: 'A stranger arrives in Dead Mesa.',
        trigger:     { type: 'auto' },
        objectives: [
            {
                id:    'reach_saloon',
                text:  'Head into town',
                check: (api) => api.distanceTo(0, 1.5, 0) < 5,
                done:  false,
            },
        ],
        onStart:    (api) => { api.showSubtitle?.('A New Arrival — head into town.') },
        onComplete: (api) => { api.showSubtitle?.('Objective complete.') },
        next:       null,
    },
]

// ── Runtime tracker state ──────────────────────────────────
let _api       = null
let _activeId  = null
const _completed = new Set()
let _flags     = {}

const byId = (id) => MISSIONS.find(m => m.id === id) || null

export function initMissions(worldApi) {
    _api = worldApi
}

export function getMission(id) {
    return byId(id)
}

export function getActiveMission() {
    return _activeId ? byId(_activeId) : null
}

export function startMission(id) {
    const m = byId(id)
    if (!m || _activeId === id || _completed.has(id)) return
    _activeId = id
    m.objectives.forEach(o => { o.done = false })
    console.log(`[mission] start: ${m.name}`)
    m.onStart?.(_api)
}

export function completeMission(id) {
    const m = byId(id)
    if (!m) return
    _completed.add(id)
    if (_activeId === id) _activeId = null
    console.log(`[mission] complete: ${m.name}`)
    m.onComplete?.(_api)
    if (m.next) startMission(m.next)
}

/**
 * Per-frame tick — only meaningful while PLAYING. No-op when missions
 * are disabled or the list is empty.
 */
export function updateMissions(dt) {
    if (!MISSIONS_ENABLED || !_api || MISSIONS.length === 0) return

    // No active mission → look for an auto / zone trigger to start.
    if (!_activeId) {
        for (const m of MISSIONS) {
            if (_completed.has(m.id)) continue
            const t = m.trigger
            if (t?.type === 'auto') { startMission(m.id); break }
            if (t?.type === 'zone' && _api.distanceTo(t.x, t.y, t.z) < (t.radius ?? 3)) {
                startMission(m.id); break
            }
        }
        if (!_activeId) return
    }

    // Active mission → evaluate objectives.
    const m = byId(_activeId)
    if (!m) { _activeId = null; return }
    let allDone = true
    for (const o of m.objectives) {
        if (!o.done && o.check?.(_api)) {
            o.done = true
            console.log(`[mission] objective done: ${o.text}`)
        }
        if (!o.done) allDone = false
    }
    if (allDone) completeMission(m.id)
}

/**
 * Called from triggerInteract() in script.js — additive, lets an
 * interactable double as a mission trigger / objective satisfier.
 */
export function handleInteractTrigger(entry) {
    if (!MISSIONS_ENABLED || !entry) return
    const name = entry.object?.name ?? ''

    // Start any not-yet-active mission whose interact trigger matches.
    if (!_activeId) {
        for (const m of MISSIONS) {
            if (_completed.has(m.id)) continue
            const t = m.trigger
            if (t?.type === 'interact' && t.interactablePrefix && name.startsWith(t.interactablePrefix)) {
                startMission(m.id); break
            }
        }
    }

    // Mark any matching interact-objectives on the active mission done.
    const m = getActiveMission()
    if (!m) return
    for (const o of m.objectives) {
        if (!o.done && o.interactablePrefix && name.startsWith(o.interactablePrefix)) {
            o.done = true
            console.log(`[mission] objective done (interact): ${o.text}`)
        }
    }
}

// ── Save / load bridge ─────────────────────────────────────
export function serializeProgress() {
    return {
        currentMissionId: _activeId,
        completed:        [..._completed],
        flags:            { ..._flags },
    }
}

/**
 * Restore from a save payload (or pass null to reset for a New Game).
 */
export function restoreProgress(data) {
    _completed.clear()
    _flags = {}
    _activeId = null
    if (!data) return
    if (Array.isArray(data.completed)) data.completed.forEach(id => _completed.add(id))
    if (data.flags) _flags = { ...data.flags }
    _activeId = data.currentMissionId ?? null
    if (_activeId) {
        const m = byId(_activeId)
        if (m) m.objectives.forEach(o => { o.done = false })
    }
}

export function getFlag(key)        { return _flags[key] }
export function setFlag(key, value) { _flags[key] = value }
