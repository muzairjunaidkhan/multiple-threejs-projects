/**
 * ═══════════════════════════════════════════════════════════
 * cast.js — the people of Dead Mesa: bodies and their Mixamo clips
 * ───────────────────────────────────────────────────────────
 * Bodies, static/character/cast/<body>.glb, were rigged by Mixamo's auto-rigger and
 * baked by src/char-prep.js. Each is 1.8 tall with its feet at y = 0, and they all
 * carry Mixamo's skeleton ("mixamorigHips" …), so every clip in clips.glb binds to
 * every body by bone name.
 *
 * A clip keeps rotations everywhere and the hips' position. The hips track is stored
 * against clips.glb's own rest hip height, and clipsFor() scales it to a body's own,
 * because the bodies' legs differ in length.
 * ═══════════════════════════════════════════════════════════
 */

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

export const DIR = './character/cast/'
export const BODY_HEIGHT = 1.8
export const HIPS = 'mixamorigHips'

// Ground speed of each locomotion clip at timeScale 1, in m/s for a 1.8 body: the planted
// foot's backward slide (char-prep.js clipSpeed, the three bodies averaged). A clip plays at
// timeScale = speed / (CLIP_SPEED × the body's scale), so the feet don't skate.
export const CLIP_SPEED = {
    'Walking': 1.74, 'Running': 5.72, 'Fast Run': 5.53, 'Crouched Walking': 0.94,
    'Walking Backwards': 1.07, 'Left Strafe Walking': 1.65, 'Right Strafe Walking': 1.64,
    'Pistol Walk': 2.54, 'Pistol Run': 3.05, 'Rifle Walk': 1.16, 'Rifle Run': 3.08,
}

const loader = new GLTFLoader()
let clipSet = null                    // Promise<{ clips, hipsY }>
const perBody = new WeakMap()         // body asset scene → its scaled clips

/** clips.glb, once: { clips: { name: AnimationClip }, hipsY: the reference rest hip height }. */
export function loadClips() {
    clipSet ??= loader.loadAsync(DIR + 'clips.glb').then(g => ({
        clips: Object.fromEntries(g.animations.map(c => [c.name, c])),
        hipsY: g.scene.getObjectByName(HIPS).position.y,
    }))
    return clipSet
}

/** A body GLB's scene, with its skinned meshes set up for the game. */
export async function loadBody(file) {
    const g = await loader.loadAsync(DIR + file)
    g.scene.traverse(o => {
        // a skinned mesh's culling sphere is computed in the bind pose and goes stale as soon as it moves
        if (o.isSkinnedMesh) o.frustumCulled = false
    })
    return g.scene
}

/** The clips with their hips track scaled onto `body` (an asset scene; clones share its clips). */
export function clipsFor(body, set) {
    let out = perBody.get(body)
    if (out) return out
    const k = body.getObjectByName(HIPS).position.y / set.hipsY
    out = {}
    for (const [name, clip] of Object.entries(set.clips)) {
        const c = clip.clone()
        const t = c.tracks.find(t => t.name === `${HIPS}.position`)
        if (t) for (let i = 0; i < t.values.length; i++) t.values[i] *= k
        out[name] = c
    }
    perBody.set(body, out)
    return out
}

/** Load an extra colour variant of a body's texture (painted in glTF orientation, like the GLB's own). */
export function loadVariant(file) {
    return new THREE.TextureLoader().loadAsync(DIR + file).then(t => {
        t.flipY = false
        t.colorSpace = THREE.SRGBColorSpace
        return t
    })
}
