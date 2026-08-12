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

| Size      | Composed landscape | Composed portrait | Always exported |
|-----------|--------------------|-------------------|-----------------|
| 296 × 128 | 296 × 128          | 128 × 296         | **296 × 128**   |
| 400 × 300 | 400 × 300          | 300 × 400         | **400 × 300**   |

A panel's frame buffer is a fixed landscape raster — a 296 × 128 module is 296
across however you hang it on the wall. Composing in portrait is a framing
choice, not a different panel, so **exports are always written in the panel's
native landscape orientation**, with a portrait composition turned a quarter
turn on the way out. The preview stays portrait; only the file rotates.

Which way it turns depends on how the module is mounted, so the save sheet
offers **↻ CW** or **↺ CCW** whenever the composition is portrait, and states
the sizes outright — *Composed 128×296, exported 296×128*.

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

- **drag** to reposition the crop
- **pinch** (or scroll) to zoom
- **↺ ↻** to rotate in quarter turns, **Flip** to mirror
- **Reset crop** to start the framing over

Crop and zoom work on the live viewfinder too, for framing before the shot.

Gestures are picked up across the **whole preview area**, not just the canvas
itself: a portrait 296 × 128 panel is only 128 px wide on screen, which is not
enough to land two fingers on, so a pinch may start anywhere in the empty space
beside it.

## Camera permission

A web page cannot ask for a permission that lasts — whether a grant is
remembered is the browser's decision. What the app does is avoid asking when it
does not have to:

- the permission state is queried first, and `getUserMedia` is never called when
  the answer is already *denied* — that just re-raises a prompt to fail again
- returning to the foreground only resumes a camera that was already granted;
  it used to call `getUserMedia` every time the app came back, which on iOS is a
  fresh prompt each time
- a blocked camera explains where to re-enable it and offers **Try again**
  rather than needing a reload, and a grant made in browser settings is picked
  up without one

On iOS, two things make it stick: **add the app to the Home Screen**, which
gives it its own permission scope, or allow the camera for the site in
**Settings › Safari › Camera** (or *aA* › Website Settings › Camera). In an
ordinary Safari tab without that, iOS asks again each session, and no amount of
page code changes it.

## Render styles

| Style        | What it does |
|--------------|--------------|
| **Photo**    | Full tonal range via dithering. The default, best for real photographs. |
| **Cel**      | Blurs into flat regions, posterises, and inks the edges — anime/cel-shaded look. |
| **Vector**   | Heavier flattening; big poster-like shapes with clean outlines. |
| **Halftone** | Clustered-dot screen — reads like newsprint rather than noise. |
| **Sketch**   | Outlines only, black on white line art. |
| **Thermal**  | False colour: the palette read as a brightness ramp rather than as hues. |
| **Riso**     | Spot-colour print, one pass per ink, deliberately out of register. |
| **Engrave**  | A line screen — line thickness tracks tone, in the local ink. |
| **Hatch**    | Crosshatching; further directions cut in as the tone deepens. |
| **Contour**  | Iso-luminance lines, coloured by band, like a topographic map. |

**Thermal** is the odd one: black → red → yellow → white happens to be a rising
luminance sequence, so the panel can carry a false-colour image with more tonal
steps than matching hues ever gives it. Faces and skies come out nothing like
life, which is the point.

**Riso** prints each ink as its own pass and offsets them, so colours fringe at
the edges the way a real risograph misregisters. Black is drawn last and covers
what is under it, so it is reserved for genuinely dark tone — at a mid threshold
it swallows saturated reds and the whole print turns grey.

**Engrave**, **Hatch** and **Contour** ink their lines in the nearest colour to
what is underneath rather than always black, so a red shirt gets red hatching.

Those five share one **Detail** slider, relabelled to whatever it means for the
style: *Misregister*, *Line gap*, or *Spacing*.

**Sketch** and **Contour** add a **Line weight** slider (1–4 px). A one-pixel
line is the first thing to disappear if panel software rescales or re-dithers
the image on its way to the display, and it is marginal on the panel itself, so
weight buys lines that survive the trip.

## Getting it onto a panel

Panel apps generally re-process whatever you upload, which can undo the work:

- **Turn their dithering off.** These exports are already exactly four colours,
  so a second pass of Floyd–Steinberg re-quantises pixels that were already
  final and breaks solid one-pixel lines into scattered dots. If the uploader
  offers *Pure Color* / *no dither* alongside Floyd–Steinberg or Atkinson,
  choose that.
- **Do not let it rescale.** Place the image at exact size, with the cell set to
  the panel's resolution. Any resize interpolates hard edges into intermediate
  greys, which the app's dithering then scatters.
- **Avoid yellow for thin lines.** Yellow on white is very low contrast on a
  physical panel — fine for fills, nearly invisible for hairlines. The `Mono`
  ink palette forces line styles to solid black, which is the safest choice for
  line art.
- **Raise Line weight** if detail still drops out.
- **Never let it become a JPEG.** JPEG cannot represent hard 4-colour edges: the
  same export saved as JPEG q0.9 goes from 4 distinct colours to **6,541**, with
  only 26% of pixels still exactly on-palette. If a step in the chain
  re-encodes as JPEG, no dithering setting downstream can recover it.

### Checking a file

Judging this by eye on a phone does not work. Zooming interpolates, and iOS
screenshots are re-tagged to the display's colour space, so a perfectly pure
file still shows pink and cream fringes on screen — the impurity is in the
screenshot, not the file.

**About › Check a file** takes any image and reports what it actually contains:
type, dimensions, every distinct colour, and what share of pixels are exactly
the four inks. Run it on an export to confirm it left clean, and on anything you
can retrieve from the panel software to see what that software did to it.

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
pinch (or use the Size slider) to resize.

Up to **three captions** are supported. The numbered tabs at the top of the
drawer switch between them and **＋** adds another; each carries its own text,
font, size, inks and position, and they stack in order so caption 3 draws over
caption 1. New captions start at staggered heights so they do not land on top of
each other. The **×** removes the caption being edited (or empties it, if it is
the only one).

A pill over the preview decides what drag and pinch move. With one caption it
reads **Photo / Text**; with more it lists them by number, so the layer being
dragged can be switched without opening a drawer. It is independent of the
drawers — collapse them and position a caption against a full-size preview. It
disappears, and control returns to the photo, when no caption has any text.

The caption is drawn **after** the image has been reduced to four colours, using
palette inks directly. Putting it through the dither instead would smear the
letterforms and destroy legibility at 296 × 128. Glyphs are rasterised at 3× and
thresholded at half coverage, which gives well-shaped letters with hard,
on-palette edges — no grey antialiasing a 4-colour panel could not show anyway.

Letters and outline each take any of the four inks; restricting the ink palette
disables the swatches it rules out, so a caption cannot smuggle a colour into a
two-tone panel. Outline thickness runs 0–8 px and is drawn outside the glyph.

Eleven faces are offered. *Sans, Serif, Slab, Mono* for straight work and
*Poster, Round, Marker* for fun, then four Japanese faces after the divider:

| Chip | Face | iOS font |
|------|------|----------|
| ゴシック | gothic / sans | Hiragino Sans |
| 明朝 | mincho / serif | Hiragino Mincho ProN |
| 丸ゴシック | round gothic | Hiragino Maru Gothic ProN |
| 楷書 | brush | Klee |

Mincho and Klee are left at regular weight: synthetic bold thickens the fine
strokes of kanji until they close up at panel sizes. Japanese characters are
full-width, so a caption of more than a few of them needs a smaller Size than
the Latin equivalent — the preview shows exactly where it will clip.

These are **system fonts**, not webfonts, which keeps the app self-contained and
offline-capable; the trade-off is that availability varies by platform. The
stacks are written iOS-first (Impact, Arial Rounded MT Bold, Bradley Hand, and
the Hiragino family), and fall back through Android's Noto CJK to generic sans,
serif or cursive elsewhere — so the distinctive faces look their best on an
iPhone.

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

- **Save project** — stores the shot as an **editable** state: the
  full-resolution background, the crop and rotation, every adjustment and all
  the captions. Reopen it from the folder button and carry on editing.
- **Save to Photos** — opens the system share sheet. On iPhone this is the only
  route from a web page into the photo album: choose *Save Image* and it lands in
  Photos rather than in Files. Shown wherever the browser can share files (as
  *Share image* on non-Apple platforms).
- **Download PNG** — exact panel resolution, 4 colours, no resampling. Written
  by the canvas as a truecolour PNG that happens to contain exactly four values.
- **Download PNG · indexed** — the same pixels as a **4-entry palette PNG at 2
  bits per pixel**. A fifth colour is not representable in the file at all, and
  the palette states the four inks outright, which is a much stronger hint to
  panel software than a truecolour image that merely happens to be 4-colour.
  Verified to decode pixel-identical to the truecolour export.
- **Download .bin** — packed 2 bits per pixel for direct upload to a panel.

### Where projects are kept

**On a server, when one is configured** — browser storage is not a safe home for
work you mean to keep. iOS Safari evicts all site data for anything not opened
in seven days, which is exactly long enough to lose it.

Open **Saved projects → Settings**, give it an endpoint URL and an optional
token, and projects are read and written there. A badge shows where they live:
*Online*, *Server unreachable*, or *This device*.

The device store stays on as a fallback, not as the default. If a save fails
because the server is down, the project is written to IndexedDB and tagged
*not synced* rather than lost, and pushed up the next time the list is opened.
When a server is configured and reachable, nothing is written to the device at
all. The service worker caches only the app's own files — API responses are
passed straight through, so the project list can never come back stale.

### Storage format

The background is stored losslessly as PNG when that comes in under 1.5 MB —
graphics and screenshots usually do, and reopen bit-identically — and as
quality-0.95 JPEG when it does not, which is the normal case for camera photos.
Error diffusion is chaotic enough that a single-level change in the source can
flip a dot and cascade, so a JPEG-backed project comes back with under 1% of its
dither pixels rearranged: invisible, but not bit-identical. Panel size, crop,
captions and every setting restore exactly either way.

### Running the server

`worker/` holds a Cloudflare Worker backed by R2 that implements the endpoint.
It is about 150 lines and costs nothing at this scale:

```sh
cd worker
npx wrangler r2 bucket create eink-projects
npx wrangler secret put TOKEN      # optional; leave unset to run it open
npx wrangler deploy
```

Put the resulting `https://….workers.dev` URL and the token into the app's
storage settings. Set `ALLOW_ORIGIN` in `wrangler.toml` to the origin serving
the app once you know it, so the endpoint is not open to every website.

The contract is small enough to reimplement on anything — a Pi, a VPS, any
host that can serve four routes with CORS:

| Route | Method | Body / response |
|-------|--------|-----------------|
| `/projects` | GET | `{ "projects": [meta, …] }`, newest first |
| `/projects/:id` | PUT | multipart: `meta` (JSON string) + `blob` (file) |
| `/projects/:id/blob` | GET | the background image |
| `/projects/:id` | DELETE | — |

`meta` carries the panel size, crop, adjustments, captions and a thumbnail;
the background travels separately as `blob` so listing stays cheap. Send
`Authorization: Bearer <token>` when a token is set, and answer `OPTIONS`
preflights with CORS headers.

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
index.html          markup and controls
styles.css          dark, touch-first UI
app.js              capture, tone mapping, dithering, styles, text, storage
sw.js               offline cache for the app shell only
manifest.json       PWA metadata
worker/worker.js    Cloudflare Worker for project storage (R2)
worker/wrangler.toml deployment config
```

Everything runs on the main thread against typed arrays; a 296 × 128 frame
processes in a few milliseconds, and the preview is capped at 30 fps.
