/* E-Ink Cam — 4-colour (black / red / yellow / white) camera for e-ink panels. */
(() => {
'use strict';

/* ---------------------------------------------------------------- palette */
/* Index order matters: it is the code written into the packed .bin export
   (0=black, 1=white, 2=yellow, 3=red — the usual Waveshare 4-colour layout). */
/* Two palettes, because the colours have two jobs.

   MATCH_PALETTE is what the quantiser reasons about: which ink is nearest to
   a pixel, and how much error is left over to diffuse. It is the idealised
   primaries, and it stays that way.

   DEFAULT_PALETTE is what actually gets written into the file. A panel's
   yellow is not #FFFF00 — it is a mustard, and the panel's own software
   quantises to its measured inks, so a file saying #FFFF00 carries an error
   the software then re-dithers. Writing the ink the software expects is what
   makes that re-dither a no-op.

   Conflating the two is a trap: #FFC000 sits far closer to mid-grey than
   #FFFF00 does, so quantising against it turns greys yellow. The panel's
   yellow still reads as yellow to the eye — it is the same slot in the
   picture, just a different pigment — so matching keeps the bright primary
   and only the emitted bytes change. */
const MATCH_PALETTE = [
  [0,   0,   0  ],  // 0 black
  [255, 255, 255],  // 1 white
  [255, 255, 0  ],  // 2 yellow
  [255, 0,   0  ],  // 3 red
];
const DEFAULT_PALETTE = [
  [0,   0,   0  ],  // 0 black
  [255, 255, 255],  // 1 white
  [255, 192, 0  ],  // 2 yellow — the panel's mustard, not a pure primary
  [255, 0,   0  ],  // 3 red
];
const PAL_NAMES = ['black','white','yellow','red'];

/* Editable, because the four colours that matter are whichever ones the
   panel's own software quantises to.

   Error diffusion against a palette you already match is a no-op: every
   pixel's error is zero, so nothing propagates and the image comes back
   unchanged. Against a palette you do not match — panel software often uses
   the display's measured inks, a brick red and a mustard yellow rather than
   RGB primaries — every pixel carries a large error that the dithering
   faithfully scatters over its neighbours. Matching the target's colours is
   what makes a re-dither harmless. */
const PALETTE = DEFAULT_PALETTE.map(c => c.slice());
/* Flat copy — nearest() runs once per pixel per frame, and a typed array
   avoids re-dereferencing the nested arrays on every candidate. */
const PAL_FLAT = new Float32Array(12);
/* The matching palette never changes, so it is flattened once. */
const MATCH_FLAT = new Float32Array(12);
for (let i = 0; i < 4; i++) {
  MATCH_FLAT[i * 3]     = MATCH_PALETTE[i][0];
  MATCH_FLAT[i * 3 + 1] = MATCH_PALETTE[i][1];
  MATCH_FLAT[i * 3 + 2] = MATCH_PALETTE[i][2];
}

/* Bumped when the shipped inks change, so every device picks the new ones up
   instead of holding on to a copy of the old defaults. */
const INK_KEY = 'einkcam.inks2';

function hex(c) {
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}

function applyInks(save) {
  for (let i = 0; i < 4; i++) {
    PAL_FLAT[i * 3]     = PALETTE[i][0];
    PAL_FLAT[i * 3 + 1] = PALETTE[i][1];
    PAL_FLAT[i * 3 + 2] = PALETTE[i][2];
  }
  document.querySelectorAll('.swatches i').forEach((el, i) => {
    if (PALETTE[i]) el.style.background = hex(PALETTE[i]);
  });
  document.querySelectorAll('[data-tcolor],[data-ocolor]').forEach(b => {
    const raw = b.dataset.tcolor !== undefined ? b.dataset.tcolor : b.dataset.ocolor;
    b.style.setProperty('--c', hex(PALETTE[+raw]));
  });
  document.querySelectorAll('[data-ink]').forEach(inp => {
    inp.value = hex(PALETTE[+inp.dataset.ink]);
  });
  document.querySelectorAll('[data-inkhex]').forEach(inp => {
    if (document.activeElement !== inp) inp.value = hex(PALETTE[+inp.dataset.inkhex]);
  });
  if (save) {
    try { localStorage.setItem(INK_KEY, JSON.stringify(PALETTE)); } catch (_) {}
  }
  if (typeof markAllTextDirty === 'function') markAllTextDirty();
}

function loadInks() {
  try {
    const v = JSON.parse(localStorage.getItem(INK_KEY));
    if (Array.isArray(v) && v.length === 4) {
      v.forEach((c, i) => {
        if (Array.isArray(c) && c.length === 3) PALETTE[i] = c.map(n => Math.max(0, Math.min(255, n | 0)));
      });
    }
  } catch (_) { /* keep the defaults */ }
}

/* Perceptual-ish channel weights for nearest-colour search. */
const WR = 2, WG = 4, WB = 3;

/* Which inks may be used. Indices always refer to PALETTE, so the .bin codes
   stay correct whatever subset is active.

   "Warm" leans the image toward the red/yellow inks with a tone shift rather
   than by biasing the colour search: skewing the distance metric makes error
   diffusion pick a colour whose error it then has to diffuse away, which
   feeds back and smears the frame. Shifting the pixels first stays stable. */
const PALETTE_MODES = {
  full:   { inks: [0, 1, 2, 3], warm: 0 },
  warm:   { inks: [0, 1, 2, 3], warm: 1 },
  red:    { inks: [0, 1, 3],    warm: 0 },
  yellow: { inks: [0, 1, 2],    warm: 0 },
  mono:   { inks: [0, 1],       warm: 0 },
};
let inks = PALETTE_MODES.full.inks;
let warmth = 0;

function nearest(r, g, b) {
  let best = inks[0], bestD = Infinity;
  for (let k = 0, n = inks.length; k < n; k++) {
    const i = inks[k], o = i * 3;
    const dr = r - MATCH_FLAT[o], dg = g - MATCH_FLAT[o+1], db = b - MATCH_FLAT[o+2];
    const d = WR*dr*dr + WG*dg*dg + WB*db*db;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/* 8x8 Bayer matrix, normalised to -0.5 .. +0.5 */
const BAYER = (() => {
  const m = [
     0,32, 8,40, 2,34,10,42,
    48,16,56,24,50,18,58,26,
    12,44, 4,36,14,46, 6,38,
    60,28,52,20,62,30,54,22,
     3,35,11,43, 1,33, 9,41,
    51,19,59,27,49,17,57,25,
    15,47, 7,39,13,45, 5,37,
    63,31,55,23,61,29,53,21,
  ];
  return Float32Array.from(m, v => (v + 0.5) / 64 - 0.5);
})();

/* Clustered-dot 4x4 — grows dots outward from a centre, so it reads as a
   printed halftone screen rather than as noise. */
const CLUSTER = (() => {
  const m = [
     7, 13, 11,  4,
    12, 16, 14,  8,
    10, 15,  6,  2,
     5,  9,  3,  1,
  ];
  return Float32Array.from(m, v => (v - 0.5) / 16 - 0.5);
})();

/* ------------------------------------------------------------------ state */
const SIZES = { '296x128': [296, 128], '400x300': [400, 300] };

const state = {
  size: '296x128',
  orient: 'landscape',
  style: 'photo',
  palette: 'full',
  dither: 'fs',
  exposure: 0,
  brightness: 0,
  contrast: 15,
  saturation: 1.6,
  gamma: 1,
  ditherAmt: 0.9,
  edge: 0.5,
  smooth: 1.5,
  detail: 5,
  weight: 1,
  zoom: 1,
  angle: 0,            // free rotation of the photo, on top of the quarter turns
  bg: 1,               // palette index behind the photo: white
  exportRot: 'cw',     // which way a portrait composition turns for export
  facing: 'environment',
  target: 'photo',     // what drag and pinch act on: 'photo' | 'text'
};

const DEFAULTS = {
  dither: 'fs', exposure: 0, brightness: 0, contrast: 15,
  saturation: 1.6, gamma: 1, ditherAmt: 0.9, edge: 0.5, smooth: 1.5, detail: 5, weight: 1, zoom: 1,
  angle: 0, bg: 1,
};

/* Crop / rotate. panX and panY are -1..1 across whatever slack the crop
   rectangle has inside the source; at zoom 1 one axis usually has none. */
const view = { rot: 0, panX: 0, panY: 0, offX: 0, offY: 0, mirror: false };

let W = 296, H = 128;
let mode = 'live';           // 'live' | 'review'

const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
            (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

/* ---------------------------------------------------------------- element */
const $ = id => document.getElementById(id);
const video    = $('video');
const preview  = $('preview');
const pctx     = preview.getContext('2d');
const stage    = $('stage');
const statusEl = $('status');

/* Off-screen canvases: two scratch buffers ping-pong for progressive
   downscaling (big -> small in halving steps keeps detail and avoids the
   aliasing you get from one giant single-step drawImage). */
const scratch = [document.createElement('canvas'), document.createElement('canvas')];
const sctxs   = scratch.map(c => c.getContext('2d'));
sctxs.forEach(c => { c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; });

/* Frames are composed and read back here, never on the visible canvas: a
   canvas that is both displayed and read every frame loses the CPU-backed
   fast path that willReadFrequently buys. `preview` only ever receives a
   finished putImageData. */
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });

/* Full-resolution snapshot of the moment the shutter was pressed, so crop,
   rotate and every filter stay re-editable afterwards without re-quantising
   from an already-reduced image. */
const still = document.createElement('canvas');
const stillCtx = still.getContext('2d');

let buf = null;        // Float32Array W*H*3, post-adjustment RGB
let tmp = null;        // Float32Array W*H*3, blur scratch
let luma = null;       // Float32Array W*H, luminance scratch
let edgeMap = null;    // Float32Array W*H, Sobel magnitude
let indices = null;    // Uint8Array W*H, palette index per pixel
let mask = null;       // Uint8Array W*H, line-art coverage
let maskInk = null;    // Uint8Array W*H, ink chosen for each covered pixel
let bgMask = null;     // Uint8Array W*H, 1 where nothing but background sits
let hasBg = false;     // whether this frame has any background at all
let imgData = null;

function allocate() {
  preview.width = W; preview.height = H;
  work.width = W; work.height = H;
  wctx.imageSmoothingEnabled = true;
  wctx.imageSmoothingQuality = 'high';
  buf = new Float32Array(W * H * 3);
  tmp = new Float32Array(W * H * 3);
  luma = new Float32Array(W * H);
  edgeMap = new Float32Array(W * H);
  indices = new Uint8Array(W * H);
  mask = new Uint8Array(W * H);
  maskInk = new Uint8Array(W * H);
  bgMask = new Uint8Array(W * H);
  imgData = pctx.createImageData(W, H);
  markAllTextDirty();        // glyph size is relative to panel height
  layoutPreview();
}

/* ------------------------------------------------------------ tone curve */
let LUT = new Uint8ClampedArray(256);

function buildLUT() {
  const ev = Math.pow(2, state.exposure);
  const c = state.contrast;
  const cf = (259 * (c + 255)) / (255 * (259 - c));   // classic contrast factor
  const invG = 1 / state.gamma;
  for (let i = 0; i < 256; i++) {
    let v = (i / 255) * ev;
    if (v < 0) v = 0; else if (v > 1) v = 1;
    v = Math.pow(v, invG) * 255;
    v = cf * (v - 128) + 128 + state.brightness;
    LUT[i] = v;
  }
}

/* --------------------------------------------------------- crop geometry */
/* The crop rectangle lives in source coordinates. When the image is rotated a
   quarter turn the panel's width and height swap over before the aspect fit,
   which is what keeps a rotated crop filling the panel exactly. */
function cropGeom(sw, sh) {
  const swap = view.rot === 90 || view.rot === 270;
  const tw = swap ? H : W, th = swap ? W : H;
  const ta = tw / th;

  /* The crop that exactly fills the panel at zoom 1. */
  let cw0 = sw, ch0 = sw / ta;
  if (ch0 > sh) { ch0 = sh; cw0 = sh * ta; }

  /* Everything derives from one number: how many panel pixels a source pixel
     is worth. Below zoom 1 the whole photo eventually fits and stops being
     cropped, leaving margin — above it, the photo is bigger than the panel and
     is cropped, exactly as before. Writing it this way keeps the two regimes
     continuous, so nothing jumps as the slider crosses 1. */
  const scale = state.zoom * tw / cw0;

  /* A tilted photo needs to be bigger than the panel to cover it, so the
     ceiling on the drawn size is the panel measured in the photo's own axes
     rather than the panel itself. At no tilt these are the same number, which
     is what keeps the untilted case exactly as it was. */
  const arad = state.angle * Math.PI / 180;
  const ca = Math.abs(Math.cos(arad)), sa = Math.abs(Math.sin(arad));
  const needW = tw * ca + th * sa, needH = tw * sa + th * ca;

  const dw = Math.min(needW, sw * scale);
  const dh = Math.min(needH, sh * scale);
  const cw = dw / scale, ch = dh / scale;

  const slackX = (sw - cw) / 2, slackY = (sh - ch) / 2;

  /* Above zoom 1 the photo overflows the panel and panning chooses which part
     shows; below it the photo has room to move instead, so the same gesture
     slides it around the margin. Exactly one of the two is ever non-zero on a
     given axis, so both can be driven by the same panX/panY. */
  /* Tilted and zoomed in, the drawn photo is wider than the panel, so there is
     no margin to slide around in — and a negative one would invert the drag. */
  const marginX = Math.max(0, (tw - dw) / 2), marginY = Math.max(0, (th - dh) / 2);

  /* Once pan runs out, offX/offY carry the photo on past the edge so it can
     hang off. They are panel pixels rather than a fraction, because there is
     no natural extent to be a fraction of. The clamp keeps a fifth of the
     photo on the panel — enough to be a deliberate composition, not enough to
     lose the picture off the side and wonder where it went. */
  const keepX = KEEP_ON_PANEL * Math.min(dw, tw);
  const keepY = KEEP_ON_PANEL * Math.min(dh, th);
  const maxCX = (tw + dw) / 2 - keepX, maxCY = (th + dh) / 2 - keepY;
  /* Rounded to whole pixels: at a fractional offset the edge column is only
     partly covered by the photo, and that fraction blends with the background
     into a pale line down the side. */
  const cx = Math.round(clampAbs(view.panX * marginX + view.offX, maxCX));
  const cy = Math.round(clampAbs(view.panY * marginY + view.offY, maxCY));

  return {
    tw, th, cw, ch, dw, dh, slackX, slackY, marginX, marginY, maxCX, maxCY,
    sx: slackX + view.panX * slackX,
    sy: slackY + view.panY * slackY,
    dx: cx,
    dy: cy,
  };
}

const KEEP_ON_PANEL = 0.2;
function clampAbs(v, m) { return v < -m ? -m : v > m ? m : v; }

function grabFrame(src, sw, sh) {
  if (!sw || !sh) return null;
  const g = cropGeom(sw, sh);

  let el = src, sx = g.sx, sy = g.sy, sW = g.cw, sH = g.ch, slot = 0;
  while (sW > g.dw * 2 && sH > g.dh * 2) {
    const nw = Math.max(Math.ceil(g.dw), Math.round(sW / 2));
    const nh = Math.max(Math.ceil(g.dh), Math.round(sH / 2));
    const cvs = scratch[slot], ctx = sctxs[slot];
    if (cvs.width !== nw || cvs.height !== nh) {
      cvs.width = nw; cvs.height = nh;
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    }
    ctx.drawImage(el, sx, sy, sW, sH, 0, 0, nw, nh);
    el = cvs; sx = 0; sy = 0; sW = nw; sH = nh;
    slot ^= 1;
  }

  /* Mirror is applied outside the rotation so it always reads as a left-right
     flip of the finished frame, whichever way the image has been turned. */
  wctx.clearRect(0, 0, W, H);
  wctx.save();
  wctx.translate(W / 2, H / 2);
  if (view.mirror) wctx.scale(-1, 1);
  /* The quarter turns and the free angle are the same rotation; only the
     quarter turns swap the panel's width and height for the aspect fit, which
     is why they stay a separate number. */
  const turn = totalTurn();
  if (turn) wctx.rotate(turn * Math.PI / 180);
  wctx.drawImage(el, sx, sy, sW, sH, -g.dw / 2 + g.dx, -g.dh / 2 + g.dy, g.dw, g.dh);
  wctx.restore();

  const frame = wctx.getImageData(0, 0, W, H);
  paintBackground(frame);
  return frame;
}

/* Anywhere the photo does not reach — margin left by scaling it down, or a
   hole in a transparent PNG — is filled with the chosen ink.

   The fill happens here, before tone mapping and dithering, so that pixels at
   the edge of the photo diffuse their error into something sensible rather
   than into black. The flat areas are then pinned to the exact ink again after
   quantisation (restoreBackground), because otherwise a background that the
   contrast slider has nudged half a level off the palette dithers into
   speckle — the one artefact this app exists to avoid. */
function paintBackground(frame) {
  /* Filled with the matching colour, not the pigment: the fill is about to go
     through the quantiser, and an exact match leaves no error to diffuse into
     the edge of the photo. restoreBackground puts the real ink back after. */
  const d = frame.data, bg = MATCH_PALETTE[state.bg], n = W * H;
  hasBg = false;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const a = d[i + 3];
    if (a === 255) { bgMask[p] = 0; continue; }
    hasBg = true;
    if (a === 0) {
      d[i] = bg[0]; d[i + 1] = bg[1]; d[i + 2] = bg[2];
      bgMask[p] = 1;
    } else {
      /* A soft edge is genuinely part of the picture, so it is blended and
         left to the dither rather than pinned flat. */
      const t = a / 255, u = 1 - t;
      d[i] = d[i] * t + bg[0] * u;
      d[i + 1] = d[i + 1] * t + bg[1] * u;
      d[i + 2] = d[i + 2] * t + bg[2] * u;
      bgMask[p] = 0;
    }
    d[i + 3] = 255;
  }
}

/* Through emit(), not by writing the pixels directly: emit is also what keeps
   indices[] in step, and the indexed PNG export is built from indices rather
   than from these pixels. Setting one without the other put a flat background
   on screen and left the quantiser's dither of it in the exported file. */
function restoreBackground(out) {
  if (!hasBg) return;
  const n = W * H;
  for (let p = 0; p < n; p++) if (bgMask[p]) emit(out, p, state.bg);
}

/* ------------------------------------------------------------ adjustment */
function adjust(src) {
  const d = src.data;
  const s = state.saturation;
  const wr = warmth ? 1.12 : 1, wg = warmth ? 1.04 : 1, wb = warmth ? 0.74 : 1;
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
    let r = LUT[d[i]] * wr, g = LUT[d[i + 1]] * wg, b = LUT[d[i + 2]] * wb;
    if (s !== 1) {
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      r = l + (r - l) * s;
      g = l + (g - l) * s;
      b = l + (b - l) * s;
    }
    buf[j] = r; buf[j + 1] = g; buf[j + 2] = b;
  }
}

/* -------------------------------------------------------------- dithering */
function quantize(mode_, amt) {
  const out = imgData.data;

  if (mode_ === 'bayer' || mode_ === 'cluster') {
    const ordered = mode_ === 'bayer' ? BAYER : CLUSTER;
    const mask = mode_ === 'bayer' ? 7 : 3;
    const shift = mode_ === 'bayer' ? 3 : 2;
    const spreadAmt = (mode_ === 'bayer' ? 110 : 150) * amt;
    /* Sampling the screen matrix through a divisor grows the cell without
       needing a bigger matrix: at scale 3 each matrix entry covers a 3x3
       block, so the dots get coarser while keeping their clustered shape. */
    const sc = mode_ === 'cluster' ? Math.max(1, Math.round(state.detail / 3.5)) : 1;
    for (let y = 0; y < H; y++) {
      const sy = sc === 1 ? y : Math.floor(y / sc);
      for (let x = 0; x < W; x++) {
        const sx = sc === 1 ? x : Math.floor(x / sc);
        const j = (y * W + x) * 3;
        const t = ordered[((sy & mask) << shift) + (sx & mask)] * spreadAmt;
        const idx = nearest(buf[j] + t, buf[j + 1] + t, buf[j + 2] + t);
        emit(out, y * W + x, idx);
      }
    }
    return;
  }

  if (mode_ === 'none') {
    for (let p = 0, j = 0; p < W * H; p++, j += 3) {
      emit(out, p, nearest(buf[j], buf[j + 1], buf[j + 2]));
    }
    return;
  }

  /* Error diffusion. Floyd–Steinberg (serpentine) or Atkinson. */
  const atkinson = mode_ === 'atkinson';
  for (let y = 0; y < H; y++) {
    const ltr = atkinson ? true : (y & 1) === 0;   // serpentine for FS only
    const xStart = ltr ? 0 : W - 1;
    const xEnd   = ltr ? W : -1;
    const step   = ltr ? 1 : -1;

    for (let x = xStart; x !== xEnd; x += step) {
      const p = y * W + x, j = p * 3;
      const or = buf[j], og = buf[j + 1], ob = buf[j + 2];
      const idx = nearest(or, og, ob);
      const m = idx * 3;
      emit(out, p, idx);

      /* Diffuse what the matching colour left over. Measuring against the
         emitted pigment instead would scatter a large constant error across
         every neighbour, which is the very artefact this is here to avoid. */
      const er = (or - MATCH_FLAT[m]) * amt;
      const eg = (og - MATCH_FLAT[m + 1]) * amt;
      const eb = (ob - MATCH_FLAT[m + 2]) * amt;

      if (atkinson) {
        const f = 1 / 8;
        spread(x + 1, y,     er, eg, eb, f);
        spread(x + 2, y,     er, eg, eb, f);
        spread(x - 1, y + 1, er, eg, eb, f);
        spread(x,     y + 1, er, eg, eb, f);
        spread(x + 1, y + 1, er, eg, eb, f);
        spread(x,     y + 2, er, eg, eb, f);
      } else {
        /* Floyd–Steinberg is the default and runs on every live frame, so the
           four taps are inlined rather than going through spread(). */
        const ahead = x + step, behind = x - step;
        if (ahead >= 0 && ahead < W) {
          const k = (p + step) * 3;
          buf[k] += er * 0.4375; buf[k+1] += eg * 0.4375; buf[k+2] += eb * 0.4375;
        }
        if (y + 1 < H) {
          const below = p + W;
          let k = below * 3;
          buf[k] += er * 0.3125; buf[k+1] += eg * 0.3125; buf[k+2] += eb * 0.3125;
          if (behind >= 0 && behind < W) {
            k = (below - step) * 3;
            buf[k] += er * 0.1875; buf[k+1] += eg * 0.1875; buf[k+2] += eb * 0.1875;
          }
          if (ahead >= 0 && ahead < W) {
            k = (below + step) * 3;
            buf[k] += er * 0.0625; buf[k+1] += eg * 0.0625; buf[k+2] += eb * 0.0625;
          }
        }
      }
    }
  }
}

function spread(x, y, er, eg, eb, f) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const j = (y * W + x) * 3;
  buf[j]     += er * f;
  buf[j + 1] += eg * f;
  buf[j + 2] += eb * f;
}

function emit(out, p, idx) {
  indices[p] = idx;
  const c = idx * 3, o = p * 4;
  out[o] = PAL_FLAT[c]; out[o + 1] = PAL_FLAT[c + 1]; out[o + 2] = PAL_FLAT[c + 2];
  out[o + 3] = 255;
}

/* ------------------------------------------------------- filters / styles */

/* Separable box blur with a running sum — O(pixels) regardless of radius.
   Used to melt photographic noise into the flat areas cel/vector need. */
function boxBlur(radius, passes) {
  blurSpread = radius < 1 ? 1 : 2 * radius * passes + 1;
  if (radius < 1) return;
  const n = radius * 2 + 1;
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < H; y++) {
      const row = y * W * 3;
      let sr = 0, sg = 0, sb = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = row + clampX(k) * 3;
        sr += buf[j]; sg += buf[j + 1]; sb += buf[j + 2];
      }
      for (let x = 0; x < W; x++) {
        const o = row + x * 3;
        tmp[o] = sr / n; tmp[o + 1] = sg / n; tmp[o + 2] = sb / n;
        const add = row + clampX(x + radius + 1) * 3;
        const sub = row + clampX(x - radius) * 3;
        sr += buf[add] - buf[sub];
        sg += buf[add + 1] - buf[sub + 1];
        sb += buf[add + 2] - buf[sub + 2];
      }
    }
    for (let x = 0; x < W; x++) {
      const col = x * 3;
      let sr = 0, sg = 0, sb = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = clampY(k) * W * 3 + col;
        sr += tmp[j]; sg += tmp[j + 1]; sb += tmp[j + 2];
      }
      for (let y = 0; y < H; y++) {
        const o = y * W * 3 + col;
        buf[o] = sr / n; buf[o + 1] = sg / n; buf[o + 2] = sb / n;
        const add = clampY(y + radius + 1) * W * 3 + col;
        const sub = clampY(y - radius) * W * 3 + col;
        sr += tmp[add] - tmp[sub];
        sg += tmp[add + 1] - tmp[sub + 1];
        sb += tmp[add + 2] - tmp[sub + 2];
      }
    }
  }
}
function clampX(x) { return x < 0 ? 0 : x >= W ? W - 1 : x; }
function clampY(y) { return y < 0 ? 0 : y >= H ? H - 1 : y; }

/* Sobel magnitude of the current buffer's luma, scaled to roughly 0..255.

   Edges are measured after blurring (so sensor noise doesn't become speckle),
   but blurring spreads a hard edge over `blurSpread` pixels, which divides its
   gradient by the same factor. Multiplying it back keeps one Outline setting
   meaningful no matter how much Smooth is dialled in. */
let blurSpread = 1;

/* Luma once per pixel, not once per Sobel tap — the 3x3 window would
   otherwise recompute it nine times over. Shared with the line-based styles. */
function computeLuma() {
  for (let p = 0, j = 0; p < W * H; p++, j += 3) {
    luma[p] = 0.299 * buf[j] + 0.587 * buf[j + 1] + 0.114 * buf[j + 2];
  }
}

function computeEdges() {
  const gain = 0.25 * blurSpread;
  computeLuma();

  for (let y = 0; y < H; y++) {
    const r0 = clampY(y - 1) * W, r1 = y * W, r2 = clampY(y + 1) * W;
    for (let x = 0; x < W; x++) {
      const xm = x > 0 ? x - 1 : 0, xp = x < W - 1 ? x + 1 : W - 1;
      const tl = luma[r0 + xm], tc = luma[r0 + x], tr = luma[r0 + xp];
      const ml = luma[r1 + xm],                    mr = luma[r1 + xp];
      const bl = luma[r2 + xm], bc = luma[r2 + x], br = luma[r2 + xp];
      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
      const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
      edgeMap[r1 + x] = Math.sqrt(gx * gx + gy * gy) * gain;
    }
  }
}

/* Squared curve: the useful range lives near the low end, so most of the
   slider's travel is spent there. */
function edgeThreshold() {
  const e = 1 - state.edge;
  return 12 + e * e * 210;
}

/* Ink the detected edges black, on top of an already-quantised frame. */
function inkEdges() {
  if (state.edge <= 0.02) return;
  const out = imgData.data, thr = edgeThreshold();
  for (let p = 0; p < W * H; p++) if (edgeMap[p] > thr) emit(out, p, 0);
}

/* Posterise before quantising: snapping each channel to a few levels is what
   turns a photograph into flat cel-shaded bands. */
function posterize(levels) {
  const step = 255 / (levels - 1);
  for (let j = 0; j < buf.length; j++) {
    buf[j] = Math.round(Math.min(255, Math.max(0, buf[j])) / step) * step;
  }
}

/* Nearest ink that can actually mark the paper — white is the paper, so a
   line drawn in it would be invisible. */
function nearestInk(r, g, b) {
  let best = -1, bestD = Infinity;
  for (let k = 0; k < inks.length; k++) {
    const i = inks[k];
    if (i === 1) continue;
    const o = i * 3;
    const dr = r - MATCH_FLAT[o], dg = g - MATCH_FLAT[o+1], db = b - MATCH_FLAT[o+2];
    const d = WR*dr*dr + WG*dg*dg + WB*db*db;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best < 0 ? inks[0] : best;
}

const paperInk = () => (inks.indexOf(1) >= 0 ? 1 : inks[inks.length - 1]);
const bayerAt = (x, y) => BAYER[((y & 7) << 3) + (x & 7)];

/* Thermal — the palette read as a brightness ramp instead of as colours.
   Black through red and yellow to white happens to be a rising luminance
   sequence, so a 4-colour panel can carry a false-colour image with far more
   tonal steps than matching hues ever gives it. */
const RAMP = [0, 3, 2, 1];

function thermalRender() {
  const out = imgData.data;
  const n = RAMP.length - 1;
  const amt = state.ditherAmt;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x, j = p * 3;
      let l = 0.299 * buf[j] + 0.587 * buf[j + 1] + 0.114 * buf[j + 2];
      l = l < 0 ? 0 : l > 255 ? 255 : l;
      const t = (l / 255) * n;
      let i = Math.floor(t);
      if (i >= n) i = n - 1;
      const frac = t - i;
      emit(out, p, RAMP[frac > 0.5 + bayerAt(x, y) * amt ? i + 1 : i]);
    }
  }
}

/* Riso — spot-colour printing, one pass per ink, deliberately out of
   register. Each layer is sampled at its own offset, and later inks cover
   earlier ones because the panel cannot overprint. */
function risoRender() {
  const out = imgData.data;
  const off = Math.round(state.detail / 2);
  const amt = 90 * state.ditherAmt;
  const paper = paperInk();
  const hasY = inks.indexOf(2) >= 0, hasR = inks.indexOf(3) >= 0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      let ink = paper;

      if (hasY) {
        const j = (clampY(y + off) * W + clampX(x - off)) * 3;
        const yellowness = Math.min(buf[j], buf[j + 1]) - buf[j + 2];
        if (yellowness + bayerAt(x, y) * amt > 30) ink = 2;
      }
      if (hasR) {
        const j = (y * W + clampX(x + off)) * 3;
        const redness = buf[j] - Math.max(buf[j + 1], buf[j + 2]);
        if (redness + bayerAt(x, y) * amt > 40) ink = 3;
      }
      const j = p * 3;
      const l = 0.299 * buf[j] + 0.587 * buf[j + 1] + 0.114 * buf[j + 2];
      /* Black is the last pass and covers everything under it, so it has to
         be reserved for genuinely dark ink — at a mid threshold it swallows
         saturated reds and the print turns grey. */
      if (l + bayerAt(x, y) * amt < 70) ink = 0;

      emit(out, p, ink);
    }
  }
}

/* Engrave and Crosshatch — a line screen rather than a dot screen. Line
   thickness tracks darkness, and crosshatch brings in further directions as
   the tone deepens, the way an etching builds up shadow. */
const HATCH = [[0.7071, 0.7071], [0.7071, -0.7071], [1, 0], [0, 1]];

/* How light each ink is. Etch works out how much of an area to cover by
   comparing the colour's brightness with its ink's, so it needs these. */
const INK_LUMA = MATCH_PALETTE.map(c => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]);

/* The ink a colour belongs to by hue alone, with brightness ignored.

   nearestInk() answers a different question — which ink is nearest overall —
   and with white excluded from a line screen, brightness decides it: a pale
   pink sits luma 240 and lands on yellow, because yellow is the only bright
   ink left. Right answer to the wrong question. Here the hue picks the ink and
   the brightness is spent on coverage instead, so pale pink becomes thin red
   lines rather than solid yellow ones.

   Anything without a warm cast — greys, greens, blues — has no ink to be, so
   it goes to black and reads as tone. */
function hueInk(r, g, b) {
  const hasY = inks.indexOf(2) >= 0, hasR = inks.indexOf(3) >= 0;
  const dark = inks.indexOf(0) >= 0 ? 0 : inks[0];
  const yellowness = Math.min(r, g) - b;
  const redness = r - Math.max(g, b);
  if (yellowness < 12 && redness < 12) return dark;
  if (hasY && hasR) return yellowness > redness ? 2 : 3;
  if (hasY && yellowness >= 12) return 2;
  if (hasR && redness >= 12) return 3;
  return dark;
}

/* A line screen like Engrave, but the line keeps the colour's hue and spends
   its brightness on how much of the paper it covers.

   Coverage is the honest amount: to average out at the colour's brightness,
   an ink of its own brightness has to cover (255 - colour) / (255 - ink) of
   the area. Pale pink against red is 14/179 — eight per cent — so it comes
   out as a fine red trace rather than a solid line, and the paper showing
   through it is what makes it read pale. Bright yellow against yellow is over
   1 and clamps to solid.

   Below about a pixel a line stops being drawable and would either vanish or
   alias into stripes, so the ordered matrix jitters the width and breaks it
   into a dashed trace instead. That is the dither doing the lightening. */
function etchRender() {
  const out = imgData.data;
  boxBlur(Math.round(state.smooth), 1);
  computeLuma();

  const period = Math.max(2.5, state.detail);
  const paper = paperInk();
  const jitter = 0.5 * state.ditherAmt;
  const black = inks.indexOf(0) >= 0 ? 0 : -1;

  /* Whether the line pattern covers this pixel at the given width. Below about
     a pixel a line stops being drawable and would either vanish or alias into
     stripes, so the ordered matrix jitters the width and breaks it into a
     dashed trace instead — that is the dither doing the lightening. */
  const line = (x, y, dir, cov) => {
    const u = (x * HATCH[dir][0] + y * HATCH[dir][1]) / period;
    const f = u - Math.floor(u);
    const width = Math.min(0.95, cov * 1.15) + bayerAt(x, y) * jitter * cov;
    return Math.abs(f - 0.5) * 2 < width;
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x, j = p * 3;
      const ink = hueInk(buf[j], buf[j + 1], buf[j + 2]);
      const lum = luma[p];
      const inkLum = INK_LUMA[ink];

      if (lum >= inkLum) {
        /* Lighter than its own ink, so the ink covers part of the paper and
           what shows through is what makes it pale.

           Line weight multiplies that. The honest coverage for a very pale
           colour is a few per cent, which is accurate and almost invisible —
           a pale pink comes back as white paper with a hint of red in it.
           Weight trades that accuracy for presence, so the colour can be
           made to read as a light red rather than as nothing. Darkening the
           image instead would work on the background too, and turn the paper
           into black lines. */
        const room = 255 - inkLum;
        let cov = room > 1 ? (255 - lum) / room : 1;
        /* Only the coloured inks. Black already spans the whole range from
           paper to solid, so its honest coverage is the right amount and
           multiplying it just floods the neutrals. Red and yellow can never
           be darker than themselves, which is what leaves a pale tint of
           them too faint to see. */
        if (ink !== black) { cov *= state.weight; if (cov > 1) cov = 1; }
        emit(out, p, line(x, y, 0, cov) ? ink : paper);
      } else {
        /* Darker than its own ink can go. The ink covers everything and black
           takes the rest, crossing the other way — which is what keeps a
           yellow area from flattening into a solid block. */
        emit(out, p, ink);
        if (black >= 0 && inkLum > 1 && line(x, y, 1, (inkLum - lum) / inkLum)) {
          emit(out, p, black);
        }
      }
    }
  }
}

function lineRender(cross) {
  const out = imgData.data;
  boxBlur(Math.round(state.smooth), 1);
  computeLuma();

  const period = Math.max(2.5, state.detail);
  const dirs = cross ? 4 : 1;
  const paper = paperInk();

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      const dark = 1 - Math.min(1, Math.max(0, luma[p] / 255));
      let on = false;

      for (let d = 0; d < dirs && !on; d++) {
        const gate = cross ? d / dirs : 0;          // each layer waits its turn
        if (dark <= gate) continue;
        const local = (dark - gate) / (1 - gate);
        const u = (x * HATCH[d][0] + y * HATCH[d][1]) / period;
        const f = u - Math.floor(u);
        const width = Math.min(0.92, local * (cross ? 1.5 : 1.15));
        if (Math.abs(f - 0.5) * 2 < width) on = true;
      }

      if (!on) { emit(out, p, paper); continue; }
      const j = p * 3;
      emit(out, p, nearestInk(buf[j], buf[j + 1], buf[j + 2]));
    }
  }
}

/* Contour — iso-luminance lines, like a topographic map. A line is drawn
   wherever a pixel and its neighbour fall in different brightness bands, and
   the bands cycle through the inks so the height reads as colour. */
/* Grow the marked pixels outward, carrying each one's ink with it.

   A one-pixel line is the first thing to disappear once an image is rescaled
   or re-dithered by panel software downstream, and it is marginal on the
   panel itself. Weight buys lines that survive the trip. */
function dilateMask(radius) {
  for (let r = 0; r < radius; r++) {
    const src = mask.slice();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (src[p]) continue;
        let n = -1;
        if (x > 0 && src[p - 1]) n = p - 1;
        else if (x < W - 1 && src[p + 1]) n = p + 1;
        else if (y > 0 && src[p - W]) n = p - W;
        else if (y < H - 1 && src[p + W]) n = p + W;
        if (n >= 0) { mask[p] = 1; maskInk[p] = maskInk[n]; }
      }
    }
  }
}

function paintMask(out, paper) {
  for (let p = 0; p < W * H; p++) emit(out, p, mask[p] ? maskInk[p] : paper);
}

function contourRender() {
  const out = imgData.data;
  boxBlur(Math.max(1, Math.round(state.smooth)), 2);
  computeLuma();

  const step = Math.max(4, state.detail * 6);
  const paper = paperInk();
  const line = inks.filter(i => i !== 1);
  const band = p => Math.floor(luma[p] / step);

  mask.fill(0);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      const b0 = band(p);
      if (b0 === band(y * W + clampX(x + 1)) && b0 === band(clampY(y + 1) * W + x)) continue;
      mask[p] = 1;
      maskInk[p] = line[((b0 % line.length) + line.length) % line.length];
    }
  }
  dilateMask(Math.round(state.weight) - 1);
  paintMask(out, paper);
}

function renderStyle() {
  const out = imgData.data;

  switch (state.style) {
    case 'cel':
      boxBlur(Math.round(state.smooth), 2);
      computeEdges();
      posterize(4);
      quantize('none', 0);
      inkEdges();
      break;

    case 'vector':
      boxBlur(Math.max(1, Math.round(state.smooth * 2)), 2);
      computeEdges();
      posterize(3);
      quantize('none', 0);
      inkEdges();
      break;

    case 'halftone':
      quantize('cluster', state.ditherAmt);
      break;

    case 'thermal':
      thermalRender();
      break;

    case 'riso':
      risoRender();
      break;

    case 'engrave':
      lineRender(false);
      break;

    case 'etch':
      etchRender();
      break;

    case 'crosshatch':
      lineRender(true);
      break;

    case 'contour':
      contourRender();
      break;

    case 'sketch': {
      boxBlur(Math.round(state.smooth), 1);
      computeEdges();
      const thr = edgeThreshold();
      mask.fill(0);
      for (let p = 0; p < W * H; p++) {
        if (edgeMap[p] > thr) { mask[p] = 1; maskInk[p] = 0; }
      }
      dilateMask(Math.round(state.weight) - 1);
      paintMask(out, paperInk());
      break;
    }

    default:
      quantize(state.dither, state.ditherAmt);
  }
}

/* ------------------------------------------------------------ text overlay */
/* System font stacks — no webfonts, so the app stays self-contained and works
   offline. The first name in each stack is the one iOS actually ships; the
   rest are fallbacks for Android and desktop. */
const FONTS = {
  sans:   '700 {S}px -apple-system, "Helvetica Neue", Arial, sans-serif',
  serif:  '700 {S}px Georgia, "Times New Roman", serif',
  slab:   '700 {S}px "American Typewriter", Rockwell, "Courier New", serif',
  mono:   '700 {S}px ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  poster: '400 {S}px Impact, Haettenschweiler, "Arial Narrow", "Arial Black", sans-serif',
  round:  '700 {S}px "Arial Rounded MT Bold", "SF Pro Rounded", "Trebuchet MS", sans-serif',
  marker: '400 {S}px "Bradley Hand", Chalkduster, "Segoe Script", "Comic Sans MS", cursive',

  /* Japanese. iOS ships the Hiragino family (and Klee since iOS 13); the rest
     of each stack covers Android's Noto CJK, then Windows and older macOS.
     Weight is left at 400 for Mincho and Klee — synthetic bold thickens the
     fine strokes of kanji until they close up at panel sizes. */
  jpGothic: '600 {S}px "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", YuGothic, Meiryo, "Noto Sans JP", "Noto Sans CJK JP", sans-serif',
  jpMincho: '400 {S}px "Hiragino Mincho ProN", "Yu Mincho", YuMincho, "Noto Serif JP", "Noto Serif CJK JP", "MS PMincho", serif',
  jpMaru:   '600 {S}px "Hiragino Maru Gothic ProN", "Tsukushi A Round Gothic", "Noto Sans JP", "Noto Sans CJK JP", sans-serif',
  jpKlee:   '400 {S}px Klee, "Klee One", "Toppan Bunkyu Midashi Mincho", "Hiragino Mincho ProN", "Yu Mincho", serif',
};

const MAX_TEXTS = 3;
/* Stagger the default position so a second and third caption do not land on
   top of the first. */
const LAYER_Y = [0.8, 0.5, 0.2];

function newLayer(i) {
  return {
    value: '',
    font: 'sans',
    size: 0.26,          // fraction of panel height
    outline: 2,          // panel pixels, outside the glyph
    color: 1,            // palette index
    outlineColor: 0,
    x: 0.5, y: LAYER_Y[i] !== undefined ? LAYER_Y[i] : 0.5,
    angle: 0,            // degrees, clockwise
    vertical: false,     // one character per line
    bmp: null,           // {w, h, mask, idx} in panel pixels
    dirty: true,
  };
}

const texts = [newLayer(0)];
let active = 0;                       // layer being edited and dragged
const layer = () => texts[active];
const liveLayers = () => texts.filter(L => L.value.trim());

const tcv  = document.createElement('canvas');
const tctx = tcv.getContext('2d', { willReadFrequently: true });
const SS = 3;          // supersample factor for glyph rasterising

function markTextDirty() { layer().dirty = true; syncTargetUI(); kick(); }
function markAllTextDirty() { texts.forEach(L => { L.dirty = true; }); }

function buildTextBitmap(L) {
  L.dirty = false;
  L.bmp = null;
  const str = L.value;
  if (!str.trim() || !W) return;

  const px = Math.max(4, L.size * H);
  const lw = L.outline;
  const fontCss = (FONTS[L.font] || FONTS.sans).replace('{S}', (px * SS).toFixed(2));

  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.font = fontCss;

  /* Vertical writing stacks one character per line, the way Japanese tategaki
     runs — not a rotated line of horizontal text. Horizontally, the caption
     breaks where the typing does: one entry can be several lines. */
  const lines = L.vertical
    ? Array.from(str.replace(/\s+/g, ''))
    : str.replace(/\s+$/, '').split('\n');
  const lineH = px * 1.12;

  let widest = 0;
  for (const ln of lines) widest = Math.max(widest, tctx.measureText(ln).width / SS);
  const cw0 = widest + lw * 2 + 6;
  const ch0 = (lines.length > 1 || L.vertical)
    ? lines.length * lineH + lw * 2 + 6
    : px * 1.5 + lw * 2 + 6;

  /* The bitmap has to hold the rotated extent, not the upright one. */
  const rad = ((L.angle || 0) * Math.PI) / 180;
  const ca = Math.abs(Math.cos(rad)), sa = Math.abs(Math.sin(rad));
  const bw = Math.ceil(cw0 * ca + ch0 * sa);
  const bh = Math.ceil(cw0 * sa + ch0 * ca);
  if (bw < 1 || bh < 1 || bw * bh > 4e6) return;

  const cw = bw * SS, ch = bh * SS;
  if (tcv.width !== cw || tcv.height !== ch) { tcv.width = cw; tcv.height = ch; }

  const mask = new Uint8Array(bw * bh);
  const idx  = new Uint8Array(bw * bh);
  const need = Math.ceil(SS * SS / 2);

  /* Canvas antialiases text, but a 4-colour panel has no intermediate shades
     to put it in. Rasterising at 3x and keeping pixels with at least half
     coverage gives well-shaped letterforms with hard, on-palette edges. */
  const stamp = (paint, ink) => {
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, cw, ch);
    tctx.font = fontCss;
    tctx.textAlign = 'center';
    tctx.textBaseline = 'middle';
    tctx.lineJoin = 'round';
    tctx.miterLimit = 2;
    tctx.translate(cw / 2, ch / 2);
    if (rad) tctx.rotate(rad);

    const step = lineH * SS;
    let y = -(lines.length - 1) * step / 2;
    for (const ln of lines) { if (ln) paint(ln, 0, y); y += step; }
    tctx.setTransform(1, 0, 0, 1, 0, 0);

    const d = tctx.getImageData(0, 0, cw, ch).data;
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let cov = 0;
        for (let sy = 0; sy < SS; sy++) {
          let o = ((y * SS + sy) * cw + x * SS) * 4 + 3;
          for (let sx = 0; sx < SS; sx++, o += 4) if (d[o] >= 128) cov++;
        }
        if (cov >= need) { const p = y * bw + x; mask[p] = 1; idx[p] = ink; }
      }
    }
  };

  /* Stroke first, fill over it: lineWidth is doubled so half the stroke sits
     outside the glyph and the fill covers the half that sits inside. */
  if (lw > 0) {
    tctx.lineWidth = lw * 2 * SS;
    stamp((t, x, y) => {
      tctx.lineWidth = lw * 2 * SS;
      tctx.strokeStyle = '#fff';
      tctx.strokeText(t, x, y);
    }, L.outlineColor);
  }
  stamp((t, x, y) => { tctx.fillStyle = '#fff'; tctx.fillText(t, x, y); }, L.color);

  L.bmp = { w: bw, h: bh, mask, idx };
}

/* Layers stamp in order, so a later caption sits over an earlier one. */
function drawText(out) {
  for (let i = 0; i < texts.length; i++) {
    const L = texts[i];
    if (L.dirty) buildTextBitmap(L);
    if (!L.bmp) continue;
    const bw = L.bmp.w, bh = L.bmp.h, mask = L.bmp.mask, idx = L.bmp.idx;
    const ox = Math.round(L.x * W - bw / 2);
    const oy = Math.round(L.y * H - bh / 2);

    for (let y = 0; y < bh; y++) {
      const ty = oy + y;
      if (ty < 0 || ty >= H) continue;
      const row = y * bw, trow = ty * W;
      for (let x = 0; x < bw; x++) {
        if (!mask[row + x]) continue;
        const tx = ox + x;
        if (tx < 0 || tx >= W) continue;
        emit(out, trow + tx, idx[row + x]);
      }
    }
  }
}

/* What a drag moves is an explicit choice rather than a hit-test on the
   glyphs: a caption sized past about half the panel covers the whole preview,
   leaving nowhere to grab for panning. The selector is independent of the
   drawers, so the caption can be placed against a full-size preview. */
function textGesture() {
  return state.target === 'text' && !!layer().value.trim();
}

function setTarget(v) {
  state.target = v;
  renderTargetPill();
}

/* The pill doubles as the layer picker: with more than one caption it lists
   them, so the layer being dragged can be switched without opening a drawer.
   It stays out of the way entirely until there is something to aim at. */
function renderTargetPill() {
  const pill = $('target-seg');
  const live = texts.map((L, i) => [L, i]).filter(([L]) => L.value.trim());
  pill.hidden = live.length === 0;
  if (pill.hidden) { pill.innerHTML = ''; return; }   // no stale buttons or ARIA

  const wanted = ['photo'].concat(live.map(([, i]) => 'text' + i));
  const current = [...pill.children].map(b => b.dataset.pick).join(',');
  if (current !== wanted.join(',')) {
    pill.innerHTML = '';
    pill.append(mkPick('photo', 'Photo'));
    live.forEach(([, i]) => {
      pill.append(mkPick('text' + i, live.length > 1 ? String(i + 1) : 'Text'));
    });
  }
  const sel = state.target === 'text' ? 'text' + active : 'photo';
  [...pill.children].forEach(b => {
    const on = b.dataset.pick === sel;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-checked', String(on));
  });
}

function mkPick(pick, label) {
  const b = document.createElement('button');
  b.className = 'seg-btn';
  b.dataset.pick = pick;
  b.setAttribute('role', 'radio');
  b.textContent = label;
  return b;
}

/* A caption that has been emptied can no longer be the drag target. */
function syncTargetUI() {
  if (state.target === 'text' && !layer().value.trim()) state.target = 'photo';
  renderTargetPill();
  renderLayerTabs();
}

function hintText() {
  return textGesture()
    ? 'Drag to move the caption · pinch to resize it'
    : 'Drag to reposition · pinch to zoom';
}

/* --------------------------------------------------------------- pipeline */
let lastSource = null;   // {el, w, h} — video, captured still, or upload

function renderOnce() {
  if (!lastSource) return false;
  const src = grabFrame(lastSource.el, lastSource.w, lastSource.h);
  if (!src) return false;
  adjust(src);
  renderStyle();
  restoreBackground(imgData.data);
  drawText(imgData.data);
  pctx.putImageData(imgData, 0, 0);
  return true;
}

let lastDraw = 0;

function loop(ts) {
  requestAnimationFrame(loop);
  if (mode !== 'live') return;
  if (ts - lastDraw < 33) return;          // cap ~30fps
  lastDraw = ts;
  if (lastSource && lastSource.el === video) {
    if (video.readyState < 2 || !video.videoWidth) return;
    lastSource.w = video.videoWidth;
    lastSource.h = video.videoHeight;
  }
  renderOnce();
}

/* Re-render immediately when a control changes and the live loop is paused. */
function kick() { if (mode !== 'live') renderOnce(); }

/* ------------------------------------------------------- preview sizing */
/* The canvas box is sized here rather than in CSS. Sizing it with max-width /
   max-height inside a flex row let the browser stretch it off-aspect, and a
   fractional scale factor makes nearest-neighbour drop whole rows of dither
   pattern — so snap to a whole-number multiple whenever the panel fits. */
let dispScale = 1;

function layoutPreview() {
  const cs = getComputedStyle(stage);
  const availW = stage.clientWidth  - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = stage.clientHeight - parseFloat(cs.paddingTop)  - parseFloat(cs.paddingBottom);
  if (availW <= 0 || availH <= 0) return;

  let k = Math.min(availW / W, availH / H);
  if (k >= 1) k = Math.floor(k);
  if (!(k > 0)) k = availW / W;

  dispScale = k;
  preview.style.width  = Math.round(W * k) + 'px';
  preview.style.height = Math.round(H * k) + 'px';
  preview.classList.toggle('smooth', k < 1);
}

/* ------------------------------------------------------------ pan / zoom */
const ptrs = new Map();
let pinch = null;

function pinchDist() {
  const [a, b] = [...ptrs.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/* Below 1 the photo is smaller than the panel and sits on the background
   colour; 0.2 is far enough to make a stamp of it without the slider spending
   most of its travel somewhere useless. */
const ZOOM_MIN = 0.2;

function setZoom(z) {
  state.zoom = Math.min(6, Math.max(ZOOM_MIN, z));
  const el = $('s-zoom');
  el.value = state.zoom;
  $('o-zoom').textContent = state.zoom.toFixed(1) + '×';
}

/* Convert a drag in screen space back into the source-space crop offset,
   undoing the mirror and rotation that sit between the two. */
function panBy(dx, dy) {
  if (!lastSource || !dispScale) return;
  const g = cropGeom(lastSource.w, lastSource.h);

  let ox = dx / dispScale, oy = dy / dispScale;
  if (view.mirror) ox = -ox;

  /* Undo the rotation that sits between the screen and the crop, so a drag
     moves the photo the way the finger went rather than off at the tilt. */
  const rad = -totalTurn() * Math.PI / 180;
  const cs = Math.cos(rad), sn = Math.sin(rad);
  const du = ox * cs - oy * sn;
  const dv = ox * sn + oy * cs;

  const perPx = g.cw / g.tw;     // source pixels per output pixel
  view.panX = slide('panX', 'offX', du, g.slackX, g.marginX, perPx, g.maxCX, g.marginX);
  view.panY = slide('panY', 'offY', dv, g.slackY, g.marginY, perPx, g.maxCY, g.marginY);
}

/* Pushing the photo off the edge has to be asked for. At zoom 1 the photo
   exactly fills the panel and one axis usually has no pan at all, so without a
   threshold every stray movement of a finger would slide the picture off and
   leave a band of background down the side — which reads as a bug, not as a
   composition. So the leftover from a drag builds up as pressure, and only
   what exceeds the deadband moves the photo. */
const OVERHANG_DEADBAND = 48;
/* Within this of flush, the photo snaps to the edge. Landing exactly on zero
   by hand is not possible, and a two-pixel band of background down the side is
   the thing being complained about, not a composition anyone chose. */
const OVERHANG_SNAP = 5;
const press = { panX: 0, panY: 0 };

function startOverhang() { press.panX = 0; press.panY = 0; }

/* A drag feeds two reservoirs, and the order matters in each direction.

   Going out: the pan first, until the crop or the margin is used up, and only
   then the overhang — so the gesture runs smoothly from one into the other
   instead of sticking at the limit.

   Coming back: the overhang first, because it was the last thing filled. Doing
   it the other way round lets the pan quietly absorb the whole return drag
   while the photo stays stuck off the edge — which is exactly what it did, and
   at any zoom with crop slack it could not be undone by dragging at all.

   Pan is inverted in crop mode — there the gesture moves the window, not the
   picture — which is why those two branches differ in sign. */
function slide(panKey, offKey, d, slack, margin, perPx, maxC, marginPx) {
  let pan = view[panKey], off = view[offKey], rest = d;
  const wasOut = off !== 0;

  if (off !== 0 && rest * off < 0) {
    const next = off + rest;
    if (off > 0 ? next <= 0 : next >= 0) {
      rest = next;                 // overhang spent; the remainder pans
      off = 0;
      press[panKey] = 0;           // leaving again has to clear the deadband
    } else {
      off = next;
      rest = 0;
    }
  }

  let used = 0;
  if (rest !== 0) {
    if (slack > 0) {
      const next = clamp1(pan - rest * perPx / slack);
      used = (pan - next) * slack / perPx;
      pan = next;
    } else if (margin > 0) {
      const next = clamp1(pan + rest / margin);
      used = (next - pan) * margin;
      pan = next;
    }
  }

  const leftover = rest - used;
  if (off !== 0) {
    off += leftover;               // already out: no threshold to clear
  } else if (leftover) {
    press[panKey] += leftover;
    const past = Math.abs(press[panKey]) - OVERHANG_DEADBAND;
    off = past > 0 ? Math.sign(press[panKey]) * past : 0;
  }

  /* Clamped against what pan already contributes, so the stored offset never
     runs past the limit — otherwise dragging back would spend the first part
     of the gesture undoing slack that was never visible. */
  const centre = pan * marginPx;
  const lo = -maxC - centre, hi = maxC - centre;
  if (off < lo) off = lo; else if (off > hi) off = hi;
  /* Only on the way back. Applied while the overhang is growing it would snap
     the photo home the moment it crossed the deadband, and it could never
     leave the edge at all. */
  if (wasOut && margin === 0 && Math.abs(off) < OVERHANG_SNAP) {
    off = 0; press[panKey] = 0;
  }

  view[offKey] = off;
  return pan;
}
function clamp1(v) { return v < -1 ? -1 : v > 1 ? 1 : v; }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

function setTextSize(v) {
  const L = layer();
  L.size = Math.min(0.9, Math.max(0.06, v));
  $('t-size').value = L.size;
  $('ot-size').textContent = L.size.toFixed(2);
  markTextDirty();
}

let dragText = false;

function bindGestures() {
  stage.addEventListener('pointerdown', e => {
    /* Capturing the pointer for a drag swallows the click that would have
       followed, so anything interactive inside the stage — the target pill,
       the source chooser, the retry button on an error — has to be let
       through before the gesture starts. */
    if (e.target.closest('button, label, input')) return;
    try { stage.setPointerCapture(e.pointerId); } catch (_) { /* stale id */ }
    if (ptrs.size === 0) { dragText = textGesture(); startOverhang(); }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) {
      pinch = { dist: pinchDist(), zoom: state.zoom, size: layer().size, onText: dragText };
    }
  });

  stage.addEventListener('pointermove', e => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;

    if (ptrs.size >= 2) {
      if (pinch && pinch.dist > 0) {
        const ratio = pinchDist() / pinch.dist;
        if (pinch.onText) setTextSize(pinch.size * ratio);
        else setZoom(pinch.zoom * ratio);
      }
    } else if (dragText) {
      /* Position is applied when the bitmap is stamped, so moving the caption
         costs nothing beyond a redraw. */
      const L = layer();
      L.x = clamp01(L.x + dx / dispScale / W);
      L.y = clamp01(L.y + dy / dispScale / H);
    } else {
      panBy(dx, dy);
    }
    kick();
  });

  const end = e => {
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (ptrs.size === 0) dragText = false;
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);

  /* Desktop convenience. */
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    if (textGesture()) setTextSize(layer().size * (e.deltaY < 0 ? 1.06 : 1 / 1.06));
    else setZoom(state.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
    kick();
  }, { passive: false });
}

function resetCrop() {
  view.rot = 0; view.panX = 0; view.panY = 0; view.offX = 0; view.offY = 0;
  view.mirror = false;
  setZoom(1);
  setAngle(0);
  syncFlip();
  kick();
}

function setAngle(deg) {
  state.angle = deg;
  $('s-angle').value = deg;
  $('o-angle').textContent = (deg > 0 ? '+' : '') + deg + '\u00b0';
}

function totalTurn() { return view.rot + state.angle; }

function rotate(deg) {
  view.rot = (view.rot + deg + 360) % 360;
  kick();
}

/* ----------------------------------------------------------------- camera */
let stream = null;

/* Whether the browser remembers a camera grant is the browser's call, not the
   page's — there is no API to ask for a lasting permission. What the page can
   do is avoid asking when it does not need to: never call getUserMedia when
   the answer is already known to be no, and never re-ask silently in the
   background, because on iOS each call is a fresh prompt. */
let hadCamera = false;      // a grant has been given at least once this session

async function cameraPermission() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return 'unknown';
    const st = await navigator.permissions.query({ name: 'camera' });
    /* Granting it later from browser settings should not need a reload. */
    if (st && 'onchange' in st) {
      st.onchange = () => { if (st.state === 'granted' && !stream && mode === 'live') startCamera(); };
    }
    return st.state;
  } catch (_) {
    return 'unknown';       // Safari has no 'camera' descriptor
  }
}

function blockedStatus() {
  setStatus('Camera blocked', IOS
    ? 'Turn it back on in Settings \u203a Safari \u203a Camera, or tap aA in the address bar \u203a Website Settings \u203a Camera \u203a Allow. You can still upload a photo.'
    : 'Camera permission is blocked for this site. Re-enable it in the browser\u2019s site settings, or upload a photo instead.',
    'Try again', () => startCamera());
}

/* The camera is only opened when it is actually asked for. Starting it on
   every launch means a permission prompt on every launch for anyone whose
   browser does not remember the grant, even when they only wanted to pick a
   photo from the library. */
function showChooser() {
  stopCamera();
  clearStatus();
  setMode('choose');
}

async function initCamera() {
  const p = await cameraPermission();
  if (p === 'granted') { startCamera(); return; }   // already allowed: no prompt to raise
  showChooser();
}

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('Camera unavailable',
      'This browser will not open a camera here. Serve the page over HTTPS, or upload a photo with the button below.');
    return;
  }
  stopCamera();
  /* Opening a camera is slow enough that the user can upload a photo or open
     a project in the meantime. Anything that stops the camera bumps this
     counter, so a start that is no longer wanted releases its stream instead
     of dragging the app back to the live view. */
  const seq = ++camSeq;
  try {
    const media = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: state.facing },
        width:  { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    if (seq !== camSeq) { media.getTracks().forEach(t => t.stop()); return; }
    stream = media;
    hadCamera = true;
    video.srcObject = stream;
    await video.play().catch(() => {});
    /* play() is a second suspension point, and an upload landing in it would
       otherwise be overwritten by the line below. */
    if (seq !== camSeq) { media.getTracks().forEach(t => t.stop()); stream = null; return; }
    lastSource = { el: video, w: video.videoWidth, h: video.videoHeight };
    view.mirror = state.facing === 'user';
    syncFlip();
    setMode('live');
    clearStatus();
  } catch (err) {
    if (seq !== camSeq) return;          // superseded; not this failure's problem
    if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
      blockedStatus();
    } else {
      setStatus('No camera', 'Could not open the camera. You can still upload a photo.',
                'Try again', () => startCamera());
    }
  }
}

let camSeq = 0;

function stopCamera() {
  camSeq++;                               // invalidates any start still in flight
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
}

function setStatus(title, body, actionLabel, onAction) {
  statusEl.hidden = false;
  statusEl.innerHTML = '';
  const b = document.createElement('b');
  b.textContent = title;
  statusEl.append(b, document.createTextNode(body || ''));
  if (actionLabel) {
    const btn = document.createElement('button');
    btn.className = 'btn status-btn';
    btn.textContent = actionLabel;
    btn.addEventListener('click', onAction);
    statusEl.append(btn);
  }
}
function clearStatus() { statusEl.hidden = true; }

/* ------------------------------------------------------------------ modes */
let hintTimer = 0;

function setMode(m) {
  mode = m;
  document.body.dataset.mode = m;
  $('chooser').hidden = m !== 'choose';
  layoutPreview();
  if (m === 'review') { renderOnce(); showHint(); }
}

function showHint() {
  const el = $('hint');
  el.textContent = hintText();
  el.classList.add('show');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ------------------------------------------------------------------ sizes */
/* Switching orientation turns the whole composition, not just the frame:
   the crop rotates and every caption travels with it, keeping its place on
   the picture and its own reading direction. */
function turnComposition(deg) {
  view.rot = (view.rot + deg + 360) % 360;
  const cw = deg > 0;
  texts.forEach(L => {
    const x = L.x, y = L.y;
    if (cw) { L.x = 1 - y; L.y = x; } else { L.x = y; L.y = 1 - x; }
    L.angle = (((L.angle || 0) + deg) % 360 + 540) % 360 - 180;
    L.dirty = true;
  });
}

function applySize() {
  const [a, b] = SIZES[state.size];
  if (state.orient === 'portrait') { W = b; H = a; } else { W = a; H = b; }
  allocate();
  kick();
}

/* ---------------------------------------------------------------- capture */
function capture() {
  if (mode !== 'live' || !lastSource) return;
  const { el, w, h } = lastSource;
  if (!w || !h) return;

  setOpenProject(null);
  still.width = w; still.height = h;
  stillCtx.drawImage(el, 0, 0, w, h);
  lastSource = { el: still, w, h };
  stopCamera();
  setMode('review');
}

function backToCamera() {
  showChooser();
}

function useUpload(img) {
  stopCamera();
  setOpenProject(null);
  startFresh();
  lastSource = { el: img, w: img.naturalWidth, h: img.naturalHeight };
  clearStatus();
  setMode('review');
}

/* A photo off the camera roll arrives with nothing attached to it, so it opens
   the way the app opens: default style, default adjustments, no captions.

   The settings are one global set rather than a per-image one, which meant
   whatever was last on screen — very often a project just reopened — came
   along and quietly reskinned the new picture. Carrying a look forward is
   something a saved project does, and it does it because it stored one.

   Not applied to the shutter: the live view is already showing the style being
   framed, and resetting at the moment of capture would change the photo out
   from under the person who just composed it. */
function startFresh() {
  view.rot = 0; view.panX = 0; view.panY = 0; view.offX = 0; view.offY = 0;
  view.mirror = false;
  syncFlip();

  state.style = 'photo';
  state.palette = 'full';
  Object.assign(state, DEFAULTS);
  setZoom(state.zoom);

  texts.length = 0;
  texts.push(newLayer(0));
  active = 0;

  ['style', 'dither', 'palette'].forEach(k => setSeg(k, state[k]));
  SLIDERS.forEach(([id, key, fmt]) => {
    $(id).value = state[key];
    $(id.replace('s-', 'o-')).textContent = fmt(state[key]);
  });
  applyPalette();
  syncBgSwatches();
  buildLUT();
  syncStyleUI();
  syncTextControls();
  renderLayerTabs();
  renderTargetPill();
}

/* ----------------------------------------------------------------- export */
function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* A panel's frame buffer is a fixed landscape raster — a 296x128 module is
   296 across however you hang it. Composing in portrait is a framing choice,
   not a different panel, so exports are always rotated back into the native
   landscape frame. Which way round depends on how the module is mounted, so
   that stays a choice. */
function nativeSize() {
  const [a, b] = SIZES[state.size];        // stored landscape-first
  return { w: a, h: b };
}

function exportsRotated() {
  const nat = nativeSize();
  return !(W === nat.w && H === nat.h);
}

/* Palette indices in the panel's own orientation. */
function exportView() {
  if (!exportsRotated()) return { w: W, h: H, idx: indices, rotated: false };

  const dw = H, dh = W;
  const out = new Uint8Array(dw * dh);
  const cw = state.exportRot !== 'ccw';
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = cw ? H - 1 - y : y;
      const dy = cw ? x : W - 1 - x;
      out[dy * dw + dx] = indices[y * W + x];
    }
  }
  return { w: dw, h: dh, idx: out, rotated: true };
}


function baseName() {
  const v = exportView();
  return `eink-${v.w}x${v.h}-${stamp()}`;
}


/* ------------------------------------------------- indexed PNG encoding */
/* Canvas only writes 24/32-bit PNGs, where nothing stops a downstream tool
   from resampling a pixel into a fifth colour. An indexed PNG carries a
   4-entry palette and 2 bits per pixel, so an off-palette colour is not
   representable at all — the file itself states that these four are the only
   colours, which is a far stronger hint to panel software than a truecolour
   image that happens to contain four values. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return (((b << 16) | a) >>> 0);
}

/* Stored (uncompressed) deflate blocks. A 4-colour panel image at 2bpp is
   tens of kilobytes at worst, so this trades a little size for having no
   compressor to get wrong. */
function zlibStore(raw) {
  const MAX = 65535;
  const blocks = Math.max(1, Math.ceil(raw.length / MAX));
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  let o = 0;
  out[o++] = 0x78; out[o++] = 0x01;
  for (let i = 0; i < blocks; i++) {
    const start = i * MAX;
    const len = Math.min(MAX, raw.length - start);
    out[o++] = (i === blocks - 1) ? 1 : 0;
    out[o++] = len & 0xFF;
    out[o++] = (len >>> 8) & 0xFF;
    out[o++] = (~len) & 0xFF;
    out[o++] = ((~len) >>> 8) & 0xFF;
    out.set(raw.subarray(start, start + len), o);
    o += len;
  }
  const ad = adler32(raw);
  out[o++] = (ad >>> 24) & 0xFF; out[o++] = (ad >>> 16) & 0xFF;
  out[o++] = (ad >>> 8) & 0xFF;  out[o++] = ad & 0xFF;
  return out.subarray(0, o);
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function indexedPngBlob() {
  const v = exportView();
  const rowBytes = Math.ceil(v.w / 4);
  const raw = new Uint8Array((rowBytes + 1) * v.h);
  for (let y = 0; y < v.h; y++) {
    const ro = y * (rowBytes + 1);
    raw[ro] = 0;                                   // filter type: none
    for (let x = 0; x < v.w; x++) {
      raw[ro + 1 + (x >> 2)] |= (v.idx[y * v.w + x] & 3) << (6 - 2 * (x & 3));
    }
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, v.w);
  dv.setUint32(4, v.h);
  ihdr[8] = 2;      // 2 bits per pixel
  ihdr[9] = 3;      // colour type 3: indexed
  const plte = new Uint8Array(12);
  for (let i = 0; i < 4; i++) {
    plte[i * 3]     = PALETTE[i][0];
    plte[i * 3 + 1] = PALETTE[i][1];
    plte[i * 3 + 2] = PALETTE[i][2];
  }

  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', plte),
    pngChunk('IDAT', zlibStore(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  return new Blob(parts, { type: 'image/png' });
}


function exportBlob() { return Promise.resolve(indexedPngBlob()); }

function exportExt() { return '.png'; }

async function saveFile() {
  const blob = await exportBlob();
  if (blob) download(blob, baseName() + exportExt());
  closeSheet();
}


function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  /* iOS hands the blob URL to its download manager and may fetch it a moment
     later, so the URL outlives the click by a generous margin. */
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}




/* iOS has no way for a web page to write straight into the photo album; the
   share sheet's "Save Image" is the supported route, so that is what this
   button opens.

   Safari only allows navigator.share() straight out of a user gesture, and
   awaiting toBlob() first spends that activation — so the PNG is encoded up
   front when the sheet opens and the tap handler shares the ready-made file
   without awaiting anything before the call. */
let pendingFile = null;

function prepareShareFile() {
  pendingFile = null;
  /* Same encoder as the download, so the two cannot disagree — including the
     rotation into the panel's native frame. */
  exportBlob().then(blob => {
    if (blob) {
      pendingFile = new File([blob], baseName() + exportExt(), { type: blob.type });
    }
  });
}

function saveToPhotos() {
  if (!pendingFile) return;                 // still encoding; tap again
  const done = () => closeSheet();
  navigator.share({ files: [pendingFile], title: 'E-Ink photo' })
    .then(done)
    .catch(() => closeSheet());             // user cancelled the sheet
}

let sharable = false;

function canSharePng() {
  try {
    const f = new File([new Uint8Array([0])], 'a.png', { type: 'image/png' });
    return !!(navigator.canShare && navigator.canShare({ files: [f] }) && navigator.share);
  } catch (_) { return false; }
}

function openSheet() {
  if (mode !== 'review') return;
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < indices.length; i++) counts[indices[i]]++;
  const total = indices.length || 1;
  const v = exportView();
  $('shot-meta').textContent = `${v.w}×${v.h} · ` +
    PAL_NAMES.map((n, i) => `${n} ${Math.round(counts[i] / total * 100)}%`).join(' · ');

  const row = $('export-rot');
  row.hidden = !v.rotated;
  if (v.rotated) {
    $('export-note').textContent = `Composed ${W}×${H}, exported ${v.w}×${v.h}`;
    setSeg('exportrot', state.exportRot);
  }

  $('save-sheet').hidden = false;
  if (sharable) prepareShareFile();
}
function closeSheet() { $('save-sheet').hidden = true; }

/* ---------------------------------------------------------------- gallery */
/* --------------------------------------------------------------- projects */
/* A project is the editable state of a shot: the full-resolution background
   plus the crop, the adjustments and every caption — not the flattened
   4-colour export.

   Projects belong on a server. Browser storage on iOS is evictable: Safari
   clears site data for anything not opened in seven days, which is exactly
   long enough to lose work you meant to keep. So a remote endpoint is used
   whenever one is configured, and the on-device store is kept only as an
   offline fallback that syncs up when the endpoint is reachable again. */

const REMOTE_KEY = 'einkcam.remote';

/* There is one server, so its address is built in rather than typed into every
   device. It is not a secret and cannot be — this file is downloaded by every
   visitor — it is simply not worth showing. The password is the actual lock,
   and it is deliberately NOT in here: this repository is public, so anything
   committed alongside the URL would protect nothing. It is entered once per
   device and remembered there. */
const REMOTE_URL = 'https://e-ink.mew-860.workers.dev';

let remote = loadRemote();

/* The only thing stored per device is the password; the URL always comes from
   the constant above, so moving the server is a one-line change that every
   device picks up. Older records also carried a url — ignoring it is what
   migrates them. */
function loadRemote() {
  if (!REMOTE_URL) return null;
  let token = '';
  try {
    const r = JSON.parse(localStorage.getItem(REMOTE_KEY));
    if (r && r.token) token = r.token;
  } catch (_) { /* unreadable — no password yet */ }
  return { url: REMOTE_URL, token };
}

function storePassword(token) {
  remote = { url: REMOTE_URL, token };
  try { localStorage.setItem(REMOTE_KEY, JSON.stringify({ token })); }
  catch (_) { /* private mode — it just will not be remembered */ }
}

function apiUrl(path) {
  return remote.url.replace(/\/+$/, '') + path;
}

function apiHeaders(extra) {
  const h = Object.assign({}, extra || {});
  if (remote && remote.token) h.Authorization = 'Bearer ' + remote.token;
  return h;
}

/* cache: 'no-store' belt-and-braces alongside the service worker rule — the
   project list must never come from a cache. */
async function api(path, opts) {
  const res = await fetch(apiUrl(path), Object.assign({
    cache: 'no-store',
    headers: apiHeaders(opts && opts.headers),
  }, opts || {}, { headers: apiHeaders(opts && opts.headers) }));
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res;
}

/* ------------------------------------------------- on-device fallback store */
const DB_NAME = 'einkcam', DB_VER = 1, STORE = 'projects';
const PROJ_MAX = 12;

function idb() {
  return new Promise((res, rej) => {
    let r;
    try { r = indexedDB.open(DB_NAME, DB_VER); }
    catch (e) { return rej(e); }
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function idbRun(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, mode);
    const out = fn(tx.objectStore(STORE));
    tx.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}

const localList   = () => idbRun('readonly',  s => s.getAll());
const localPut    = r  => idbRun('readwrite', s => s.put(r));
const localDelete = id => idbRun('readwrite', s => s.delete(id));

/* ------------------------------------------------------------- serialising */
/* Lossless when it is affordable, JPEG when it is not.

   Error diffusion is chaotic — shifting one source pixel by a single level can
   flip a dot and cascade — so a lossy background comes back with a slightly
   different dither pattern (under 1% of pixels, invisible, but not identical).
   Graphics and screenshots compress small as PNG and round-trip exactly;
   camera photos run to several megabytes, where JPEG is the sane trade. */
const LOSSLESS_LIMIT = 1.5e6;

function encode(canvas, type, q) {
  return new Promise(res => canvas.toBlob(res, type, q));
}

function hasAlpha(canvas) {
  try {
    const x = canvas.getContext('2d', { willReadFrequently: true });
    const d = x.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true;
  } catch (_) { /* tainted or oversized — assume not */ }
  return false;
}

async function sourceBlob() {
  const { el, w, h } = lastSource;
  let canvas = el;
  if (!el.toBlob) {
    canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(el, 0, 0, w, h);
  }
  const png = await encode(canvas, 'image/png');
  if (png && png.size <= LOSSLESS_LIMIT) return png;
  /* JPEG has no alpha channel, so falling back to it would bring a transparent
     PNG back with black wherever the background belongs. Size is the lesser
     problem. */
  if (png && hasAlpha(canvas)) return png;
  return encode(canvas, 'image/jpeg', 0.95);
}

/* bmp and dirty are derived from the rest, so they are not persisted. */
function serialiseTexts() {
  return texts.map(L => ({
    value: L.value, font: L.font, size: L.size, outline: L.outline,
    color: L.color, outlineColor: L.outlineColor, x: L.x, y: L.y,
    angle: L.angle, vertical: L.vertical,
  }));
}

function meta(rec) {
  return {
    id: rec.id, w: rec.w, h: rec.h, thumb: rec.thumb,
    state: rec.state, view: rec.view, texts: rec.texts, active: rec.active,
  };
}

/* ------------------------------------------------------------------ saving */
async function pushRemote(rec) {
  const fd = new FormData();
  fd.append('meta', JSON.stringify(meta(rec)));
  fd.append('blob', rec.blob, 'background');
  await api('/projects/' + rec.id, { method: 'PUT', body: fd });
}

/* Which stored project the work on screen came from, so Save can put it back
   where it came from instead of leaving a second copy behind. Cleared whenever
   the background changes, because at that point it is a different picture. */
let openId = null;

function setOpenProject(id) {
  openId = id;
  const btn = $('btn-save-project');
  if (btn) btn.disabled = !id;
}

async function saveProject(asNew) {
  if (mode !== 'review' || !lastSource) return;
  if (!asNew && !openId) return;              // nothing to save over
  const blob = await sourceBlob();
  if (!blob) { toast('Could not save this image'); return; }

  /* Overwriting keeps the id, so the project stays where it was in the list
     rather than jumping to the top as if it were new. */
  const id = asNew ? String(Date.now()) : openId;
  const rec = {
    id,
    w: W, h: H,
    thumb: preview.toDataURL('image/png'),
    state: Object.assign({}, state),
    view: Object.assign({}, view),
    texts: serialiseTexts(),
    active,
    blob,
  };

  if (remote) {
    try {
      await pushRemote(rec);
      setOpenProject(id);
      toast(asNew ? 'Saved online' : 'Project updated');
      closeSheet();
      return;
    } catch (_) {
      /* Keep the work rather than lose it, and mark it to go up later. */
      rec.pending = true;
    }
  }

  try {
    await localPut(rec);
    const all = await localList();
    all.sort((a, b) => Number(b.id) - Number(a.id));
    for (const old of all.slice(PROJ_MAX)) await localDelete(old.id);
    setOpenProject(id);
    toast(remote ? 'Server unreachable — saved on device' : 'Saved on this device');
  } catch (_) {
    toast('Could not save — storage unavailable');
  }
  closeSheet();
}

/* Anything saved while the endpoint was down goes up on the next listing. */
async function flushPending() {
  if (!remote) return;
  let pend = [];
  try { pend = (await localList()).filter(r => r.pending); } catch (_) { return; }
  for (const rec of pend) {
    try {
      await pushRemote(rec);
      await localDelete(rec.id);
    } catch (_) { return; }        // still down; try again next time
  }
  if (pend.length) toast(`Synced ${pend.length} project${pend.length === 1 ? '' : 's'}`);
}

/* ---------------------------------------------------------------- restoring */
/* Push a restored project back through every control, so the drawers agree
   with what is on screen. */
function applyProjectState(rec) {
  setOpenProject(rec.id);
  Object.assign(state, rec.state);
  Object.assign(view, { offX: 0, offY: 0 }, rec.view);

  texts.length = 0;
  (rec.texts && rec.texts.length ? rec.texts : [{}]).forEach((t, i) => {
    texts.push(Object.assign(newLayer(i), t, { bmp: null, dirty: true }));
  });
  active = Math.min(rec.active || 0, texts.length - 1);

  ['size', 'orient', 'style', 'dither', 'palette'].forEach(k => setSeg(k, state[k]));
  SLIDERS.forEach(([id, key, fmt]) => {
    $(id).value = state[key];
    $(id.replace('s-', 'o-')).textContent = fmt(state[key]);
  });

  applyPalette();
  syncBgSwatches();
  buildLUT();
  syncStyleUI();
  syncFlip();
  applySize();            // re-allocates buffers and marks the captions dirty
  syncTextControls();
  renderLayerTabs();
  renderTargetPill();
}

function setSeg(attr, value) {
  document.querySelectorAll(`[data-${attr}]`).forEach(b => {
    const on = b.dataset[attr] === String(value);
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-checked', String(on));
  });
}

let srcUrl = null;

async function openProject(rec) {
  let blob = rec.blob;
  if (!blob) {
    try {
      blob = await (await api('/projects/' + rec.id + '/blob')).blob();
    } catch (_) {
      toast('Could not fetch that project');
      return;
    }
  }

  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    await (img.decode ? img.decode() : new Promise(ok => { img.onload = ok; }));
  } catch (_) {
    URL.revokeObjectURL(url);
    toast('Could not open that project');
    return;
  }
  stopCamera();
  if (srcUrl) URL.revokeObjectURL(srcUrl);
  srcUrl = url;

  applyProjectState(rec);
  lastSource = { el: img, w: img.naturalWidth, h: img.naturalHeight };
  $('projects').hidden = true;
  setMode('review');
}

async function removeProject(rec) {
  if (rec.local) { await localDelete(rec.id); return; }
  try { await api('/projects/' + rec.id, { method: 'DELETE' }); }
  catch (_) { toast('Could not delete — server unreachable'); }
}

/* ------------------------------------------------------------------ listing */
async function gatherProjects() {
  const out = [];
  let remoteFailed = false, needsAuth = false;

  if (remote) {
    try {
      const data = await (await api('/projects')).json();
      (data.projects || []).forEach(p => p && out.push(p));
    } catch (e) {
      remoteFailed = true;
      /* A rejected password is not an unreachable server, and saying so is the
         difference between "type it in" and "wait and try later". */
      needsAuth = /HTTP 40[13]/.test(String(e && e.message));
    }
  }

  /* On-device records are only the ones not yet on the server (or all of them
     when no server is configured). */
  try {
    (await localList()).forEach(r => out.push(Object.assign({}, r, { local: true })));
  } catch (_) { /* no IndexedDB */ }

  out.sort((a, b) => Number(b.id) - Number(a.id));
  return { list: out, remoteFailed, needsAuth };
}

function storeLabel(remoteFailed, needsAuth) {
  if (!remote) return ['This device', 'Browser storage can be evicted — add a server to keep projects safely.'];
  if (needsAuth) return ['Password needed', 'Enter the password to use projects on this device.'];
  if (remoteFailed) return ['Server unreachable', 'Showing what is on this device. Saves will sync when the server is back.'];
  return ['Online', 'Projects are saved on the server, not on this device.'];
}

async function renderProjects() {
  const grid = $('projects-grid');
  grid.innerHTML = '';
  await flushPending();

  const { list, remoteFailed, needsAuth } = await gatherProjects();
  const [label, detail] = storeLabel(remoteFailed, needsAuth);
  const badge = $('store-status');
  badge.textContent = label;
  badge.className = 'store-badge ' + (!remote ? 'is-local' : remoteFailed ? 'is-down' : 'is-online');

  /* Visibility is derived here rather than left as whatever it last was.
     The form opens by itself when nothing will work until a password is in,
     stays open while the user is deliberately editing one, and is otherwise
     closed — including straight after connecting, which is when leaving a
     password box on screen is most confusing. */
  const wantForm = needsAuth || pwOpen;
  $('store-form').hidden = !wantForm;
  if (wantForm) fillStoreForm();
  if (!wantForm) $('store-msg').textContent = '';
  $('store-detail').textContent = detail;

  if (!list.length) {
    const p = document.createElement('p');
    p.textContent = 'No saved projects yet. Take or upload a photo, then Save · Project.';
    grid.appendChild(p);
    return;
  }

  list.forEach(rec => {
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = rec.thumb;
    img.alt = '';

    const meta = document.createElement('figcaption');
    const caps = (rec.texts || []).filter(t => t.value && t.value.trim()).length;
    const d = new Date(Number(rec.id));
    const p2 = n => String(n).padStart(2, '0');
    meta.textContent = `${rec.w}×${rec.h} · ${caps} caption${caps === 1 ? '' : 's'}` +
      ` · ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;

    if (rec.local) {
      const tag = document.createElement('span');
      tag.className = 'proj-tag';
      tag.textContent = rec.pending ? 'not synced' : 'on device';
      fig.append(tag);
    }

    const open = document.createElement('button');
    open.className = 'proj-open';
    open.setAttribute('aria-label', 'Open project');
    open.addEventListener('click', () => openProject(rec));

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Delete project');
    del.addEventListener('click', async () => { await removeProject(rec); renderProjects(); });

    fig.append(img, meta, open, del);
    grid.appendChild(fig);
  });
}

/* ------------------------------------------------------------ storage setup */
/* When storage is off, show the built-in endpoint rather than empty fields, so
   turning it back on is one tap instead of retyping a token on a phone. */
function fillStoreForm() {
  $('store-token').value = remote ? (remote.token || '') : '';
}

/* Three outcomes, not two — a refused password and an unreachable server need
   different things from whoever is reading the message. */
async function tryPassword(token) {
  const saved = remote;
  remote = { url: REMOTE_URL, token };
  try {
    await api('/projects');
    return 'ok';
  } catch (e) {
    return /HTTP 40[13]/.test(String(e && e.message)) ? 'refused' : 'down';
  } finally {
    remote = saved;
  }
}

/* Whether the user asked to see the password field, as opposed to it being
   put there because nothing would work without one. */
let pwOpen = false;

function bindStorage() {
  $('btn-store-setup').addEventListener('click', () => {
    pwOpen = $('store-form').hidden;
    $('store-form').hidden = !pwOpen;
    if (pwOpen) fillStoreForm(); else $('store-msg').textContent = '';
  });

  /* Connect checks before it saves: storing a password that does not work
     would leave the app quietly offline with no hint as to why. */
  $('store-form').addEventListener('submit', async e => {
    e.preventDefault();
    const token = $('store-token').value.trim();
    if (!token) return;
    const btn = $('btn-store-connect');
    btn.disabled = true;
    $('store-msg').textContent = 'Connecting…';
    const result = await tryPassword(token);
    btn.disabled = false;

    if (result === 'refused') {
      $('store-msg').textContent = 'That password was not accepted.';
      return;
    }
    if (result === 'down') {
      $('store-msg').textContent = 'Could not reach the server. Check your connection and try again.';
      return;
    }
    storePassword(token);
    pwOpen = false;
    $('store-form').hidden = true;
    $('store-msg').textContent = '';
    toast('Projects are online');
    renderProjects();
  });
}

/* A file inspector, because the usual way of judging this — zooming in on a
   phone and looking — cannot work: the zoom interpolates and the screenshot
   is re-tagged to the display colour space, so a pure file still shows
   impure pixels. This reads the actual decoded pixels. */
function bindChecker() {
  const input = $('chk-input'), out = $('chk-out');
  input.addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;

      const counts = new Map();
      let onPalette = 0;
      const pal = new Set(PALETTE.map(p => p.join(',')));
      for (let p = 0; p < d.length; p += 4) {
        const k = d[p] + ',' + d[p + 1] + ',' + d[p + 2];
        counts.set(k, (counts.get(k) || 0) + 1);
        if (pal.has(k)) onPalette++;
      }
      const total = d.length / 4;
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const stray = sorted.filter(([k]) => !pal.has(k));
      const pct = n => (n / total * 100).toFixed(2) + '%';

      const lines = [];
      lines.push(`file    ${file.name}`);
      lines.push(`type    ${file.type || 'unknown'}${/jpe?g/i.test(file.type) ? '   <-- JPEG cannot hold hard 4-colour edges' : ''}`);
      lines.push(`size    ${c.width} x ${c.height}`);
      lines.push(`colours ${counts.size} distinct`);
      lines.push(`palette ${pct(onPalette)} of pixels are exactly the four inks`);
      lines.push('');
      sorted.slice(0, 8).forEach(([k, n]) => {
        const rgb = k.split(',').map(Number);
        const hex = '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
        lines.push(`  ${pal.has(k) ? 'ok ' : '>> '}${hex}  ${pct(n).padStart(7)}`);
      });
      if (stray.length) {
        lines.push('');
        lines.push(`${stray.length} colour${stray.length === 1 ? '' : 's'} outside the palette.`);
        lines.push('Something in the chain resampled or recompressed this.');
      } else {
        lines.push('');
        lines.push('Clean: nothing but the four panel inks.');
      }
      out.textContent = lines.join('\n');
      out.hidden = false;
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      out.textContent = 'Could not read that file as an image.';
      out.hidden = false;
      URL.revokeObjectURL(url);
    };
    img.src = url;
    e.target.value = '';
  });
}

function bindInks() {
  document.querySelectorAll('[data-ink]').forEach(inp => {
    inp.addEventListener('input', () => {
      const m = /^#?([0-9a-f]{6})$/i.exec(inp.value.trim());
      if (!m) return;
      const n = parseInt(m[1], 16);
      PALETTE[+inp.dataset.ink] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      applyInks(true);
      kick();
    });
  });
  document.querySelectorAll('[data-inkhex]').forEach(inp => {
    inp.addEventListener('input', () => {
      const m = /^#?([0-9a-f]{6})$/i.exec(inp.value.trim());
      if (!m) return;                       // ignore half-typed values
      const n = parseInt(m[1], 16);
      PALETTE[+inp.dataset.inkhex] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      applyInks(true);
      kick();
    });
  });

  $('btn-ink-reset').addEventListener('click', () => {
    DEFAULT_PALETTE.forEach((c, i) => { PALETTE[i] = c.slice(); });
    applyInks(true);
    kick();
    toast('Inks reset');
  });
}

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

/* -------------------------------------------------------------------- UI */
function bindSeg(attr, apply) {
  document.querySelectorAll(`[data-${attr}]`).forEach(btn => {
    btn.addEventListener('click', () => {
      btn.parentElement.querySelectorAll('.seg-btn').forEach(b => {
        b.classList.remove('is-active');
        b.setAttribute('aria-checked', 'false');
      });
      btn.classList.add('is-active');
      btn.setAttribute('aria-checked', 'true');
      apply(btn.dataset[attr]);
    });
  });
}

const SLIDERS = [
  ['s-exposure',   'exposure',   v => v.toFixed(2)],
  ['s-brightness', 'brightness', v => String(Math.round(v))],
  ['s-contrast',   'contrast',   v => String(Math.round(v))],
  ['s-saturation', 'saturation', v => v.toFixed(2)],
  ['s-gamma',      'gamma',      v => v.toFixed(2)],
  ['s-dither',     'ditherAmt',  v => v.toFixed(2)],
  ['s-edge',       'edge',       v => v.toFixed(2)],
  ['s-smooth',     'smooth',     v => v.toFixed(1)],
  ['s-detail',     'detail',     v => v.toFixed(1)],
  ['s-weight',     'weight',     v => (state.style === 'etch' ? '\u00d7' : '') +
                                        v.toFixed(0) + (state.style === 'etch' ? '' : ' px')],
  ['s-zoom',       'zoom',       v => v.toFixed(1) + '×'],
  ['s-angle',      'angle',      v => (v > 0 ? '+' : '') + v.toFixed(0) + '\u00b0'],
];

/* Sliders that only matter for some styles are hidden for the rest, and the
   dither row is dimmed when the active style ignores it. */
const DETAIL_LABEL = {
  halftone: 'Dot size', riso: 'Misregister',
  engrave: 'Line gap', etch: 'Line gap', crosshatch: 'Line gap', contour: 'Spacing',
};

function syncStyleUI() {
  document.querySelectorAll('.slider[data-styles]').forEach(el => {
    el.hidden = !el.dataset.styles.split(' ').includes(state.style);
  });
  $('dither-seg').classList.toggle('is-muted',
    state.style !== 'photo' && state.style !== 'thermal' && state.style !== 'riso');
  $('lbl-detail').textContent = DETAIL_LABEL[state.style] || 'Detail';
  /* In Etch the slider multiplies how much ink a colour lays down rather than
     how many pixels wide a line is. */
  $('lbl-weight').textContent = state.style === 'etch' ? 'Ink weight' : 'Line weight';
  $('o-weight').textContent = (state.style === 'etch' ? '\u00d7' : '') +
    state.weight.toFixed(0) + (state.style === 'etch' ? '' : ' px');
}

function syncFlip() {
  $('btn-flip').setAttribute('aria-pressed', String(view.mirror));
}

function applyPalette() {
  const m = PALETTE_MODES[state.palette] || PALETTE_MODES.full;
  inks = m.inks;
  warmth = m.warm;
  syncInkSwatches();
}

function syncBgSwatches() {
  document.querySelectorAll('[data-bg]').forEach(b =>
    b.classList.toggle('is-active', +b.dataset.bg === state.bg));
}

function setSwatch(kind, i) {
  if (kind === 'tcolor') layer().color = i; else layer().outlineColor = i;
  document.querySelectorAll(`[data-${kind}]`).forEach(b =>
    b.classList.toggle('is-active', +b.dataset[kind] === i));
  markTextDirty();
}

/* An ink the panel palette has ruled out must not sneak back in through the
   caption, so those swatches are disabled and any live selection moves off. */
function syncInkSwatches() {
  document.querySelectorAll('[data-tcolor],[data-ocolor],[data-bg]').forEach(b => {
    const raw = b.dataset.tcolor !== undefined ? b.dataset.tcolor
              : b.dataset.ocolor !== undefined ? b.dataset.ocolor : b.dataset.bg;
    b.disabled = inks.indexOf(+raw) < 0;
  });
  /* A background the panel cannot print would be quantised to something else
     anyway, so it moves to paper rather than staying wrong. */
  if (inks.indexOf(state.bg) < 0) { state.bg = paperInk(); syncBgSwatches(); }
  /* Every layer has to be brought inside the new ink set, not just the one
     on screen in the drawer. */
  const fallback = inks.indexOf(1) >= 0 ? 1 : inks[0];
  texts.forEach(L => {
    if (inks.indexOf(L.color) < 0) { L.color = fallback; L.dirty = true; }
    if (inks.indexOf(L.outlineColor) < 0) { L.outlineColor = inks[0]; L.dirty = true; }
  });
  syncTextControls();
  kick();
}

/* The drawer always edits one layer; these push the active layer's settings
   into the controls when the selection changes. */
function syncTextControls() {
  const L = layer();
  $('t-input').value = L.value;
  autoSizeInput();
  $('t-size').value = L.size;
  $('ot-size').textContent = L.size.toFixed(2);
  $('t-outline').value = L.outline;
  $('ot-outline').textContent = String(L.outline).replace(/\.0$/, '');
  $('t-angle').value = L.angle || 0;
  $('ot-angle').textContent = (L.angle || 0) + '\u00b0';
  $('t-vertical').setAttribute('aria-pressed', String(!!L.vertical));
  document.querySelectorAll('[data-font]').forEach(b => {
    const on = b.dataset.font === L.font;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-checked', String(on));
  });
  document.querySelectorAll('[data-tcolor]').forEach(b =>
    b.classList.toggle('is-active', +b.dataset.tcolor === L.color));
  document.querySelectorAll('[data-ocolor]').forEach(b =>
    b.classList.toggle('is-active', +b.dataset.ocolor === L.outlineColor));
}

function renderLayerTabs() {
  const row = $('layer-tabs');
  if (!row) return;
  row.innerHTML = '';
  texts.forEach((L, i) => {
    const b = document.createElement('button');
    b.className = 'lchip' + (i === active ? ' is-active' : '') +
                  (L.value.trim() ? '' : ' is-empty');
    b.textContent = String(i + 1);
    b.setAttribute('aria-label', `Caption ${i + 1}`);
    b.addEventListener('click', () => selectLayer(i));
    row.append(b);
  });
  if (texts.length < MAX_TEXTS) {
    const add = document.createElement('button');
    add.className = 'lchip add';
    add.textContent = '＋';
    add.setAttribute('aria-label', 'Add caption');
    add.addEventListener('click', addLayer);
    row.append(add);
  }
  const del = $('t-clear');
  del.setAttribute('aria-label', texts.length > 1 ? 'Remove this caption' : 'Clear caption');
}

function selectLayer(i) {
  active = i;
  syncTextControls();
  setTarget(layer().value.trim() ? 'text' : 'photo');
  renderLayerTabs();
  kick();
}

function addLayer() {
  if (texts.length >= MAX_TEXTS) return;
  texts.push(newLayer(texts.length));
  selectLayer(texts.length - 1);
  $('t-input').focus();
}

/* With more than one caption the button removes this layer outright; with a
   single one there is nothing to remove, so it just empties it. */
function removeLayer() {
  if (texts.length > 1) {
    texts.splice(active, 1);
    active = Math.min(active, texts.length - 1);
  } else {
    texts[0] = newLayer(0);
  }
  syncTextControls();
  syncTargetUI();
  kick();
  $('t-input').focus();
}

/* The field grows with the caption instead of scrolling a one-line window,
   which matters most on a phone where the drawer is already short. */
function autoSizeInput() {
  const el = $('t-input');
  if (!el.offsetParent) return;          // hidden: nothing to measure
  /* scrollHeight excludes the border, but height is set on the border box, so
     the borders would eat two pixels off the last line. */
  const cs = getComputedStyle(el);
  const edges = cs.boxSizing === 'border-box'
    ? parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) : 0;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight + edges, 96) + 'px';
}

function bindTextControls() {
  const input = $('t-input');
  input.addEventListener('input', () => {
    const L = layer();
    const had = !!L.value.trim();
    L.value = input.value;
    autoSizeInput();
    /* Typing the first characters of a caption takes aim at it, so a drag
       straight afterwards moves the new text rather than the photo. After
       that the pill is in charge and this stays out of the way. */
    if (!had && L.value.trim()) setTarget('text');
    markTextDirty();
  });
  $('t-clear').addEventListener('click', removeLayer);

  document.querySelectorAll('[data-font]').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-font]').forEach(o => {
        o.classList.remove('is-active');
        o.setAttribute('aria-checked', 'false');
      });
      b.classList.add('is-active');
      b.setAttribute('aria-checked', 'true');
      layer().font = b.dataset.font;
      markTextDirty();
    });
  });

  document.querySelectorAll('[data-bg]').forEach(b =>
    b.addEventListener('click', () => {
      state.bg = +b.dataset.bg;
      syncBgSwatches();
      kick();
    }));

  document.querySelectorAll('[data-tcolor]').forEach(b =>
    b.addEventListener('click', () => setSwatch('tcolor', +b.dataset.tcolor)));
  document.querySelectorAll('[data-ocolor]').forEach(b =>
    b.addEventListener('click', () => setSwatch('ocolor', +b.dataset.ocolor)));

  const size = $('t-size');
  size.addEventListener('input', () => setTextSize(parseFloat(size.value)));
  const angle = $('t-angle');
  angle.addEventListener('input', () => {
    layer().angle = parseInt(angle.value, 10);
    $('ot-angle').textContent = angle.value + '\u00b0';
    markTextDirty();
  });
  const nudge = d => {
    const L = layer();
    L.angle = (((L.angle || 0) + d) % 360 + 540) % 360 - 180;
    syncTextControls();
    markTextDirty();
  };
  $('t-rot-l').addEventListener('click', () => nudge(-15));
  $('t-rot-r').addEventListener('click', () => nudge(15));
  $('t-vertical').addEventListener('click', () => {
    const L = layer();
    L.vertical = !L.vertical;
    $('t-vertical').setAttribute('aria-pressed', String(L.vertical));
    markTextDirty();
  });

  const outline = $('t-outline');
  outline.addEventListener('input', () => {
    layer().outline = parseFloat(outline.value);
    $('ot-outline').textContent = outline.value.replace(/\.0$/, '');
    markTextDirty();
  });

  /* The pill's buttons are rebuilt as captions come and go, so it is bound
     once by delegation rather than per button. */
  $('target-seg').addEventListener('click', e => {
    const btn = e.target.closest('[data-pick]');
    if (!btn) return;
    const pick = btn.dataset.pick;
    if (pick === 'photo') { setTarget('photo'); }
    else {
      active = +pick.slice(4);
      syncTextControls();
      renderLayerTabs();
      setTarget('text');
    }
    $('hint').textContent = hintText();
    showHint();
  });

  renderLayerTabs();
  syncTextControls();
}

/* Only one drawer open at a time — both are tall, and the preview needs the
   room more than they do. */
function togglePanel(which) {
  const adv = $('advanced'), txt = $('textpanel');
  const openAdv = which === 'adjust' ? adv.hidden : false;
  const openTxt = which === 'text'   ? txt.hidden : false;
  adv.hidden = !openAdv;
  txt.hidden = !openTxt;
  $('btn-adjust').setAttribute('aria-expanded', String(openAdv));
  $('btn-text').setAttribute('aria-expanded', String(openTxt));
  /* Opening the text drawer aims the gestures at the caption; closing it
     leaves them there, so the caption can be finished against a full preview.
     Closing the drawer is not a reason to change what you were editing. */
  if (openTxt && layer().value.trim()) setTarget('text');
  /* A hidden field has no scrollHeight to measure, so a caption restored while
     the drawer was closed has to be re-fitted when it opens. */
  if (openTxt) autoSizeInput();
  layoutPreview();
  $('hint').textContent = hintText();
  showHint();
}

function bindSliders() {
  SLIDERS.forEach(([id, key, fmt]) => {
    const el = $(id), out = $(id.replace('s-', 'o-'));
    const update = () => {
      state[key] = parseFloat(el.value);
      out.textContent = fmt(state[key]);
      buildLUT();
      kick();
    };
    el.addEventListener('input', update);
    update();
  });
}

function resetAdjustments() {
  Object.assign(state, DEFAULTS);
  SLIDERS.forEach(([id, key, fmt]) => {
    $(id).value = state[key];
    $(id.replace('s-', 'o-')).textContent = fmt(state[key]);
  });
  document.querySelectorAll('[data-dither]').forEach(b => {
    const on = b.dataset.dither === state.dither;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-checked', String(on));
  });
  syncBgSwatches();
  buildLUT();
  kick();
}

function wire() {
  bindSeg('size',    v => { state.size = v; applySize(); });
  bindSeg('orient',  v => {
    if (v !== state.orient) turnComposition(v === 'portrait' ? 90 : -90);
    state.orient = v;
    applySize();
    syncTextControls();          // the turn changed each caption's angle
  });
  bindSeg('dither',  v => { state.dither = v; kick(); });
  bindSeg('style',   v => { state.style = v; syncStyleUI(); kick(); });
  bindSeg('palette', v => { state.palette = v; applyPalette(); kick(); });

  bindSliders();
  buildLUT();
  syncStyleUI();
  bindGestures();

  bindTextControls();
  syncInkSwatches();
  syncTargetUI();
  $('btn-adjust').addEventListener('click', () => togglePanel('adjust'));
  $('btn-text').addEventListener('click', () => togglePanel('text'));

  $('btn-reset').addEventListener('click', resetAdjustments);
  $('btn-rot-l').addEventListener('click', () => rotate(-90));
  $('btn-rot-r').addEventListener('click', () => rotate(90));
  $('btn-rot-quick').addEventListener('click', () => rotate(90));
  $('btn-fit').addEventListener('click', resetCrop);
  $('btn-flip').addEventListener('click', () => {
    view.mirror = !view.mirror; syncFlip(); kick();
  });

  $('shutter').addEventListener('click', capture);
  $('btn-back').addEventListener('click', backToCamera);
  $('btn-save').addEventListener('click', openSheet);
  $('btn-save-close').addEventListener('click', closeSheet);
  $('btn-download').addEventListener('click', saveFile);
  bindSeg('exportrot', v => {
    state.exportRot = v;
    openSheet();                 // refresh the note and the pending share file
  });

  sharable = canSharePng();
  if (sharable) {
    const btn = $('btn-photos');
    btn.hidden = false;
    btn.textContent = IOS ? 'Save to Photos' : 'Share image';
    btn.addEventListener('click', saveToPhotos);
  } else {
    /* Saving to Photos goes through the system share sheet, which not every
       browser offers. Hiding the button silently makes that look like the app
       has lost a feature, so it says so — except on an insecure page, where
       the cause is the page rather than the browser and the reader can do
       nothing about it from here. */
    if (window.isSecureContext) {
      const note = $('share-note');
      note.hidden = false;
      note.textContent = 'This browser cannot save straight to Photos. Download the PNG instead.';
    }
  }

  $('btn-use-camera').addEventListener('click', () => startCamera());
  $('btn-use-library').addEventListener('click', () => $('file-input').click());
  $('btn-cam').addEventListener('click', () => {
    state.facing = state.facing === 'environment' ? 'user' : 'environment';
    startCamera();
  });

  $('file-input').addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { useUpload(img); URL.revokeObjectURL(url); };
    img.onerror = () => { URL.revokeObjectURL(url); setStatus('Could not read that image', ''); };
    img.src = url;
    e.target.value = '';
  });

  $('btn-projects').addEventListener('click', () => { renderProjects(); $('projects').hidden = false; });
  $('btn-projects-close').addEventListener('click', () => {
    $('projects').hidden = true;
    pwOpen = false;               // reopening starts closed, not mid-edit
  });
  $('btn-save-project').addEventListener('click', () => saveProject(false));
  $('btn-save-new').addEventListener('click', () => saveProject(true));
  bindStorage();

  bindChecker();
  bindInks();
  $('btn-help').addEventListener('click', () => { $('help').hidden = false; });
  $('btn-help-close').addEventListener('click', () => { $('help').hidden = true; });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopCamera();
    /* Only resume a camera that was already granted. Calling getUserMedia
       here on a browser that has not been asked yet raises a prompt every
       time the app comes back to the foreground. */
    else if (!stream && mode === 'live' && hadCamera) startCamera();
  });

  if (window.ResizeObserver) {
    new ResizeObserver(() => layoutPreview()).observe(stage);
  } else {
    window.addEventListener('resize', layoutPreview);
  }
  window.addEventListener('orientationchange', () => setTimeout(layoutPreview, 300));
}

/* -------------------------------------------------------------------- go */
loadInks();
applyInks(false);
applySize();
wire();
syncFlip();
initCamera();
requestAnimationFrame(loop);

/* isSecureContext, not a protocol check: localhost is a secure context too,
   and testing the worker matters more than the one line it saves. */
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

})();
