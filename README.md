# Slow Light

Make a still deep-sky image move. Drop in a galaxy or nebula; Slow Light finds the stars and star-forming regions, sets them gently in motion, and exports a seamless loop at the image's native resolution. Everything runs on-device. Nothing is uploaded.

## Download

No account or setup needed. Download the app from the **[latest release](https://github.com/orrerium-studios/Slow-Light/releases/latest)**:

| Platform | File |
|---|---|
| Windows | the `.exe` installer |
| Mac with Apple silicon | the `.dmg` |
| Android | `Slow-Light-Android.apk` |

Or use it in your browser with nothing to install: **[orrerium-studios.github.io/Slow-Light](https://orrerium-studios.github.io/Slow-Light/)**

## Files

```
index.html            landing page: the demo loop as hero, what it does, how it works
app.html              the tool
app.js                the rendering core (analysis, shaders, loop, export, UI wiring)
electron/main.js      desktop shell (window, save dialog, menu)
electron/preload.js   empty bridge, ready for native features later
android/              Android app project (Capacitor)
package.json          npm scripts and installer config
capacitor.config.json mobile app id and settings
scripts/www.js        assembles www/ for the mobile build
build/icon.png        rasterized icon for installers
sw.js                 service worker: works offline after first visit
manifest.webmanifest  lets browsers install it like an app
icon.svg              app icon
assets/demo.mp4       1600px web preview of the demo loop (the native-res file is not in the repo)
assets/poster.jpg     hero poster and offline fallback
assets/og.jpg         social-share image
LICENSE               GNU General Public License v3.0
```

## How it works

The effect is the same one prototyped in Python, moved onto the GPU.

1. **Analysis** (`analyze()` in `app.js`, plain JavaScript, runs once per image)
   - Stars: a top-hat filter against a smoothed background, local maxima above 1.35 times the noise floor measured in blank sky, brightest first, capped at 3,000 with a minimum spacing so glints never stack. Each star keeps its real color.
   - Star-forming regions: red excess (`R - 0.5B - 0.25G`) thresholded and connected-components labeled, up to 420 by area.
   - Flow mask: heavily blurred luminance, so gas moves and empty sky doesn't.

2. **Galaxy pass** (`FS_GALAXY`). One fragment shader computes, for every output pixel, where to sample the source: a differential rotation whose angular speed falls with radius (`0.42 + 0.58 / (1 + r/rc)`), plus a slow displacement from four smooth random fields blended over the loop.

3. **Sprite pass** (`VS_SPRITE`/`FS_SPRITE`). Stars and knots are additive gaussian quads drawn with instancing. The twinkle dips below baseline as well as rising; the dip is a second draw with reverse-subtract blending.

4. **Loop.** Every animated quantity is a function of loop phase `u ∈ [0,1)` with an integer number of cycles: rotation follows `½(1 - cos 2πu)`, each star has 3 to 11 cycles plus an integer beat, each knot 2 to 5, the bulge 1, the flow exactly 4 field transitions. Frame `u = 1` equals frame `u = 0`, so the loop is seamless by construction rather than by crossfade.

5. **Export.** The canvas backing store is set to the image's native size and one loop is recorded with `MediaRecorder`, pushing frames manually so nothing is dropped.

## Parameters

| Control | What it does | Python equivalent |
|---|---|---|
| Core sweep | Peak rotation of the core at mid-loop, degrees | `SWEEP_DEG` |
| Flow drift | Gas displacement, px (roughly a standard deviation) | `FLOW_AMP` |
| Star-forming glow | Gain on the knot pulse | `K_amp` scale |
| Twinkle strength | Gain on star glints | `S_amp` scale |
| Stars twinkling | How many of the detected stars animate, brightest first | detection cap |
| Length | Loop duration, seconds | `NFRAMES / FPS` |

The constant 1.045 crop (`P.zoom`) is the margin that lets the warps pull pixels from just outside the frame. It never animates.

## What's next

In order. Each is a self-contained step.

**0. Demo numbers follow the demo image.** The landing page quotes 2,600 stars and 201 regions, measured on the galaxy in `assets/demo.mp4`. A new demo image needs new numbers.

**1. Full-quality export with WebCodecs.** `MediaRecorder` is convenient but hands the codec and bitrate to the browser and records in real time. `VideoEncoder` gives explicit control and can run faster than real time. One constraint to design around: an image this size (3600 x 2702) exceeds H.264 level 5.2's frame-size limit, so hardware H.264 encoders may refuse it. VP9 or AV1 in a WebM container is the reliable default at native resolution, with H.264 offered when the frame fits.

**2. Move analysis to a Web Worker.** Detection takes a second or two on a 4K image and currently freezes the page while it runs.

**3. iOS.** The same Capacitor project with `npx cap add ios`, but building it needs a Mac with Xcode.

**4. Presets and a gallery.** Tuned defaults for common targets (face-on spiral, edge-on, emission nebula, globular cluster) and somewhere for people to post results.

## License and image credits

Copyright (C) 2026 Orrerium Studios LLC.

Slow Light is free software: you can redistribute it and/or modify it under the terms of the [GNU General Public License v3.0](LICENSE).

Imagery from NASA is public domain; ESA/Hubble and ESA/Webb imagery is generally CC BY 4.0 and needs a credit line.
