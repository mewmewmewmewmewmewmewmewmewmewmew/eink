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
  zoom: 1,
  facing: 'environment',
  target: 'photo',     // what drag and pinch act on: 'photo' | 'text'
};

const DEFAULTS = {
  dither: 'fs', exposure: 0, brightness: 0, contrast: 15,
  saturation: 1.6, gamma: 1, ditherAmt: 0.9, edge: 0.5, smooth: 1.5, zoom: 1,
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

function computeEdges() {
  const gain = 0.25 * blurSpread;

  /* Luma once per pixel, not once per Sobel tap — the 3x3 window would
     otherwise recompute it nine times over. */
  for (let p = 0, j = 0; p < W * H; p++, j += 3) {
    luma[p] = 0.299 * buf[j] + 0.587 * buf[j + 1] + 0.114 * buf[j + 2];
  }

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

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('Camera unavailable',
      'This browser will not open a camera here. Serve the page over HTTPS, or upload a photo with the button below.');
    return;
  }
  stopCamera();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: state.facing },
        width:  { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
    lastSource = { el: video, w: video.videoWidth, h: video.videoHeight };
    view.mirror = state.facing === 'user';
    syncFlip();
    setMode('live');
    clearStatus();
  } catch (err) {
    setStatus('No camera', err && err.name === 'NotAllowedError'
      ? 'Camera permission was denied. Allow it in your browser settings, or upload a photo instead.'
      : 'Could not open the camera. You can still upload a photo.');
  }
}

function stopCamera() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
}

function setStatus(title, body) {
  statusEl.hidden = false;
  statusEl.innerHTML = '';
  const b = document.createElement('b');
  b.textContent = title;
  statusEl.append(b, document.createTextNode(body || ''));
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

function baseName() { return `eink-${W}x${H}-${stamp()}`; }

function pngBlob() {
  return new Promise(res => preview.toBlob(res, 'image/png'));
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
  saveToGallery();
  closeSheet();
}

/* 2 bits per pixel, MSB first, rows padded to a whole number of bytes. */
function packBin() {
  const rowBytes = Math.ceil(W / 4);
  const out = new Uint8Array(rowBytes * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const code = indices[y * W + x] & 3;
      out[y * rowBytes + (x >> 2)] |= code << (6 - 2 * (x & 3));
    }
  }
  return out;
}

function saveBIN() {
  download(new Blob([packBin()], { type: 'application/octet-stream' }), baseName() + '.bin');
  saveToGallery();
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
  const done = () => { saveToGallery(); closeSheet(); };
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
  $('shot-meta').textContent = `${W}×${H} · ` +
    PAL_NAMES.map((n, i) => `${n} ${Math.round(counts[i] / total * 100)}%`).join(' · ');
  $('save-sheet').hidden = false;
  if (sharable) prepareShareFile();
}
function closeSheet() { $('save-sheet').hidden = true; }

/* ---------------------------------------------------------------- gallery */
const GKEY = 'einkcam.shots';
const GMAX = 24;

function loadGallery() {
  try { return JSON.parse(localStorage.getItem(GKEY)) || []; }
  catch (_) { return []; }
}
function storeGallery(list) {
  try { localStorage.setItem(GKEY, JSON.stringify(list)); }
  catch (_) { /* quota — drop silently */ }
  updateGalleryBadge(list.length);
}
function updateGalleryBadge(n) {
  const el = $('gallery-count');
  el.textContent = n;
  el.hidden = n === 0;
}
function saveToGallery() {
  const list = loadGallery();
  list.unshift({ t: Date.now(), w: W, h: H, d: preview.toDataURL('image/png') });
  storeGallery(list.slice(0, GMAX));
}
function renderGallery() {
  const grid = $('gallery-grid');
  const list = loadGallery();
  grid.innerHTML = '';
  if (!list.length) {
    const p = document.createElement('p');
    p.textContent = 'No shots yet.';
    grid.appendChild(p);
    return;
  }
  list.forEach((item, i) => {
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = item.d;
    img.alt = `${item.w}×${item.h}`;
    img.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = item.d;
      a.download = `eink-${item.w}x${item.h}-${item.t}.png`;
      a.click();
    });
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Delete');
    del.addEventListener('click', () => {
      const l = loadGallery(); l.splice(i, 1); storeGallery(l); renderGallery();
    });
    fig.append(img, del);
    grid.appendChild(fig);
  });
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
  ['s-zoom',       'zoom',       v => v.toFixed(1) + '×'],
];

/* Sliders that only matter for some styles are hidden for the rest, and the
   dither row is dimmed when the active style ignores it. */
function syncStyleUI() {
  document.querySelectorAll('.slider[data-styles]').forEach(el => {
    el.hidden = !el.dataset.styles.split(' ').includes(state.style);
  });
  $('dither-seg').classList.toggle('is-muted', state.style !== 'photo');
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

  $('btn-gallery').addEventListener('click', () => { renderGallery(); $('gallery').hidden = false; });
  $('btn-gallery-close').addEventListener('click', () => { $('gallery').hidden = true; });
  $('btn-gallery-clear').addEventListener('click', () => {
    localStorage.removeItem(GKEY); updateGalleryBadge(0); renderGallery();
  });

  $('btn-help').addEventListener('click', () => { $('help').hidden = false; });
  $('btn-help-close').addEventListener('click', () => { $('help').hidden = true; });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopCamera();
    else if (!stream && mode === 'live') startCamera();
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
updateGalleryBadge(loadGallery().length);
startCamera();
requestAnimationFrame(loop);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

})();
