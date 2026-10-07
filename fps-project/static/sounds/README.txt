SOUND EFFECTS
=============

Served at /sounds/<name>.ogg  (static/ is Vite's publicDir — see vite.config.js).

The table that maps logical sound names to these files is MANIFEST in
src/game/audio.js. Renaming a file here without updating that table makes the
sound silently disappear: a buffer that fails to load is never registered, and
every play call for it becomes a no-op. That is deliberate — a missing asset
must not throw and break the game — but it means typos are silent.

SOURCE / LICENCE
----------------
Every file here is CC0 1.0 Universal (public domain dedication,
https://creativecommons.org/publicdomain/zero/1.0/). No attribution is required;
it is given anyway, in the in-game CREDITS screen.

  - doors, steps, UI, impacts: Kenney packs (below)
  - guns, gun handling, horses: real recordings (REAL RECORDINGS, further down)

All non-recorded files are from Kenney (https://kenney.nl):

  RPG Audio     — https://kenney.nl/assets/rpg-audio      (kenney_rpg-audio.zip,    965 KB)
  UI Audio      — https://kenney.nl/assets/ui-audio       (kenney_ui-audio.zip,     402 KB)
  Impact Sounds — https://kenney.nl/assets/impact-sounds  (kenney_impact-sounds.zip, 801 KB)

Only the files below were extracted from those packs and renamed to semantic
names, so the repo carries ~520 KB instead of 2.2 MB. The rename table is
reproduced here so the set can be rebuilt from the original packs at any time.

  RPG Audio                          ->  here
  ------------------------------------------------------
  doorOpen_1.ogg                     ->  door_open_1.ogg
  doorOpen_2.ogg                     ->  door_open_2.ogg
  doorClose_1.ogg                    ->  door_close_1.ogg
  doorClose_3.ogg                    ->  door_close_2.ogg
  doorClose_4.ogg                    ->  door_heavy.ogg
  creak1.ogg                         ->  creak_1.ogg
  creak3.ogg                         ->  creak_2.ogg
  handleCoins.ogg                    ->  money_gain.ogg
  handleCoins2.ogg                   ->  money_loss.ogg
  metalClick.ogg                     ->  latch_click.ogg
  metalLatch.ogg                     ->  latch_heavy.ogg
  bookOpen.ogg                       ->  board_open.ogg
  bookClose.ogg                      ->  board_close.ogg
  cloth1.ogg                         ->  swing_1.ogg
  cloth3.ogg                         ->  swing_2.ogg
  dropLeather.ogg                    ->  land_hard.ogg
  handleSmallLeather.ogg             ->  case_open.ogg
  handleSmallLeather2.ogg            ->  case_close.ogg

  UI Audio                           ->  here
  ------------------------------------------------------
  rollover2.ogg                      ->  ui_move.ogg
  click1.ogg                         ->  ui_select.ogg
  click3.ogg                         ->  ui_back.ogg
  switch2.ogg                        ->  ui_pause.ogg

  Impact Sounds (footsteps)          ->  here
  ------------------------------------------------------
  footstep_grass_000..004.ogg        ->  step_dirt_1..5.ogg    (default; soft, slightly gritty)
  footstep_snow_000..004.ogg         ->  step_gravel_1..5.ogg  (dry crunch)
  footstep_wood_000..004.ogg         ->  step_wood_1..5.ogg    (boardwalk)
  footstep_carpet_000..004.ogg       ->  step_soft_1..5.ogg    (muffled thud)

  Impact Sounds (gunfights)          ->  here
  ------------------------------------------------------
  impactPunch_medium_000..002.ogg    ->  hit_1..3.ogg          (a bullet finds a body)
  impactSoft_heavy_000..001.ogg      ->  bodyfall_1..2.ogg     (a body meets the ground)
  impactWood_light_000..002.ogg      ->  bullet_1..3.ogg       (a bullet finds wood / dirt)

FOOTSTEP LOUDNESS
-----------------
Every Kenney file is normalised to about -1 dBFS PEAK, so peak says nothing about
how loud a sound feels. The footsteps therefore do NOT play at raw sample level:
audio.js scales each footstep buffer at decode time to the same "active" RMS
(FOOTSTEP_TARGET_DB, samples above 10% of peak), so every surface plays at one
level. The in-game Settings panel > Audio has "Footsteps Volume" and
"Footstep Sound" (dirt / gravel / wood / soft); changing either plays a sample.
Both are remembered in localStorage (deadmesa.audio.v1).

The previous set (Kenney RPG Audio footstep00-09, boot-on-stone thumps) averaged
-11 dBFS active RMS and was played loudly enough to sit level with the doors; it
was replaced for being too loud and unpleasant.

REAL RECORDINGS  (guns, gun handling, horses — all CC0)
---------------
Cut, mixed and encoded by a scratchpad tool (build-sounds.mjs: ffmpeg + a few lines
of mixing): mono, 44.1 kHz Vorbis, peak-normalised.

  The Free Firearm Sound Library (Ben Jaszczak, Brian Nelson, Kevin Heras, Matthew
  Nanney) — https://opengameart.org/content/the-free-firearm-sound-library
  Each shot cut 3 ms before its onset, with its own outdoor echo, the tail faded.
    gun_revolver_1   Smith & Wesson 642 (.38 Special revolver), near     V_27P.wav
    gun_revolver_2   M1911 (.45), near                                   A_42P.wav
    gun_far_1 / _2   the same two, mid distance  (bandits' shots)        V_22P / A_34P
    gun_shotgun_1    Winchester Model 12 pump, 12 ga, near               K_22P.wav
    gun_shotgun_2    Benelli Nova pump, 12 ga, near                      O_21P.wav
    gun_rifle_1      Winchester Model 1894 lever action, near            L_23P.wav
    gun_rifle_2      Marlin 336 lever action, near                       I_22P.wav
    gun_rifle_3      Springfield 1917 bolt action, near                  B_24P.wav

  Equipment Clicks III (a real bolt-action rifle) — https://opengameart.org/content/equipment-clicks-iii
  Gun Reload Sound Effects (singlebullet1)        — https://opengameart.org/content/gun-reload-sound-effects
  Shotgun Reload Sound effects (Rack, First Shell) — https://opengameart.org/content/shotgun-reload-sound-effects
    dry_fire         one click
    reload_revolver  gate, six cartridges (0.28 + k·0.17 s), gate, hammer — 1.6 s, the
                     revolver reload's timing in combat.js
    reload_break     latch, snap open, two rounds, snap shut — 1.3 s
    shell_insert     one round into a tube magazine (played per round)
    cycle_pump / cycle_lever / cycle_bolt   the action worked between shots

  Horse gallop on different surfaces — https://opengameart.org/content/horse-gallop-on-different-surfaces
  (only its CC0 samples, all originally from freesound.org)
    hoof_1 / _2      single clops cut from "SFX - Horse - Trot" by MrFizzywig (a walk)
    gallop_1         one stride, "Single Horse Galopp" by D4XX
    gallop_2         one stride, "SRS_Foley_Horse_Galloping" by StephenSaldanha

NOT SAMPLED
-----------
The saloon piano has no file here. It is synthesised at runtime with Web Audio
oscillators, rendered once into an AudioBuffer, and then played through the same
positional voice pool as everything else. See the PIANO section of audio.js. The
same goes for Dead Eye's 'heartbeat', 'deadeye_in', 'deadeye_out' and 'deadeye_mark'.

FORMAT
------
.ogg (Vorbis) ONLY — that is all Kenney ships in these packs, and the recordings were
encoded to match.
Chrome, Edge and Firefox decode it natively. Safari did not support Ogg Vorbis
until 17.4 and it remains unreliable on iOS: there every decodeAudioData()
rejects, no buffer registers, and every play call no-ops. The game still runs
correctly, just silently. To support Safari, transcode:

    ffmpeg -i x.ogg -c:a aac -b:a 96k x.m4a

and make MANIFEST in audio.js pick the extension from a support probe.
