/**
 * ═══════════════════════════════════════════════════════════
 * weapons.js — the arsenal: weapon + ammo data, and the player's inventory
 * ───────────────────────────────────────────────────────────
 * Pure data and bookkeeping — no THREE, no DOM. combat.js reads the equipped
 * weapon from here, the gunsmith sells from here, the wheel lists from here,
 * and script.js saves serialize() / restores restore().
 *
 * Models live in static/weapons/<model>. Every GLB is in metres with the
 * barrel along +z, sights +y and its origin at the grip; the anchors below
 * (muzzle / fore-end / butt) were measured when they were baked (npc-prep.js).
 * The town is modelled at half scale, so combat.js draws them at 0.5.
 *
 * Sources: Quaternius Ultimate Gun Pack (CC0) for all but the repeater, which
 * is the lever-action from Polyy's 3D Low-Poly Guns Pack (CC0).
 * ═══════════════════════════════════════════════════════════
 */

/** Wheel order. 'unarmed' holsters everything. */
export const CATEGORIES = ['unarmed', 'sidearm', 'shotgun', 'rifle', 'sniper']
export const CATEGORY_LABEL = { unarmed: 'Unarmed', sidearm: 'Sidearm', shotgun: 'Shotgun', rifle: 'Rifle', sniper: 'Sniper' }

export const AMMO = {
    revolver: { name: 'Revolver Cartridges', cap: 72, box: 12, price: 4, start: 24 },
    rifle:    { name: 'Rifle Cartridges',    cap: 40, box: 10, price: 6, start: 0 },
    shotgun:  { name: 'Shotgun Shells',      cap: 24, box: 8,  price: 6, start: 0 },
}

/**
 * hold:    'pistol' — one hand, the arm swung onto the aim line;
 *          'rifle'  — butt to the shoulder, both hands on the gun.
 * reload:  [fixed s, s per round loaded] — a revolver or a tube magazine fills a
 *          round at a time; a break-open or single shot is one motion.
 * cycle:   the sound after each shot for actions that work between shots.
 * pellets / spread (deg) / falloff: shotguns only. Spreads look tight, but the town is at
 *          half scale: a person is ~0.26 u wide, so 3.5° already covers them at ~4 u.
 * zoomFov: scoped — the aim camera narrows to this FOV.
 */
export const WEAPONS = {
    cattleman: {
        name: 'Cattleman Revolver', category: 'sidearm', ammo: 'revolver', model: 'revolver.glb', hold: 'pistol',
        mag: 6, damage: 34, interval: 0.45, reload: [0.4, 0.2], range: 60, price: 0,
        sound: 'revolver', reloadSound: 'reload', muzzle: [0, 0.075, 0.246],
        blurb: 'Reliable single-action six-shooter.',
    },
    schofield: {
        name: 'Schofield Revolver', category: 'sidearm', ammo: 'revolver', model: 'schofield.glb', hold: 'pistol',
        mag: 6, damage: 42, interval: 0.55, reload: [1.2, 0], range: 60, price: 60,
        sound: 'revolver', reloadSound: 'reload_break', muzzle: [0, 0.072, 0.255],
        blurb: 'Hits harder; the break-top frame reloads all six at once.',
    },
    double_action: {
        name: 'Double-Action Revolver', category: 'sidearm', ammo: 'revolver', model: 'double_action.glb', hold: 'pistol',
        mag: 6, damage: 28, interval: 0.26, reload: [0.4, 0.2], range: 55, price: 90,
        sound: 'revolver', reloadSound: 'reload', muzzle: [0, 0.076, 0.255],
        blurb: 'No hammer to cock — fires as fast as you can pull.',
    },
    sawed_off: {
        name: 'Sawed-off Shotgun', category: 'shotgun', ammo: 'shotgun', model: 'sawed_off.glb', hold: 'pistol',
        mag: 2, damage: 14, pellets: 9, spread: 3.5, falloff: true, interval: 0.35, reload: [1.8, 0], range: 12, price: 110,
        sound: 'shotgun', reloadSound: 'reload_break', muzzle: [0, 0.045, 0.475],
        blurb: 'Two barrels, wide spread. Devastating up close, useless far away.',
    },
    pump_shotgun: {
        name: 'Pump-action Shotgun', category: 'shotgun', ammo: 'shotgun', model: 'pump_shotgun.glb', hold: 'rifle',
        mag: 5, damage: 15, pellets: 8, spread: 2.2, falloff: true, interval: 0.85, reload: [0.3, 0.4], range: 20, price: 150,
        sound: 'shotgun', reloadSound: 'reload_tube', cycle: 'cycle_pump',
        muzzle: [0, 0.048, 0.595], fore: [0, 0.014, 0.268], butt: [0, -0.007, -0.255],
        blurb: 'Five shells and a tighter spread for a bit more reach.',
    },
    repeater: {
        name: 'Carbine Repeater', category: 'rifle', ammo: 'rifle', model: 'repeater.glb', hold: 'rifle',
        mag: 8, damage: 45, interval: 0.5, reload: [0.4, 0.25], range: 90, price: 160,
        sound: 'rifle', reloadSound: 'reload_tube', cycle: 'cycle_lever',
        muzzle: [0, 0.093, 0.686], fore: [0, 0.053, 0.294], butt: [0, -0.013, -0.294],
        blurb: 'Lever-action. Eight rounds, quick follow-up shots.',
    },
    bolt_rifle: {
        name: 'Bolt-action Rifle', category: 'rifle', ammo: 'rifle', model: 'bolt_rifle.glb', hold: 'rifle',
        mag: 5, damage: 75, interval: 1.1, reload: [0.6, 0.4], range: 120, price: 220,
        sound: 'rifle', reloadSound: 'reload_tube', cycle: 'cycle_bolt',
        muzzle: [0, 0.047, 0.763], fore: [0, 0.025, 0.307], butt: [0, -0.042, -0.297],
        blurb: 'Slow, accurate, and two body shots put a bandit down.',
    },
    rolling_block: {
        name: 'Rolling Block Rifle', category: 'sniper', ammo: 'rifle', model: 'rolling_block.glb', hold: 'rifle',
        mag: 1, damage: 140, interval: 1.5, reload: [1.6, 0], range: 160, zoomFov: 18, price: 320,
        sound: 'rifle', reloadSound: 'reload_break',
        muzzle: [0, 0.041, 0.77], fore: [0, 0.02, 0.306], butt: [0, -0.044, -0.3],
        blurb: 'Single shot with a long scope. One hit, one kill.',
    },
}
export const HEAD_MUL = 2

/** Seconds to load `rounds` into weapon `w`. */
export const reloadTime = (w, rounds) => w.reload[0] + w.reload[1] * rounds

// ─────────────────────────────────────────
// INVENTORY
// ─────────────────────────────────────────
const inv = {
    owned:    new Set(),
    loaded:   {},          // weapon id → rounds in it
    reserve:  {},          // ammo type → rounds carried
    selected: {},          // category → the weapon id the wheel / carry shows for it
    equipped: null,        // weapon id in hand when aiming; null = unarmed
    slung:    null,        // the long gun carried on the back
}

/** The starting kit: the Cattleman, loaded, and two boxes of cartridges. */
export function newGame() {
    inv.owned = new Set(['cattleman'])
    inv.loaded = { cattleman: WEAPONS.cattleman.mag }
    inv.reserve = Object.fromEntries(Object.entries(AMMO).map(([k, a]) => [k, a.start]))
    inv.selected = { sidearm: 'cattleman' }
    inv.equipped = 'cattleman'
    inv.slung = null
}
newGame()

export const owns = (id) => inv.owned.has(id)
export const equipped = () => inv.equipped
export const equippedWeapon = () => (inv.equipped ? WEAPONS[inv.equipped] : null)
export const loaded = (id) => inv.loaded[id] ?? 0
export const reserve = (type) => inv.reserve[type] ?? 0
export const selectedIn = (cat) => inv.selected[cat] ?? null
export const slung = () => inv.slung
export const ownedIn = (cat) => Object.keys(WEAPONS).filter(id => WEAPONS[id].category === cat && inv.owned.has(id))

/** Add a weapon (it comes with one full load, not drawn from the reserve). */
export function give(id) {
    if (!WEAPONS[id] || inv.owned.has(id)) return false
    inv.owned.add(id)
    inv.loaded[id] = WEAPONS[id].mag
    const cat = WEAPONS[id].category
    if (!inv.selected[cat]) inv.selected[cat] = id
    return true
}

/** Add up to `n` rounds of `type`, respecting the carry cap. Returns how many fitted. */
export function addAmmo(type, n) {
    const room = Math.max(0, AMMO[type].cap - reserve(type))
    const k = Math.min(room, Math.max(0, Math.round(n)))
    inv.reserve[type] = reserve(type) + k
    return k
}
export const ammoRoom = (type) => Math.max(0, AMMO[type].cap - reserve(type))

/** Take up to `n` rounds of `type` from the reserve; returns how many were available. */
export function takeAmmo(type, n) {
    const k = Math.min(reserve(type), n)
    inv.reserve[type] = reserve(type) - k
    return k
}

/** Change the rounds loaded in `id` (firing: -1; a reload: +k). */
export function setLoaded(id, n) { inv.loaded[id] = Math.max(0, Math.min(WEAPONS[id].mag, n)) }

/** Put `id` in hand (null = unarmed). Long guns become the one carried on the back. */
export function equip(id) {
    if (id && !inv.owned.has(id)) return false
    inv.equipped = id
    if (id) {
        const w = WEAPONS[id]
        inv.selected[w.category] = id
        if (w.category !== 'sidearm') inv.slung = id
    }
    return true
}

/** Choose which owned gun a slot shows, without equipping it (the wheel's scroll). */
export function selectWithin(cat, id) {
    if (inv.owned.has(id) && WEAPONS[id].category === cat) inv.selected[cat] = id
}

/** The owned weapons in wheel order (for the mouse wheel's next / previous). */
export function cycleOrder() {
    const out = [null]
    for (const cat of CATEGORIES) if (cat !== 'unarmed') out.push(...ownedIn(cat))
    return out
}

/** Next (+1) or previous (-1) owned weapon after the equipped one, unarmed included. */
export function cycled(dir) {
    const order = cycleOrder()
    const i = Math.max(0, order.indexOf(inv.equipped))
    return order[(i + dir + order.length) % order.length]
}

// ─────────────────────────────────────────
// SAVE / LOAD
// ─────────────────────────────────────────
export function serialize() {
    return {
        owned: [...inv.owned], loaded: { ...inv.loaded }, reserve: { ...inv.reserve },
        selected: { ...inv.selected }, equipped: inv.equipped, slung: inv.slung,
    }
}

/** Older saves have no inventory: they get the starting kit (their `ammo` = Cattleman rounds). */
export function restore(d, legacyAmmo) {
    newGame()
    if (!d) {
        if (Number.isFinite(legacyAmmo)) setLoaded('cattleman', legacyAmmo)
        return
    }
    for (const id of d.owned ?? []) if (WEAPONS[id]) inv.owned.add(id)
    inv.owned.add('cattleman')
    for (const [id, n] of Object.entries(d.loaded ?? {})) if (WEAPONS[id]) setLoaded(id, n)
    for (const [t, n] of Object.entries(d.reserve ?? {})) if (AMMO[t]) inv.reserve[t] = Math.max(0, Math.min(AMMO[t].cap, n | 0))
    for (const [c, id] of Object.entries(d.selected ?? {})) if (inv.owned.has(id) && WEAPONS[id].category === c) inv.selected[c] = id
    inv.equipped = d.equipped && inv.owned.has(d.equipped) ? d.equipped : (d.equipped === null ? null : 'cattleman')
    inv.slung = d.slung && inv.owned.has(d.slung) ? d.slung : null
}

/** Debug / tests: the whole inventory as plain data. */
export const snapshot = () => serialize()
