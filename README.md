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

Switching between landscape and portrait turns the **whole composition** with
the frame: the crop rotates a quarter turn and every caption carries its
position and its own angle around with it, so a layout you built in one
orientation arrives intact in the other rather than sideways. Note that this
turn stacks with the export turn above — a portrait composition is rotated once
for the frame and once again on the way into the landscape file.

The camera frame is centre-cropped to the panel's aspect ratio and downscaled in
halving steps (rather than one big jump) so fine detail survives the trip down to
a few hundred pixels.

The preview is sized to a whole-number multiple of the panel whenever it fits, so
the dither pattern is shown pixel-exact. When the panel is wider than the screen
(400 px on a 390 px-wide phone) it is resampled smoothly rather than by
nearest-neighbour, which would drop whole rows of the pattern.

## Shoot, upload, edit

The app opens on a **source chooser** — *Take a photo* or *Choose from library*
— rather than reaching for the camera on its own. Starting the camera at launch
means a permission prompt at launch for anyone whose browser does not remember
the grant, even when they only wanted to pick an existing photo. If the browser
does report the camera as already allowed, it starts straight away, since there
is no prompt to raise.

Press the shutter and the app keeps the **full-resolution** frame, so everything
stays editable afterwards — crop, rotation and every filter re-run from the
original pixels rather than from an already-reduced image. The upload button
(bottom left) puts any photo from your library through exactly the same path.

A photo off the camera roll **starts clean**: default style, default
adjustments, no captions. The settings are one global set rather than one per
image, so without this whatever was last on screen — very often a project just
reopened — came along and quietly reskinned the new picture. Carrying a look
forward is a saved project's job, and it can do it because it stored one. The
panel size and orientation are the exception: they describe the hardware on the
wall, not the photograph, so they stay where you put them.

The shutter is deliberately not covered by that. The live view is already
showing the style being framed, and resetting at the moment of capture would
change the photo out from under whoever just composed it.

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
| **Etch**     | The same line screen, but the line keeps the colour's hue and spends its brightness on how much paper it covers. |
| **Litho**    | A line screen of constant width, dithered inside the line — the weight is yours to choose, the tone comes from the fill. |
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

**Etch** exists because "nearest colour" is the wrong question for a line
screen. A line cannot be white — a white line on white paper is not a line — so
the choice is between black, red and yellow, and yellow is the only bright one
of the three. That makes brightness decide: a pale pink sits at luma 240 and
lands on yellow, more than twice as far from red as from yellow. Right answer,
wrong question.

Etch picks the ink by **hue alone** and spends the brightness on **coverage**
instead. Hue is measured against green rather than against whichever of green
and blue is larger: pink is red with white mixed in, and white brings blue with
it, so a cool pink scores 9 against `max(g, b)` and reads as neutral while the
same pink scores 31 against green. Blue is not one of the four inks and has no
business competing for the pixel.

How much colour goes down comes from how **colourful** the pixel is, not how
dark. Driving it from darkness makes a near-white pink hopeless — it is barely
darker than paper, so the honest coverage is one per cent and no amount of
weight rescues it — while its hue is perfectly measurable. Black then covers
whatever darkness the colour did not account for, crossing the other way, so
neutrals fall through to black alone and still read as tone. To average out at the colour's brightness, an ink has to cover
`(255 − colour) ÷ (255 − ink)` of the area — pale pink against red is 14/179,
eight per cent — so it comes out as a fine red trace, and the paper showing
through is what makes it read pale. Below about a pixel a line stops being
drawable, so the ordered matrix jitters the width and breaks it into a dashed
trace rather than letting it alias into stripes.

**Line weight** becomes **Ink weight** here, and multiplies that coverage for
the colours only — black already spans paper to solid, so multiplying it just
floods the neutrals, and the greys hold at 46% whatever the weight. Anything without a warm cast —
greys, greens, blues — has no ink to be, so it goes to black and reads as tone,
exactly as Engrave does.

| | Engrave | Etch |
|---|---|---|
| pale pink | yellow, 6% covered | **red**, 47% |
| cool pink | yellow, 4% | **red**, 29% |
| near-white pink | nothing at all | **red**, 21% |
| grey | yellow, 46% | **black**, 46% |
| blue | yellow, 47% | **black**, 47% |

## Litho: the line width is a choice, not a measurement

Engrave and Etch both spend the tone on the line — dark means a fat line, pale
means a thin one — so the line weight is never yours to set. **Litho** keeps
Engrave's geometry, one direction and one gap, but the band is a **constant
width** picked from the slider, and the tone is dithered *inside* it. A pale
area drawn with a thick line is a thick line that is mostly paper.

The fill is the fraction of ink it takes to tint the paper down to the tone —
`(paper − colour) ÷ (paper − ink)` — and the band's width is deliberately not
part of that sum. Dividing by it (so that a narrow band could still reach solid
black) crushes the whole picture: at the narrowest setting nearly every tone
demands more than a full band, everything spills into the black fallback, and
seven of eight test swatches came out as the same flat 35% black. Leaving the
width out costs range at the narrow end — a narrow screen simply cannot go very
dark — and that is the honest answer. The slider reads **Line width**, and its
percentages are the band, not the ink.

Colour follows Etch: the ink is chosen by hue, and where the colour is lighter
than the paper in tone but still plainly coloured, its **chroma** claims the
band instead. That case is not hypothetical — the tone curve legitimately lifts
a near-white pink to luma 256, one step *above* white paper, so the tint
fraction is zero or negative and the swatch would vanish. Below the ink's own
brightness the shortfall goes to black in a second dither level, exactly as in
Etch, so a dark gold is yellow and black in the same band.

The ordered matrix is indexed **along and across the line**, not along the
screen axes. A band only ever covers a couple of columns of an upright matrix,
so the thresholds available inside it are a fixed slice of the range and the
palest tones round away to nothing however small the fill gets.

| | Engrave | Etch | Litho |
|---|---|---|---|
| pale pink | yellow, 6% | **red**, 47% | **red**, 14% |
| near-white pink | nothing | **red**, 21% | **red**, 6% |
| strong pink | — | **red**, 92% | **red**, 35% (a full band) |
| grey | yellow, 46% | **black**, 46% | **black**, 14% |

Litho and Etch read alike at a glance, and that is a property of the pair
rather than a bug: both rule the same 45° screen in the same hue-picked ink,
and once a colour is saturated enough to claim a whole band, a full band and a
full-coverage Etch line are the same solid stroke. The measured difference is
large — the same photo leaves 76% of the paper white through Litho and 34%
through Etch, and 54% of pixels differ — and **Line width** is what separates
them: Litho is the lighter, airier one until you turn it up.

An attempt to force the two further apart — a saturating chroma curve so colour
could never fill a band on its own, the tone dithered along the line into
dashes, and a wider ruling — was reverted. It did what it said, and the dashed
ruling was a worse picture. The version here is the one kept on the strength of
how it looks, and the suite asserts the difference is real rather than assuming
it.

## The tone curve is not 8-bit

`LUT` is a `Float32Array` rather than a `Uint8ClampedArray`, and that is not an
optimisation. A contrast boost pushes highlights past 255, and clamping them
there flattens a pale colour to neutral white before anything downstream can
see its hue. A near-white pink came out of the tone stage as `256, 251, 256` —
a red-green difference of 5 where the real one is 22 — so it read as grey and
turned up as black lines. Turning the saturation up did nothing about it,
because saturation runs *after* the curve and there was no colour left in the
highlight to amplify.

Everything reading the buffer either measures differences or quantises, so
values above 255 are harmless there, and `posterize` clamps on its own account.

The screen and line styles share one **Detail** slider, relabelled to whatever it means for the
style: *Misregister*, *Line gap*, *Spacing* — or, for **Halftone**, *Dot size*,
which scales the clustered-dot cell so the screen can read as a coarse newsprint
rosette instead of a single-pixel one.

**Sketch** and **Contour** add a **Line weight** slider (1–4 px) — the same
control is *Ink weight* for Etch and *Line width* for Litho. A one-pixel
line is the first thing to disappear if panel software rescales or re-dithers
the image on its way to the display, and it is marginal on the panel itself, so
weight buys lines that survive the trip.

## The yellow is a mustard, on purpose

The shipped yellow ink is **`#FFC000`**, not `#FFFF00`. A panel's yellow is a
mustard pigment, and the panel's own software quantises to its measured inks —
so a file claiming `#FFFF00` carries an error that the software then re-dithers,
which is what breaks solid areas and one-pixel lines. Writing the ink it expects
makes that re-dither a no-op.

This is why the palette is **two palettes**. The quantiser matches against the
idealised primaries (`#FFFF00`) and diffuses its error against them; only the
bytes written out use the real pigment. Conflating the two is a trap worth
naming: `#FFC000` sits far closer to mid-grey in the colour metric than
`#FFFF00` does, so quantising *against* it turns grey mid-tones yellow and the
picture falls apart. The panel's yellow still reads as yellow to the eye — same
slot in the picture, different pigment — so matching keeps the bright primary
and only the output changes.

The inks stay editable in **About**, and edits change only what is written, not
how the image is decided. If your panel's yellow measures differently, put its
value in there.

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

### Saving on the phone the panel app runs on

Either route works, and both leave the pixels untouched on the way out:

- **Download** lands the file in Files, byte-exact.
- **Save to Photos** goes through the share sheet, which also offers *Save to
  Files* and any app that accepts an image — including, possibly, the panel app
  itself.

The risk is not in saving, it is in reading back: some apps re-encode whatever
they pull out of the photo library, which is exactly what turns four colours
into thousands. That is a property of the reading app, not of Photos. If a
panel result looks muddy, save the image and run it through **About › Check a
file** — if that still reports four colours the library is not the problem, and
if it does not, Download to Files instead.

### Matching the panel's inks

**About › Ink colours** sets the four colours everything is quantised to, and
they are not decorative — this is the lever when panel software mangles an
upload.

Error diffusion against a palette you already match is a **no-op**: every
pixel's error against its nearest palette colour is zero, so nothing
propagates and the image comes back exactly as it went in. Re-dithering a
truly matching image cannot change it.

Against a palette you do **not** match, every pixel carries a large error that
the dithering faithfully scatters over its neighbours — which looks exactly
like the speckle and colour drift people blame on the panel. Panel software
often quantises to the display's *measured* inks: an amber-ish yellow and a
brick red rather than RGB primaries.

To find the target's real values: make an image of solid blocks of its four
colours **in the panel's own software**, export it, and run it through *Check a
file* below. It prints the exact hex of every colour present. Put those four
into Ink colours and the exports become pure in the target's palette, at which
point its dithering has nothing left to do.

`tools/testcard.mjs` generates a diagnostic card at panel resolution — solid
blocks, a one-pixel checkerboard, 1/2/3-pixel line sets, hairlines in each ink
and corner registration pixels. Send it *through* the panel software and each
band fails in a recognisable way: a mushy checkerboard means something
rescaled, speckled solid blocks mean forced dithering, shifted block colours
mean a palette or colour-profile mismatch, missing corner pixels mean cropping.

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

A caption can also be **rotated** — the Rotate slider runs −180° to +180°, and
the **↺ ↻** chips beside it nudge in 15° steps for the common case of a small
tilt. **Vertical text** sets the caption one character per line, the way
Japanese runs down a column, which is also the only shape that fits a caption
into a 128 px-wide portrait panel without shrinking it to nothing. Spaces are
dropped in vertical mode, since a blank line reads as a gap rather than a word
break.

The caption field takes **line breaks** — press Return and the caption runs to
another line. Lines are centred on each other and the block grows evenly around
the caption's position, so adding one does not shove the text downwards. The
field itself grows with the text rather than scrolling a one-line window.

Up to **nine captions** are supported. The numbered tabs at the top of the
drawer switch between them and **＋** adds another; each carries its own text,
font, size, inks and position, and they stack in order so caption 9 draws over
caption 1. The **×** removes the caption being edited (or empties it, if it is
the only one).

Nine is where the cap sits because it is the last count that keeps every tab a
**single digit**, so the tab row is the same set of same-sized chips whatever is
on it. It wraps to a second line rather than running off the side of a phone.

New captions start on staggered spots so they do not land exactly on top of one
already there — three heights, and each further pass across them steps sideways
as well, which lays the nine defaults out as a grid. With captions at their
default size they will still overlap; the point is only that a new one is
visibly somewhere else, not that nine of them arrive pre-arranged.

A pill over the preview decides what drag and pinch move. With one caption it
reads **Photo / Text**; with more it lists them by number, so the layer being
dragged can be switched without opening a drawer. It is independent of the
drawers — collapse them and position a caption against a full-size preview. It
disappears, and control returns to the photo, when no caption has any text.

Because it floats over the picture, the pill is held to about two thirds of the
stage and scrolls past that rather than growing across the whole top of the
photo — a full nine would otherwise take 337 px of a 390 px-wide phone.
Selecting a caption scrolls the pill to it, by setting `scrollLeft` rather than
by `scrollIntoView`, which walks up the tree and scrolls the page as well.

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
error-diffusion strength, and `Outline` and `Smooth` drive the edge-based styles.

## Zoom, rotation, background and transparency

`Zoom` runs **0.2× to 6×**. Above 1 the photo is larger than the panel and the
slider chooses how far into it to crop. Below 1 the photo is *smaller* than the
panel: it stops being cropped once the whole of it fits, and sits on the
background colour with a margin. Both regimes come from one number — panel
pixels per source pixel — so nothing jumps as the slider crosses 1.

Dragging does the sensible thing on either side. Above 1 it pans the crop; below
1 there is no crop left to pan, so it slides the photo around inside the margin.
Exactly one of the two is available on a given axis, so the same gesture covers
both without a mode switch.

Keep dragging past that and the photo **hangs off the edge**, bleeding out of
the frame with background behind it. Whatever the pan cannot absorb is handed on
to an overhang offset rather than dropped, so a long drag runs smoothly from one
into the other instead of sticking at the limit. A fifth of the photo always
stays on the panel — far enough to be a deliberate composition, not far enough
to lose the picture off the side and wonder where it went.

Hanging it off has to be asked for, though. At zoom 1 the photo exactly fills
the panel and one axis usually has no pan at all, so without a threshold every
stray movement of a finger would slide the picture off and leave a band of
background down the side. The leftover from a drag therefore builds up as
pressure and only what exceeds a **48 px deadband** moves the photo.

The order the two reservoirs fill and empty in is not the same. Going out, the
pan goes first and the overhang takes the remainder. Coming back, the
**overhang unwinds first**, because it was the last thing filled — the other
way round, the pan quietly absorbs the whole return drag while the photo stays
stuck off the edge, which at any zoom with crop slack cannot be undone by
dragging at all. Within 5 px of flush the photo snaps to the edge, since
landing exactly on zero by hand is not possible and a two-pixel band of
background is nobody's composition. That snap applies only on the way back;
while the overhang is growing it would pull the photo home the instant it
crossed the deadband, and it could never leave.

The offset is finally **rounded to whole pixels**, because at a fractional one
the edge column is only partly covered by the photo and that fraction blends
with the background into a pale line down the side.

**Rotate** tilts the photo −45° to +45°, on top of the ↺ ↻ quarter turns — the
two compose, so any angle is reachable. Only the quarter turns swap the panel's
width and height for the aspect fit, which is why they stay a separate control.

Tilting exposes background at the corners, which is often the point. When it is
not, zoom in: the ceiling on the drawn size is the panel measured *in the
photo's own axes* rather than the panel itself, so a tilted photo is allowed to
be larger than the frame and can cover it again. At no tilt those are the same
number, so nothing about the untilted case changes.

**Background** picks which of the four inks fills everything the photo does not
cover. It is restricted by the ink palette in the same way captions are, so a
two-tone panel cannot be given a red background.

**Transparent PNGs work.** Alpha is composited onto the background colour, so a
cut-out subject lands on flat ink rather than on black. Soft, antialiased edges
are blended and left to the dither, because a feathered edge is genuinely part of
the picture; fully transparent pixels are pinned to the exact ink *after*
quantisation. That last part matters: a flat area that tone mapping has nudged
half a level off the palette dithers into speckle, which is the one artefact this
app exists to avoid.

The fill goes through the same `emit()` as everything else that puts ink down.
That matters because the preview is built from an RGBA buffer while the indexed
PNG is built from a parallel array of palette indices: writing one without the
other is invisible on screen and wrong in the file. It was, once — a background
that was flat white in the app came out as a dither of it in the export.

Transparency also survives a project save. Projects normally fall back to JPEG
for large backgrounds, and JPEG has no alpha channel — so an image that has any
is kept as PNG however big it turns out.

## Saving

- **Save** / **Save new** — two columns, because editing a project you opened
  and starting a new one from it are different intentions. Both store the shot
  as an **editable** state: the full-resolution background, the crop and
  rotation, every adjustment and all the captions.

  *Save* puts the work back over the project it came from, keeping its id — so
  it stays where it was in the list rather than jumping to the top as if it
  were new. It is disabled until there is something to save over: on a fresh
  photo, and again whenever the background changes, since at that point it is a
  different picture and overwriting an unrelated project would be a surprise.

  *Save new* always makes another one, and the app then follows the copy — a
  second *Save* updates what you just branched to, not what you branched away
  from.
- **Save to Photos** — opens the system share sheet. On iPhone this is the only
  route from a web page into the photo album: choose *Save Image* and it lands in
  Photos rather than in Files. Shown wherever the browser can share files (as
  *Share image* on non-Apple platforms).
- **Download PNG** — a 4-entry palette PNG at 2 bits per pixel. A fifth colour is
  not representable in the file at all, and the palette states the four inks
  outright, which is a far stronger hint to panel software than a truecolour
  image that merely happens to be 4-colour.

*Save to Photos* and *Download PNG* are built from the same bytes, so the two
can never disagree — including the portrait quarter turn.

Save to Photos is feature-detected: it needs the Web Share API with file
support, which is not universal and, being a powerful API, also requires a
**secure context** — an `http://` page does not get it however capable the
browser is. When the browser is the reason, the sheet says so, since a missing
button otherwise reads as a missing feature. When the page is the reason it
says nothing: that is a property of how the app is being served, which the
person looking at the sheet cannot act on.

### Where projects are kept

**On a server, when one is configured** — browser storage is not a safe home for
work you mean to keep. iOS Safari evicts all site data for anything not opened
in seven days, which is exactly long enough to lose it.

The endpoint is **built into the app** (`REMOTE_URL` in `app.js`) and never
shown, so setup is one field: the password. Moving the server is a one-line
change every device picks up.

The URL is not a secret and cannot be — `app.js` is downloaded by every visitor
— it is simply not worth showing. The **password** is the actual lock, and it is
deliberately *not* in the repository: this one is public, so anything committed
next to the URL would protect nothing. It is typed once per device and
remembered there.

So a device that has never been used opens **Saved projects** to *Password
needed*, with the form already open and one **Connect** button. Connect verifies
before it saves — storing a password that does not work would leave the app
quietly offline with no hint why — and says which of the two things went wrong:
*That password was not accepted* or *Could not reach the server*.

A badge shows where projects live: *Online*, *Password needed*, *Server
unreachable*, or *This device*. The field's visibility is derived from that
state on every render rather than left wherever it was last put, so it appears
when a password is actually needed and is not still sitting there afterwards.
The **Password** link opens it on demand to change one. *Password needed* is deliberately distinct from
*Server unreachable*: one is fixed by typing, the other by waiting.

There is no manual device-only switch. If the server cannot be reached the app
falls back on its own, so the button only ever offered a way to be offline on
purpose.

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
