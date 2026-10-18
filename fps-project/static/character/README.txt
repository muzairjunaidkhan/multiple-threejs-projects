CHARACTERS
==========

Everything the game loads is in cast/ (src/game/cast.js, player.js, npc.js, horse.js).
(The earlier cast — Cowboy.glb, Y Bot.fbx, the Quaternius npc/ folder and static/animations/ —
has been deleted.)


CAST  (cast/)
====

  player.glb      the player   (GA 451 Rugged Cowboy)        18k tris, 2048² base colour (JPEG)
  townsman.glb    townsfolk    (Cowboy - western 01)         18k tris, 1024²
  bandit.glb      bandits      (Cowboy Character Model)      18k tris, 1024²
  townsman_<tan|grey|olive|wine>.jpg, bandit_<dust|dark>.jpg
                  recoloured textures on the same UVs; npc.js swaps them onto a shared
                  material (painted in glTF orientation: load with flipY = false)
  clips.glb       33 Mixamo clips on a bare Mixamo skeleton (no mesh)
  horse.glb       the horse: 30k tris, 15 of its own clips

Each body is one skinned mesh (one draw call) on Mixamo's skeleton (33 bones,
"mixamorigHips" ...), baked 1.8 tall with its feet at y = 0. The game scales the player
×0.533 (0.96 u) and NPCs ×0.5.

SOURCE / LICENCE  (credited in-game, CREDITS screen)
----------------
  player    "GA Free_451_Rugged Cowboy - High Poly" by Galaxy Abundant — CC-BY 4.0
            https://sketchfab.com/3d-models/ga-free-451-rugged-cowboy-high-poly-7a8b66096bdd454ebc5aa99e6ff388ce
  townsfolk "Cowboy - western 01" by ALTEREGO (v.a.c.u.u.m.) — CC-BY 4.0
            https://sketchfab.com/3d-models/cowboy-western-01-9df692aa75c24fbe9ec695f5626a1cb7
  bandits   "Cowboy Character Model" by arok59520 — Sketchfab Free Standard licence
            https://sketchfab.com/3d-models/cowboy-character-model-86be1d4e5a4640788c4cd9b16256b159
  horse     "Horse" by Henry S (https://sketchfab.com/henry_7; horse.glb's metadata still carries the
            old username henrysteve973) — CC-BY 4.0
            https://sketchfab.com/3d-models/horse-a6f860e43e364619bccb174a1ac7d0c9
  clips     Adobe Mixamo (https://www.mixamo.com), downloaded as FBX, without skin, 30 fps

HOW THEY WERE MADE
------------------
 1. Shrink (Node, gltf-transform + meshoptimizer; a scratchpad tool, not in the repo):
    the 400-650k-triangle sources simplified to ~18k, textures to base colour only, then
    written as OBJ + MTL + JPEG zips for Mixamo's uploader. The bandit needed the
    "permissive" simplifier with heavy UV weights so its face texture didn't tear.
 2. Rig: Mixamo's auto-rigger (markers placed by hand), downloaded as FBX Binary, T-pose,
    with skin. The FBX only references its texture by path, so the texture is re-applied.
 3. Bake: src/char-prep.html + src/char-prep.js (dev only; never part of `npm run build`):
      __char.loadChar(key, fbxUrl, textureUrl)   1.8 tall, feet on the ground (moved into
                                                 the hips bone, so the clips' hips track
                                                 scales right), vertices welded
      __char.loadClips(base, names); processClip(name, { xz, flatUp })
                                                 rotations + the hips position; locomotion
                                                 clips detrended (in place, sway kept);
                                                 Jump / Roll / Reload hips pinned
      __char.paintVariant(key, rules)            hue-range recolour -> JPEG
      __char.exportChar(key), exportClips(names) GLB
    clipSpeed() and footContacts() measured the ground speed of each locomotion clip
    (cast.js CLIP_SPEED) and the frames where the feet land (player.js STEPS).
 4. Horse: slimmed in Node (clips renamed, constant scale channels dropped, keyframes
    resampled, textures 2048 / 1024 JPEG). Its walk and gallop hoof speeds and hoofbeats are
    in horse.js.

Mixamo has no horse-riding clip: the rider plays Sitting Idle with the legs reshaped in
code (player.js animate, script.js RIDER_POSE), the left hand stays on the reins (the left
arm is its own layer), and aiming turns the back at most ~23° per spine bone so the skin
doesn't wring. Mixamo's Hit Reaction is a crouched one, so the player flinches in code;
bandits use the clip and duck.
