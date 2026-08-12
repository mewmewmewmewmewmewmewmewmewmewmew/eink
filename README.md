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
| 269 × 128 | 269 × 128 | 128 × 269 |
| 400 × 300 | 400 × 300 | 300 × 400 |

The camera frame is centre-cropped to the panel's aspect ratio and downscaled in
halving steps (rather than one big jump) so fine detail survives the trip down to
a few hundred pixels.

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

## Adjustments

Exposure, brightness, contrast, saturation and gamma are applied *before*
quantisation, which is the only place they can meaningfully change the result —
with four colours available, tone mapping is most of the work. `Dither` sets
error-diffusion strength, `Outline` and `Smooth` drive the edge-based styles, and
`Zoom` is a digital crop.

## Saving

- **Save PNG** — exact panel resolution, 4 colours, no resampling.
- **Save .bin** — packed 2 bits per pixel for direct upload to a panel.
- **Share** — the system share sheet, where the browser supports it.

Recent shots are kept in `localStorage` (last 24); tap one to download it again.

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

## Layout

```
index.html    markup and controls
styles.css    dark, touch-first UI
app.js        capture, tone mapping, dithering, styles, export
sw.js         offline cache
manifest.json PWA metadata
```

Everything runs on the main thread against typed arrays; a 269 × 128 frame
processes in a few milliseconds, and the preview is capped at 30 fps.
