# E-Ink Cam

A mobile web app that takes photos in the four colours a 4-colour e-ink panel can
actually display — **black `#000000`, red `#FF0000`, yellow `#FFFF00`, white
`#FFFFFF`** — and nothing else.

The viewfinder is the output: the live camera feed is quantised to the palette at
the panel's exact pixel resolution, so what you frame is what the panel shows. No
build step, no dependencies — plain HTML, CSS and JavaScript.

## Running it

Camera access requires a secure context, so `https://` or `localhost`:

```sh
npx http-server . -p 8080      # then open http://localhost:8080
```

To use it from a phone, host the folder anywhere static (GitHub Pages works —
serve from the repository root). Then **Add to Home Screen**: it installs as a
standalone PWA and works offline.

## Panel sizes

| Size      | Landscape | Portrait  |
|-----------|-----------|-----------|
| 296 × 128 | 296 × 128 | 128 × 296 |
| 400 × 300 | 400 × 300 | 300 × 400 |

The camera frame is centre-cropped to the panel's aspect ratio and downscaled in
halving steps (rather than one big jump) so fine detail survives the trip down to
a few hundred pixels.

The preview is sized to a whole-number multiple of the panel whenever it fits, so
the dither pattern is shown pixel-exact. When the panel is wider than the screen
(400 px on a 390 px-wide phone) it is resampled smoothly rather than by
nearest-neighbour, which would drop whole rows of the pattern.

## Shoot, upload, edit

Press the shutter and the app keeps the **full-resolution** frame, so everything
stays editable afterwards — crop, rotation and every filter re-run from the
original pixels rather than from an already-reduced image. The upload button
(bottom left) puts any photo from your library through exactly the same path.

Once a shot is taken or uploaded:

- **drag** the preview to reposition the crop
- **pinch** (or scroll) to zoom
- **↺ ↻** to rotate in quarter turns, **Flip** to mirror
- **Reset crop** to start the framing over

Crop and zoom work on the live viewfinder too, for framing before the shot.

## Render styles

| Style        | What it does |
|--------------|--------------|
| **Photo**    | Full tonal range via dithering. The default, best for real photographs. |
| **Cel**      | Blurs into flat regions, posterises, and inks the edges — anime/cel-shaded look. |
| **Vector**   | Heavier flattening; big poster-like shapes with clean outlines. |
| **Halftone** | Clustered-dot screen — reads like newsprint rather than noise. |
| **Sketch**   | Outlines only, black on white line art. |

**Dither** (Photo only) selects how quantisation error is handled:

- **Diffuse** — Floyd–Steinberg, serpentine scan. Most detail.
- **Atkinson** — diffuses only ¾ of the error; crisper, more contrast, classic Mac look.
- **Ordered** — fixed 8×8 Bayer matrix. Regular texture, no smearing.
- **Flat** — nearest colour, no dithering. Graphic and posterised.

**Ink palette** restricts which of the four inks may be used — `4-ink`, `Warm`
(pushes tones toward red/yellow), `Red` (black/white/red), `Yellow`
(black/white/yellow), `Mono` (black/white). Useful for two-colour panels, or for
a deliberate look.

## Text

Open the **Text** drawer, type a caption, and place it by dragging the preview;
pinch (or use the Size slider) to resize. While that drawer is open the preview's
drag and pinch belong to the caption — close it and they go back to the crop.

The caption is drawn **after** the image has been reduced to four colours, using
palette inks directly. Putting it through the dither instead would smear the
letterforms and destroy legibility at 296 × 128. Glyphs are rasterised at 3× and
thresholded at half coverage, which gives well-shaped letters with hard,
on-palette edges — no grey antialiasing a 4-colour panel could not show anyway.

Letters and outline each take any of the four inks; restricting the ink palette
disables the swatches it rules out, so a caption cannot smuggle a colour into a
two-tone panel. Outline thickness runs 0–8 px and is drawn outside the glyph.

Seven faces are offered — *Sans, Serif, Slab, Mono* for straight work and
*Poster, Round, Marker* for fun. These are **system fonts**, not webfonts, which
keeps the app self-contained and offline-capable; the trade-off is that
availability varies by platform. The stacks are written iOS-first (Impact,
Arial Rounded MT Bold, Bradley Hand), and fall back to generic bold sans, serif
or cursive elsewhere, so the playful faces look their best on an iPhone.

## Screen layout

The controls drawer is capped at 40% of the viewport and scrolls internally
rather than growing to fit its contents. Left to size itself it reached 410px on
an iPhone 13 — enough to push the preview down to its floor and overflow the
viewport entirely. With the cap, a 296 × 128 panel stays pixel-exact at 1:1 even
with the drawer open. The whole drawer is one scroll region rather than a page
with a separate scroller for the sliders, so a flick always moves the same thing.

## Adjustments

Exposure, brightness, contrast, saturation and gamma are applied *before*
quantisation, which is the only place they can meaningfully change the result —
with four colours available, tone mapping is most of the work. `Dither` sets
error-diffusion strength, `Outline` and `Smooth` drive the edge-based styles, and
`Zoom` is a digital crop.

## Saving

- **Save to Photos** — opens the system share sheet. On iPhone this is the only
  route from a web page into the photo album: choose *Save Image* and it lands in
  Photos rather than in Files. Shown wherever the browser can share files (as
  *Share image* on non-Apple platforms).
- **Download PNG** — exact panel resolution, 4 colours, no resampling.
- **Download .bin** — packed 2 bits per pixel for direct upload to a panel.

Saved shots are also kept in `localStorage` (last 24); tap one to download again.

Safari only permits `navigator.share()` directly from a user gesture, so the PNG
is encoded when the save sheet opens and the button shares the ready-made file —
awaiting the encode inside the tap handler would spend the gesture and Safari
would reject the call.

### .bin format

2 bits per pixel, MSB first, 4 pixels per byte, rows padded to a whole number of
bytes (`ceil(width / 4)` bytes per row), top-left origin, row-major. Colour codes:

| Code | Colour |
|------|--------|
| `0`  | black  |
| `1`  | white  |
| `2`  | yellow |
| `3`  | red    |

This is the layout most Waveshare-style 4-colour panels expect. If yours uses a
different code order, remap it by reordering `PALETTE` in `app.js` — the array
index *is* the code written to the file.

## Files

```
index.html    markup and controls
styles.css    dark, touch-first UI
app.js        capture, tone mapping, dithering, styles, export
sw.js         offline cache
manifest.json PWA metadata
```

Everything runs on the main thread against typed arrays; a 296 × 128 frame
processes in a few milliseconds, and the preview is capped at 30 fps.
