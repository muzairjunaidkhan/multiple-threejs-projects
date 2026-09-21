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
All files are from Kenney (https://kenney.nl), released under CC0 1.0 Universal
(public domain dedication, https://creativecommons.org/publicdomain/zero/1.0/).
No attribution is required; it is given anyway, in the in-game CREDITS screen.

  RPG Audio  — https://kenney.nl/assets/rpg-audio   (kenney_rpg-audio.zip, 965 KB)
  UI Audio   — https://kenney.nl/assets/ui-audio    (kenney_ui-audio.zip,  402 KB)

Only the files below were extracted from those packs and renamed to semantic
names, so the repo carries ~420 KB instead of 1.4 MB. The rename table is
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
  footstep00.ogg                     ->  footstep_1.ogg
  footstep02.ogg                     ->  footstep_2.ogg
  footstep04.ogg                     ->  footstep_3.ogg
  footstep05.ogg                     ->  footstep_4.ogg
  footstep07.ogg                     ->  footstep_5.ogg
  footstep09.ogg                     ->  footstep_6.ogg
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

NOT SAMPLED
-----------
The saloon piano has no file here. It is synthesised at runtime with Web Audio
oscillators, rendered once into an AudioBuffer, and then played through the same
positional voice pool as everything else. See the PIANO section of audio.js.

FORMAT
------
.ogg (Vorbis) ONLY — that is all Kenney ships in these two packs.
Chrome, Edge and Firefox decode it natively. Safari did not support Ogg Vorbis
until 17.4 and it remains unreliable on iOS: there every decodeAudioData()
rejects, no buffer registers, and every play call no-ops. The game still runs
correctly, just silently. To support Safari, transcode:

    ffmpeg -i x.ogg -c:a aac -b:a 96k x.m4a

and make MANIFEST in audio.js pick the extension from a support probe.
