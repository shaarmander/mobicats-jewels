# Mobicat’s Jewels

A free, browser-based ring designer and jewelry viewer. Pick a setting, compare cuts at the same carat weight, and rotate the ring under five studio lighting rigs.

**[Open the live viewer](https://jewels.mobicat.club/)**

[![A three-diamond trilogy rotating under the studio softbox](docs/diamond-orbit.webp)](https://jewels.mobicat.club/#v=1&setting=trilogy&cut=emerald&center=natural-diamond&accent=natural-diamond&profile=classic&metal=yellow-gold&carats=1.5&rig=softbox&sparkle=0&eye=-16.71818,29.4,38.93665&target=0,2.4,1.5)

[Open the ring from this clip](https://jewels.mobicat.club/#v=1&setting=trilogy&cut=emerald&center=natural-diamond&accent=natural-diamond&profile=classic&metal=yellow-gold&carats=1.5&rig=softbox&sparkle=0&eye=-16.71818,29.4,38.93665&target=0,2.4,1.5)

## Try it

- The studio opens on a 1.50 ct emerald-cut natural diamond with two diamond side stones in 18k yellow gold. Choose **Share this ring** to copy a link to your design and camera angle or save a clean PNG at the current canvas resolution. Individual accent colors, the ring position, focus and light settings travel with the link.
- Open **Ring design** to choose among 18 settings, 18 center cuts, 86 gemstone entries and seven metals. On a phone, tap the sliders icon in the bottom toolbar.
- Choose **Fine**, **Classic** or **Bold** under Ring design. Classic is the default. On touchscreens, tapping the center stone opens its cut gallery. **Change gemstone** opens the color library. Each side or pavé stone can have its own gem. Tap the band to choose a metal or change the setting.
- Tap **Try on** to use your camera. Show the back of your hand with your fingers spread, then adjust **Visual fit**. The camera, tracking model, and ring render run locally. Closing try-on or leaving the tab stops the camera. Visual fit is an estimate.
- Use **Center weight** to explore 0.50–3.00 ct in 0.05 ct steps. Carats measure mass. Dimensions depend on both the stone’s cut and its density.
- Drag to orbit, scroll or pinch to zoom, and choose **Move ring** to drag it across the floor. The camera panel includes sparkle, depth of field and surface focus. The bottom corner shows the current frame rate during motion.

## Run locally

Use Node.js 22 and npm.

```sh
npm ci
npm run dev
```

Open [the local viewer](http://127.0.0.1:4181/). All meshes, lighting and texture assets needed to run it are included.

```sh
npm run build
npm run preview
```

The production build is a static site in `dist/` and can be served from any web host at the domain root. The included Wrangler configuration describes the Mobicat deployment.

## Rendering

The Three.js / WebGL 2 renderer follows refracted and reflected rays through each stone’s facet planes. Light absorption depends on distance inside the stone. Shared HDR studio lighting and local reflection probes shade the polished casting. Directional floor caustics are baked for each reference setting and cut, then adjusted for light direction, material and center-stone size at runtime.

The materials estimate at the top uses the volume of the fitted metal and the individual weight and material of every stone. Open the estimate for the breakdown and [pricing references](docs/pricing.md).

During camera motion, depth of field uses a single shaded view and a depth-aware aperture filter. When the camera rests, devices with floating-point render targets progressively add 24 optical views. A contrast-directed resolve smooths reflections during orbit. At rest the renderer integrates eight subpixel samples with a closed aperture. The refitted ring rests on the floor as the center weight changes. Each casting has an offline fit binding with independent displacements for the three profiles and stone size. A smooth spatial cage constrains prong and gallery cross-sections, anchors the bearing to the gemstone, and holds the lower shoulders fixed during carat changes. Carat adjustments are a visual fitting approximation. The center setting uses tapered claws and a scalloped gallery. The offline pipeline fits each claw to the crown of its cut before welding the setting to the band.

The `tools/` directory contains the optional offline asset pipeline. Regenerating native CAD starts with a Gemmo Studio source tree containing `crates/gemmo_core`. Running or modifying the web viewer uses the assets in this repository. npm prepares the local tracking runtime before development and production builds. The browser loads the hand model and WebAssembly runtime when someone opens try-on. The try-on uses the visible ring finger to center the band, estimates roll from the palm, and filters position, rotation and diameter separately. A small local image sample refines the fit when both finger edges are distinct.

## Release checks

The [matched renderer comparison](docs/renderer-check.md) includes the round solitaire and emerald-cut trilogy at three camera angles.

| Device | Test | Result |
| --- | --- | --- |
| Desktop Chrome, RTX 5080 | 1440 � 900, rotating pav� trilogy, 60% depth of field | 240 FPS on the November 17 desktop run |
| Physical iPhone, Safari | Five-minute orbit and camera try-on | Awaiting device recording |
| Physical midrange Android, Chrome | Five-minute orbit and camera try-on | Awaiting device measurement |

To repeat the phone check, [open the pav� trilogy](https://jewels.mobicat.club/#v=1&setting=cluster&cut=round&center=natural-diamond&accent=natural-diamond&aperture=0.6). Start the turntable with the play button, let it run for five minutes and record the FPS readout in the final 30 seconds. Try three setting changes, start camera try-on and return to the studio. Record the model, browser, time to the first usable ring, sustained FPS range and any problems with tapping or camera recovery. The phone target is 30 FPS or higher during orbit.

## License

The viewer code and original generated jewelry assets use the [MIT License](LICENSE). Mobicat’s name and logo identify the project. Three.js retains its [own MIT copyright notice](public/third-party/three-LICENSE.txt).

The tracking runtime is Google’s MediaPipe Tasks Vision ([Apache 2.0 notice](public/third-party/mediapipe-LICENSE.txt)). The bundled hand model is the Google float16 v1 [Hand Landmarker model](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task).
