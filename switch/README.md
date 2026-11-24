# Nintendo Switch homebrew port (work in progress)

This directory holds the native Switch port of SKYBOUND. It is **not** the finished game yet.

## Status

| Piece | State |
| --- | --- |
| devkitA64 + libnx build | ✅ builds a real `.nro` |
| Window, input, main loop | ✅ implemented here |
| 3D renderer | ⛔ not started — the web build uses WebGL, which does not exist on Switch homebrew |
| Level generation, physics, world | ⛔ not started — currently JavaScript in `js/` |
| Menus, options, save data | ⛔ not started |
| `.nsp` packaging | ⛔ blocked — needs a title-packaging step and console keys, see below |

Run it from the Homebrew Menu on a Switch with CFW, or on an emulator. It boots to a text
screen, shows the toolchain/input status, and exits on `+`.

## Why this is a rewrite and not a repackage

The desktop and Android builds are the same HTML/JS bundle rendered by Chromium's WebGL. Homebrew
on Switch gives you libnx and a framebuffer (deko3d, or EGL/GLES through Mesa) — no browser, no
JavaScript engine, no WebGL. So a port means reimplementing the game natively:

1. **Platform layer** (this directory): window/swapchain, `HidNpad` input mapped to the existing
   move/jump/dash/pause actions, frame timing.
2. **Renderer**: the world is already deterministic boxes and simple meshes, so a deko3d renderer
   with one shader for lit geometry, one for emissive pickups, and a simple particle path covers
   it. The character is a handful of primitive meshes.
3. **Simulation**: port `js/levelgen.js`, `js/world.js` and the physics in `js/player.js`. These are
   pure math and carry over almost line for line — the level generator is seeded and has no
   dependencies.
4. **UI**: the menus are DOM today; on Switch they become quads plus the same focus-ring navigation
   logic, which is already a flat list of items per screen.
5. **Audio**: `js/audio.js` synthesises tones through WebAudio; the native equivalent is
   `audren`/`audout` with the same envelopes.

Until steps 2–5 are done, **there is no playable Switch build**, and the repository description
says so.

## Building the `.nro`

```bash
export DEVKITPRO=/c/devkitPro
export DEVKITA64=$DEVKITPRO/devkitA64
cd switch
make            # produces SKYBOUND.nro next to the Makefile
```

Copy `switch/SKYBOUND.nro` to `/switch/` on the SD card and launch it from the Homebrew Menu, or
send it over the network with `nxlink -s switch/SKYBOUND.nro`.

## About `.nsp`

An `.nsp` is an installable title package, not a build target of devkitA64. Producing one means
repacking the homebrew binary into NCAs with a ticket using tools such as `hacBrewPack`, which
requires the console's `prod.keys`. Those keys are not in this repository, are not something this
project can ship, and dumping them is outside what this port does. There is therefore **no `.nsp`
artifact**, and the release notes say so.
