WEAPONS
=======

Every gun the player can own (src/game/weapons.js has the stats, prices and anchors) and the
bandits' revolver. One mesh each, one draw call. All in metres: barrel along +z, sights +y,
origin at the grip (where the right hand closes). The game draws them at 0.5 (the town is
modelled at half scale).

  file                 weapon (in game)           source model                       tris
  revolver.glb         Cattleman Revolver         Quaternius  Revolver_5            ~1.3k   (also the bandits')
  schofield.glb        Schofield Revolver         Quaternius  Revolver_1            ~1.0k
  double_action.glb    Double-Action Revolver     Quaternius  Revolver_2            ~1.3k
  sawed_off.glb        Sawed-off Shotgun          Quaternius  Shotgun_SawedOff      ~1.0k
  pump_shotgun.glb     Pump-action Shotgun        Quaternius  Shotgun_3             ~1.0k
  repeater.glb         Carbine Repeater           Polyy       lever_action_rifle    ~9.0k   (textured, 512 px JPEG)
  bolt_rifle.glb       Bolt-action Rifle          Quaternius  SniperRifle_6, scope cut off   ~0.7k
  rolling_block.glb    Rolling Block Rifle        Quaternius  SniperRifle_1 (scoped) ~1.4k

  icons/<id>.png       256×96 side views on transparent backgrounds (weapon wheel, gunsmith)

SOURCE / LICENCE  (both CC0 1.0; credited in the in-game CREDITS screen anyway)
----------------
  Ultimate Gun Pack by Quaternius        https://quaternius.itch.io/ultimate-guns-pack
  3D Low-Poly Guns Pack by Polyy (low-poly LOD edition)
                                         https://polyyai.itch.io/3d-low-poly-guns-pack
      Polyy's own note (not a licence condition): please don't resell their pack unmodified.

The Quaternius pack has no lever-action rifle, and no unscoped bolt rifle; the repeater comes
from Polyy, and the bolt rifle is SniperRifle_6 with every triangle above 74 % of its height
(the scope and rings) removed. The pack's pistols are modern semi-automatics and were left out.

HOW THEY WERE BUILT
-------------------
src/npc-prep.js (dev only):  loadGuns([...]) / loadGlbGun(...) → viewGuns() contact sheet →
bakeGun(name, { length, grip, muzzle, fore, butt, cutAbove, colors }) → viewBaked() (anchor
check: grip white, muzzle yellow, fore-end cyan, butt magenta) → exportGun(name).
Flat-coloured pack models become vertex colours (the source materials are near-black, so they
are recoloured to steel / blued steel / walnut); the textured repeater keeps its UVs and a
downscaled colour map. weaponIcons(ids) renders icons/.

Anchors are fractions of each source model's bounding box (x from the butt end, y from the
bottom), turned into metres in the baked frame; weapons.js stores the results:
  muzzle — flash and tracer start;  fore — where the left hand holds a long gun;
  butt   — the end of the stock, set against the right shoulder when aiming.
