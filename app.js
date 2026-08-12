/* E-Ink Cam — 4-colour (black / red / yellow / white) camera for e-ink panels. */
(() => {
'use strict';

/* ---------------------------------------------------------------- palette */
/* Index order matters: it is the code written into the packed .bin export
   (0=black, 1=white, 2=yellow, 3=red — the usual Waveshare 4-colour layout). */
const PALETTE = [
  [0,   0,   0  ],  // 0 black
  [255, 255, 255],  // 1 white
  [255, 255, 0  ],  // 2 yellow
  [255, 0,   0  ],  // 3 red
];
const PAL_NAMES = ['black','white','yellow','red'];
/* Flat copy — nearest() runs once per pixel per frame, and a typed array
   avoids re-dereferencing the nested arrays on every candidate. */
const PAL_FLAT = new Float32Array([0,0,0, 255,255,255, 255,255,0, 255,0,0]);

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
    const dr = r - PAL_FLAT[o], dg = g - PAL_FLAT[o+1], db = b - PAL_FLAT[o+2];
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
  zoom: 1,
  exportRot: 'cw',     // which way a portrait composition turns for export
  facing: 'environment',
  target: 'photo',     // what drag and pinch act on: 'photo' | 'text'
};

const DEFAULTS = {
  dither: 'fs', exposure: 0, brightness: 0, contrast: 15,
  saturation: 1.6, gamma: 1, ditherAmt: 0.9, edge: 0.5, smooth: 1.5, detail: 5, zoom: 1,
};

/* Crop / rotate. panX and panY are -1..1 across whatever slack the crop
   rectangle has inside the source; at zoom 1 one axis usually has none. */
const view = { rot: 0, panX: 0, panY: 0, mirror: false };

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
const dimsEl   = $('dims');

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
  imgData = pctx.createImageData(W, H);
  dimsEl.textContent = `${W} × ${H}`;
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

  let cw = sw, ch = sw / ta;
  if (ch > sh) { ch = sh; cw = sh * ta; }
  cw /= state.zoom; ch /= state.zoom;

  const slackX = (sw - cw) / 2, slackY = (sh - ch) / 2;
  return {
    tw, th, cw, ch, slackX, slackY,
    sx: slackX + view.panX * slackX,
    sy: slackY + view.panY * slackY,
  };
}

function grabFrame(src, sw, sh) {
  if (!sw || !sh) return null;
  const g = cropGeom(sw, sh);

  let el = src, sx = g.sx, sy = g.sy, sW = g.cw, sH = g.ch, slot = 0;
  while (sW > g.tw * 2 && sH > g.th * 2) {
    const nw = Math.max(g.tw, Math.round(sW / 2));
    const nh = Math.max(g.th, Math.round(sH / 2));
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
  wctx.save();
  wctx.translate(W / 2, H / 2);
  if (view.mirror) wctx.scale(-1, 1);
  if (view.rot) wctx.rotate(view.rot * Math.PI / 180);
  wctx.drawImage(el, sx, sy, sW, sH, -g.tw / 2, -g.th / 2, g.tw, g.th);
  wctx.restore();

  return wctx.getImageData(0, 0, W, H);
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
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const j = (y * W + x) * 3;
        const t = ordered[((y & mask) << shift) + (x & mask)] * spreadAmt;
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
      const pal = PALETTE[idx];
      emit(out, p, idx);

      const er = (or - pal[0]) * amt;
      const eg = (og - pal[1]) * amt;
      const eb = (ob - pal[2]) * amt;

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
    const dr = r - PAL_FLAT[o], dg = g - PAL_FLAT[o+1], db = b - PAL_FLAT[o+2];
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
function contourRender() {
  const out = imgData.data;
  boxBlur(Math.max(1, Math.round(state.smooth)), 2);
  computeLuma();

  const step = Math.max(4, state.detail * 6);
  const paper = paperInk();
  const line = inks.filter(i => i !== 1);
  const band = p => Math.floor(luma[p] / step);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      const b0 = band(p);
      const edge = b0 !== band(y * W + clampX(x + 1)) || b0 !== band(clampY(y + 1) * W + x);
      emit(out, p, edge ? line[((b0 % line.length) + line.length) % line.length] : paper);
    }
  }
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
      const paper = inks.indexOf(1) >= 0 ? 1 : inks[0];
      for (let p = 0; p < W * H; p++) emit(out, p, edgeMap[p] > thr ? 0 : paper);
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
  const s = L.value;
  if (!s.trim() || !W) return;

  const px = Math.max(4, L.size * H);
  const lw = L.outline;
  const fontCss = (FONTS[L.font] || FONTS.sans).replace('{S}', (px * SS).toFixed(2));

  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.font = fontCss;
  const measured = tctx.measureText(s).width / SS;

  const bw = Math.ceil(measured + lw * 2 + 6);
  const bh = Math.ceil(px * 1.5 + lw * 2 + 6);
  if (bw < 1 || bh < 1 || bw * bh > 4e6) return;

  const cw = bw * SS, ch = bh * SS;
  if (tcv.width !== cw || tcv.height !== ch) { tcv.width = cw; tcv.height = ch; }

  const mask = new Uint8Array(bw * bh);
  const idx  = new Uint8Array(bw * bh);
  const need = Math.ceil(SS * SS / 2);

  /* Canvas antialiases text, but a 4-colour panel has no intermediate shades
     to put it in. Rasterising at 3x and keeping pixels with at least half
     coverage gives well-shaped letterforms with hard, on-palette edges. */
  const stamp = (draw, ink) => {
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, cw, ch);
    tctx.font = fontCss;
    tctx.textAlign = 'center';
    tctx.textBaseline = 'middle';
    tctx.lineJoin = 'round';
    tctx.miterLimit = 2;
    draw(cw / 2, ch / 2);

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
    stamp((x, y) => {
      tctx.lineWidth = lw * 2 * SS;
      tctx.strokeStyle = '#fff';
      tctx.strokeText(s, x, y);
    }, L.outlineColor);
  }
  stamp((x, y) => { tctx.fillStyle = '#fff'; tctx.fillText(s, x, y); }, L.color);

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

function setZoom(z) {
  state.zoom = Math.min(6, Math.max(1, z));
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

  let du, dv;
  switch (view.rot) {
    case 90:  du =  oy; dv = -ox; break;
    case 180: du = -ox; dv = -oy; break;
    case 270: du = -oy; dv =  ox; break;
    default:  du =  ox; dv =  oy;
  }

  const perPx = g.cw / g.tw;     // source pixels per output pixel
  if (g.slackX > 0) view.panX = clamp1(view.panX - du * perPx / g.slackX);
  if (g.slackY > 0) view.panY = clamp1(view.panY - dv * perPx / g.slackY);
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
    if (e.target.closest('#target-seg')) return;   // let the pill take its taps
    try { stage.setPointerCapture(e.pointerId); } catch (_) { /* stale id */ }
    if (ptrs.size === 0) dragText = textGesture();
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
  view.rot = 0; view.panX = 0; view.panY = 0; view.mirror = false;
  setZoom(1);
  syncFlip();
  kick();
}

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

async function initCamera() {
  if (await cameraPermission() === 'denied') { blockedStatus(); return; }
  startCamera();
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

  still.width = w; still.height = h;
  stillCtx.drawImage(el, 0, 0, w, h);
  lastSource = { el: still, w, h };
  stopCamera();
  setMode('review');
}

function backToCamera() {
  setMode('live');
  startCamera();
}

function useUpload(img) {
  stopCamera();
  view.rot = 0; view.panX = 0; view.panY = 0; view.mirror = false;
  setZoom(1);
  syncFlip();
  lastSource = { el: img, w: img.naturalWidth, h: img.naturalHeight };
  clearStatus();
  setMode('review');
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

function exportCanvas() {
  const v = exportView();
  if (!v.rotated) return preview;

  const c = document.createElement('canvas');
  c.width = v.w; c.height = v.h;
  const ctx = c.getContext('2d');
  const im = ctx.createImageData(v.w, v.h);
  const d = im.data;
  for (let p = 0; p < v.w * v.h; p++) {
    const o = p * 4, k = v.idx[p] * 3;
    d[o] = PAL_FLAT[k]; d[o + 1] = PAL_FLAT[k + 1]; d[o + 2] = PAL_FLAT[k + 2]; d[o + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);
  return c;
}

function baseName() {
  const v = exportView();
  return `eink-${v.w}x${v.h}-${stamp()}`;
}

function pngBlob() {
  return new Promise(res => exportCanvas().toBlob(res, 'image/png'));
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function savePNG() {
  const blob = await pngBlob();
  if (blob) download(blob, baseName() + '.png');
  closeSheet();
}

/* 2 bits per pixel, MSB first, rows padded to a whole number of bytes,
   written in the panel's native orientation. */
function packBin() {
  const v = exportView();
  const rowBytes = Math.ceil(v.w / 4);
  const out = new Uint8Array(rowBytes * v.h);
  for (let y = 0; y < v.h; y++) {
    for (let x = 0; x < v.w; x++) {
      const code = v.idx[y * v.w + x] & 3;
      out[y * rowBytes + (x >> 2)] |= code << (6 - 2 * (x & 3));
    }
  }
  return out;
}

function saveBIN() {
  download(new Blob([packBin()], { type: 'application/octet-stream' }), baseName() + '.bin');
  closeSheet();
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
  preview.toBlob(blob => {
    if (blob) pendingFile = new File([blob], baseName() + '.png', { type: 'image/png' });
  }, 'image/png');
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
let remote = loadRemote();

function loadRemote() {
  try {
    const r = JSON.parse(localStorage.getItem(REMOTE_KEY));
    return r && r.url ? r : null;
  } catch (_) { return null; }
}

function storeRemote(cfg) {
  remote = cfg;
  try {
    if (cfg) localStorage.setItem(REMOTE_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(REMOTE_KEY);
  } catch (_) { /* private mode — config just will not persist */ }
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
  return encode(canvas, 'image/jpeg', 0.95);
}

/* bmp and dirty are derived from the rest, so they are not persisted. */
function serialiseTexts() {
  return texts.map(L => ({
    value: L.value, font: L.font, size: L.size, outline: L.outline,
    color: L.color, outlineColor: L.outlineColor, x: L.x, y: L.y,
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

async function saveProject() {
  if (mode !== 'review' || !lastSource) return;
  const blob = await sourceBlob();
  if (!blob) { toast('Could not save this image'); return; }

  const rec = {
    id: String(Date.now()),
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
      toast('Saved online');
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
  Object.assign(state, rec.state);
  Object.assign(view, rec.view);

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
  let remoteFailed = false;

  if (remote) {
    try {
      const data = await (await api('/projects')).json();
      (data.projects || []).forEach(p => out.push(p));
    } catch (_) { remoteFailed = true; }
  }

  /* On-device records are only the ones not yet on the server (or all of them
     when no server is configured). */
  try {
    (await localList()).forEach(r => out.push(Object.assign({}, r, { local: true })));
  } catch (_) { /* no IndexedDB */ }

  out.sort((a, b) => Number(b.id) - Number(a.id));
  return { list: out, remoteFailed };
}

function storeLabel(remoteFailed) {
  if (!remote) return ['This device', 'Browser storage can be evicted — add a server to keep projects safely.'];
  if (remoteFailed) return ['Server unreachable', 'Showing what is on this device. Saves will sync when the server is back.'];
  return ['Online', remote.url];
}

async function renderProjects() {
  const grid = $('projects-grid');
  grid.innerHTML = '';
  await flushPending();

  const { list, remoteFailed } = await gatherProjects();
  const [label, detail] = storeLabel(remoteFailed);
  const badge = $('store-status');
  badge.textContent = label;
  badge.className = 'store-badge ' + (!remote ? 'is-local' : remoteFailed ? 'is-down' : 'is-online');
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
function fillStoreForm() {
  $('store-url').value = remote ? remote.url : '';
  $('store-token').value = remote ? (remote.token || '') : '';
}

async function testEndpoint(url, token) {
  const saved = remote;
  remote = { url, token };
  try {
    await api('/projects');
    return true;
  } catch (e) {
    return false;
  } finally {
    remote = saved;
  }
}

function bindStorage() {
  $('btn-store-setup').addEventListener('click', () => {
    const f = $('store-form');
    f.hidden = !f.hidden;
    if (!f.hidden) fillStoreForm();
  });

  $('btn-store-test').addEventListener('click', async () => {
    const url = $('store-url').value.trim();
    if (!url) return;
    $('store-msg').textContent = 'Testing…';
    const okay = await testEndpoint(url, $('store-token').value.trim());
    $('store-msg').textContent = okay
      ? 'Reached the server.'
      : 'No answer. Check the URL, the token, and that the server allows this origin (CORS).';
  });

  $('store-form').addEventListener('submit', async e => {
    e.preventDefault();
    const url = $('store-url').value.trim();
    if (!url) return;
    storeRemote({ url, token: $('store-token').value.trim() });
    $('store-form').hidden = true;
    toast('Saving projects online');
    renderProjects();
  });

  $('btn-store-off').addEventListener('click', () => {
    storeRemote(null);
    $('store-form').hidden = true;
    toast('Saving projects on this device');
    renderProjects();
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
  ['s-zoom',       'zoom',       v => v.toFixed(1) + '×'],
];

/* Sliders that only matter for some styles are hidden for the rest, and the
   dither row is dimmed when the active style ignores it. */
const DETAIL_LABEL = {
  riso: 'Misregister', engrave: 'Line gap', crosshatch: 'Line gap', contour: 'Spacing',
};

function syncStyleUI() {
  document.querySelectorAll('.slider[data-styles]').forEach(el => {
    el.hidden = !el.dataset.styles.split(' ').includes(state.style);
  });
  $('dither-seg').classList.toggle('is-muted',
    state.style !== 'photo' && state.style !== 'thermal' && state.style !== 'riso');
  $('lbl-detail').textContent = DETAIL_LABEL[state.style] || 'Detail';
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

function setSwatch(kind, i) {
  if (kind === 'tcolor') layer().color = i; else layer().outlineColor = i;
  document.querySelectorAll(`[data-${kind}]`).forEach(b =>
    b.classList.toggle('is-active', +b.dataset[kind] === i));
  markTextDirty();
}

/* An ink the panel palette has ruled out must not sneak back in through the
   caption, so those swatches are disabled and any live selection moves off. */
function syncInkSwatches() {
  document.querySelectorAll('[data-tcolor],[data-ocolor]').forEach(b => {
    const raw = b.dataset.tcolor !== undefined ? b.dataset.tcolor : b.dataset.ocolor;
    b.disabled = inks.indexOf(+raw) < 0;
  });
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
  $('t-size').value = L.size;
  $('ot-size').textContent = L.size.toFixed(2);
  $('t-outline').value = L.outline;
  $('ot-outline').textContent = String(L.outline).replace(/\.0$/, '');
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

function bindTextControls() {
  const input = $('t-input');
  input.addEventListener('input', () => {
    const L = layer();
    const had = !!L.value.trim();
    L.value = input.value;
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

  document.querySelectorAll('[data-tcolor]').forEach(b =>
    b.addEventListener('click', () => setSwatch('tcolor', +b.dataset.tcolor)));
  document.querySelectorAll('[data-ocolor]').forEach(b =>
    b.addEventListener('click', () => setSwatch('ocolor', +b.dataset.ocolor)));

  const size = $('t-size');
  size.addEventListener('input', () => setTextSize(parseFloat(size.value)));
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
  buildLUT();
  kick();
}

function wire() {
  bindSeg('size',    v => { state.size = v; applySize(); });
  bindSeg('orient',  v => { state.orient = v; applySize(); });
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
  $('btn-png').addEventListener('click', savePNG);
  bindSeg('exportrot', v => {
    state.exportRot = v;
    openSheet();                 // refresh the note and the pending share file
  });
  $('btn-bin').addEventListener('click', saveBIN);

  sharable = canSharePng();
  if (sharable) {
    const btn = $('btn-photos');
    btn.hidden = false;
    btn.textContent = IOS ? 'Save to Photos' : 'Share image';
    btn.addEventListener('click', saveToPhotos);
  }

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
  $('btn-projects-close').addEventListener('click', () => { $('projects').hidden = true; });
  $('btn-save-project').addEventListener('click', saveProject);
  bindStorage();

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
