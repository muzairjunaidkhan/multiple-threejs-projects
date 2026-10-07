/**
 * ═══════════════════════════════════════════════════════════
 * audio.js — sound effects (3D positional + 2D)
 * ───────────────────────────────────────────────────────────
 * One THREE.AudioListener rides the camera; world events play through a
 * pool of PositionalAudio voices parented to the scene, so a door across
 * the street is quieter and off to one side. Footsteps, UI and money are
 * flat 2D — they have no world position worth panning.
 *
 * Samples are CC0 recordings (see static/sounds/README.txt): Kenney packs for
 * doors, steps and impacts; real firearms, gun handling and horses for the
 * rest. The piano and Dead Eye's cues have no sample: they are synthesised
 * once into AudioBuffers and played through the same voice pools.
 *
 * Design notes that are easy to get wrong:
 *  · NO AudioContext is created at import time — `settings` is a plain
 *    object so lil-gui (built at module scope, before bootShell) can bind
 *    to it before initAudio() has ever run.
 *  · The context starts suspended; the first real gesture resumes it.
 *  · A missing/undecodable file is a silent no-op, never an exception.
 * ═══════════════════════════════════════════════════════════
 */

import * as THREE from 'three'

// ─────────────────────────────────────────
// SETTINGS — bound directly by the lil-gui "Audio" folder.
// Module scope + localStorage only: no WebAudio here, because this object
// must exist before initAudio() is called.
// ─────────────────────────────────────────
const STORE_KEY = 'deadmesa.audio.v1'

/** Selectable footstep surfaces — each maps to the `step_<set>` manifest entry. */
export const FOOTSTEP_SETS = ['dirt', 'gravel', 'wood', 'soft']

export const settings = {
    master:         0.7,
    mute:           false,
    footstepVolume: 0.35,      // its own slider: footsteps are the most-repeated sound
    footstepSet:    'dirt',
}

try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY))
    if (raw && typeof raw === 'object') {
        if (Number.isFinite(raw.master)) settings.master = THREE.MathUtils.clamp(raw.master, 0, 1)
        if (typeof raw.mute === 'boolean') settings.mute = raw.mute
        if (Number.isFinite(raw.footstepVolume)) settings.footstepVolume = THREE.MathUtils.clamp(raw.footstepVolume, 0, 1)
        if (FOOTSTEP_SETS.includes(raw.footstepSet)) settings.footstepSet = raw.footstepSet
    }
} catch { /* private mode — defaults are fine */ }

// ─────────────────────────────────────────
// MANIFEST — logical name → file in static/sounds (served at /sounds/…).
// Arrays are variant sets: one is picked at random per play.
// Renaming a file without updating this table silently kills that sound.
// ─────────────────────────────────────────
const MANIFEST = {
    door_open:   ['door_open_1.ogg', 'door_open_2.ogg'],
    door_close:  ['door_close_1.ogg', 'door_close_2.ogg'],
    door_heavy:  ['door_heavy.ogg'],
    creak:       ['creak_1.ogg', 'creak_2.ogg'],
    latch_click: ['latch_click.ogg'],
    latch_heavy: ['latch_heavy.ogg'],
    case_open:   ['case_open.ogg'],
    case_close:  ['case_close.ogg'],
    board_open:  ['board_open.ogg'],
    board_close: ['board_close.ogg'],
    swing:       ['swing_1.ogg', 'swing_2.ogg'],
    land_hard:   ['land_hard.ogg'],
    // Footstep surfaces (Kenney Impact Sounds). Played via playFootstep(), which
    // picks the active set and loudness-normalises it — see FOOTSTEP_TARGET_DB.
    step_dirt:   ['step_dirt_1.ogg', 'step_dirt_2.ogg', 'step_dirt_3.ogg',
                  'step_dirt_4.ogg', 'step_dirt_5.ogg'],
    step_gravel: ['step_gravel_1.ogg', 'step_gravel_2.ogg', 'step_gravel_3.ogg',
                  'step_gravel_4.ogg', 'step_gravel_5.ogg'],
    step_wood:   ['step_wood_1.ogg', 'step_wood_2.ogg', 'step_wood_3.ogg',
                  'step_wood_4.ogg', 'step_wood_5.ogg'],
    step_soft:   ['step_soft_1.ogg', 'step_soft_2.ogg', 'step_soft_3.ogg',
                  'step_soft_4.ogg', 'step_soft_5.ogg'],
    money_gain:  ['money_gain.ogg'],
    money_loss:  ['money_loss.ogg'],
    // Gunfire: real recordings (The Free Firearm Sound Library, CC0), cut at the shot with its
    // own echo. The player hears near-distance recordings; a bandit's shot is the same guns
    // recorded from mid distance, played positionally.
    gunshot_revolver: ['gun_revolver_1.ogg', 'gun_revolver_2.ogg'],
    gunshot_shotgun:  ['gun_shotgun_1.ogg', 'gun_shotgun_2.ogg'],
    gunshot_rifle:    ['gun_rifle_1.ogg', 'gun_rifle_2.ogg', 'gun_rifle_3.ogg'],
    gunshot:          ['gun_far_1.ogg', 'gun_far_2.ogg'],
    // Working the guns: recordings of a real bolt action, cartridges and a shotgun (OpenGameArt
    // CC0), assembled to combat.js's reload timings
    dry_fire:     ['dry_fire.ogg'],
    reload:       ['reload_revolver.ogg'],      // gate, six cartridges, gate, hammer — 1.6 s
    reload_break: ['reload_break.ogg'],         // latch, open, two rounds, shut — 1.3 s
    reload_tube:  ['shell_insert.ogg'],         // one round into a tube (played per round)
    cycle_pump:   ['cycle_pump.ogg'],
    cycle_lever:  ['cycle_lever.ogg'],
    cycle_bolt:   ['cycle_bolt.ogg'],
    // Horses (OpenGameArt "Horse gallop on different surfaces", the CC0 recordings)
    hoof:         ['hoof_1.ogg', 'hoof_2.ogg'],      // single clops: a walk
    gallop:       ['gallop_1.ogg', 'gallop_2.ogg'],  // one whole stride: played once per gallop cycle
    // Impacts (Kenney Impact Sounds)
    hit:         ['hit_1.ogg', 'hit_2.ogg', 'hit_3.ogg'],           // a bullet finds a body
    bodyfall:    ['bodyfall_1.ogg', 'bodyfall_2.ogg'],
    bullet:      ['bullet_1.ogg', 'bullet_2.ogg', 'bullet_3.ogg'],  // a bullet finds wood / dirt
    ui_move:     ['ui_move.ogg'],
    ui_select:   ['ui_select.ogg'],
    ui_back:     ['ui_back.ogg'],
    ui_pause:    ['ui_pause.ogg'],
}

const SOUND_DIR = '/sounds/'

// ─────────────────────────────────────────
// PANNER — tuned to this world's scale.
// A person is 0.96 units tall, buildings ~6.4, the main street ~5 wide and
// the town ~40 across. The listener sits on the camera, ~1.5 behind the
// player, so a door you just opened is 1.5-3 units away.
//   1u → 1.00   2u → 0.50   5u → 0.20   20u → 0.05   (inverse model)
// ─────────────────────────────────────────
const PANNER = {
    distanceModel: 'inverse',
    refDistance:   1.0,
    rolloffFactor: 1.0,
    maxDistance:   30,
}

const WORLD_VOICES = 12   // realistic concurrency is 1-3; headroom for layered cues
const UI_VOICES    = 6

// ─────────────────────────────────────────
// FOOTSTEP LOUDNESS
//
// Kenney normalises every file to ~-1 dBFS PEAK, so peak says nothing about how
// loud a sound feels — the previous footsteps averaged -11 dBFS "active" RMS at
// unity gain and were then played at 0.45-0.80, i.e. about as loud as a door.
// Instead each footstep buffer is scaled at decode time to the same active RMS,
// so every surface set sits at one level and the slider means the same thing
// whichever set is chosen.
//
// -18 dBFS at unity; with the default slider (0.35) and master (0.7) that lands
// a walking step near -34 dBFS and a running step near -30 dBFS — roughly 12 dB
// and 14 dB below what shipped. Measured, not guessed (see the session notes).
// ─────────────────────────────────────────
const FOOTSTEP_TARGET_DB = -18
const FOOTSTEP_TARGET    = Math.pow(10, FOOTSTEP_TARGET_DB / 20)

/** RMS over only the samples above 10% of peak, so silent padding and long
 *  quiet tails don't flatter a short transient like a footfall. */
function activeRms(buf) {
    const d = buf.getChannelData(0)
    let peak = 0
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a }
    const gate = peak * 0.1
    let sum = 0, n = 0
    for (let i = 0; i < d.length; i++) { if (Math.abs(d[i]) > gate) { sum += d[i] * d[i]; n++ } }
    return n ? Math.sqrt(sum / n) : 0
}

function normaliseFootstep(buf) {
    const rms = activeRms(buf)
    buf._norm = rms > 0 ? THREE.MathUtils.clamp(FOOTSTEP_TARGET / rms, 0.15, 4) : 1
}

// ─────────────────────────────────────────
// STATE
// ─────────────────────────────────────────
let _listener = null
let _ctx      = null
let _scene    = null
let _inited   = false
let _unlock   = null
let _tick     = 0          // monotonic counter for steal-oldest

const _buffers = new Map()      // name → AudioBuffer[]
const _world   = []             // THREE.PositionalAudio
const _ui      = []             // THREE.Audio
const _loaded  = []
const _failed  = []
const _counts  = new Map()      // name → times played; test surface only

let _resolveReady = null
/** Resolves once every buffer has either loaded or failed. Never rejects. */
export const ready = new Promise((res) => { _resolveReady = res })

// ─────────────────────────────────────────
// SETTINGS PLUMBING
// ─────────────────────────────────────────
export function applySettings() {
    settings.master         = THREE.MathUtils.clamp(Number(settings.master) || 0, 0, 1)
    settings.footstepVolume = THREE.MathUtils.clamp(Number(settings.footstepVolume) || 0, 0, 1)
    if (!FOOTSTEP_SETS.includes(settings.footstepSet)) settings.footstepSet = 'dirt'
    if (_listener) _listener.setMasterVolume(settings.mute ? 0 : settings.master)
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)) } catch { /* ignore */ }
}

// ─────────────────────────────────────────
// INIT
// ─────────────────────────────────────────
/**
 * @param {THREE.Camera} camera  the listener rides this
 * @param {THREE.Scene}  scene   positional voices are parented here
 */
export function initAudio(camera, scene) {
    if (_inited) return
    _inited = true

    _listener = new THREE.AudioListener()    // this is what creates the AudioContext
    _ctx      = _listener.context
    _scene    = scene

    // The camera is NOT in the scene graph, but the renderer calls
    // camera.updateMatrixWorld() every frame (parent === null), which recurses
    // into this listener and pushes the WebAudio listener pose.
    camera.add(_listener)

    for (let i = 0; i < WORLD_VOICES; i++) {
        const v = new THREE.PositionalAudio(_listener)
        v.setDistanceModel(PANNER.distanceModel)
        v.setRefDistance(PANNER.refDistance)
        v.setRolloffFactor(PANNER.rolloffFactor)
        v.setMaxDistance(PANNER.maxDistance)
        v._startedTick = -1
        scene.add(v)                          // NOT the emitting mesh: doors rotate
        _world.push(v)
    }
    for (let i = 0; i < UI_VOICES; i++) {
        const v = new THREE.Audio(_listener)
        v._startedTick = -1
        _ui.push(v)
    }

    applySettings()
    armUnlock()
    preloadAll()
    renderSynthSounds().catch(err => console.warn('[audio] synth failed', err))
}

/**
 * Browsers start the context suspended until a real gesture. Listen in the
 * CAPTURE phase on window so we run before menu.js / script.js handlers —
 * one of those calls stopImmediatePropagation() on some keys.
 */
function armUnlock() {
    if (_unlock) return
    _unlock = () => {
        if (!_ctx) return
        if (_ctx.state === 'running') return disarmUnlock()
        _ctx.resume().then(() => { if (_ctx.state === 'running') disarmUnlock() }).catch(() => {})
    }
    for (const ev of ['pointerdown', 'mousedown', 'keydown', 'touchstart']) {
        window.addEventListener(ev, _unlock, { capture: true, passive: true })
    }
}

function disarmUnlock() {
    if (!_unlock) return
    for (const ev of ['pointerdown', 'mousedown', 'keydown', 'touchstart']) {
        window.removeEventListener(ev, _unlock, { capture: true })
    }
    _unlock = null
}

function preloadAll() {
    const loader = new THREE.AudioLoader()
    const jobs = []

    for (const [name, files] of Object.entries(MANIFEST)) {
        const bufs = []
        _buffers.set(name, bufs)
        files.forEach((file, i) => {
            jobs.push(new Promise((res) => {
                loader.load(
                    SOUND_DIR + file,
                    (buf) => {
                        if (name.startsWith('step_')) normaliseFootstep(buf)
                        bufs[i] = buf; _loaded.push(file); res()
                    },
                    undefined,
                    // AudioLoader routes here instead of throwing. A missing or
                    // undecodable file just never registers, and every play call
                    // for it becomes a no-op — the game stays silent, not broken.
                    () => { _failed.push(file); res() },
                )
            }))
        })
    }

    Promise.all(jobs).then(() => {
        for (const [name, bufs] of _buffers) {
            const live = bufs.filter(Boolean)
            if (live.length) _buffers.set(name, live)
            else _buffers.delete(name)
        }
        if (_failed.length) console.warn(`[audio] ${_failed.length} file(s) failed:`, _failed)
        console.log(`[audio] ready — ${_loaded.length} file(s), ${_buffers.size} sounds`)
        _resolveReady({ loaded: _loaded, failed: _failed })
    })
}

// ─────────────────────────────────────────
// VOICE POOL
// ─────────────────────────────────────────
/** Free voice if there is one, else steal the oldest — a dropped cue is worse than a clipped tail. */
function takeVoice(pool) {
    let oldest = pool[0]
    for (const v of pool) {
        if (!v.isPlaying) return v
        if (v._startedTick < oldest._startedTick) oldest = v
    }
    oldest.stop()      // safe to re-play afterwards; never use pause() (it keeps _progress)
    return oldest
}

const _pos = new THREE.Vector3()

/**
 * PositionalAudio.updateMatrixWorld early-returns while !isPlaying, so at
 * play() time the panner still holds the PREVIOUS shot's coordinates and then
 * ramps across a frame — the sound audibly slides in from wherever the last
 * one was. Hard-set the panner params instead.
 */
function placeVoice(voice, target) {
    if (target.isVector3) _pos.copy(target)
    else target.getWorldPosition(_pos)          // meshes are nested under cityModel (scale 0.5)

    voice.position.copy(_pos)
    voice.updateMatrix()

    const p = voice.panner
    const t = _ctx.currentTime
    if (p.positionX) {
        p.positionX.cancelScheduledValues(t); p.positionX.setValueAtTime(_pos.x, t)
        p.positionY.cancelScheduledValues(t); p.positionY.setValueAtTime(_pos.y, t)
        p.positionZ.cancelScheduledValues(t); p.positionZ.setValueAtTime(_pos.z, t)
    } else {
        p.setPosition(_pos.x, _pos.y, _pos.z)   // legacy Safari path
    }
}

/** setVolume() glides over ~20ms from the last shot's level, which eats transients. */
function setVoiceGain(voice, v) {
    const t = _ctx.currentTime
    voice.gain.gain.cancelScheduledValues(t)
    voice.gain.gain.setValueAtTime(v, t)
}

function pickBuffer(name) {
    const bufs = _buffers.get(name)
    if (!bufs || !bufs.length) return null
    return bufs.length === 1 ? bufs[0] : bufs[(Math.random() * bufs.length) | 0]
}

function startVoice(voice, buf, opts, name) {
    if (name) _counts.set(name, (_counts.get(name) ?? 0) + 1)
    const { volume = 1, rate = 1, rateJitter = 0, normalize = false } = opts
    voice.stop()
    voice.setBuffer(buf)
    voice.setLoop(false)
    setVoiceGain(voice, volume * (normalize ? (buf._norm ?? 1) : 1))
    // A touch of detune so repeats (footsteps especially) never sound identical.
    const r = rate * (1 + (Math.random() * 2 - 1) * rateJitter)
    voice.playbackRate = r
    voice._startedTick = ++_tick
    voice.play()
    // play() applies the rate via setTargetAtTime, i.e. a ~10ms glide up from
    // 1.0 on the fresh source. Pin it so a one-shot starts at its pitch.
    if (voice.source) {
        voice.source.playbackRate.cancelScheduledValues(_ctx.currentTime)
        voice.source.playbackRate.setValueAtTime(r, _ctx.currentTime)
    }
}

// ─────────────────────────────────────────
// PLAYBACK
// ─────────────────────────────────────────
const canPlay = () => _inited && _ctx && _ctx.state === 'running' && !settings.mute

/** Flat, non-positional. For the player's own body, the HUD and the menu. */
export function play2D(name, opts = {}) {
    if (!canPlay()) return
    const buf = pickBuffer(name)
    if (!buf) return
    startVoice(takeVoice(_ui), buf, opts, name)
}

export function playUI(name, opts = {}) { play2D(name, opts) }

/**
 * One footfall on the currently selected surface. `volume` is RELATIVE (walk
 * vs run); the Footsteps slider scales it, and the buffer's own loudness is
 * normalised at decode time — so callers never have to know how hot a sample is.
 */
export function playFootstep(opts = {}) {
    if (!canPlay()) return
    const vol = (opts.volume ?? 1) * settings.footstepVolume
    if (vol < 0.002) return                       // slider at zero → truly silent
    const name = `step_${settings.footstepSet}`
    const buf  = pickBuffer(name) ?? pickBuffer('step_dirt')
    if (!buf) return
    // Counted under one name so tests don't have to know which surface is active.
    startVoice(takeVoice(_ui), buf, { ...opts, volume: vol, normalize: true }, 'footstep')
}

/** Positional. `target` is an Object3D (world position is read) or a Vector3. */
export function playAt(target, name, opts = {}) {
    if (!canPlay() || !target) return
    const buf = pickBuffer(name)
    if (!buf) return
    const voice = takeVoice(_world)
    placeVoice(voice, target)
    startVoice(voice, buf, opts, name)
}

/** Silence every world voice — used when leaving PLAYING. */
export function stopWorld() {
    for (const v of _world) if (v.isPlaying) v.stop()
}

// ─────────────────────────────────────────
// PIANO — synthesised, not sampled.
//
// Rendered once through an OfflineAudioContext into an AudioBuffer, then
// played through the normal positional pool, so it gets panning, distance
// falloff, voice stealing and master volume for free.
// ─────────────────────────────────────────
const PIANO_BPM      = 148
const PIANO_BEAT     = 60 / PIANO_BPM
const PIANO_DURATION = 3.2
const PIANO_PHRASES  = [
    // [midi, beat, beats-long] over a C major pentatonic — no wrong notes possible
    [[67, 0, 1], [69, 1, 1], [72, 2, 1], [69, 3, 0.5], [67, 3.5, 1.5]],
    [[72, 0, 0.75], [71, 0.75, 0.25], [69, 1, 1], [67, 2, 1], [64, 3, 1.5]],
    [[64, 0, 0.5], [67, 0.5, 0.5], [72, 1, 1], [69, 2, 0.5], [67, 2.5, 0.5], [64, 3, 1]],
]
const PIANO_BASS  = [36, null, 43, null]                        // oompah: root on 1 and 3
const PIANO_CHORD = [null, [60, 64, 67], null, [60, 64, 67]]    // stab on 2 and 4

let _pianoReady = null

const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12)

/**
 * One struck string. Triangle fundamental + a second triangle detuned +9
 * cents (that beating IS the honky-tonk sound) + a quiet octave sine, run
 * through a lowpass that sweeps down as the string damps, plus a short
 * bandpassed square "hammer knock" for the wooden attack.
 */
function pianoNote(oac, midi, when, dur, vel) {
    const f   = midiToHz(midi)
    const out = oac.createGain()

    const tone = oac.createBiquadFilter()
    tone.type = 'lowpass'
    tone.Q.value = 0.7
    tone.frequency.setValueAtTime(Math.min(6000, f * 9), when)
    tone.frequency.exponentialRampToValueAtTime(Math.max(600, f * 2.2), when + dur * 0.8)
    tone.connect(out)

    for (const p of [
        { type: 'triangle', detune:  0, mul: 1, g: 1.00 },
        { type: 'triangle', detune:  9, mul: 1, g: 0.55 },
        { type: 'sine',     detune: -4, mul: 2, g: 0.22 },
    ]) {
        const o = oac.createOscillator()
        o.type = p.type
        o.frequency.value = f * p.mul
        o.detune.value = p.detune
        const g = oac.createGain()
        g.gain.value = p.g
        o.connect(g); g.connect(tone)
        o.start(when); o.stop(when + dur + 0.05)
    }

    const k = oac.createOscillator()
    k.type = 'square'
    k.frequency.value = f * 3
    const kb = oac.createBiquadFilter()
    kb.type = 'bandpass'
    kb.frequency.value = f * 4
    kb.Q.value = 2
    const kg = oac.createGain()
    kg.gain.setValueAtTime(0.18 * vel, when)
    kg.gain.exponentialRampToValueAtTime(0.0001, when + 0.018)
    k.connect(kb); kb.connect(kg); kg.connect(out)
    k.start(when); k.stop(when + 0.03)

    // A struck string has no sustain plateau: attack straight into decay.
    // exponentialRampToValueAtTime cannot target 0 — 0.0001 is the floor.
    out.gain.setValueAtTime(0.0001, when)
    out.gain.exponentialRampToValueAtTime(0.34 * vel, when + 0.004)
    out.gain.exponentialRampToValueAtTime(0.0001, when + dur)
    return out
}

async function renderPhrase(index) {
    const rate = _ctx.sampleRate
    // Mono: a PannerNode upmixes anyway, and it halves the cached PCM.
    const oac = new OfflineAudioContext(1, Math.ceil(rate * PIANO_DURATION), rate)

    const master = oac.createGain()
    master.gain.value = 0.9
    master.connect(oac.destination)

    // Slapback instead of a convolver — four nodes for "big wooden room".
    const delay = oac.createDelay(0.2)
    delay.delayTime.value = 0.055
    const fb = oac.createGain(); fb.gain.value = 0.18
    const damp = oac.createBiquadFilter(); damp.type = 'lowpass'; damp.frequency.value = 2200
    const wet = oac.createGain(); wet.gain.value = 0.2
    delay.connect(damp); damp.connect(fb); fb.connect(delay); damp.connect(wet)
    wet.connect(oac.destination)

    const jitter = () => (Math.random() * 2 - 1) * 0.012        // ±12ms
    const vel    = () => 1 + (Math.random() * 2 - 1) * 0.15     // ±15%
    const decay  = (m) => Math.max(0.6, 2.0 - (m - 48) * 0.022)

    const add = (midi, beat, beats, v) => {
        const when = Math.max(0, beat * PIANO_BEAT + jitter())
        const n = pianoNote(oac, midi, when, Math.min(decay(midi), beats * PIANO_BEAT + 0.9), v * vel())
        n.connect(master); n.connect(delay)
    }

    for (const [midi, beat, beats] of PIANO_PHRASES[index]) add(midi, beat, beats, 1.0)
    PIANO_BASS.forEach((m, b) => { if (m !== null) add(m, b, 1, 0.85) })
    PIANO_CHORD.forEach((ch, b) => { if (ch) for (const m of ch) add(m, b, 0.5, 0.42) })

    return oac.startRendering()
}

async function renderAllPhrases() {
    for (let i = 0; i < PIANO_PHRASES.length; i++) {
        _buffers.set(`piano_${i}`, [await renderPhrase(i)])
    }
}

/** Play a random saloon phrase at `target`. Renders on first use, then cached. */
export function playPianoAt(target) {
    if (!canPlay() || !target) return
    if (!_pianoReady) {
        _pianoReady = renderAllPhrases().catch((err) => {
            console.warn('[audio] piano render failed', err)
            _pianoReady = null
        })
    }
    _pianoReady.then(() => {
        const n = (Math.random() * PIANO_PHRASES.length) | 0
        playAt(target, `piano_${n}`, { volume: 0.9, rateJitter: 0.01 })
    })
}

// ─────────────────────────────────────────
// SYNTHESISED — the few sounds with no recording: Dead Eye's heartbeat, whooshes and
// mark click (and the piano, above). Guns and horses are recordings (MANIFEST).
// ─────────────────────────────────────────
function noiseBuffer(oac, seconds) {
    const b = oac.createBuffer(1, Math.ceil(oac.sampleRate * seconds), oac.sampleRate)
    const d = b.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
    return b
}

/** Noise through a filter with an attack-decay envelope, into `dest`. */
function noiseHit(oac, noise, dest, when, { type, freq, q = 0.7, gain, attack = 0.001, decay }) {
    const src = oac.createBufferSource()
    src.buffer = noise
    const f = oac.createBiquadFilter()
    f.type = type; f.frequency.value = freq; f.Q.value = q
    const g = oac.createGain()
    g.gain.setValueAtTime(0.0001, when)
    g.gain.exponentialRampToValueAtTime(gain, when + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay)
    src.connect(f); f.connect(g); g.connect(dest)
    src.start(when, Math.random() * 0.5); src.stop(when + attack + decay + 0.02)
}

/** Metallic clicks at `times` (s): short bandpassed noise ticks with a faint ring. */
async function renderClicks(len, times, { freq = 3200, gain = 0.6 } = {}) {
    const rate = _ctx.sampleRate
    const oac = new OfflineAudioContext(1, Math.ceil(rate * len), rate)
    const noise = noiseBuffer(oac, 0.2)
    for (const [t, f, g] of times) {
        noiseHit(oac, noise, oac.destination, t, { type: 'bandpass', freq: (f ?? 1) * freq, q: 3, gain: (g ?? 1) * gain, decay: 0.012 })
        noiseHit(oac, noise, oac.destination, t + 0.004, { type: 'bandpass', freq: (f ?? 1) * freq * 0.62, q: 8, gain: (g ?? 1) * gain * 0.35, decay: 0.05 })
    }
    return oac.startRendering()
}

/** Low double thump ("lub-dub") for Dead Eye. */
async function renderHeartbeat() {
    const rate = _ctx.sampleRate
    const oac = new OfflineAudioContext(1, Math.ceil(rate * 0.5), rate)
    for (const [t, g] of [[0.01, 0.9], [0.17, 0.6]]) {
        const o = oac.createOscillator()
        o.type = 'sine'
        o.frequency.setValueAtTime(62, t)
        o.frequency.exponentialRampToValueAtTime(38, t + 0.12)
        const gn = oac.createGain()
        gn.gain.setValueAtTime(0.0001, t)
        gn.gain.exponentialRampToValueAtTime(g, t + 0.012)
        gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
        o.connect(gn); gn.connect(oac.destination)
        o.start(t); o.stop(t + 0.18)
    }
    return oac.startRendering()
}

/** A falling filtered-noise swoosh — the world slowing down (or, reversed, speeding up). */
async function renderWhoosh(down = true) {
    const rate = _ctx.sampleRate, len = 0.7
    const oac = new OfflineAudioContext(1, Math.ceil(rate * len), rate)
    const src = oac.createBufferSource()
    src.buffer = noiseBuffer(oac, len)
    const f = oac.createBiquadFilter()
    f.type = 'bandpass'; f.Q.value = 1.4
    f.frequency.setValueAtTime(down ? 2400 : 300, 0)
    f.frequency.exponentialRampToValueAtTime(down ? 220 : 2600, len * 0.9)
    const g = oac.createGain()
    g.gain.setValueAtTime(0.0001, 0)
    g.gain.exponentialRampToValueAtTime(0.7, 0.08)
    g.gain.exponentialRampToValueAtTime(0.0001, len)
    src.connect(f); f.connect(g); g.connect(oac.destination)
    src.start(0)
    return oac.startRendering()
}

async function renderSynthSounds() {
    _buffers.set('heartbeat', [await renderHeartbeat()])
    _buffers.set('deadeye_in', [await renderWhoosh(true)])
    _buffers.set('deadeye_out', [await renderWhoosh(false)])
    _buffers.set('deadeye_mark', [await renderClicks(0.12, [[0.005, 1.6, 0.8]], { freq: 3000 })])
}

// ─────────────────────────────────────────
// TEST SURFACE — used by the headless verification script.
// ─────────────────────────────────────────
export function getDebugState() {
    return {
        inited:    _inited,
        ctxState:  _ctx ? _ctx.state : 'none',
        loaded:    _loaded.length,
        failed:    _failed.slice(),
        sounds:    [..._buffers.keys()],
        playing:   _world.filter(v => v.isPlaying).length + _ui.filter(v => v.isPlaying).length,
        counts:    Object.fromEntries(_counts),
        // Per-surface decode-time gain, so a test can confirm every set was normalised.
        stepNorms: Object.fromEntries(FOOTSTEP_SETS.map(s =>
            [s, (_buffers.get(`step_${s}`) ?? []).map(b => +(b._norm ?? 0).toFixed(3))])),
        settings:  { ...settings },
    }
}
