/**
 * ═══════════════════════════════════════════════════════════
 * npc.js — townsfolk who walk Dead Mesa's streets
 * ───────────────────────────────────────────────────────────
 * Bodies: static/character/cast/<body>.glb (cast.js): two Sketchfab cowboys
 * rigged by Mixamo's auto-rigger, one skinned mesh and one texture each, so one
 * draw call per NPC. Townsfolk are "Cowboy – Western 01" (ALTEREGO, CC-BY),
 * bandits "Cowboy Character Model" (arok59520). Colour variants are
 * repainted textures (<body>_<variant>.jpg) swapped onto a shared material.
 *
 * Clips: static/character/cast/clips.glb (Mixamo), shared with the player; the
 * hips track is scaled to each body on load (cast.clipsFor).
 *
 * World access is injected (initNpcs), not imported:
 *   { scene, camera, world, RAPIER, getPlayerPos, getPlayerCollider, isPlayerDead,
 *     playerStance() ('stand' | 'crouch' | 'ride'), sound(name, pos, opts),
 *     onKill(npc, info), damagePlayer(n, from), fxShot(from, to, opts) }
 *
 * Bandits (hostile: true) carry a revolver and run a small state machine:
 *   patrol (their route) → alert (spotted / shot at / heard a shot) → chase (jog
 *   straight at the player) ⇄ attack (stand and fire, hit chance falls with range)
 *   → reload after six → … → return to the route when the player is lost for a few
 *   seconds, leaves the camp's leash, or dies.
 *
 * No navmesh: every NPC walks an authored ROUTE of street waypoints (checked
 * with debug.validateRoute), snaps to the ground with a down-ray, waits at
 * some stops, and stops for the player when they stand in the way.
 *
 * Combat side: each NPC has a capsule collider (combat.js hits it with a ray and
 * calls damage()). A hit flinches; a kill plays Dying, drops the capsule and
 * fades the body; townsfolk respawn a minute later, out of the player's sight.
 * A gunshot nearby (onGunshot) sends walkers sprinting along their route away
 * from it and makes posted townsfolk cower.
 * ═══════════════════════════════════════════════════════════
 */

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js'
import * as cast from './cast.js'

export const NPC_SCALE = 0.5          // bodies are 1.8 (metres); the town is modelled at half scale

const BODIES = {
    townsman: { file: 'townsman.glb', variants: ['tan', 'grey', 'olive', 'wine'] },
    bandit:   { file: 'bandit.glb',   variants: ['dust', 'dark'] },
}

// What each behaviour plays (Mixamo clip names, clips.glb).
const CLIP = {
    idle: 'Idle', walk: 'Walking', jog: 'Running', sprint: 'Fast Run', cower: 'Terrified',
    gunIdle: 'Pistol Idle', aim: 'Shooting', reload: 'Reloading', hit: 'Hit Reaction', death: 'Dying',
}
const ONE_SHOTS = [CLIP.death, CLIP.hit, CLIP.reload]           // play once, hold the last frame
const HIT_TIME  = 1.0                 // s of the (crouched) hit reaction before carrying on …
const HIT_RATE  = 1.4                 // … played this much faster than authored
const SHOT_FROM = 0.2                 // s into Shooting where its kick starts; between shots it holds frame 0
const FALL_AT   = 2.3                 // s into Dying when the body meets the ground

// ── combat tuning ──
const HP_TOWNSFOLK   = 60
const HP_BANDIT      = 100
const HEAD_FRACTION  = 0.83           // a hit above this share of body height is a headshot
const FLEE_SPEED     = 3.2            // u/s — a sprint (the player runs at 3.4)
const FLEE_TIME      = 6              // s after the last scare
const HEAR_RADIUS    = 15             // u — gunshots closer than this scare townsfolk
const DEAD_LINGER    = 15             // s a body stays before fading …
const DEAD_LINGER_BANDIT = 45         // … long enough to walk over and loot a bandit
const FADE_TIME      = 1.5
const RESPAWN_DELAY  = 60             // s after death (townsfolk) …
const RESPAWN_BANDIT = 300            // s after death, a camp takes on a new man …
const RESPAWN_CLEAR  = 25             // u — … once the player is this far from the spot AND it is off-screen

// ── bandits ──
const BANDIT = {
    sight:       14,                  // u — sees the player this far, in front …
    fovCos:      Math.cos(THREE.MathUtils.degToRad(60)),    // … within a 120° cone
    closeSense:  4,                   // u — notices the player this close from any side
    crouchSight: 0.55,                // × sight and closeSense for a crouching player …
    crouchHit:   0.7,                 // … and × the hit chance against one
    hearRadius:  25,                  // u — a gunshot this close draws them in
    buddyRadius: 20,                  // u — an alerted bandit alerts the rest of the camp
    reactTime:   0.6,                 // s from spotting to acting
    attackRange: 9,                   // u — stops and shoots inside this; chases outside it
    chaseSpeed:  2.6,                 // u/s (a jog; the player runs at 3.4)
    leash:       30,                  // u from camp before they give up the chase
    giveUp:      6,                   // s without line of sight before returning to patrol
    rounds:      6,
    shotGap:     [1.1, 1.6],          // s between shots
    hitNear:     0.65, hitFar: 0.25,  // hit chance at ≤ nearDist … ≥ farDist
    nearDist:    5, farDist: 14,
    damage:      [10, 14],
    aimCos:      Math.cos(0.3),       // only fires once roughly facing the player
}
const COMBAT_STATES = new Set(['alert', 'chase', 'attack', 'reload'])
const GUN_MUZZLE = new THREE.Vector3(0, 0.075, 0.246)     // revolver.glb, metres, barrel +z

const WALK_SPEED   = 0.75             // u/s — a stroll (the player walks at 1.1)
const TURN_RATE    = 5                // rad/s
const ARRIVE_DIST  = 0.15             // u — a waypoint counts as reached
const AI_HZ        = 10               // decisions + ground probes; motion is per frame
const FADE         = 0.35             // s — animation cross-fade
const YIELD_DIST   = 0.9              // u — the player this close, in front, stops a walker
const YIELD_COS    = Math.cos(THREE.MathUtils.degToRad(55))
const LOD_DIST     = 22               // u — beyond: animation at 1/3 rate
const CULL_DIST    = 60               // u — beyond: hidden, no animation (still walks)
const RAY_UP       = 0.6              // ground probe starts this far above the feet …
const RAY_LEN      = 1.6              // … and looks this far down
const CAPSULE      = { r: 0.13, hh: 0.32 }   // player-blocking capsule; NPC ≈ 0.9 u tall

// Collision groups (16-bit membership << 16 | 16-bit filter). NPC capsules are in their
// own group so their own probes (and later, gunfire LOS) can look through them.
const NPC_GROUP     = 0x0002
export const NPC_COLLIDER  = ((NPC_GROUP << 16) | 0xFFFF) >>> 0      // (horse.js parks its horses in this group too)
const IGNORE_NPCS   = ((0xFFFF << 16) | (0xFFFF & ~NPC_GROUP)) >>> 0

// ─────────────────────────────────────────
// ROUTES — street waypoints (world x/z; y comes from the ground probe).
//   loop: true  → A→B→…→A;   false → ping-pong A→…→Z→…→A
//   y: rough street height (the spawn probe starts just above it, below any awning)
//   a stop may add: wait (s), face (yaw, rad; 0 = +z), anim (a clip name)
// ─────────────────────────────────────────
// Measured on a 0.25 u heightmap of the physics world: Main Street runs north-south
// between building fronts at x ≈ -24.2 (west) and -19.4 (east), z -21 … +4; the road
// crosses east-west at z ≈ 5-8; the station platform is at z 9-14, rails at z ≈ 14.5.
const FACE = { south: 0, east: Math.PI / 2, north: Math.PI, west: -Math.PI / 2 }   // yaw: 0 = +z

export const ROUTES = {
    // one-way loop, keeping right: north up the east side, south down the west side
    // (the west lane is x -22.4: something knee-high stands at (-22.9, -18.2))
    mainLoop: {
        loop: true, y: -22,
        points: [
            { x: -20.6, z:   3.5 },
            { x: -20.6, z: -19.5, wait: 2 },
            { x: -22.4, z: -19.5 },
            { x: -22.4, z:   3.5, wait: 2 },
        ],
    },
    road: {
        loop: false, y: -22,
        points: [
            { x: -44.0, z: 6.4, wait: 4 },
            { x: -30.0, z: 6.4 },
            { x: -12.0, z: 6.6 },
            { x:  -2.0, z: 6.6, wait: 4 },
        ],
    },
    // stationary (one point, wait forever)
    station:     { y: -22, points: [{ x: -27.5, z: 12.4, wait: Infinity, face: FACE.south }] },
    saloonPorch: { y: -22, points: [{ x: -25.0, z:  3.2, wait: Infinity, face: FACE.east }] },
    deputy:      { y: -22, points: [{ x: -19.8, z: -11.2, wait: Infinity, face: FACE.west }] },   // Sheriff's office
    // the AMMUNITION store: its facade sign (SM_Bld_Sign_05) hangs at (-24.8, -7.4); he stands
    // on the porch beside the door and runs the shop (gunsmith.js) — talk to him with [E].
    // y is lower than the street's so the spawn probe (y + 1.5) starts UNDER the porch's
    // awning (its top is at about -20.5) and lands on the boards, not on the roof.
    gunsmith:    { y: -22.6, points: [{ x: -24.0, z: -6.2, wait: Infinity, face: FACE.east }] },

    // Bandit camps, off the town's streets:
    //   East Road — just south of the road between the lake and the eastern hills, where
    //               the player walks in from the spawn at x ≈ 50.
    //   Railside  — across the southern track, by the lone stable at (-29, 66).
    eastPatrol:   { loop: false, y: -22, points: [{ x: 8.0, z: 12.0, wait: 4 }, { x: 16.0, z: 12.0, wait: 4 }] },
    eastLookout:  { y: -22, points: [{ x: 12.5, z: 14.5, wait: Infinity, face: FACE.north }] },
    southPatrol:  { loop: false, y: -22, points: [{ x: -35.0, z: 63.0, wait: 4 }, { x: -22.0, z: 63.0, wait: 4 }] },   // z 64.5 runs into the stable
    southLookout: { y: -22, points: [{ x: -25.5, z: 67.5, wait: Infinity, face: FACE.north }] },
}

// ─────────────────────────────────────────
// ROSTER — who walks where. `at` = starting waypoint index; `speed` scales WALK_SPEED;
// `hostile` = a bandit (gun in hand, shoots the player, bounty on death).
// ─────────────────────────────────────────
export const ROSTER = [
    { name: 'Walker',    body: 'townsman', variant: null,    route: 'mainLoop',    at: 0, speed: 1.0 },
    { name: 'Walker 2',  body: 'townsman', variant: 'tan',   route: 'mainLoop',    at: 2, speed: 0.9 },
    { name: 'Traveller', body: 'townsman', variant: 'olive', route: 'road',        at: 0, speed: 1.1 },
    { name: 'Passenger', body: 'townsman', variant: 'grey',  route: 'station' },
    { name: 'Barfly',    body: 'townsman', variant: 'wine',  route: 'saloonPorch' },
    { name: 'Deputy',    body: 'townsman', variant: 'olive', route: 'deputy' },
    { name: 'Gunsmith',  body: 'townsman', variant: 'grey',  route: 'gunsmith' },

    { name: 'Bandit East',    body: 'bandit', variant: null,   route: 'eastPatrol',   at: 0, hostile: true },
    { name: 'Bandit East 2',  body: 'bandit', variant: 'dark', route: 'eastLookout',         hostile: true },
    { name: 'Bandit South',   body: 'bandit', variant: 'dust', route: 'southPatrol',  at: 1, hostile: true },
    { name: 'Bandit South 2', body: 'bandit', variant: 'dark', route: 'southLookout',        hostile: true },
]

// ─────────────────────────────────────────
// RUNTIME
// ─────────────────────────────────────────
let api     = null
let assets  = null
const npcs  = []
const byCollider = new Map()          // collider handle → npc
let aiAcc   = 0

export function initNpcs(worldApi) { api = worldApi }

async function loadAssets() {
    const names = Object.keys(BODIES)
    const [set, gunGltf, ...scenes] = await Promise.all([
        cast.loadClips(),
        new GLTFLoader().loadAsync('./weapons/revolver.glb'),
        ...names.map(b => cast.loadBody(BODIES[b].file)),
    ])
    const variantTex = await Promise.all(names.flatMap(b =>
        BODIES[b].variants.map(v => cast.loadVariant(`${b}_${v}.jpg`).then(t => [b, v, t]))))

    const out = {}
    names.forEach((name, i) => {
        const scene = scenes[i]
        let mesh = null
        scene.traverse(o => { if (o.isSkinnedMesh) mesh = o })
        const materials = { default: mesh.material }
        for (const [b, v, t] of variantTex) if (b === name) {
            const m = mesh.material.clone()
            m.map = t
            m.name = `${mesh.material.name}_${v}`
            materials[v] = m
        }
        const clips = cast.clipsFor(scene, set)
        out[name] = { scene, materials, clips, grip: gripMatrix(scene, clips) }
    })
    let gun = null
    gunGltf.scene.traverse(o => { if (o.isMesh && !gun) gun = o })
    gun.removeFromParent()
    out.gun = gun
    return out
}

/**
 * Where the revolver sits in the right hand's frame: posed in Shooting (the arm out), the grip
 * goes in the palm (between the wrist and the index knuckle, a little up) with the barrel
 * straight down the body's forward (+z) and the sights up. Measured once per body, so it
 * holds in every clip (the gun simply follows the hand).
 */
function gripMatrix(scene, clips) {
    const mixer = new THREE.AnimationMixer(scene)
    mixer.clipAction(clips[CLIP.aim]).play()
    mixer.update(0)
    scene.updateMatrixWorld(true)
    const hand = scene.getObjectByName('mixamorigRightHand'), knuckle = scene.getObjectByName('mixamorigRightHandIndex1')
    const palm = hand.getWorldPosition(new THREE.Vector3())
        .lerp(knuckle.getWorldPosition(new THREE.Vector3()), 0.6)
    palm.y += 0.02
    const local = hand.matrixWorld.clone().invert().multiply(new THREE.Matrix4().makeTranslation(palm.x, palm.y, palm.z))
    mixer.stopAllAction()
    mixer.uncacheRoot(scene)
    scene.updateMatrixWorld(true)
    return local
}

/** Load bodies + clips and spawn the roster. Safe to call once; failures leave the town empty. */
export async function loadNpcs() {
    if (assets) return true
    try {
        assets = await loadAssets()
    } catch (err) {
        console.error('[npc] asset load failed — town stays empty', err)
        return false
    }
    for (const def of ROSTER) spawn(def)
    console.log(`[npc] ${npcs.length} spawned`)
    return true
}

function spawn(def) {
    const body = assets[def.body]
    const route = ROUTES[def.route]
    const root = SkeletonUtils.clone(body.scene)
    root.name = `NPC:${def.name}`
    root.scale.setScalar(NPC_SCALE)
    let mesh = null
    root.traverse(o => { if (o.isSkinnedMesh) mesh = o })
    mesh.material = body.materials[def.variant || 'default']
    api.scene.add(root)

    const mixer = new THREE.AnimationMixer(root)
    const actions = {}
    for (const [n, c] of Object.entries(body.clips)) actions[n] = mixer.clipAction(c)
    for (const name of ONE_SHOTS) if (actions[name]) {
        actions[name].setLoop(THREE.LoopOnce, 1)
        actions[name].clampWhenFinished = true
    }

    const { world, RAPIER } = api
    const rb = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased())
    const col = world.createCollider(
        RAPIER.ColliderDesc.capsule(CAPSULE.hh, CAPSULE.r)
            .setTranslation(0, CAPSULE.hh + CAPSULE.r, 0)
            .setCollisionGroups(NPC_COLLIDER),
        rb)

    // standing height (for headshots): every body is baked 1.8 tall
    const height = cast.BODY_HEIGHT * NPC_SCALE

    // bandits carry the revolver in the right hand, always
    let gun = null
    if (def.hostile) {
        gun = assets.gun.clone()
        gun.matrix.copy(body.grip)
        gun.matrix.decompose(gun.position, gun.quaternion, gun.scale)
        root.getObjectByName('mixamorigRightHand').add(gun)
    }
    const pts = route.points
    const home = new THREE.Vector3(pts.reduce((s, p) => s + p.x, 0) / pts.length, 0, pts.reduce((s, p) => s + p.z, 0) / pts.length)

    const n = {
        def, route, root, mesh, mixer, actions, rb, col, height, gun, home,
        sharedMaterial: mesh.material, fadeMaterial: null,
        hostile: !!def.hostile, maxHp: def.hostile ? HP_BANDIT : HP_TOWNSFOLK, hp: 0,
        pos: new THREE.Vector3(), y: 0, groundY: 0, yaw: 0,
        i: 0, dir: 1, state: 'walk', wait: 0, face: null, stopAnim: null,
        speed: WALK_SPEED * (def.speed ?? 1), gait: 1,
        fleeT: 0, hurtT: 0, deadT: 0, fallSoundAt: 0, hidden: false,
        // bandit combat
        provoked: false, alertT: 0, lostT: 0, shotT: 0, shootAnimT: 0, reloadT: 0, rounds: BANDIT.rounds,
        current: null, animAcc: 0, lodTick: 0,
    }
    byCollider.set(col.handle, n)
    npcs.push(n)
    place(n)
    return n
}

/** Put an NPC at its starting waypoint, facing the next one, alive (spawn, New Game, respawn). */
function place(n) {
    const pts = n.route.points
    n.i = n.def.at ?? 0
    n.dir = 1
    n.hp = n.maxHp
    n.fleeT = n.hurtT = n.deadT = n.fallSoundAt = 0
    n.provoked = false
    n.alertT = n.lostT = n.shotT = n.shootAnimT = n.reloadT = 0
    n.rounds = BANDIT.rounds
    n.hidden = false
    n.root.visible = true
    n.mesh.material = n.sharedMaterial
    n.col.setEnabled(true)
    const p = pts[n.i]
    n.pos.set(p.x, 0, p.z)
    // Rapier only indexes colliders for queries during world.step(), so at spawn (city
    // collider just built) this can miss; think() retries until it lands.
    n.y = n.groundY = n.route.y ?? 0
    n.grounded = false
    snapToGround(n)
    n.wait = 0
    if (pts.length === 1) {                      // a post: stand there
        n.yaw = p.face ?? 0
        n.state = 'wait'
        n.wait = p.wait ?? Infinity
        n.face = p.face ?? null
        n.stopAnim = p.anim ?? CLIP.idle
        n.current = null
        play(n, n.stopAnim, 0, true)
    } else {
        advance(n)                               // head for the next stop
        const q = pts[n.i]
        n.yaw = Math.atan2(q.x - p.x, q.z - p.z)
        n.state = 'walk'
        n.current = null
        play(n, CLIP.walk, 0, true)
    }
    sync(n)
}

/** First ground fix: probe from just above the route's street level, then snap (no damping). */
function snapToGround(n) {
    const g = groundAt(n.pos.x, n.pos.z, (n.route.y ?? n.y) + 1.5, 4)
    if (g == null) return false
    n.y = n.groundY = g
    n.grounded = true
    return true
}

export function resetNpcs() { for (const n of npcs) place(n) }

/** The waypoint `d` steps (±1) from the current one, or null past a ping-pong route's end. */
function neighbour(n, d) {
    const len = n.route.points.length
    if (n.route.loop) return (n.i + d + len) % len
    const k = n.i + d
    return k >= 0 && k < len ? k : null
}

function advance(n) {
    const len = n.route.points.length
    if (len === 1) return
    if (n.route.loop) { n.i = neighbour(n, n.dir); return }
    if (neighbour(n, n.dir) == null) n.dir = -n.dir
    n.i += n.dir
}

function play(n, name, fade = FADE, randomPhase = false) {
    if (n.current === name) return
    const next = n.actions[name]
    if (!next) return
    const prev = n.current && n.actions[n.current]
    if (!prev) for (const a of Object.values(n.actions)) a.stop()     // (re)placing: clean slate
    next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play()
    if (randomPhase) next.time = Math.random() * next.getClip().duration
    if (prev && fade > 0) prev.crossFadeTo(next, fade, false)
    else if (prev) prev.stop()
    n.current = name
}

// ── queries (city only — NPC capsules are filtered out) ──
const _ray = { origin: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: -1, z: 0 } }
let _rapierRay = null

/** Height of the first surface below (x, fromY, z) within `len`, or null. */
function groundAt(x, z, fromY, len = 200) {
    const { world, RAPIER } = api
    _rapierRay ??= new RAPIER.Ray(_ray.origin, _ray.dir)
    _ray.origin.x = x; _ray.origin.y = fromY; _ray.origin.z = z
    _ray.dir.x = 0; _ray.dir.y = -1; _ray.dir.z = 0
    const hit = world.castRay(_rapierRay, len, true, undefined, IGNORE_NPCS)
    return hit ? fromY - hit.toi : null
}

/** Distance to the first wall along a horizontal ray, or null when clear within `len`. */
function wallAhead(x, y, z, dx, dz, len) {
    const { world, RAPIER } = api
    _rapierRay ??= new RAPIER.Ray(_ray.origin, _ray.dir)
    _ray.origin.x = x; _ray.origin.y = y; _ray.origin.z = z
    _ray.dir.x = dx; _ray.dir.y = 0; _ray.dir.z = dz
    const hit = world.castRay(_rapierRay, len, true, undefined, IGNORE_NPCS)
    return hit ? hit.toi : null
}

// ─────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────
const _toPlayer = new THREE.Vector3()

const isPost = (n) => n.route.points.length === 1
const moving = (n) => n.state === 'walk' || n.state === 'flee' || n.state === 'return'

/** Decisions at AI_HZ, then the ground probe. */
function think(n, dt, player) {
    if (n.state === 'dead') return
    if (n.hostile) thinkBandit(n, dt, player)
    else thinkRoute(n, dt, player)

    if (!n.grounded) { snapToGround(n); return }
    const g = groundAt(n.pos.x, n.pos.z, n.y + RAY_UP, RAY_LEN)
    if (g != null) n.groundY = g
}

/** Route life: arrivals, waits, yielding to the player, calming down after a scare. */
function thinkRoute(n, dt, player) {
    const p = n.route.points[n.i]

    // the player standing in front of a walker stops them (and releases them on leaving)
    _toPlayer.set(player.x - n.pos.x, 0, player.z - n.pos.z)
    const dist = _toPlayer.length()
    const inFront = dist < YIELD_DIST &&
        (_toPlayer.x * Math.sin(n.yaw) + _toPlayer.z * Math.cos(n.yaw)) / (dist || 1) > YIELD_COS
    if (n.state === 'walk' && inFront) n.state = 'yield'
    else if (n.state === 'yield' && !inFront) n.state = 'walk'

    if ((n.state === 'flee' || n.state === 'cower') && (n.fleeT -= dt) <= 0) calm(n)

    if (moving(n) && Math.hypot(p.x - n.pos.x, p.z - n.pos.z) < ARRIVE_DIST) {
        if (n.state === 'return') {                         // back on the route after a fight
            if (isPost(n)) { n.state = 'wait'; n.wait = Infinity; n.face = p.face ?? null; n.stopAnim = p.anim ?? CLIP.idle }
            else { n.state = 'walk'; advance(n) }
        } else if (n.state === 'flee') {
            fleeOnward(n)                                   // runners don't stop at stops
        } else if (p.wait && n.state === 'walk') {
            n.state = 'wait'
            n.wait = p.wait * THREE.MathUtils.randFloat(0.7, 1.3)
            n.face = p.face ?? null
            n.stopAnim = p.anim ?? CLIP.idle
        } else advance(n)
    } else if (n.state === 'wait' && (n.wait -= dt) <= 0) {
        n.state = 'walk'
        advance(n)
    }
}

// ── bandits ──
const _eye = { x: 0, y: 0, z: 0 }, _losDir = { x: 0, y: 0, z: 0 }
let _losRay = null

/**
 * The player's chest, as a height above their capsule's centre: lower when crouched (so a
 * trough or a fence hides them), higher in the saddle.
 */
const CHEST = { stand: 0.15, crouch: -0.12, ride: 0.6 }
const chestY = (player) => player.y + (CHEST[api.playerStance?.()] ?? CHEST.stand)

/** Clear line from the bandit's eyes to the player's chest (other NPCs don't block). */
function hasLOS(n, player, d) {
    const { world, RAPIER } = api
    _losRay ??= new RAPIER.Ray(_eye, _losDir)
    _eye.x = n.pos.x; _eye.y = n.y + 0.8; _eye.z = n.pos.z
    const tx = player.x - _eye.x, ty = chestY(player) - _eye.y, tz = player.z - _eye.z
    const len = Math.hypot(tx, ty, tz) || 1
    _losDir.x = tx / len; _losDir.y = ty / len; _losDir.z = tz / len
    const hit = world.castRay(_losRay, Math.max(0, len - 0.25), true, undefined, IGNORE_NPCS, api.getPlayerCollider?.())
    return !hit
}

function alertBandit(n) {
    if (COMBAT_STATES.has(n.state) || n.state === 'dead') return
    n.state = 'alert'
    n.alertT = BANDIT.reactTime * THREE.MathUtils.randFloat(0.8, 1.3)
    n.shotT = THREE.MathUtils.randFloat(0.2, 0.7)           // the first shot comes quickly
    n.lostT = 0
    for (const o of npcs) {                                   // the camp hears it
        if (o !== n && o.hostile && o.state !== 'dead' && o.pos.distanceTo(n.pos) < BANDIT.buddyRadius) o.provoked = true
    }
}

/** Walk back to the nearest point of the route, then patrol as before. */
function startReturn(n) {
    n.state = 'return'
    n.provoked = false
    n.lostT = 0
    let best = 0, bd = Infinity
    n.route.points.forEach((p, k) => { const d = Math.hypot(p.x - n.pos.x, p.z - n.pos.z); if (d < bd) { bd = d; best = k } })
    n.i = best
}

function thinkBandit(n, dt, player) {
    const B = BANDIT
    const fighting = COMBAT_STATES.has(n.state)
    if (api.isPlayerDead?.()) {
        if (fighting) startReturn(n)
        n.provoked = false
        thinkRoute(n, dt, player)
        return
    }

    const dx = player.x - n.pos.x, dz = player.z - n.pos.z
    const d = Math.hypot(dx, dz)
    const facing = (dx * Math.sin(n.yaw) + dz * Math.cos(n.yaw)) / (d || 1)
    // a crouching player is noticed late (unless the fight is already on)
    const k = api.playerStance?.() === 'crouch' && !fighting ? B.crouchSight : 1
    const close = B.closeSense * k
    const inRange = d < close || d < B.sight * k * (fighting ? 1.6 : 1)
    const los = inRange && hasLOS(n, player, d)
    const sees = los && (d < close || fighting || n.provoked || facing > B.fovCos)
    n.lostT = sees ? 0 : n.lostT + dt

    if (!fighting) {
        if (sees || n.provoked) alertBandit(n)
        else { thinkRoute(n, dt, player); return }
    }
    n.provoked = false

    switch (n.state) {
        case 'alert':
            if ((n.alertT -= dt) <= 0) n.state = d > B.attackRange ? 'chase' : 'attack'
            break
        case 'chase':
            if (n.lostT > B.giveUp || n.pos.distanceTo(n.home) > B.leash) startReturn(n)
            else if (sees && d <= B.attackRange) n.state = 'attack'
            break
        case 'attack':
            if (n.lostT > 0.8 || d > B.attackRange * 1.3) { n.state = 'chase'; break }
            n.shotT -= dt
            if (n.shotT <= 0 && facing > B.aimCos) banditFire(n, player, d)
            break
        case 'reload':
            if ((n.reloadT -= dt) <= 0) { n.rounds = B.rounds; n.state = sees ? 'attack' : 'chase' }
            break
    }
}

const _muzzle = new THREE.Vector3(), _shotTo = new THREE.Vector3()
const _missRay = { o: { x: 0, y: 0, z: 0 }, d: { x: 0, y: 0, z: 0 } }
let _missRapier = null

function banditFire(n, player, d) {
    const B = BANDIT
    n.rounds--
    n.shotT = THREE.MathUtils.randFloat(...B.shotGap)
    n.shootAnimT = 0.9
    const a = n.actions[CLIP.aim]
    a.time = SHOT_FROM
    a.timeScale = 1

    n.gun.updateWorldMatrix(true, false)
    n.gun.localToWorld(_muzzle.copy(GUN_MUZZLE))
    const k = THREE.MathUtils.clamp((d - B.nearDist) / (B.farDist - B.nearDist), 0, 1)
    const hit = Math.random() < THREE.MathUtils.lerp(B.hitNear, B.hitFar, k) * (api.playerStance?.() === 'crouch' ? B.crouchHit : 1)

    api.sound?.('gunshot', _muzzle, { volume: 1.4, rateJitter: 0.05 })
    onGunshot(n.pos)                                          // townsfolk scatter
    if (hit) {
        _shotTo.set(player.x, chestY(player) - 0.05, player.z)
        api.fxShot?.(_muzzle, _shotTo)
        api.damagePlayer?.(THREE.MathUtils.randInt(...B.damage), n.pos)
    } else {
        // a near miss: aim off to one side of the player and let it land somewhere
        const side = (Math.random() < 0.5 ? -1 : 1) * THREE.MathUtils.randFloat(0.35, 0.8)
        const ux = (player.x - n.pos.x) / (d || 1), uz = (player.z - n.pos.z) / (d || 1)
        _shotTo.set(player.x - uz * side, player.y + THREE.MathUtils.randFloat(-0.5, 0.4), player.z + ux * side)
        const dir = _shotTo.clone().sub(_muzzle).normalize()
        const { world, RAPIER } = api
        _missRapier ??= new RAPIER.Ray(_missRay.o, _missRay.d)
        Object.assign(_missRay.o, { x: _muzzle.x, y: _muzzle.y, z: _muzzle.z })
        Object.assign(_missRay.d, { x: dir.x, y: dir.y, z: dir.z })
        const h = world.castRay(_missRapier, 40, true, undefined, IGNORE_NPCS, api.getPlayerCollider?.())
        if (h) _shotTo.copy(_muzzle).addScaledVector(dir, h.toi)
        else _shotTo.copy(_muzzle).addScaledVector(dir, 40)
        api.fxShot?.(_muzzle, _shotTo, { puff: !!h })
        if (h) api.sound?.('bullet', _shotTo, { volume: 0.6, rateJitter: 0.1 })
    }
    if (n.rounds <= 0) {
        n.state = 'reload'
        n.reloadT = n.actions[CLIP.reload].getClip().duration
    }
}

/** After the player respawns: living bandits go back to their posts; the dead stay down until their camp restocks. */
export function resetHostiles() {
    for (const n of npcs) if (n.hostile && n.state !== 'dead') place(n)
}

/** Back to normal after a scare: posts resume their post, walkers their route. */
function calm(n) {
    n.fleeT = 0
    if (isPost(n)) { n.state = 'wait'; n.wait = Infinity }
    else {
        n.state = 'walk'
        if (n.route.loop) n.dir = 1                          // back to keeping right
    }
}

/**
 * A runner reached a waypoint: carry on to whichever neighbour is farther from the
 * threat. If neither gets meaningfully farther than here (a dead end facing the
 * shooter, or two corners equally far from it), crouch instead of shuttling.
 */
function fleeOnward(n) {
    const pts = n.route.points
    const d2 = (q) => (q.x - n.threat.x) ** 2 + (q.z - n.threat.z) ** 2
    let best = null, bestD = -1, bestDir = n.dir
    for (const d of [n.dir, -n.dir]) {
        const k = neighbour(n, d)
        if (k == null) continue
        if (d2(pts[k]) > bestD) { bestD = d2(pts[k]); best = k; bestDir = d }
    }
    if (best == null || bestD < d2(pts[n.i]) * 1.1) { n.state = 'cower'; return }   // ≥ 5 % farther, or stay
    n.i = best
    n.dir = bestDir
}

/** timeScale for locomotion clip `name` to cover `speed` u/s on an NPC (cast.CLIP_SPEED is for 1.8 m bodies). */
const clipRate = (name, speed) => speed / (cast.CLIP_SPEED[name] * NPC_SCALE)

/** Per-frame motion + animation choice. */
function move(n, dt, player) {
    if (n.state === 'dead') {
        n.y = THREE.MathUtils.damp(n.y, n.groundY, 14, dt)
        return
    }
    const hurt = n.hurtT > 0
    if (hurt) n.hurtT -= dt
    if (n.shootAnimT > 0) n.shootAnimT -= dt

    const facesPlayer = n.state === 'alert' || n.state === 'attack' || n.state === 'reload' || n.state === 'chase'
    let targetYaw = null
    if (facesPlayer) targetYaw = Math.atan2(player.x - n.pos.x, player.z - n.pos.z)
    else if (moving(n)) {
        const p = n.route.points[n.i]
        targetYaw = Math.atan2(p.x - n.pos.x, p.z - n.pos.z)
    } else if (n.face != null && n.state === 'wait') targetYaw = n.face

    let turn = 0
    if (targetYaw != null) {
        turn = Math.atan2(Math.sin(targetYaw - n.yaw), Math.cos(targetYaw - n.yaw))
        const rate = n.state === 'flee' || facesPlayer ? TURN_RATE * 2 : TURN_RATE
        n.yaw += THREE.MathUtils.clamp(turn, -rate * dt, rate * dt)
    }

    let anim
    if (n.state === 'chase' && !hurt) {
        // straight at the player; a wall in the way just stops them (they shoot when they can see)
        const d = Math.hypot(player.x - n.pos.x, player.z - n.pos.z)
        const blocked = d < 1.2 || wallAhead(n.pos.x, n.y + 0.3, n.pos.z, Math.sin(n.yaw), Math.cos(n.yaw), 0.45) != null
        if (blocked) play(n, CLIP.gunIdle)
        else {
            const speed = BANDIT.chaseSpeed * THREE.MathUtils.clamp(Math.cos(turn), 0.2, 1)
            n.pos.x += Math.sin(n.yaw) * speed * dt
            n.pos.z += Math.cos(n.yaw) * speed * dt
            play(n, CLIP.jog)
            n.actions[CLIP.jog].timeScale = clipRate(CLIP.jog, speed)
        }
    } else if (moving(n) && !hurt) {
        // slow into sharp turns so walkers pivot instead of orbiting the waypoint
        n.gait = THREE.MathUtils.clamp(Math.cos(turn), 0.25, 1)
        const fleeing = n.state === 'flee'
        const speed = (fleeing ? FLEE_SPEED : n.speed) * n.gait
        // never step past the waypoint: at a sprint one AI tick covers twice ARRIVE_DIST,
        // so think() alone would let a runner overshoot and circle back
        const p = n.route.points[n.i]
        const remain = Math.hypot(p.x - n.pos.x, p.z - n.pos.z)
        const step = Math.min(speed * dt, remain)
        n.pos.x += Math.sin(n.yaw) * step
        n.pos.z += Math.cos(n.yaw) * step
        if (fleeing && remain <= speed * dt) fleeOnward(n)    // runners don't stop at stops
        anim = fleeing ? CLIP.sprint : CLIP.walk
        play(n, anim)
        n.actions[anim].timeScale = clipRate(anim, speed)
    } else {
        anim = hurt ? CLIP.hit
            : n.state === 'attack' ? CLIP.aim
            : n.state === 'reload' ? CLIP.reload
            : n.state === 'alert' ? CLIP.gunIdle
            : n.state === 'cower' ? CLIP.cower
            : n.state === 'wait' ? n.stopAnim
            : CLIP.idle
        play(n, anim, hurt ? 0.08 : FADE)
        // aiming holds the arm out (frame 0) between shots; banditFire runs the kick
        if (anim === CLIP.aim) n.actions[CLIP.aim].timeScale = n.shootAnimT > 0 ? 1 : 0
        else if (anim === CLIP.hit) n.actions[CLIP.hit].timeScale = HIT_RATE
    }
    n.y = THREE.MathUtils.damp(n.y, n.groundY, 14, dt)
}

// ─────────────────────────────────────────
// DAMAGE / DEATH / FEAR
// ─────────────────────────────────────────
/** The NPC owning a Rapier collider (combat.js resolves its ray hits through this). */
export function npcForCollider(collider) { return collider ? byCollider.get(collider.handle) ?? null : null }

/** Is a world-space hit point on `n` a headshot? */
export function isHeadshot(n, point) { return point.y - n.y > n.height * HEAD_FRACTION }

/**
 * Apply `amount` damage. `from` = where the shot came from (for fleeing).
 * Returns { killed, hp } or null if already dead.
 */
export function damage(n, amount, { head = false, from = null } = {}) {
    if (n.state === 'dead') return null
    n.hp -= amount
    api.sound?.('hit', n.root.position, { volume: 0.9, rateJitter: 0.08 })
    if (n.hp <= 0) {
        kill(n, { head, from })
        return { killed: true, hp: 0 }
    }
    // Mixamo's hit reaction ducks into a crouch: the start of it, a little quick, then carry on
    const a = n.actions[CLIP.hit]
    if (n.current === CLIP.hit) a.reset().play()                   // a second hit replays the flinch
    a.timeScale = HIT_RATE
    n.hurtT = HIT_TIME
    if (n.hostile) n.provoked = true
    else if (from) scare(n, from)
    return { killed: false, hp: n.hp }
}

function kill(n, info) {
    n.state = 'dead'
    n.hp = 0
    n.hurtT = 0
    n.deadT = 0
    n.fallSoundAt = FALL_AT
    n.col.setEnabled(false)
    play(n, CLIP.death, 0.12)
    api.onKill?.(n, info)
}

/** Townsfolk: walkers sprint along their route away from `threat`; posts crouch. */
function scare(n, threat) {
    if (n.hostile || n.state === 'dead') return
    n.fleeT = FLEE_TIME
    n.threat = { x: threat.x, z: threat.z }
    if (isPost(n)) { n.state = 'cower'; return }
    if (n.state === 'cower') return                           // already cornered
    n.state = 'flee'
    // run for whichever of the two waypoints around us is farther from the threat
    const pts = n.route.points
    const d2 = (q) => (q.x - threat.x) ** 2 + (q.z - threat.z) ** 2
    const back = neighbour(n, -n.dir)
    if (back != null && d2(pts[back]) > d2(pts[n.i])) { n.i = back; n.dir = -n.dir }
}

/** A shot was fired at `pos`: townsfolk within earshot scatter; bandits come looking. */
export function onGunshot(pos) {
    for (const n of npcs) {
        if (n.state === 'dead') continue
        const d = Math.hypot(n.pos.x - pos.x, n.pos.z - pos.z)
        if (n.hostile) { if (d < BANDIT.hearRadius) n.provoked = true }
        else if (d < HEAR_RADIUS) scare(n, pos)
    }
}

/** Dead bodies: the fall thud, linger, fade out, and (townsfolk) respawn out of sight. */
function updateDead(n, dt, player) {
    n.deadT += dt
    if (n.fallSoundAt && n.deadT >= n.fallSoundAt) {
        n.fallSoundAt = 0
        api.sound?.('bodyfall', n.root.position, { volume: 0.8, rateJitter: 0.06 })
    }
    const linger = n.hostile ? DEAD_LINGER_BANDIT : DEAD_LINGER
    if (!n.hidden && n.deadT > linger) {
        if (!n.fadeMaterial) {
            n.fadeMaterial = n.sharedMaterial.clone()
            n.fadeMaterial.transparent = true
        }
        n.mesh.material = n.fadeMaterial
        const k = 1 - (n.deadT - linger) / FADE_TIME
        n.fadeMaterial.opacity = Math.max(0, k)
        if (k <= 0) { n.hidden = true; n.root.visible = false }
    }
    if (!n.hidden || n.deadT < (n.hostile ? RESPAWN_BANDIT : RESPAWN_DELAY)) return
    // back where they start their route (a bandit camp restocks the same way) — but never
    // where the player could watch them appear
    const s = n.route.points[n.def.at ?? 0]
    if (Math.hypot(player.x - s.x, player.z - s.z) > RESPAWN_CLEAR && !onScreen(s.x, n.groundY + 0.45, s.z)) place(n)
}

const _frustum = new THREE.Frustum(), _pv = new THREE.Matrix4(), _sphere = new THREE.Sphere()
/** Is a person-sized sphere at (x, y, z) inside the camera's view? */
function onScreen(x, y, z) {
    const cam = api.camera
    cam.updateMatrixWorld()
    _pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    _frustum.setFromProjectionMatrix(_pv)
    return _frustum.intersectsSphere(_sphere.set(_sphere.center.set(x, y, z), 0.6))
}

/** An NPC by its roster name (the gunsmith, tests). */
export function npcByName(name) { return npcs.find(n => n.def.name === name) ?? null }

/**
 * The nearest living NPC within `reach` of `pos` and inside the cone `cosMax` around the
 * horizontal direction `dir` (a punch). Measured to the NPC's near side (its capsule radius).
 */
export function nearestInFront(pos, dir, reach, cosMax) {
    let best = null, bd = Infinity
    for (const n of npcs) {
        if (n.state === 'dead' || n.hidden) continue
        const dx = n.pos.x - pos.x, dz = n.pos.z - pos.z
        const d = Math.hypot(dx, dz)
        if (d - CAPSULE.r > reach || d > bd) continue
        if (d > 1e-3 && (dx * dir.x + dz * dir.z) / d < cosMax) continue
        best = n; bd = d
    }
    return best
}

function sync(n) {
    n.root.position.set(n.pos.x, n.y, n.pos.z)
    n.root.rotation.set(0, n.yaw, 0)
    n.rb.setNextKinematicTranslation({ x: n.pos.x, y: n.y, z: n.pos.z })
}

export function updateNpcs(dt) {
    if (!npcs.length) return
    aiAcc += dt
    const aiDt = aiAcc >= 1 / AI_HZ ? aiAcc : 0
    if (aiDt) aiAcc = 0
    const player = api.getPlayerPos()
    const cam = api.camera.position

    for (const n of npcs) {
        if (n.state === 'dead') updateDead(n, dt, player)
        if (aiDt) think(n, aiDt, player)
        move(n, dt, player)
        sync(n)

        const d = cam.distanceTo(n.root.position)
        n.root.visible = !n.hidden && d < CULL_DIST
        n.animAcc = Math.min(n.animAcc + dt, 0.5)
        if (!n.root.visible) continue
        if (d > LOD_DIST && (++n.lodTick % 3)) continue
        n.mixer.update(n.animAcc)
        n.animAcc = 0
    }
}

// ─────────────────────────────────────────
// DEBUG — used by the headless checks (import('/game/npc.js').debug)
// ─────────────────────────────────────────
export const debug = {
    player: () => { const p = api.getPlayerPos(); return { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) } },
    list: () => npcs.map(n => ({
        name: n.def.name, state: n.state, anim: n.current, i: n.i, hp: n.hp, ...(n.hostile ? { rounds: n.rounds } : {}),
        x: +n.pos.x.toFixed(2), y: +n.y.toFixed(3), z: +n.pos.z.toFixed(2),
        yaw: +n.yaw.toFixed(2), visible: n.root.visible,
    })),
    groundAt: (x, z, fromY = 50) => groundAt(x, z, fromY),
    /** Scene objects whose name matches `pattern` (a regex source), with world positions. */
    findObjects(pattern, limit = 40) {
        const re = new RegExp(pattern, 'i'), out = [], p = new THREE.Vector3()
        api.scene.traverse(o => {
            if (out.length >= limit || !re.test(o.name)) return
            o.getWorldPosition(p)
            const b = o.isMesh ? new THREE.Box3().setFromObject(o) : null
            out.push({ name: o.name, type: o.type, pos: p.toArray().map(v => +v.toFixed(2)),
                       box: b && [b.min.toArray().map(v => +v.toFixed(1)), b.max.toArray().map(v => +v.toFixed(1))] })
        })
        return out
    },
    /** Can NPC `name` see the player right now (the bandits' eye-to-chest ray)? */
    los(name) {
        const n = npcs.find(n => n.def.name === name), p = api.getPlayerPos()
        return { los: hasLOS(n, p, Math.hypot(p.x - n.pos.x, p.z - n.pos.z)), eyeY: +(n.y + 0.8).toFixed(2), chestY: +(p.y + 0.15).toFixed(2) }
    },
    /**
     * Run the NPC logic for `seconds` of game time in `dt` steps without rendering; returns
     * each NPC's track sampled every `every` seconds, plus the largest per-step y change.
     */
    simulate(seconds, dt = 1 / 30, every = 2) {
        const tracks = npcs.map(() => [])
        const maxDy = npcs.map(() => 0)
        let t = 0, next = 0
        while (t < seconds) {
            const ys = npcs.map(n => n.y)
            updateNpcs(dt)
            npcs.forEach((n, k) => { maxDy[k] = Math.max(maxDy[k], Math.abs(n.y - ys[k])) })
            t += dt
            if (t >= next) {
                npcs.forEach((n, k) => tracks[k].push([+n.pos.x.toFixed(2), +n.y.toFixed(2), +n.pos.z.toFixed(2), n.state[0]]))
                next += every
            }
        }
        return npcs.map((n, k) => ({ name: n.def.name, maxDy: +maxDy[k].toFixed(3), track: tracks[k] }))
    },
    /** Top-surface heights over a grid (row-major, z rows × x columns), null = no hit. */
    heightGrid(x0, z0, x1, z1, step, fromY = 50) {
        const rows = []
        for (let z = z0; z <= z1 + 1e-6; z += step) {
            const row = []
            for (let x = x0; x <= x1 + 1e-6; x += step) {
                const g = groundAt(x, z, fromY)
                row.push(g == null ? null : +g.toFixed(2))
            }
            rows.push(row)
        }
        return rows
    },
    /**
     * Walk a route's segments like an NPC would, every 0.1 u: the ground (largest rise/drop
     * between samples), and short forward rays at knee (0.25) and chest (0.6) height above
     * the LOCAL ground, so terrain slope doesn't read as a wall. Also sweeps the same rays
     * `halfWidth` to each side (an NPC is ~0.3 u wide). Reports where anything was hit.
     */
    validateRoute(name, { halfWidth = 0.15 } = {}) {
        const r = typeof name === 'string' ? ROUTES[name] : name          // or a candidate route object
        const pts = r.loop ? [...r.points, r.points[0]] : r.points
        const segs = []
        for (let k = 0; k + 1 < pts.length; k++) {
            const a = pts[k], b = pts[k + 1]
            const len = Math.hypot(b.x - a.x, b.z - a.z)
            const dx = (b.x - a.x) / len, dz = (b.z - a.z) / len
            let y = groundAt(a.x, a.z, (r.y ?? -22) + 1.5, 4)
            let maxStep = 0, lost = 0
            const hits = []
            for (let s = 0; s <= len; s += 0.1) {
                const cx = a.x + dx * s, cz = a.z + dz * s
                const g = groundAt(cx, cz, y + RAY_UP, RAY_LEN)
                if (g == null) { lost++; continue }
                maxStep = Math.max(maxStep, Math.abs(g - y))
                y = g
                for (const side of [-halfWidth, 0, halfWidth]) for (const h of [0.25, 0.6]) {
                    const t = wallAhead(cx - dz * side, g + h, cz + dx * side, dx, dz, 0.12)
                    if (t != null && hits.length < 6) hits.push(`${(cx + dx * t).toFixed(1)},${(cz + dz * t).toFixed(1)}@${h}`)
                }
            }
            segs.push({ from: k, len: +len.toFixed(1), maxStep: +maxStep.toFixed(3), lost, hits })
        }
        return segs
    },
}
