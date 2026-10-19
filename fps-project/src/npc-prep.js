/**
 * npc-prep.js: turns the raw Quaternius packs into game assets (dev only).
 *
 * Inputs, served by a local static server and passed to init(base):
 *   Universal Base Characters [Standard]   Superhero_Male / _Female _FullBody.gltf
 *   Universal Animation Library [Standard] UAL1_Standard.glb (43 clips)
 * Both are CC0, from https://quaternius.itch.io/ (see static/character/README.txt).
 *
 * The two packs share one 65-joint skeleton with identical bone names, so clips bind to
 * the characters BY NAME with no retargeting. This page proves that in the real three.js
 * runtime (viewSheet), and then bakes small GLBs with base-colour textures only. The raw
 * PNGs are 1-4 MB each.
 *
 * Driven from headless Chrome over CDP: a scratchpad script calls window.__npc.
 */

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js'

const SIZE = 1000
const canvas  = document.getElementById('canvas')
const overlay = document.getElementById('overlay')
const octx    = overlay.getContext('2d')

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(1)
renderer.setSize(SIZE, SIZE, false)
renderer.setClearColor(0x14161c)

const R = { base: '', chars: {}, clips: {}, ual: null }

const BASE_DIR = 'base_x/Universal%20Base%20Characters%5BStandard%5D/Base%20Characters/Godot%20-%20UE/'
const UAL_FILE = 'ual_x/Universal%20Animation%20Library%5BStandard%5D/Unreal-Godot/UAL1_Standard.glb'

/** Summarise a loaded scene: bone count and, per mesh, size / material / texture facts. */
function describe(scene) {
    const meshes = []
    let bones = 0
    scene.traverse(o => {
        if (o.isBone) bones++
        if (!o.isMesh) return
        o.geometry.computeBoundingBox()
        const bb  = o.geometry.boundingBox
        const mat = Array.isArray(o.material) ? o.material[0] : o.material
        const img = mat?.map?.image
        meshes.push({
            name: o.name, skinned: !!o.isSkinnedMesh, verts: o.geometry.attributes.position.count,
            tris: (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3,
            height: +(bb.max.y - bb.min.y).toFixed(3),
            material: mat?.name, alphaTest: mat?.alphaTest, transparent: mat?.transparent, side: mat?.side,
            mapSize: img ? `${img.width}x${img.height}` : null,
            normalMap: !!mat?.normalMap, roughnessMap: !!mat?.roughnessMap,
        })
    })
    return { bones, meshes }
}

async function init(base) {
    R.base = base
    const loader = new GLTFLoader()
    const errors = []
    for (const [key, file] of [['male', 'Superhero_Male_FullBody.gltf'], ['female', 'Superhero_Female_FullBody.gltf']]) {
        try { R.chars[key] = (await loader.loadAsync(base + BASE_DIR + file)).scene }
        catch (e) { errors.push(`${key}: ${e.message || e}`) }
    }
    R.ual = await loader.loadAsync(base + UAL_FILE)
    for (const c of R.ual.animations) R.clips[c.name] = c
    return {
        errors,
        male: R.chars.male && describe(R.chars.male),
        female: R.chars.female && describe(R.chars.female),
        clips: Object.fromEntries(Object.entries(R.clips).map(([k, c]) => [k, +c.duration.toFixed(2)])),
    }
}

/** Load any extra glTF (an outfit, a part) under R.chars[key] so viewSheet can show it. */
async function loadAs(key, url) {
    const g = await new GLTFLoader().loadAsync(R.base + url)
    R.chars[key] = g.scene
    return describe(g.scene)
}

// ─────────────────────────────────────────
// ASSEMBLY: outfit body + grafted head
//
// The free Base Characters are bare "Superhero" bodies, and the free outfits
// (Modular Character Outfits - Fantasy) are clothing + forearm skin built for
// the paid "Regular" body, with no head. So an NPC is the OUTFIT (its own
// Regular-proportion skeleton, all 65 bones) plus the Superhero's head, neck,
// eyes and eyebrows grafted onto it.
//
// The graft keeps the Superhero's own inverse bind matrices, on a Skeleton
// built from the OUTFIT's bones in the Superhero's joint order. So the head
// keeps its exact offset from the head bone, and follows the outfit's head
// bone when animated. No skin indices are rewritten.
// ─────────────────────────────────────────
const OUTFIT_DIR = 'outfits_x/Modular%20Character%20Outfits%20-%20Fantasy%5BStandard%5D/Exports/glTF%20(Godot-Unreal)/Outfits/'
const HEAD_BONES = ['Head', 'neck_01']

/** Triangles of a skinned mesh whose three vertices are all dominated by `boneNames`. */
function subsetByBones(mesh, boneNames) {
    const g  = mesh.geometry
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight
    const keep = new Set()
    mesh.skeleton.bones.forEach((b, i) => { if (boneNames.includes(b.name)) keep.add(i) })
    const dominant = (v) => {
        let bi = -1, bw = -1
        for (let k = 0; k < 4; k++) { const w = sw.getComponent(v, k); if (w > bw) { bw = w; bi = si.getComponent(v, k) } }
        return bi
    }
    const src = g.index.array, out = []
    for (let t = 0; t < src.length; t += 3) {
        const a = src[t], b = src[t + 1], c = src[t + 2]
        if (keep.has(dominant(a)) && keep.has(dominant(b)) && keep.has(dominant(c))) out.push(a, b, c)
    }
    const ng = g.clone()
    ng.setIndex(out)
    return compact(ng)
}

/** Drop vertices no triangle references, so the exported file doesn't carry them. */
function compact(g) {
    const idx = g.index.array, map = new Map()
    const order = []
    for (const i of idx) if (!map.has(i)) { map.set(i, order.length); order.push(i) }
    const out = new THREE.BufferGeometry()
    for (const [name, attr] of Object.entries(g.attributes)) {
        const Arr = attr.array.constructor, n = attr.itemSize
        const arr = new Arr(order.length * n)
        order.forEach((src, dst) => { for (let k = 0; k < n; k++) arr[dst * n + k] = attr.array[src * n + k] })
        out.setAttribute(name, new THREE.BufferAttribute(arr, n, attr.normalized))
    }
    out.setIndex(Array.from(idx, i => map.get(i)))
    return out
}

/** Graft `srcMesh` (skinned to the Superhero skeleton) onto the outfit's bones. */
function graft(srcMesh, geometry, outfitBonesByName) {
    const bones = srcMesh.skeleton.bones.map(b => outfitBonesByName[b.name])
    if (bones.some(b => !b)) throw new Error(`graft: bone missing in outfit for ${srcMesh.name}`)
    const skeleton = new THREE.Skeleton(bones, srcMesh.skeleton.boneInverses.map(m => m.clone()))
    const m = new THREE.SkinnedMesh(geometry, srcMesh.material)
    m.name = srcMesh.name
    m.frustumCulled = false
    m.bind(skeleton, srcMesh.bindMatrix.clone())
    return m
}

/**
 * Build an NPC: outfit + grafted head. Stored as R.chars[key] for viewing / export.
 * `drop`: outfit pieces to leave off, matched against the mesh name (e.g. 'Head_Hood').
 */
async function assemble(key, outfitFile, headKey, { drop = [] } = {}) {
    const outfit = (await new GLTFLoader().loadAsync(R.base + OUTFIT_DIR + outfitFile)).scene
    const dropped = []
    outfit.traverse(o => { if (o.isMesh && drop.some(d => o.name.includes(d))) dropped.push(o) })
    for (const o of dropped) o.parent.remove(o)
    const bonesByName = {}
    outfit.traverse(o => { if (o.isBone) bonesByName[o.name] = o })

    const head = R.chars[headKey]
    const parts = []
    head.traverse(o => { if (o.isSkinnedMesh) parts.push(o) })
    const body = parts.find(p => /superhero/i.test(p.name))
    const grafted = [
        graft(body, subsetByBones(body, HEAD_BONES), bonesByName),
        ...parts.filter(p => p !== body).map(p => graft(p, p.geometry, bonesByName)),   // eyes, eyebrows
    ]
    for (const g of grafted) outfit.add(g)
    outfit.updateMatrixWorld(true)
    R.chars[key] = outfit
    return { bones: Object.keys(bonesByName).length, dropped: dropped.map(o => o.name),
             grafted: grafted.map(g => `${g.name}:${g.geometry.index.count / 3}t`) }
}

// ─────────────────────────────────────────
// HAT: lifted out of the player cowboy's source mesh (src/rig/cowboy-source.glb, CC0)
//
// The source is one mesh on one texture atlas. Normalised the way rig-cowboy.js
// does it ("N-space": feet at y = 0, height 1, centred in x/z), the hat is every
// triangle whose three vertices sit above `minY`.
// ─────────────────────────────────────────
async function loadHat(minY = 0.925) {
    const gltf = await new GLTFLoader().loadAsync(new URL('./rig/cowboy-source.glb', import.meta.url).href)
    let mesh = null
    gltf.scene.traverse(o => { if (o.isMesh && !mesh) mesh = o })
    gltf.scene.updateMatrixWorld(true)
    const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)
    g.computeBoundingBox()
    const bb = g.boundingBox
    const H = bb.max.y - bb.min.y, cx = (bb.max.x + bb.min.x) / 2, cz = (bb.max.z + bb.min.z) / 2, y0 = bb.min.y
    const p = g.attributes.position
    for (let i = 0; i < p.count; i++) p.setXYZ(i, (p.getX(i) - cx) / H, (p.getY(i) - y0) / H, (p.getZ(i) - cz) / H)

    if (!g.index) g.setIndex(Array.from({ length: p.count }, (_, i) => i))
    const src = g.index.array, out = []
    for (let t = 0; t < src.length; t += 3) {
        if (p.getY(src[t]) > minY && p.getY(src[t + 1]) > minY && p.getY(src[t + 2]) > minY) out.push(src[t], src[t + 1], src[t + 2])
    }
    g.setIndex(out)
    const hat = compact(g)
    for (const k of Object.keys(hat.attributes)) if (!['position', 'normal', 'uv'].includes(k)) hat.deleteAttribute(k)
    hat.computeBoundingBox()
    hat.computeBoundingSphere()
    R.hat = { geometry: hat, material: mesh.material }
    const b2 = hat.boundingBox
    return { tris: out.length / 3, verts: hat.attributes.position.count, attrs: Object.keys(g.attributes),
             min: b2.min.toArray().map(n => +n.toFixed(3)), max: b2.max.toArray().map(n => +n.toFixed(3)),
             map: mesh.material.map ? `${mesh.material.map.image.width}x${mesh.material.map.image.height}` : null }
}

/** Measure `key`'s grafted head at bind pose: head-mesh bounds + Head bone position (world). */
function headInfo(key) {
    const root = R.chars[key]
    poseAt(root, null)
    root.updateMatrixWorld(true)
    let head = null, bone = null
    root.traverse(o => { if (o.isSkinnedMesh && /superhero/i.test(o.name)) head = o; if (o.isBone && o.name === 'Head') bone = o })
    const box = new THREE.Box3(), v = new THREE.Vector3()
    const pos = head.geometry.attributes.position
    for (let i = 0; i < pos.count; i++) { head.getVertexPosition(i, v); box.expandByPoint(v.applyMatrix4(head.matrixWorld)) }
    const bp = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld)
    return { min: box.min.toArray().map(n => +n.toFixed(4)), max: box.max.toArray().map(n => +n.toFixed(4)),
             bone: bp.toArray().map(n => +n.toFixed(4)) }
}

/**
 * Put the hat on `key`'s Head bone. The hat's brim (its lowest point) goes `y` metres
 * relative to the top of the head (negative = down over the skull), centred on the head,
 * `z` metres forward, `scale` times its N-space size, tilted `tilt` rad about x.
 * All measured at bind pose.
 */
function wearHat(key, { scale = 1, y = 0, z = 0, tilt = 0, color = null } = {}) {
    const root = R.chars[key]
    const old = root.getObjectByName('Hat')
    if (old) old.parent.remove(old)
    const hi = headInfo(key)
    let bone = null
    root.traverse(o => { if (o.isBone && o.name === 'Head') bone = o })
    const mat = R.hat.material.clone()
    if (color) mat.color.set(color)
    const hat = new THREE.Mesh(R.hat.geometry, mat)
    hat.name = 'Hat'
    const hb = R.hat.geometry.boundingBox
    const hc = new THREE.Vector3((hb.min.x + hb.max.x) / 2, hb.min.y, (hb.min.z + hb.max.z) / 2)
    // place in world at bind pose, then re-express in the bone's frame
    const cx = (hi.min[0] + hi.max[0]) / 2, cz = (hi.min[2] + hi.max[2]) / 2
    const world = new THREE.Matrix4().compose(
        new THREE.Vector3(cx, hi.max[1] + y, cz + z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, 0, 0)),
        new THREE.Vector3(scale, scale, scale))
        .multiply(new THREE.Matrix4().makeTranslation(-hc.x, -hc.y, -hc.z))
    hat.matrix.copy(bone.matrixWorld).invert().multiply(world)
    hat.matrix.decompose(hat.position, hat.quaternion, hat.scale)
    bone.add(hat)
    return hi
}

// ─────────────────────────────────────────
// MERGE: every part → ONE SkinnedMesh on ONE 1024² atlas (one draw call per NPC)
//
// Each part is skinned to world space at rest (three's attached bind mode:
// world = Σ w · boneWorld · boneInverse · bindMatrix · p), so the merged mesh
// needs only one skeleton, whose inverses are the bones' rest world matrices.
// The hat is rigid on Head (weight 1).
//
// Atlas: per material, the used UV islands (connected triangles, merged where their
// UV boxes overlap) are cut out of a pre-downscaled copy of the source texture and
// shelf-packed. Unused texture space (most of the Superhero body texture, since
// only the head is kept) never reaches the atlas. Densities are relative to the
// source, and scaled together until the islands just fit.
// ─────────────────────────────────────────
const ATLAS = 1024
const PAD = 4                      // px of real neighbouring texels around every island
const DENSITY = [                  // atlas px per source px, before the common fit factor
    [/^MI_(Peasant|Ranger)/, 0.24],
    [/^MI_Superhero/, 0.30],       // face
    [/^MI_Regular/, 0.14],         // forearms / hands
    [/^MI_Hair/, 0.10],            // eyebrows
    [/^MI_Eyes/, 0.40],
    [/^Hat$/, 4],                  // 2×2 palette texture → an 8×8 cell
]
const density = (matName) => (DENSITY.find(([re]) => re.test(matName)) || [0, 0.2])[1]

/** Union-find islands of a geometry's triangles; returns UV boxes [u0, v0, u1, v1]. */
function uvIslands(g) {
    const idx = g.index.array, uv = g.attributes.uv
    const parent = new Int32Array(uv.count).map((_, i) => i)
    const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i }
    for (let t = 0; t < idx.length; t += 3) {
        const a = find(idx[t]), b = find(idx[t + 1]), c = find(idx[t + 2])
        parent[b] = a; parent[find(c)] = a
    }
    const boxes = new Map()
    for (let t = 0; t < idx.length; t++) {
        const r = find(idx[t]), u = uv.getX(idx[t]), v = uv.getY(idx[t])
        const b = boxes.get(r) || [1e9, 1e9, -1e9, -1e9]
        b[0] = Math.min(b[0], u); b[1] = Math.min(b[1], v); b[2] = Math.max(b[2], u); b[3] = Math.max(b[3], v)
        boxes.set(r, b)
    }
    return [...boxes.values()]
}

/** Merge boxes that overlap (after growing each by `grow` UV units), until none do. */
function mergeBoxes(boxes, grow) {
    let list = boxes.map(b => b.slice())
    for (let changed = true; changed;) {
        changed = false
        outer: for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
            const a = list[i], b = list[j]
            if (a[0] - grow <= b[2] && b[0] - grow <= a[2] && a[1] - grow <= b[3] && b[1] - grow <= a[3]) {
                list[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
                list.splice(j, 1)
                changed = true
                break outer
            }
        }
    }
    return list
}

/** Shelf-pack rects {w, h} into ATLAS×ATLAS; sets x, y. Returns false if they don't fit. */
function shelfPack(rects) {
    const order = rects.slice().sort((a, b) => b.h - a.h)
    let x = 0, y = 0, shelf = 0
    for (const r of order) {
        if (r.w > ATLAS) return false
        if (x + r.w > ATLAS) { x = 0; y += shelf; shelf = 0 }
        r.x = x; r.y = y
        x += r.w; shelf = Math.max(shelf, r.h)
    }
    return y + shelf <= ATLAS
}

/** High-quality downscale of an image to w×h (progressive halving, then one final step). */
function downscale(img, w, h) {
    let src = img, sw = img.width, sh = img.height
    while (sw / 2 >= w && sh / 2 >= h) {
        const c = document.createElement('canvas')
        c.width = sw = Math.round(sw / 2); c.height = sh = Math.round(sh / 2)
        const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, sw, sh)
        src = c
    }
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    const x = c.getContext('2d'); x.imageSmoothingEnabled = w < sw; x.imageSmoothingQuality = 'high'
    x.drawImage(src, 0, 0, w, h)
    return c
}

// ── recolouring (per material, on the downscaled source, before packing) ──
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
 * Rules: { hue: [h0, h1] (wraps if h0 > h1) | undefined, sat: [s0, s1], light: [l0, l1],
 *          to: { h, s (absolute or null = keep), sMul, lMul }, mul: '#hex' }
 * First matching rule wins. `mul` multiplies RGB; `to` rewrites HSL.
 */
function recolour(canvas, rules) {
    if (!rules?.length) return canvas
    const x = canvas.getContext('2d'), im = x.getImageData(0, 0, canvas.width, canvas.height), d = im.data
    const hex = (s) => { const n = parseInt(s.slice(1), 16); return { r: (n >> 16 & 255) / 255, g: (n >> 8 & 255) / 255, b: (n & 255) / 255 } }
    const muls = rules.map(r => r.mul ? hex(r.mul) : null)       // sRGB multiply, on the sRGB texels
    for (let i = 0; i < d.length; i += 4) {
        const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255
        const [h, s, l] = rgb2hsl(r, g, b)
        for (let k = 0; k < rules.length; k++) {
            const q = rules[k]
            if (q.hue && !(q.hue[0] <= q.hue[1] ? h >= q.hue[0] && h <= q.hue[1] : h >= q.hue[0] || h <= q.hue[1])) continue
            if (q.sat && (s < q.sat[0] || s > q.sat[1])) continue
            if (q.light && (l < q.light[0] || l > q.light[1])) continue
            let out
            if (muls[k]) { const c = muls[k]; out = [r * c.r, g * c.g, b * c.b] }
            else {
                const t = q.to
                out = hsl2rgb(t.h ?? h, Math.min(1, t.s ?? s * (t.sMul ?? 1)), Math.min(1, l * (t.lMul ?? 1)))
            }
            d[i] = out[0] * 255; d[i + 1] = out[1] * 255; d[i + 2] = out[2] * 255
            break
        }
    }
    x.putImageData(im, 0, 0)
    return canvas
}

/** Gather the parts of an assembled character: [{ mesh, material, rigid }]. */
function partsOf(root) {
    const parts = []
    root.traverse(o => { if (o.isMesh && !o.userData.merged) parts.push(o) })
    return parts
}

/**
 * Merge R.chars[key] into one SkinnedMesh with an atlas. Computes the layout once
 * (kept on R.layouts[key]) so paintAtlas() can repaint colour variants onto the same UVs.
 * `rules`: the base recolouring baked into the default atlas (see paintAtlas).
 */
function mergeCharacter(key, rules = {}) {
    const root = R.chars[key]
    poseAt(root, null)
    root.position.set(0, 0, 0)
    root.updateMatrixWorld(true)

    const parts = partsOf(root)
    const body = parts.find(p => p.isSkinnedMesh && !/superhero|eyes|eyebrows/i.test(p.name))
    const bones = body.skeleton.bones.slice()
    const boneIndex = new Map(bones.map((b, i) => [b, i]))
    const headIdx = bones.findIndex(b => b.name === 'Head')

    // ── atlas layout: islands per material ──
    const byMat = new Map()                           // matKey → { image, parts: [], boxes: [] }
    for (const p of parts) {
        const mk = p.name === 'Hat' ? 'Hat' : p.material.name
        const e = byMat.get(mk) || { key: mk, image: p.material.map.image, parts: [], boxes: [] }
        e.parts.push(p)
        e.boxes.push(...uvIslands(p.geometry))
        byMat.set(mk, e)
    }
    const mats = [...byMat.values()]
    let fit = 1.6, rects
    for (; fit > 0.2; fit *= 0.94) {
        rects = []
        for (const m of mats) {
            const f = density(m.key) * fit
            m.f = f
            m.sw = Math.max(8, Math.round(m.image.width * f)); m.sh = Math.max(8, Math.round(m.image.height * f))
            m.rects = mergeBoxes(m.boxes, (PAD * 2) / m.sw).map(b => ({
                m, box: b,
                w: Math.ceil((b[2] - b[0]) * m.sw) + PAD * 2,
                h: Math.ceil((b[3] - b[1]) * m.sh) + PAD * 2,
            }))
            rects.push(...m.rects)
        }
        if (shelfPack(rects)) break
    }

    // ── geometry: skin each part to world at rest, remap UVs into its island's rect ──
    const P = [], N = [], UV = [], SI = [], SW = [], I = []
    const tmp = new THREE.Matrix4(), acc = new THREE.Matrix4(), nm = new THREE.Matrix3()
    const v = new THREE.Vector3(), n = new THREE.Vector3()
    for (const p of parts) {
        const g = p.geometry, pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv
        const m = byMat.get(p.name === 'Hat' ? 'Hat' : p.material.name)
        const base = P.length / 3
        let boneMats = null, map = null
        if (p.isSkinnedMesh) {
            boneMats = p.skeleton.bones.map((b, j) => new THREE.Matrix4().multiplyMatrices(b.matrixWorld, p.skeleton.boneInverses[j]))
            map = p.skeleton.bones.map(b => boneIndex.get(b))
        }
        // which rect each vertex's island went to: test containment (islands never straddle rects)
        const rectOf = (u, vv) => m.rects.find(r => u >= r.box[0] - 1e-6 && u <= r.box[2] + 1e-6 && vv >= r.box[1] - 1e-6 && vv <= r.box[3] + 1e-6)
        for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i); n.fromBufferAttribute(nor, i)
            if (p.isSkinnedMesh) {
                acc.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
                const si = g.attributes.skinIndex, sw = g.attributes.skinWeight
                const js = [], ws = []
                for (let k = 0; k < 4; k++) {
                    const w = sw.getComponent(i, k)
                    if (w <= 0) continue
                    const j = si.getComponent(i, k)
                    const e = boneMats[j].elements, a = acc.elements
                    for (let q = 0; q < 16; q++) a[q] += e[q] * w
                    js.push(map[j]); ws.push(w)
                }
                tmp.multiplyMatrices(acc, p.bindMatrix)
                v.applyMatrix4(tmp)
                n.applyMatrix3(nm.getNormalMatrix(tmp)).normalize()
                while (js.length < 4) { js.push(0); ws.push(0) }
                const sum = ws.reduce((s, w) => s + w, 0) || 1
                SI.push(...js); SW.push(...ws.map(w => w / sum))
            } else {
                v.applyMatrix4(p.matrixWorld)
                n.applyMatrix3(nm.getNormalMatrix(p.matrixWorld)).normalize()
                SI.push(headIdx, 0, 0, 0); SW.push(1, 0, 0, 0)
            }
            P.push(v.x, v.y, v.z); N.push(n.x, n.y, n.z)
            const u = uv.getX(i), vv = uv.getY(i), r = rectOf(u, vv)
            UV.push((r.x + PAD + (u - r.box[0]) * m.sw) / ATLAS, (r.y + PAD + (vv - r.box[1]) * m.sh) / ATLAS)
        }
        for (const k of g.index.array) I.push(base + k)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3))
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2))
    // 65 joints fit a byte; weights as normalised bytes (valid core glTF), summing to exactly 255
    const W8 = new Uint8Array(SW.length)
    for (let i = 0; i < SW.length; i += 4) {
        let rest = 255, big = 0
        for (let k = 0; k < 4; k++) { W8[i + k] = Math.round(SW[i + k] * 255); rest -= W8[i + k]; if (W8[i + k] > W8[i + big]) big = k }
        W8[i + big] += rest
    }
    geo.setAttribute('skinIndex', new THREE.Uint8BufferAttribute(SI, 4))
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(W8, 4, true))
    geo.setIndex(I)
    geo.computeBoundingBox(); geo.computeBoundingSphere()

    R.layouts = R.layouts || {}
    R.layouts[key] = { mats, rects }
    const tex = new THREE.CanvasTexture(paintAtlas(key, rules))
    tex.flipY = false
    tex.colorSpace = THREE.SRGBColorSpace
    tex.userData.mimeType = 'image/jpeg'
    const material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0, side: THREE.DoubleSide })
    material.name = `NPC_${key}`

    // swap the parts for the merged mesh
    for (const p of parts) p.parent.remove(p)
    const merged = new THREE.SkinnedMesh(geo, material)
    merged.name = `NPC_${key}`
    merged.userData.merged = true
    merged.frustumCulled = false
    root.add(merged)
    root.updateMatrixWorld(true)
    merged.bind(new THREE.Skeleton(bones), merged.matrixWorld)

    const used = rects.reduce((s, r) => s + r.w * r.h, 0) / (ATLAS * ATLAS)
    return { tris: I.length / 3, verts: P.length / 3, fit: +fit.toFixed(3), rects: rects.length, atlasUse: +used.toFixed(3),
             perMat: mats.map(m => `${m.key}:${m.rects.length}r@${m.sw}`) }
}

/** Paint the atlas for `key`'s layout; `rules` = { matRegexSource: recolourRules } for a variant. */
function paintAtlas(key, rules = {}) {
    const { mats } = R.layouts[key]
    const atlas = document.createElement('canvas')
    atlas.width = atlas.height = ATLAS
    const x = atlas.getContext('2d')
    x.fillStyle = '#6b5a48'
    x.fillRect(0, 0, ATLAS, ATLAS)
    for (const m of mats) {
        let src = downscale(m.image, m.sw, m.sh)
        for (const [re, rs] of Object.entries(rules)) if (new RegExp(re).test(m.key)) src = recolour(src, rs)
        const pat = x.createPattern(src, 'repeat')
        for (const r of m.rects) {
            pat.setTransform(new DOMMatrix().translate(r.x + PAD - r.box[0] * m.sw, r.y + PAD - r.box[1] * m.sh))
            x.fillStyle = pat
            x.fillRect(r.x, r.y, r.w, r.h)
        }
    }
    return atlas
}

/** Swap `key`'s atlas for a repainted variant (for viewing). Returns the canvas. */
function applyVariant(key, rules) {
    const c = paintAtlas(key, rules)
    let mesh = null
    R.chars[key].traverse(o => { if (o.userData.merged) mesh = o })
    const tex = new THREE.CanvasTexture(c)
    tex.flipY = false
    tex.colorSpace = THREE.SRGBColorSpace
    tex.userData.mimeType = 'image/jpeg'
    mesh.material.map = tex
    mesh.material.needsUpdate = true
    return c
}

// ─────────────────────────────────────────
// RECIPES → static/character/npc/<name>.glb  (+ <name>_<variant>.jpg repaints)
// ─────────────────────────────────────────
const BROWS  = [{ mul: '#5a4030' }]                 // the hair texture is near-white (tinted in-engine upstream)
const GREEN  = { hue: [55, 175], sat: [0.10, 1] }    // the Ranger's greens (hood, tunic, trousers)
const CREAM  = { hue: [15, 75], sat: [0, 0.5], light: [0.52, 1] }   // the Peasant shirt
const RECIPES = {
    townsman:   { outfit: 'Male_Peasant.gltf',   head: 'male',   drop: [],
                  hat: { scale: 2.25, y: -0.085 }, rules: { MI_Hair: BROWS } },
    townswoman: { outfit: 'Female_Peasant.gltf', head: 'female', drop: [],
                  hat: { scale: 2.15, y: -0.08 },  rules: { MI_Hair: BROWS, '^Hat$': [{ mul: '#c8b8a8' }] } },
    bandit:     { outfit: 'Male_Ranger.gltf',    head: 'male',   drop: ['Head_Hood', 'Acc_Pauldron'],
                  hat: { scale: 2.25, y: -0.085 },
                  rules: { MI_Hair: BROWS, '^Hat$': [{ mul: '#4a4440' }], MI_Ranger: [{ ...GREEN, to: { h: 30, sMul: 0.22, lMul: 0.62 } }] } },
    banditF:    { outfit: 'Female_Ranger.gltf',  head: 'female', drop: ['Head_Hood', 'Acc_Pauldron'],
                  hat: { scale: 2.15, y: -0.08 },
                  rules: { MI_Hair: BROWS, '^Hat$': [{ mul: '#4a4440' }], MI_Ranger: [{ ...GREEN, to: { h: 30, sMul: 0.22, lMul: 0.62 } }] } },
}
/** Repaints per recipe: extra rules layered over the recipe's own (same keys replace). */
const VARIANTS = {
    townsman: {
        blue:  { MI_Peasant: [{ ...CREAM, to: { h: 212, s: 0.32, lMul: 0.78 } }], '^Hat$': [{ mul: '#8a6a50' }] },
        red:   { MI_Peasant: [{ ...CREAM, to: { h: 4,   s: 0.42, lMul: 0.72 } }], '^Hat$': [{ mul: '#9a9a9a' }] },
    },
    townswoman: {
        green: { MI_Peasant: [{ ...CREAM, to: { h: 95,  s: 0.22, lMul: 0.8 } }],  '^Hat$': [{ mul: '#8a6a50' }] },
        blue:  { MI_Peasant: [{ ...CREAM, to: { h: 225, s: 0.25, lMul: 0.85 } }], '^Hat$': [{ mul: '#ffffff' }] },
    },
    bandit: {
        oxblood: { MI_Ranger: [{ ...GREEN, to: { h: 358, sMul: 0.55, lMul: 0.55 } }], '^Hat$': [{ mul: '#6a5040' }] },
        dust:    { MI_Ranger: [{ ...GREEN, to: { h: 34,  sMul: 0.45, lMul: 0.95 } }], '^Hat$': [{ mul: '#2e2a28' }] },
    },
    banditF: {
        oxblood: { MI_Ranger: [{ ...GREEN, to: { h: 358, sMul: 0.55, lMul: 0.55 } }], '^Hat$': [{ mul: '#2e2a28' }] },
    },
}

/** Assemble + hat + merge one recipe into R.chars[name]. */
async function build(name) {
    const rc = RECIPES[name]
    const a = await assemble(name, rc.outfit, rc.head, { drop: rc.drop })
    wearHat(name, rc.hat)
    const m = mergeCharacter(name, rc.rules)
    return { ...a, ...m }
}

const toDataURL = (blob) => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob) })

/** Export R.chars[name] (bones + merged mesh) as GLB → data URL. */
async function exportGLB(name) {
    const root = R.chars[name]
    poseAt(root, null)
    root.position.set(0, 0, 0)
    root.updateMatrixWorld(true)
    const buf = await new GLTFExporter().parseAsync(root, { binary: true })
    return toDataURL(new Blob([buf], { type: 'model/gltf-binary' }))
}

/** A variant repaint of `name` as a JPEG data URL. */
function variantJPEG(name, variant, quality = 0.88) {
    const rules = { ...RECIPES[name].rules, ...VARIANTS[name][variant] }
    return paintAtlas(name, rules).toDataURL('image/jpeg', quality)
}

// ── clips ──
/** Per clip: track kinds, and which bones have position tracks that actually move. */
function clipReport(names) {
    const out = {}
    for (const n of names) {
        const c = R.clips[n]
        const kinds = {}, movingPos = [], constPos = []
        for (const t of c.tracks) {
            const [node, prop] = t.name.split('.')
            kinds[prop] = (kinds[prop] || 0) + 1
            if (prop !== 'position') continue
            const v = t.values
            let dev = 0
            for (let i = 3; i < v.length; i++) dev = Math.max(dev, Math.abs(v[i] - v[i % 3]))
            ;(dev > 1e-3 ? movingPos : constPos).push(node)
        }
        out[n] = { dur: +c.duration.toFixed(2), kinds, movingPos, constPos: constPos.length }
    }
    return out
}

/**
 * Compare bone rest positions between the UAL armature and an NPC's skeleton: where a
 * clip's position track is constant AND equals UAL's rest, it only restates UAL's bone
 * lengths — dropping it lets each NPC keep its own proportions.
 */
function restDiff(name) {
    const a = {}, b = {}
    R.ual.scene.traverse(o => { if (o.isBone) a[o.name] = o.position })
    R.chars[name].traverse(o => { if (o.isBone) b[o.name] = o.position })
    const rows = []
    for (const k of Object.keys(a)) if (b[k]) {
        const d = a[k].distanceTo(b[k])
        if (d > 1e-3) rows.push(`${k}:${d.toFixed(3)}`)
    }
    return rows
}

/**
 * A UAL clip trimmed to the channels that matter. Every UAL clip keys position AND scale
 * on all 65 bones, but only the pelvis actually moves; the constant ones restate UAL's
 * bone lengths, which differ from the Regular-body outfits by up to 8 cm (upper arms).
 * So: rotations everywhere, position on the pelvis only, no scale. With `body` (an
 * assembled character key) the pelvis track is re-based onto that body's rest height,
 * which is what npc.js does at runtime too.
 */
function trimClip(clip, body = null) {
    const c = clip.clone()
    c.tracks = c.tracks.filter(t => {
        const [node, prop] = t.name.split('.')
        return prop === 'quaternion' || (prop === 'position' && node === 'pelvis')
    })
    c.tracks.forEach(t => t.optimize())
    if (body) {
        const ual = R.ual.scene.getObjectByName('pelvis').position
        const own = R.chars[body].getObjectByName('pelvis').position
        const t = c.tracks.find(t => t.name === 'pelvis.position')
        for (let i = 0; i < t.values.length; i += 3) {
            t.values[i] += own.x - ual.x; t.values[i + 1] += own.y - ual.y; t.values[i + 2] += own.z - ual.z
        }
    }
    return c
}

/** Clips-only GLB: the UAL bone hierarchy (no mesh; keeps UAL's pelvis rest for re-basing) + trimmed clips. */
async function exportClips(names) {
    let top = null
    R.ual.scene.traverse(o => { if (o.isBone && !top && !o.parent?.isBone) top = o })
    const holder = new THREE.Group()
    holder.name = 'UAL_Clips'
    holder.add(top.clone(true))
    holder.traverse(o => { if (o.isMesh) o.parent.remove(o) })
    const clips = names.map(n => trimClip(R.clips[n]))
    holder.updateMatrixWorld(true)
    const buf = await new GLTFExporter().parseAsync(holder, { binary: true, animations: clips })
    return { url: await toDataURL(new Blob([buf], { type: 'model/gltf-binary' })), bytes: buf.byteLength,
             tracks: clips.map(c => `${c.name}:${c.tracks.length}`) }
}

/**
 * Ground speed of an in-place locomotion clip: while a foot is planted (within 1.5 cm of
 * its lowest point) it slides backwards at the walking speed. Measured on `name`'s rig.
 */
function clipSpeed(name, clip, { bones = ['ball_l', 'ball_r'], thr = 0.025 } = {}) {
    const root = R.chars[name]
    root.position.set(0, 0, 0)
    const feet = bones.map(f => root.getObjectByName(f))
    const trimmed = trimClip(R.clips[clip], name)
    const dur = trimmed.duration, dt = 1 / 120
    const samples = []
    const p = new THREE.Vector3()
    for (let t = 0; t <= dur + 1e-6; t += dt) {
        poseAt(root, trimmed, t)
        root.updateMatrixWorld(true)
        samples.push(feet.map(f => p.setFromMatrixPosition(f.matrixWorld).toArray()))
    }
    // planted = within `thr` of the lowest point; the median of the backward slide rejects the
    // touch-down / lift-off frames that the threshold lets in
    const vs = []
    for (const k of [0, 1]) {
        const minY = Math.min(...samples.map(s => s[k][1]))
        for (let i = 1; i < samples.length; i++) {
            if (samples[i][k][1] > minY + thr || samples[i - 1][k][1] > minY + thr) continue
            vs.push(-(samples[i][k][2] - samples[i - 1][k][2]) / dt)
        }
    }
    vs.sort((a, b) => a - b)
    poseAt(root, null)
    return { clip, dur: +dur.toFixed(3), speed: vs.length ? +vs[vs.length >> 1].toFixed(3) : null,
             iqr: vs.length ? [+vs[vs.length >> 2].toFixed(2), +vs[(vs.length * 3) >> 2].toFixed(2)] : null, plantedSamples: vs.length }
}

// ─────────────────────────────────────────
// GUNS — Quaternius Ultimate Gun Pack (CC0), FBX → one small GLB
// ─────────────────────────────────────────
const GUN_DIR = 'guns_x/FBX/'
// The pack's materials are near-black; these read as steel, blued steel, walnut.
const GUN_COLORS = {
    Metal: '#4a4a4e', LightMetal: '#9a9aa0', Grey: '#6b4428',
    Wood: '#7a4f2e', DarkWood: '#5a3820', Black: '#2a2a2c',
}

/** Load pack models by name (e.g. 'Shotgun_SawedOff') into R.guns[name] = { root, box, size }. */
async function loadGuns(names = ['Revolver_1', 'Revolver_2', 'Revolver_3', 'Revolver_4', 'Revolver_5']) {
    const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js')
    const out = []
    R.guns = R.guns && !Array.isArray(R.guns) ? R.guns : {}
    for (const name of names) {
        const root = await new FBXLoader().loadAsync(`${R.base}${GUN_DIR}${name}.fbx`)
        root.updateMatrixWorld(true)
        const box = new THREE.Box3().setFromObject(root)
        const size = box.getSize(new THREE.Vector3())
        const mats = new Set()
        root.traverse(o => {
            if (!o.isMesh) return
            for (const m of (Array.isArray(o.material) ? o.material : [o.material])) mats.add(`${m.name}#${m.color?.getHexString()}`)
        })
        R.guns[name] = { root, box, size }
        out.push({ name, size: size.toArray().map(n => +n.toFixed(1)), mats: [...mats].join(' ') })
    }
    return out
}

/**
 * A textured glTF gun (Polyy.AI pack, ~1 unit long) into R.guns[name], scaled to the
 * Quaternius pack's units (190 units ≈ 28 cm) so contact sheets compare sizes. Its readme
 * says muzzles point -X, but the lever-action's points +X, the Quaternius convention, so
 * `flip` is opt-in. `length` in metres.
 */
async function loadGlbGun(name, url, length, { flip = false } = {}) {
    const g = await new GLTFLoader().loadAsync(R.base + url)
    const inner = g.scene
    inner.updateMatrixWorld(true)
    const b0 = new THREE.Box3().setFromObject(inner)
    const root = new THREE.Group()
    root.add(inner)
    if (flip) inner.rotation.y = Math.PI
    inner.scale.setScalar((length / 0.28 * 190) / (b0.max.x - b0.min.x))
    root.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(root)
    const size = box.getSize(new THREE.Vector3())
    const mats = []
    root.traverse(o => { if (o.isMesh) mats.push(`${o.name}:${o.geometry.index ? o.geometry.index.count / 3 : 0}t:${o.material.name}:${o.material.map ? o.material.map.image.width + 'px' : 'nomap'}`) })
    R.guns[name] = { root, box, size, textured: true }
    return { name, size: size.toArray().map(n => +n.toFixed(1)), mats: mats.join(' ') }
}

/**
 * Contact sheet: every loaded gun from the side (barrel to the right), all at ONE scale so
 * sizes compare, in a grid with labels. Assumes the pack's units are consistent (Revolver_5
 * is 190 units ≈ 28 cm).
 */
function viewGuns(names = Object.keys(R.guns), { cols = 3, colors = GUN_COLORS } = {}) {
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1b1e26)
    scene.add(new THREE.AmbientLight(0xffffff, 1.0))
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(1, 3, 4); scene.add(sun)
    const maxLen = Math.max(...names.map(n => R.guns[n].size.x))
    const rows = Math.ceil(names.length / cols)
    const cw = SIZE / cols, ch = SIZE / rows
    const camera = new THREE.OrthographicCamera(-0.55 * maxLen, 0.55 * maxLen, 0.55 * maxLen * ch / cw, -0.55 * maxLen * ch / cw, 1, 5000)
    camera.position.set(0, 0, 2000); camera.lookAt(0, 0, 0)
    octx.clearRect(0, 0, SIZE, SIZE)
    octx.font = '13px Courier New'
    renderer.setScissorTest(true)
    names.forEach((n, k) => {
        const g = R.guns[n]
        const c = g.box.getCenter(new THREE.Vector3())
        g.root.position.copy(c).multiplyScalar(-1)
        g.root.traverse(o => {
            if (!o.isMesh) return
            const tint = (m) => { const mm = m.clone(); if (colors[m.name]) mm.color.set(colors[m.name]); return mm }
            // an array on a geometry without groups draws nothing, so keep single materials single
            o.material = Array.isArray(o.material) ? o.material.map(tint) : tint(o.material)
        })
        scene.add(g.root)
        const cx = (k % cols) * cw, cy = Math.floor(k / cols) * ch
        renderer.setViewport(cx, SIZE - cy - ch, cw, ch)
        renderer.setScissor(cx, SIZE - cy - ch, cw, ch)
        renderer.render(scene, camera)
        scene.remove(g.root)
        octx.fillStyle = '#fff'
        octx.fillText(`${n}  ${(g.size.x * 0.28 / 190 * 100).toFixed(0)} cm`, cx + 6, cy + 16)
    })
    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, SIZE, SIZE)
    return true
}

/**
 * Bake a pack model into one mesh (vertex colours per source material, one draw call):
 * metres, barrel along +z, sights up +y, origin at the grip (where the right hand closes).
 * All anchor positions are FRACTIONS of the source bounding box, measured from the back
 * (x: 0 = butt end, 1 = muzzle end; y: 0 = bottom, 1 = top):
 *   grip    [fx, fy]  → the origin
 *   muzzle  fy        → muzzle point at the front, this height
 *   fore    [fx, fy]  → long guns: where the left hand holds
 *   butt    fy        → long guns: centre of the stock's end (sits on the shoulder)
 * `length` is the real length in metres.
 */
function bakeGun(name, { length = 0.28, colors = GUN_COLORS, grip = [0.12, 0.3], muzzle = 0.8, fore = null, butt = null, cutAbove = null } = {}) {
    const g = R.guns[name]
    g.root.position.set(0, 0, 0)
    g.root.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(g.root), size = box.getSize(new THREE.Vector3())
    const s = length / size.x
    const at = (fx, fy) => new THREE.Vector3(box.min.x + size.x * fx, box.min.y + size.y * fy, (box.min.z + box.max.z) / 2)
    const gripP = at(...grip)
    const xf = new THREE.Matrix4().makeRotationY(-Math.PI / 2)                   // +x (barrel) → +z
        .multiply(new THREE.Matrix4().makeScale(s, s, s))
        .multiply(new THREE.Matrix4().makeTranslation(-gripP.x, -gripP.y, -gripP.z))
    const anchors = { muzzle: at(1, muzzle).applyMatrix4(xf) }
    if (fore) anchors.fore = at(...fore).applyMatrix4(xf)
    if (butt != null) anchors.butt = at(0, butt).applyMatrix4(xf)
    if (g.textured) return bakeTextured(name, g, xf, anchors)
    const P = [], N = [], C = [], used = {}
    const col = new THREE.Color()
    g.root.traverse(o => {
        if (!o.isMesh) return
        const geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry
        const m = new THREE.Matrix4().multiplyMatrices(xf, o.matrixWorld)
        const nm = new THREE.Matrix3().getNormalMatrix(m)
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        const groups = geo.groups.length ? geo.groups : [{ start: 0, count: geo.attributes.position.count, materialIndex: 0 }]
        const p = new THREE.Vector3(), n = new THREE.Vector3(), w = new THREE.Vector3()
        // `cutAbove`: drop triangles lying wholly above this share of the height (a scope)
        const cutY = cutAbove == null ? Infinity : box.min.y + size.y * cutAbove
        const above = (v) => w.fromBufferAttribute(geo.attributes.position, v).applyMatrix4(o.matrixWorld).y > cutY
        for (const gr of groups) {
            const mat = mats[gr.materialIndex]
            // (contact sheets swap in recoloured clones, so look the colour up by NAME)
            if (colors[mat.name]) col.set(colors[mat.name]); else col.copy(mat.color)   // hex → linear
            used[mat.name] = colors[mat.name] ?? null
            for (let t = gr.start; t + 2 < gr.start + gr.count; t += 3) {
                if (above(t) && above(t + 1) && above(t + 2)) continue
                for (let v = t; v < t + 3; v++) {
                    p.fromBufferAttribute(geo.attributes.position, v).applyMatrix4(m)
                    n.fromBufferAttribute(geo.attributes.normal, v).applyMatrix3(nm).normalize()
                    P.push(p.x, p.y, p.z); N.push(n.x, n.y, n.z); C.push(col.r, col.g, col.b)
                }
            }
        }
    })
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3))
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3))
    geo.computeBoundingBox(); geo.computeBoundingSphere()
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.5 })
    mat.name = name
    const mesh = new THREE.Mesh(geo, mat)
    mesh.name = name
    const r3 = (v) => v.toArray().map(n => +n.toFixed(3))
    mesh.userData.anchors = Object.fromEntries(Object.entries(anchors).map(([k, v]) => [k, r3(v)]))
    R.gun = mesh
    R.baked = R.baked || {}
    R.baked[name] = mesh
    const bb = geo.boundingBox
    return { name, verts: P.length / 3, used, min: r3(bb.min), max: r3(bb.max), anchors: mesh.userData.anchors }
}

/**
 * bakeGun() for a textured model: same transform and anchors, but keeps UVs and the colour
 * map, downscaled to 512 px and stored as JPEG, instead of baking vertex colours.
 */
function bakeTextured(name, g, xf, anchors, texSize = 512) {
    const parts = []
    let map = null
    g.root.traverse(o => {
        if (!o.isMesh) return
        const geo = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone())
        geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(xf, o.matrixWorld))
        for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k)
        parts.push(geo)
        map ??= o.material.map
    })
    const P = [], N = [], UV = []
    for (const p of parts) {
        P.push(...p.attributes.position.array); N.push(...p.attributes.normal.array); UV.push(...p.attributes.uv.array)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3))
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2))
    geo.computeBoundingBox(); geo.computeBoundingSphere()
    const tex = new THREE.CanvasTexture(downscale(map.image, texSize, texSize))
    tex.flipY = false                                           // same UV convention as the source glTF
    tex.colorSpace = THREE.SRGBColorSpace
    tex.userData.mimeType = 'image/jpeg'
    const mat = new THREE.MeshStandardMaterial({ map: tex, metalness: 0.2, roughness: 0.6 })
    mat.name = name
    const mesh = new THREE.Mesh(geo, mat)
    mesh.name = name
    const r3 = (v) => v.toArray().map(n => +n.toFixed(3))
    mesh.userData.anchors = Object.fromEntries(Object.entries(anchors).map(([k, v]) => [k, r3(v)]))
    R.gun = mesh
    R.baked = R.baked || {}
    R.baked[name] = mesh
    const bb = geo.boundingBox
    return { name, tris: P.length / 9, textured: true, min: r3(bb.min), max: r3(bb.max), anchors: mesh.userData.anchors }
}

/**
 * Wheel / shop icons: each finished static/weapons/<id>.glb from the side, barrel to the
 * right, on a transparent `w`×`h` PNG with a little margin. Returns { id: dataURL }.
 */
async function weaponIcons(ids, { w = 256, h = 96 } = {}) {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h
    const r = new THREE.WebGLRenderer({ canvas: cv, alpha: true, antialias: true, preserveDrawingBuffer: true })
    r.setClearColor(0x000000, 0)
    const out = {}
    for (const id of ids) {
        const gltf = await new GLTFLoader().loadAsync(`/weapons/${id}.glb`)
        const scene = new THREE.Scene()
        scene.add(new THREE.AmbientLight(0xffffff, 1.1))
        const sun = new THREE.DirectionalLight(0xffffff, 1.8); sun.position.set(-2, 3, 1); scene.add(sun)
        scene.add(gltf.scene)
        gltf.scene.updateMatrixWorld(true)
        const b = new THREE.Box3().setFromObject(gltf.scene)
        const c = b.getCenter(new THREE.Vector3()), size = b.getSize(new THREE.Vector3())
        const half = Math.max(size.z / 2 / (w / h), size.y / 2) * 1.12      // fit length or height
        const cam = new THREE.OrthographicCamera(-half * w / h, half * w / h, half, -half, 0.01, 10)
        cam.position.set(c.x - 2, c.y, c.z)                                // from -x: barrel (+z) to the right
        cam.lookAt(c)
        r.render(scene, cam)
        out[id] = cv.toDataURL('image/png')
    }
    r.dispose()
    return out
}

/** Same grip as npc.js gripMatrix(): palm of hand_r in Pistol_Aim_Neutral, barrel along +z. */
function holdGun(key) {
    const root = R.chars[key]
    root.position.set(0, 0, 0)
    poseAt(root, R.trimmedFor ? R.trimmedFor(root, 'Pistol_Aim_Neutral') : 'Pistol_Aim_Neutral', 0)
    root.updateMatrixWorld(true)
    const hand = root.getObjectByName('hand_r'), knuckle = root.getObjectByName('middle_01_r')
    const palm = hand.getWorldPosition(new THREE.Vector3()).lerp(knuckle.getWorldPosition(new THREE.Vector3()), 0.55)
    palm.y += 0.015
    const local = hand.matrixWorld.clone().invert().multiply(new THREE.Matrix4().makeTranslation(palm.x, palm.y, palm.z))
    const g = R.gun.clone()
    g.matrix.copy(local)
    g.matrix.decompose(g.position, g.quaternion, g.scale)
    hand.add(g)
    poseAt(root, null)
    return true
}

async function exportGun(name = null) {
    const mesh = name ? R.baked[name] : R.gun
    mesh.removeFromParent()
    const buf = await new GLTFExporter().parseAsync(mesh, { binary: true })
    return toDataURL(new Blob([buf], { type: 'model/gltf-binary' }))
}

/**
 * Baked guns from the side, one per row, at their real relative size, with the anchors
 * marked: origin/grip (white), muzzle (yellow), fore-end (cyan), butt (magenta).
 */
function viewBaked(names = Object.keys(R.baked)) {
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1b1e26)
    scene.add(new THREE.AmbientLight(0xffffff, 0.9))
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(3, 4, 2); scene.add(sun)
    const dot = (c) => new THREE.Mesh(new THREE.SphereGeometry(0.008, 10, 8), new THREE.MeshBasicMaterial({ color: c, depthTest: false }))
    const rowH = SIZE / names.length
    const maxLen = Math.max(...names.map(n => { const b = R.baked[n].geometry.boundingBox; return b.max.z - b.min.z }))
    const half = 0.55 * maxLen
    const camera = new THREE.OrthographicCamera(-half, half, half * rowH / SIZE, -half * rowH / SIZE, 0.01, 10)
    octx.clearRect(0, 0, SIZE, SIZE)
    octx.font = '13px Courier New'
    renderer.setScissorTest(true)
    names.forEach((n, k) => {
        const mesh = R.baked[n], a = mesh.userData.anchors
        const grp = new THREE.Group()
        grp.add(mesh)
        const add = (p, c) => { const d = dot(c); d.position.set(...p); d.renderOrder = 9; grp.add(d) }
        add([0, 0, 0], 0xffffff); add(a.muzzle, 0xffd400)
        if (a.fore) add(a.fore, 0x00e5ff)
        if (a.butt) add(a.butt, 0xff3df2)
        const b = mesh.geometry.boundingBox
        const cz = (b.min.z + b.max.z) / 2, cy = (b.min.y + b.max.y) / 2
        scene.add(grp)
        camera.position.set(1, cy, cz); camera.lookAt(0, cy, cz)     // from +x: barrel (+z) points left
        renderer.setViewport(0, SIZE - (k + 1) * rowH, SIZE, rowH)
        renderer.setScissor(0, SIZE - (k + 1) * rowH, SIZE, rowH)
        renderer.render(scene, camera)
        scene.remove(grp)
        octx.fillStyle = '#fff'
        octx.fillText(`${n}  ${((b.max.z - b.min.z) * 100).toFixed(0)} cm`, 8, k * rowH + 16)
    })
    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, SIZE, SIZE)
    return true
}

// ─────────────────────────────────────────
// MODEL CHECK — any GLBs side by side (decimation before/after, orientation, scale)
// ─────────────────────────────────────────
/**
 * rows: [[url, label], …] per row. Each model is normalised to 1.8 tall, feet on the ground,
 * centred, and drawn in its own cell. `view`: 'front' | 'side' | 'face' (head close-up).
 */
async function viewModels(rows, { view = 'front' } = {}) {
    const loader = new GLTFLoader()
    const loaded = await Promise.all(rows.map(r => Promise.all(r.map(async ([url, label]) => {
        const g = await loader.loadAsync(url)
        const root = g.scene
        root.updateMatrixWorld(true)
        const b = new THREE.Box3().setFromObject(root), size = b.getSize(new THREE.Vector3())
        const holder = new THREE.Group()
        holder.add(root)
        const k = 1.8 / size.y
        root.scale.multiplyScalar(k)
        root.position.set(-(b.min.x + size.x / 2) * k, -b.min.y * k, -(b.min.z + size.z / 2) * k)
        let tris = 0
        root.traverse(o => { if (o.isMesh) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3 })
        return { holder, label, size: size.toArray().map(v => +v.toFixed(3)), tris }
    }))))
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1b1e26)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444033, 1.6))
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(2, 4, 5); scene.add(sun)
    const nRows = rows.length, nCols = Math.max(...rows.map(r => r.length))
    const cw = SIZE / nCols, ch = SIZE / nRows
    const camera = new THREE.PerspectiveCamera(view === 'face' ? 14 : 30, cw / ch, 0.05, 50)
    octx.clearRect(0, 0, SIZE, SIZE)
    octx.font = '12px Courier New'
    renderer.setScissorTest(true)
    loaded.forEach((row, ri) => row.forEach((m, ci) => {
        scene.add(m.holder)
        const lookY = view === 'face' ? 1.62 : 0.92
        const dist = view === 'face' ? 1.6 : 4.4
        const dir = view === 'side' ? [1, 0, 0] : [0, 0, 1]
        camera.position.set(dir[0] * dist, lookY + (view === 'face' ? 0.02 : 0.1), dir[2] * dist)
        camera.lookAt(0, lookY, 0)
        const x = ci * cw, y = ri * ch
        renderer.setViewport(x, SIZE - y - ch, cw, ch)
        renderer.setScissor(x, SIZE - y - ch, cw, ch)
        renderer.render(scene, camera)
        scene.remove(m.holder)
        octx.fillStyle = '#fff'
        octx.fillText(`${m.label}  ${Math.round(m.tris / 1000)}k`, x + 6, y + 15)
    }))
    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, SIZE, SIZE)
    return loaded.map(r => r.map(m => ({ label: m.label, size: m.size, tris: Math.round(m.tris) })))
}

// POSING + VIEW
const _mix = new Map()
function poseAt(root, clipName, t) {
    let m = _mix.get(root)
    if (!m) { m = new THREE.AnimationMixer(root); _mix.set(root, m) }
    m.stopAllAction()
    if (!clipName) return
    const clip = typeof clipName === 'string' ? R.clips[clipName] : clipName
    m.clipAction(clip, root).reset().play()
    m.setTime(t)
}

/** From now on, viewSheet poses each body with trimmed clips re-based to it (as in the game). */
function useTrimmedClips() {
    const raw = R.clips, cache = new Map()
    R.rawClips = raw
    const trimmedFor = (root, name) => {
        const body = Object.keys(R.chars).find(k => R.chars[k] === root)
        const key = body + '|' + name
        if (!cache.has(key)) cache.set(key, trimClip(raw[name], body))
        return cache.get(key)
    }
    R.trimmedFor = trimmedFor
    return true
}

/** Up to four poses per image (2x2): [{ clip, time, cam }], male and female side by side. */
function viewSheet(cells, { gap = 0.55, dist = 5.4, chars = ['male', 'female'], extra = null } = {}) {
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1b1e26)
    scene.add(new THREE.AmbientLight(0xffffff, 0.9))
    const sun = new THREE.DirectionalLight(0xffffff, 1.5)
    sun.position.set(2, 5, 4)
    scene.add(sun)
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial({ color: 0x252932 }))
    ground.rotation.x = -Math.PI / 2
    scene.add(ground)

    const roots = chars.map((k, i) => {
        const r = R.chars[k]
        r.position.set((i - (chars.length - 1) / 2) * gap * 2, 0, 0)
        scene.add(r)
        return r
    })
    if (extra) for (const e of extra) scene.add(e)

    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100)
    const dirs = { front: [0, 0, 1], side: [1, 0, 0], back: [0, 0, -1], three: [0.7, 0.15, 0.7] }
    const cell = SIZE / 2
    octx.clearRect(0, 0, SIZE, SIZE)
    octx.font = '14px Courier New'
    renderer.setScissorTest(true)
    cells.slice(0, 4).forEach((c, i) => {
        const cx = (i % 2) * cell, cy = Math.floor(i / 2) * cell
        for (const r of roots) poseAt(r, c.clip && R.trimmedFor ? R.trimmedFor(r, c.clip) : (c.clip || null), c.time || 0)
        const d = new THREE.Vector3(...dirs[c.cam || 'front']).normalize()
        camera.position.set(0, c.h ?? 0.95, 0).addScaledVector(d, c.dist ?? dist)
        camera.lookAt(0, c.h ?? 0.95, 0)
        renderer.setViewport(cx, SIZE - cy - cell, cell, cell)
        renderer.setScissor(cx, SIZE - cy - cell, cell, cell)
        renderer.render(scene, camera)
        octx.fillStyle = '#fff'
        octx.fillText(`${c.clip || 'bind pose'}  t=${(c.time || 0).toFixed(2)}  ${c.cam || 'front'}`, cx + 8, cy + 18)
    })
    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, SIZE, SIZE)
    return true
}

window.__npc = {
    R, THREE, init, loadAs, assemble, loadHat, headInfo, wearHat, mergeCharacter, paintAtlas, applyVariant,
    RECIPES, VARIANTS, build, exportGLB, variantJPEG, clipReport, restDiff, trimClip, exportClips, clipSpeed,
    useTrimmedClips, loadGuns, loadGlbGun, viewGuns, bakeGun, exportGun, viewBaked, holdGun, GUN_COLORS, weaponIcons,
    viewModels,
    viewSheet, poseAt, GLTFExporter, SkeletonUtils,
}
