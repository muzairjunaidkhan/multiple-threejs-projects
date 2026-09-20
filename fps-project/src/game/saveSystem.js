/**
 * ═══════════════════════════════════════════════════════════
 * saveSystem.js — 3-slot localStorage save/load
 * ───────────────────────────────────────────────────────────
 * Pure JSON I/O — no THREE, no physics. script.js builds the
 * payload (captureSaveFromWorld) and applies it (applySaveToWorld);
 * this module only persists and retrieves it.
 *
 * Storage layout: one key per slot →  deadmesa.save.1 | .2 | .3
 *   value = JSON.stringify({ version, timestamp, payload })
 * ═══════════════════════════════════════════════════════════
 */

export const SCHEMA_VERSION = 1
export const SLOTS          = [1, 2, 3]

const keyFor = (slot) => `deadmesa.save.${slot}`

/**
 * Default payload shape — what a save holds. script.js fills the
 * real values; this documents the contract and seeds new games.
 */
export function emptyPayload() {
    return {
        position:         { x: 0, y: 1.5, z: 0 },
        camYaw:           0,
        camPitch:         0.4,
        currentMissionId: null,
        completed:        [],
        flags:            {},
        inventory:        [],
        missionName:      'Free Roam',
        location:         'Dead Mesa',
    }
}

function readRaw(slot) {
    try {
        const s = localStorage.getItem(keyFor(slot))
        return s ? JSON.parse(s) : null
    } catch (err) {
        console.warn(`[save] read failed slot ${slot}`, err)
        return null
    }
}

export function hasSave(slot) {
    return readRaw(slot) !== null
}

export function anySave() {
    return SLOTS.some(hasSave)
}

/**
 * Persist a payload to a slot. Wraps with version + timestamp.
 * Returns true on success, false if storage is unavailable/full.
 */
export function save(slot, payload) {
    const record = { version: SCHEMA_VERSION, timestamp: Date.now(), payload }
    try {
        localStorage.setItem(keyFor(slot), JSON.stringify(record))
        return true
    } catch (err) {
        console.warn(`[save] write failed slot ${slot}`, err)
        return false
    }
}

/**
 * Load a slot's payload, or null if empty/corrupt. Runs an identity
 * migration if the stored version differs (extend as schema evolves).
 */
export function load(slot) {
    const record = readRaw(slot)
    if (!record) return null
    let payload = record.payload ?? null
    if (record.version !== SCHEMA_VERSION) {
        payload = migrate(payload, record.version)
    }
    return payload
}

function migrate(payload, fromVersion) {
    // Identity migration for now — fill in real upgrades as the schema grows.
    console.log(`[save] migrating v${fromVersion} → v${SCHEMA_VERSION}`)
    return payload
}

export function deleteSlot(slot) {
    try { localStorage.removeItem(keyFor(slot)) } catch (err) {
        console.warn(`[save] delete failed slot ${slot}`, err)
    }
}

/**
 * Descriptors for the Load screen. One entry per slot, in slot order.
 * { slot, empty, missionName, location, timestamp }
 */
export function listSlots() {
    return SLOTS.map(slot => {
        const record = readRaw(slot)
        if (!record) return { slot, empty: true }
        const p = record.payload ?? {}
        return {
            slot,
            empty:       false,
            missionName: p.missionName ?? 'Free Roam',
            location:    p.location ?? 'Dead Mesa',
            timestamp:   record.timestamp ?? 0,
        }
    })
}

/**
 * Slot number of the newest save (highest timestamp), or null if none.
 * Used by the CONTINUE button.
 */
export function mostRecentSlot() {
    let best = null, bestTs = -1
    for (const slot of SLOTS) {
        const record = readRaw(slot)
        if (record && (record.timestamp ?? 0) > bestTs) { bestTs = record.timestamp ?? 0; best = slot }
    }
    return best
}
