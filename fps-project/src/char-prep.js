/**
 * char-prep.js: turns the Mixamo-rigged characters and the Mixamo clips into game assets (dev only).
 *
 * Inputs, served by a local static server (each call takes full URLs):
 *   mixamo-rigged/<id>_mixamo.fbx  bodies rigged by Mixamo's auto-rigger (FBX Binary, T-pose, with skin)
 *   mixamo-anims/<Name>.fbx         Mixamo clips (FBX Binary, without skin)
 *   tex/<id>.jpg                    base colours (the rigged FBX only references its texture by path)
 *
 * Every body shares Mixamo's 65-bone skeleton, so every clip binds to every body BY NAME. A
 * clip keeps rotations everywhere and position on the hips only. The hips track is stored
 * against the clip skeleton's rest hip height, and the game scales it to each body's own.
 *
 * Driven from headless Chrome over CDP: a scratchpad script calls window.__char.
 */

import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

const SIZE = 1000
const canvas  = document.getElementById('canvas')
const overlay = document.getElementById('overlay')
const octx    = overlay.getContext('2d')

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(1)
renderer.setSize(SIZE, SIZE, false)
renderer.setClearColor(0x14161c)

const R = { chars: {}, raw: {}, clips: {}, skel: null, bodyClips: new Map() }
const HIPS = 'mixamorigHips'

/** FBXLoader turns "mixamorig:Hips" into "mixamorigHips"; numbered rigs ("mixamorig1:") become the same. */
const canon = (name) => name.replace(/^mixamorig\d*:?/, 'mixamorig')

function describe(root) {
    const meshes = [], bones = []
    root.traverse(o => {
        if (o.isBone) bones.push(o.name)
        if (!o.isMesh) return
        const mat = Array.isArray(o.material) ? o.material[0] : o.material
        meshes.push({
            name: o.name, skinned: !!o.isSkinnedMesh, verts: o.geometry.attributes.position.count,
            tris: (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3,
            attrs: Object.keys(o.geometry.attributes), groups: o.geometry.groups.length,
            material: mat?.type, map: mat?.map?.image ? `${mat.map.image.width}x${mat.map.image.height}` : null,
            joints: o.skeleton?.bones.length,
        })
    })
    root.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(root, true)
    const hips = root.getObjectByName(HIPS)
    return { bones: bones.length, boneNames: bones.slice(0, 70), meshes,
             min: box.min.toArray().map(v => +v.toFixed(3)), max: box.max.toArray().map(v => +v.toFixed(3)),
             hipsLocal: hips?.position.toArray().map(v => +v.toFixed(3)) }
}

// ─────────────────────────────────────────
// BODIES
// ─────────────────────────────────────────
/**
 * Load a rigged body, give it its texture on a plain PBR material, and stand it `height`
 * metres tall with its feet on y = 0 (the scale goes on the FBX group, so the bones keep
 * Mixamo's own units and the clips' hips tracks stay comparable).
 */
async function loadChar(key, url, texUrl, { height = 1.8, roughness = 0.85 } = {}) {
    const fbx = await new FBXLoader().loadAsync(url)
    fbx.traverse(o => { o.name = canon(o.name) })
    const tex = await new THREE.TextureLoader().loadAsync(texUrl)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.userData.mimeType = 'image/jpeg'
    tex.anisotropy = 4
    fbx.traverse(o => {
        if (!o.isMesh) return
        o.material = new THREE.MeshStandardMaterial({ name: key, map: tex, roughness, metalness: 0 })
        o.frustumCulled = false
        // the FBX comes unindexed (three vertices per triangle); welding identical ones cuts the file ~4×
        o.geometry = mergeVertices(o.geometry)
    })
    fbx.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(fbx, true)
    const srcHeight = box.max.y - box.min.y
    const k = height / srcHeight
    // Feet to y = 0 by moving the HIPS, not the group: some uploads had their origin at
    // mid-body, so the hips sat ~0.1 above their parent, and the clips' hips track (which
    // is scaled by the hips' rest height) would barely move them. Every bone keeps its
    // world matrix, so the skinning is unchanged.
    const hips = fbx.getObjectByName(HIPS)
    hips.position.x -= (box.min.x + box.max.x) / 2
    hips.position.y -= box.min.y
    hips.position.z -= (box.min.z + box.max.z) / 2
    fbx.scale.multiplyScalar(k)
    fbx.position.set(0, 0, 0)
    const root = new THREE.Group()
    root.name = key
    root.add(fbx)
    root.userData.hipsRestY = hips.position.y        // posing moves the bone; the clips scale by this
    R.chars[key] = root
    return { srcHeight: +srcHeight.toFixed(3), scale: +k.toFixed(5), anims: fbx.animations.length, ...describe(root) }
}

/** Load an already-baked GLB (for checking an export round-trips). */
async function loadGlb(key, url) {
    const g = await new GLTFLoader().loadAsync(url)
    R.chars[key] = g.scene
    g.scene.userData.hipsRestY = g.scene.getObjectByName(HIPS)?.position.y
    g.scene.userData.clips = Object.fromEntries(g.animations.map(c => [c.name, c]))
    return describe(g.scene)
}

// ─────────────────────────────────────────
// CLIPS
// ─────────────────────────────────────────
/** Load Mixamo clip files `${base}${name}.fbx`. The first file's skeleton is the reference. */
async function loadClips(base, names) {
    const loader = new FBXLoader()
    const out = {}
    for (const name of names) {
        const fbx = await loader.loadAsync(`${base}${encodeURIComponent(name)}.fbx`)
        fbx.traverse(o => { o.name = canon(o.name) })
        const clip = fbx.animations[0]
        clip.name = name
        for (const t of clip.tracks) t.name = canon(t.name)
        const hips = fbx.getObjectByName(HIPS)
        R.raw[name] = { clip, hipsRest: hips.position.clone() }
        if (!R.skel) R.skel = fbx
        const kinds = {}
        for (const t of clip.tracks) { const p = t.name.split('.').pop(); kinds[p] = (kinds[p] || 0) + 1 }
        const hp = clip.tracks.find(t => t.name === `${HIPS}.position`)
        const v = hp?.values, n = v ? v.length / 3 : 0
        out[name] = {
            dur: +clip.duration.toFixed(2), frames: n, kinds, hipsRest: hips.position.toArray().map(x => +x.toFixed(1)),
            hipsStart: v ? [v[0], v[1], v[2]].map(x => +x.toFixed(1)) : null,
            hipsDrift: v ? [v[(n - 1) * 3] - v[0], v[(n - 1) * 3 + 1] - v[1], v[(n - 1) * 3 + 2] - v[2]].map(x => +x.toFixed(1)) : null,
            hipsYRange: v ? (() => { let lo = 1e9, hi = -1e9; for (let i = 1; i < v.length; i += 3) { lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]) } return [+lo.toFixed(1), +hi.toFixed(1)] })() : null,
        }
    }
    return out
}

/**
 * The game's version of a clip: rotations + the hips position, which is scaled from the
 * clip's own source skeleton onto the reference one and started at the rest x/z.
 *   xz: 'keep'    the hips' horizontal motion stays (a fall, a stagger)
 *       'detrend' the straight-line drift from the first frame to the last comes out, so a
 *                 walk keeps its sway but goes nowhere (the physics capsule travels instead)
 *       'pin'     no horizontal hips motion at all (a roll or a jump the capsule carries)
 *   flatUp: the hips never rise above their first frame (a jump whose height the physics gives)
 */
function processClip(name, { xz = 'keep', flatUp = false } = {}) {
    const { clip, hipsRest } = R.raw[name]
    const ref = R.skel.getObjectByName(HIPS).position
    const c = clip.clone()
    c.tracks = c.tracks.filter(t => t.name.endsWith('.quaternion') || t.name === `${HIPS}.position`)
    const hp = c.tracks.find(t => t.name === `${HIPS}.position`)
    if (hp) {
        const v = hp.values, times = hp.times, n = times.length
        const k = ref.y / hipsRest.y
        for (let i = 0; i < v.length; i++) v[i] *= k
        const x0 = v[0], y0 = v[1], z0 = v[2]
        const T = times[n - 1] - times[0] || 1
        const trend = xz === 'detrend'
        const dx = trend ? v[(n - 1) * 3] - x0 : 0, dz = trend ? v[(n - 1) * 3 + 2] - z0 : 0
        for (let i = 0; i < n; i++) {
            const f = (times[i] - times[0]) / T
            if (xz === 'pin') { v[i * 3] = ref.x; v[i * 3 + 2] = ref.z }
            else {
                v[i * 3]     += ref.x - x0 - dx * f
                v[i * 3 + 2] += ref.z - z0 - dz * f
            }
            if (flatUp) v[i * 3 + 1] = Math.min(v[i * 3 + 1], y0)
        }
    }
    for (const t of c.tracks) t.optimize()
    R.clips[name] = c
    R.bodyClips.clear()
    return { name, tracks: c.tracks.length, dur: +c.duration.toFixed(3) }
}

/** A processed clip with its hips track scaled onto body `key` (what the game does at load). */
function bodyClip(key, name) {
    const own = R.chars[key].userData.clips?.[name]       // a GLB's own clips (the horse) play as they are
    if (own) return own
    const id = `${key}|${name}`
    if (!R.bodyClips.has(id)) {
        const c = R.clips[name].clone()
        const root = R.chars[key]
        const k = (root.userData.hipsRestY ?? root.getObjectByName(HIPS).position.y) / R.skel.getObjectByName(HIPS).position.y
        const hp = c.tracks.find(t => t.name === `${HIPS}.position`)
        if (hp) for (let i = 0; i < hp.values.length; i++) hp.values[i] *= k
        R.bodyClips.set(id, c)
    }
    return R.bodyClips.get(id)
}

/**
 * Ground speed of an in-place locomotion clip on body `key` (m/s for the 1.8 m body):
 * while a foot is planted (near its lowest point) it slides backwards at the walking speed.
 * `axis`: 'z' forward (+z), 'x' sideways (+x = the body's left).
 */
function clipSpeed(key, name, { thr = 0.03, axis = 'z' } = {}) {
    const root = R.chars[key]
    root.position.set(0, 0, 0)
    const feet = ['mixamorigLeftToeBase', 'mixamorigRightToeBase'].map(b => root.getObjectByName(b))
    const clip = bodyClip(key, name)
    const dur = clip.duration, dt = 1 / 120
    const samples = [], p = new THREE.Vector3()
    for (let t = 0; t <= dur + 1e-6; t += dt) {
        poseAt(root, clip, t)
        root.updateMatrixWorld(true)
        samples.push(feet.map(f => p.setFromMatrixPosition(f.matrixWorld).toArray()))
    }
    const ax = axis === 'x' ? 0 : 2
    const vs = []
    for (const k of [0, 1]) {
        const minY = Math.min(...samples.map(s => s[k][1]))
        for (let i = 1; i < samples.length; i++) {
            if (samples[i][k][1] > minY + thr || samples[i - 1][k][1] > minY + thr) continue
            vs.push(-(samples[i][k][ax] - samples[i - 1][k][ax]) / dt)
        }
    }
    vs.sort((a, b) => a - b)
    poseAt(root, null)
    return { clip: name, dur: +dur.toFixed(3), speed: vs.length ? +vs[vs.length >> 1].toFixed(3) : null,
             iqr: vs.length ? [+vs[vs.length >> 2].toFixed(2), +vs[(vs.length * 3) >> 2].toFixed(2)] : null, planted: vs.length }
}

/**
 * When each foot comes down in a locomotion clip, as fractions of the cycle: the frames where
 * a toe drops into the band within `thr` of its lowest point. The game plays a footstep there.
 */
function footContacts(key, name, { thr = 0.03 } = {}) {
    const root = R.chars[key]
    const feet = ['mixamorigLeftToeBase', 'mixamorigRightToeBase'].map(b => root.getObjectByName(b))
    const clip = bodyClip(key, name), dur = clip.duration, dt = 1 / 120
    const ys = [[], []], p = new THREE.Vector3()
    for (let t = 0; t < dur; t += dt) {
        poseAt(root, clip, t)
        root.updateMatrixWorld(true)
        feet.forEach((f, k) => ys[k].push(p.setFromMatrixPosition(f.matrixWorld).y))
    }
    const out = []
    ys.forEach((y, k) => {
        const lo = Math.min(...y), n = y.length
        for (let i = 0; i < n; i++) {
            const prev = y[(i - 1 + n) % n]
            if (y[i] <= lo + thr && prev > lo + thr) out.push([k ? 'R' : 'L', +(i / n).toFixed(3)])
        }
    })
    poseAt(root, null)
    return out.sort((a, b) => a[1] - b[1])
}

// ─────────────────────────────────────────
// COLOUR VARIANTS — a body's texture repainted by hue range (shirts, trousers), so a
// handful of townsfolk don't all wear the same clothes. Same rules as npc-prep.js.
// ─────────────────────────────────────────
function rgb2hsl(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2
    if (mx === mn) return [0, 0, l]
    const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
    const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
    return [h * 60, s, l]
}
function hsl2rgb(h, s, l) {
    const f = (n) => { const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)) }
    return [f(0), f(8), f(4)]
}
/**
 * Rules: { hue: [h0, h1] (wraps if h0 > h1), sat: [s0, s1], light: [l0, l1],
 *          to: { h, s (absolute, or null = keep), sMul, lMul } | mul: '#hex' }. First match wins.
 */
function recolour(canvas, rules) {
    const x = canvas.getContext('2d'), im = x.getImageData(0, 0, canvas.width, canvas.height), d = im.data
    const hex = (s) => { const n = parseInt(s.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255] }
    const muls = rules.map(r => r.mul ? hex(r.mul) : null)
    for (let i = 0; i < d.length; i += 4) {
        const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255
        const [h, s, l] = rgb2hsl(r, g, b)
        for (let k = 0; k < rules.length; k++) {
            const q = rules[k]
            if (q.hue && !(q.hue[0] <= q.hue[1] ? h >= q.hue[0] && h <= q.hue[1] : h >= q.hue[0] || h <= q.hue[1])) continue
            if (q.sat && (s < q.sat[0] || s > q.sat[1])) continue
            if (q.light && (l < q.light[0] || l > q.light[1])) continue
            let out
            if (muls[k]) out = [r * muls[k][0], g * muls[k][1], b * muls[k][2]]
            else { const t = q.to; out = hsl2rgb(t.h ?? h, Math.min(1, t.s ?? s * (t.sMul ?? 1)), Math.min(1, l * (t.lMul ?? 1))) }
            d[i] = out[0] * 255; d[i + 1] = out[1] * 255; d[i + 2] = out[2] * 255
            break
        }
    }
    x.putImageData(im, 0, 0)
    return canvas
}

/**
 * Body `key`'s texture repainted by `rules`, as a JPEG data URL in glTF orientation (flipped,
 * as GLTFExporter stores the base texture), so the game swaps it in with flipY = false.
 * `apply`: also show it on the body here, for a check render.
 */
function paintVariant(key, rules, { quality = 0.88, apply = false } = {}) {
    let mesh = null
    R.chars[key].traverse(o => { if (o.isSkinnedMesh) mesh = o })
    const src = (mesh.userData.baseMap ??= mesh.material.map)
    const img = src.image
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    c.getContext('2d').drawImage(img, 0, 0)
    recolour(c, rules)
    if (apply) {
        const t = new THREE.CanvasTexture(c)
        t.colorSpace = THREE.SRGBColorSpace
        mesh.material = mesh.material.clone()
        mesh.material.map = t
    }
    const f = document.createElement('canvas')
    f.width = c.width; f.height = c.height
    const fx = f.getContext('2d')
    fx.translate(0, f.height); fx.scale(1, -1)
    fx.drawImage(c, 0, 0)
    return f.toDataURL('image/jpeg', quality)
}

/** Back to the body's own texture (after paintVariant(…, { apply: true })). */
function resetVariant(key) {
    R.chars[key].traverse(o => { if (o.isSkinnedMesh && o.userData.baseMap) { o.material = o.material.clone(); o.material.map = o.userData.baseMap } })
}

// ─────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────
const toDataURL = (blob) => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob) })

/** Body `key` (skeleton + skinned mesh + texture) as a GLB data URL, in its rest pose. */
async function exportChar(key) {
    const root = R.chars[key]
    poseAt(root, null)
    root.position.set(0, 0, 0)
    root.updateMatrixWorld(true)
    const buf = await new GLTFExporter().parseAsync(root, { binary: true, maxTextureSize: 4096 })
    return { url: await toDataURL(new Blob([buf], { type: 'model/gltf-binary' })), bytes: buf.byteLength }
}

/** The processed clips on a bare copy of the reference skeleton (its hips rest height is the yardstick). */
async function exportClips(names = Object.keys(R.clips)) {
    const holder = new THREE.Group()
    holder.name = 'MixamoClips'
    const hips = R.skel.getObjectByName(HIPS).clone(true)
    hips.traverse(o => { if (o.isMesh) o.parent.remove(o) })
    holder.add(hips)
    holder.updateMatrixWorld(true)
    // only tracks for bones some body has (the auto-rigged bodies have no finger bones)
    const have = new Set()
    for (const r of Object.values(R.chars)) r.traverse(o => { if (o.isBone) have.add(o.name) })
    const clips = names.map(n => {
        const c = R.clips[n].clone()
        c.tracks = c.tracks.filter(t => have.has(t.name.split('.')[0]))
        return c
    })
    const buf = await new GLTFExporter().parseAsync(holder, { binary: true, animations: clips })
    return { url: await toDataURL(new Blob([buf], { type: 'model/gltf-binary' })), bytes: buf.byteLength,
             tracks: clips.map(c => `${c.name}:${c.tracks.length}`) }
}

// ─────────────────────────────────────────
// POSING + VIEWS
// ─────────────────────────────────────────
const _mix = new Map()
function poseAt(root, clip, t = 0) {
    let m = _mix.get(root)
    if (!m) { m = new THREE.AnimationMixer(root); _mix.set(root, m) }
    m.stopAllAction()
    if (!clip) { root.traverse(o => { if (o.isBone && o.userData.rest) { o.position.copy(o.userData.rest.p); o.quaternion.copy(o.userData.rest.q) } }); return }
    root.traverse(o => { if (o.isBone && !o.userData.rest) o.userData.rest = { p: o.position.clone(), q: o.quaternion.clone() } })
    m.clipAction(clip, root).reset().play()
    m.setTime(t)
}

function stage() {
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1b1e26)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444033, 1.4))
    const sun = new THREE.DirectionalLight(0xffffff, 1.6)
    sun.position.set(2, 5, 4)
    scene.add(sun)
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ color: 0x272b34 }))
    ground.rotation.x = -Math.PI / 2
    scene.add(ground)
    const grid = new THREE.GridHelper(40, 80, 0x3a4050, 0x3a4050)
    grid.position.y = 0.001
    scene.add(grid)
    return scene
}

const DIRS = { front: [0, 0, 1], side: [1, 0, 0], back: [0, 0, -1], three: [0.75, 0, 0.66], left: [-1, 0, 0], top: [0.3, 1.6, 0.6] }

/**
 * Contact sheet: `cells` = [{ key, clip, t (s; or frac: 0..1 of the clip), cam, h, dist, label }],
 * laid out in `cols` columns. A clip name is posed through bodyClip (re-based to that body).
 */
function viewCells(cells, { cols = 4, dist = 4.2, h = 0.9, fov = 30 } = {}) {
    const scene = stage()
    const rows = Math.ceil(cells.length / cols)
    const cw = SIZE / cols, ch = SIZE / rows
    const camera = new THREE.PerspectiveCamera(fov, cw / ch, 0.05, 100)
    octx.clearRect(0, 0, SIZE, SIZE)
    octx.font = '12px Courier New'
    renderer.setScissorTest(true)
    cells.forEach((c, i) => {
        const root = R.chars[c.key]
        if (c.paint) paintVariant(c.key, c.paint, { apply: true })
        else if (c.key !== 'horse') resetVariant(c.key)
        scene.add(root)
        root.position.set(0, 0, 0)
        const clip = c.clip ? bodyClip(c.key, c.clip) : null
        const t = c.frac != null && clip ? c.frac * clip.duration : (c.t ?? 0)
        poseAt(root, clip, t)
        root.updateMatrixWorld(true)
        const d = new THREE.Vector3(...DIRS[c.cam || 'front']).normalize()
        const hh = c.h ?? h
        camera.position.set(0, hh, 0).addScaledVector(d, c.dist ?? dist)
        camera.lookAt(0, hh, 0)
        const x = (i % cols) * cw, y = Math.floor(i / cols) * ch
        renderer.setViewport(x, SIZE - y - ch, cw, ch)
        renderer.setScissor(x, SIZE - y - ch, cw, ch)
        renderer.render(scene, camera)
        scene.remove(root)
        octx.fillStyle = '#fff'
        octx.fillText(c.label ?? `${c.clip || 'rest'} ${t.toFixed(2)}`, x + 5, y + 14)
    })
    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, SIZE, SIZE)
    return { rows, cols }
}

window.__char = {
    R, THREE, canon, loadChar, loadGlb, loadClips, processClip, bodyClip, clipSpeed, footContacts,
    exportChar, exportClips, poseAt, viewCells, describe, recolour, paintVariant, resetVariant,
}
