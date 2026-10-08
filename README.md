# Neon Snake: Ultimate 2

The next cut of Neon Snake: Ultimate. Still a single HTML file with no build step and no dependencies — now with a snake that is genuinely lit in 3D, a soundtrack that arranges itself, and a scoreboard with gears in it.

**Play it:** https://gabarsolon.github.io/neon-snake-ultimate-2/

It builds on [Neon Snake: Ultimate](https://github.com/Gabarsolon/neon-snake-ultimate), which builds on [Neon Snake Merged](https://github.com/Gabarsolon/neon-snake-merged).

## What's new in 2

- **The snake is lit in WebGL:** real tube geometry with union end caps, two-light shading, subsurface glow, fresnel rim and a reflection of the nebula behind it. Eyes are punched out of the shading so the glow shows through, and the body splits into two lit runs when it straddles a portal wall.
- **The frame is graded like film:** half-float bloom, god rays, anamorphic streaks, barrel distortion with scanlines (CRT), chromatic aberration, grain and vignette — with a quality scaler that keeps the frame budget honest on weak hardware.
- **The soundtrack plays along:** the loop turns into a new key every fourth phrase, a lead answers at the end of every other phrase, and every eighth phrase drops the kick and bass for one bar — a riser carries you into the key change. Overdrive sweeps the whole track open and lifts the arpeggio an octave; high combos duck the pads to make room for the drums.
- **Odometer score:** every digit is its own reel of 0–9 sliding behind a window, on the HUD and on the game-over total.
- **Combos overheat the frame:** every bite lands harder as the combo climbs, and past ×4 the picture tips into fever — chromatic swirl, rainbow sheen, beat-synced pulses, spectrum-flickering highlights and a chromatic-splitting HUD. Impacts zoom blur the frame, orbs carry orbiting sparks and a spinning twinkle, the tube races with energy veins, and the attract demo runs hot on purpose.
- **Everything from Ultimate is still here:** overdrive, golden orbs, Nova, combos and banners, 7 themes, portal or solid walls, three paces, CRT, attract mode, touch controls, top 3 scores, saved settings, reduced motion, and a 2D fallback for browsers without WebGL.

## Controls

| Action | Keyboard | Touch |
| --- | --- | --- |
| Steer | Arrow keys or WASD | Swipe or D-pad |
| Start | Space or Enter | Tap |
| Overdrive boost (hold) | Space or Shift | BOOST button |
| Pause | P or Esc | Pause button |
| Sound on/off | M | Speaker button |

Options on the title, pause and game-over screens: 7 colour themes, solid or portal walls, Chill / Normal / Insane pace, CRT filter, and separate sound effect and music toggles.

## Run locally

Open `index.html` in any modern browser.

## Tests

`test/` holds a headless harness built on plain Node and Chrome DevTools — no packages to install. It drives every scene (boot, menu, gameplay, overdrive, golden, Nova, death, themes, portal, CRT, touch, reduced motion, pacing, audio) and checks the render pixels, the game invariants, the audio scheduler and the DOM overlays.

```
node test/harness.mjs                     # the whole suite
node test/harness.mjs --only=crt,phone    # a subset, --quiet to drop the ascii frames
```

Screenshots land in `test/shots/`.
