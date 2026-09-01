# Slow Light

Make a still deep-sky image move. Drop in a galaxy or nebula; Slow Light finds the stars and star-forming regions, sets them gently in motion, and exports a seamless loop at the image's native resolution. Everything runs on-device in the browser. Nothing is uploaded.

This is the shared rendering core. It runs in any modern browser today and is the same code that will ship inside the iOS and Android apps.

## Downloads without building anything

`.github/workflows/build.yml` makes GitHub build the apps for you. Once, do this:

1. Create a free GitHub account if you don't have one, and a new repository (public or private).
2. Put this folder in it. Easiest: GitHub Desktop, or drag the files onto the repository page in the browser (make sure the `.github` folder comes along; it's hidden on Windows by default).
3. Open the repository's **Actions** tab. A run called "Build apps" starts automatically. It takes about ten minutes.
4. When it's green, click the run. Under **Artifacts** you'll find `Slow-Light-Windows` (the installer), `Slow-Light-Android` (an APK you can install on any Android phone), and `Slow-Light-Mac`.

Every later push rebuilds all three. The Android build is a debug APK: it installs directly on a phone (allow "install from unknown sources" when asked) and is fine for you, friends, and a portfolio. Publishing to the Play Store needs a signed release build, which Android Studio walks you through.

## Files

```
index.html            landing page — the demo loop as hero, what it does, how it works
app.html              the tool
app.js                the rendering core (analysis, shaders, loop, export, UI wiring)
electron/main.js      desktop shell (window, save dialog, menu)
electron/preload.js   empty bridge, ready for native features later
package.json          npm scripts and installer config
capacitor.config.json mobile app id and settings
scripts/www.js        assembles www/ for the mobile build
build/icon.png        rasterised icon for installers
sw.js                 service worker: works offline after first visit
manifest.webmanifest  lets browsers install it like an app
icon.svg              app icon
assets/demo.mp4       1600px web preview of the demo loop (the native-res file is not in the repo)
assets/poster.jpg     hero poster and offline fallback
assets/og.jpg         social-share image
```

## Run it

Serve the folder — the service worker and manifest need http(s), not `file://`:

```
npx serve .
```

Then open the printed address. Firefox and Safari work for preview; export is most reliable in Chrome and Edge for now (see "What's next").

## Desktop app

The same files wrapped in Electron, so it opens in its own window from an icon with no browser around it.

```
npm install        # once; downloads Electron (~100 MB)
npm start          # opens Slow Light as a desktop app
npm run dist       # builds an installer for the OS you're on, into release/
```

`npm run dist` produces a Windows installer (`.exe`) on Windows, a `.dmg` on a Mac, and an AppImage on Linux. Building for another OS than the one you're on needs that OS (or a CI runner), which is normal for desktop apps.

Exports open a save dialog and reveal the file when done. The shell lives in `electron/main.js`; the app is untouched.

## Android app

The same files inside a native Android shell, via Capacitor. Test in the phone's browser first (below) — it's the same engine, and it takes two minutes instead of an hour.

**Check it on the phone before wrapping.** In this folder run `npx serve .`, read the Network address it prints, and open that address in Chrome on a phone on the same Wi-Fi. If rendering and export work there, they'll work in the app.

**Install Android Studio** from developer.android.com. Accept the defaults; it brings its own Java and the Android SDK. Open it once and let it finish downloading components.

**Set up the project (once):**

```
npm run android:setup
```

This installs Capacitor and the two plugins the app uses (Filesystem and Share, for saving exports), assembles the `www/` folder, and generates the `android/` project.

**Run or rebuild:**

```
npm run android
```

This refreshes `www/`, syncs it into the Android project, and opens Android Studio. There, press Run (the green triangle). Pick a real phone with USB debugging enabled if you have one — GPU and video behaviour on the emulator is not representative. To see the app's console from your PC, open `chrome://inspect` in desktop Chrome while the phone is connected.

**Build an installable APK** from Android Studio: Build → Generate App Bundles or APKs → APK. For the Play Store you'll generate a signed bundle instead; Android Studio walks you through creating the signing key.

What differs on mobile:
- Exports go through the system share sheet (save to Photos, Drive, send, ...) instead of a download.
- `www/` is generated — don't edit it. Edit `app.html`/`app.js` and run `npm run android` again. In `www/`, the tool is `index.html` and the landing page is `about.html`.
- Native-resolution export is the thing most likely to struggle on a phone: real-time recording of a 3600×2702 canvas is heavy, and some devices cap the recorder's frame size. If that shows up, the fix is a native encoder plugin, which is the next planned step after WebCodecs.

## Ship it

The whole thing is static files, so any static host works. The zero-cost path:

1. Create a public GitHub repository and push this folder to it.
2. In the repo, Settings → Pages → Source: Deploy from a branch → `main`, folder `/ (root)`.
3. A minute later it's live at `https://<you>.github.io/<repo>/`. Update the Source link in `index.html`'s footer to point at the repo.

Netlify and Cloudflare Pages are equally good if you'd rather drag-and-drop the folder. No build step, no config.

For a portfolio, link to the landing page, not the tool: the demo plays before anyone has to do anything, and the "How it works" section is the write-up.

## How it works

The effect is the same one prototyped in Python, moved onto the GPU.

1. **Analysis** (`analyze()` in `app.js`, plain JavaScript, runs once per image)
   - Stars: a top-hat filter against a smoothed background, local maxima above 1.35× the noise floor measured in blank sky, brightest first, capped at 3,000 with a minimum spacing so glints never stack. Each star keeps its real colour.
   - Star-forming regions: red excess (`R − 0.5B − 0.25G`) thresholded and connected-components labelled, up to 420 by area.
   - Flow mask: heavily blurred luminance, so gas moves and empty sky doesn't.

2. **Galaxy pass** (`FS_GALAXY`) — one fragment shader computes, for every output pixel, where to sample the source: a differential rotation whose angular speed falls with radius (`0.42 + 0.58 / (1 + r/rc)`), plus a slow displacement from four smooth random fields blended over the loop.

3. **Sprite pass** (`VS_SPRITE`/`FS_SPRITE`) — stars and knots are additive gaussian quads drawn with instancing. The twinkle dips below baseline as well as rising; the dip is a second draw with reverse-subtract blending.

4. **Loop** — every animated quantity is a function of loop phase `u ∈ [0,1)` with an integer number of cycles: rotation follows `½(1 − cos 2πu)`, each star has 3–11 cycles plus an integer beat, each knot 2–5, the bulge 1, the flow exactly 4 field transitions. Frame `u = 1` equals frame `u = 0`, so the loop is seamless by construction rather than by crossfade.

5. **Export** — sets the canvas backing store to the image's native size and records one loop with `MediaRecorder`, pushing frames manually so nothing is dropped.

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

**0. Replace the demo numbers if you change the demo image.** The landing page quotes 2,600 stars and 201 regions — those are from the galaxy this was built with. If you swap `assets/demo.mp4`, update them.

**1. Verify in a real browser.** This core was written and static-checked but not run in a browser yet. Open it, load an image, and paste anything from the developer console (F12) into the chat. Shader compile errors, if any, will be reported in the status line.

**2. Full-quality export with WebCodecs.** `MediaRecorder` is convenient but hands the codec and bitrate to the browser and records in real time. `VideoEncoder` gives explicit control and can run faster than real time. One constraint to design around: an image this size (3600×2702) exceeds H.264 level 5.2's frame-size limit, so hardware H.264 encoders may refuse it — VP9 or AV1 in a WebM container is the reliable default at native resolution, with H.264 offered when the frame fits.

**3. Move analysis to a Web Worker.** Detection takes a second or two on a 4K image and currently freezes the page while it runs.

**4. Mobile.** See "Android app" above. iOS is the same Capacitor project with `npx cap add ios`, but building it needs a Mac with Xcode.

**5. Presets and a gallery.** Tuned defaults for common targets (face-on spiral, edge-on, emission nebula, globular cluster) and somewhere for people to post results.

## Licence and image credits

Code: yours. Sample imagery you bundle from NASA is public domain; ESA/Hubble and ESA/Webb imagery is generally CC BY 4.0 and needs a credit line.
