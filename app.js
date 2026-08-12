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
const SIZES = { '269x128': [269, 128], '400x300': [400, 300] };

const state = {
  size: '269x128',
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
  mirror: false,
  facing: 'environment',
};

const DEFAULTS = {
  dither: 'fs', exposure: 0, brightness: 0, contrast: 15,
  saturation: 1.6, gamma: 1, ditherAmt: 0.9, edge: 0.5, smooth: 1.5, zoom: 1,
};

let W = 269, H = 128;

/* ---------------------------------------------------------------- element */
const $ = id => document.getElementById(id);
const video    = $('video');
const preview  = $('preview');
const pctx     = preview.getContext('2d');
const shot     = $('shot');
const sctx     = shot.getContext('2d');
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

/* Working buffers, re-allocated on size change. */
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

/* ------------------------------------------------------------ frame grab */
/* Crop the source to the panel aspect ratio (centre "cover" crop), apply
   digital zoom, downscale progressively, mirror if asked, and hand back the
   pixels at exactly W x H. */
function grabFrame(src, sw, sh) {
  if (!sw || !sh) return null;

  const ta = W / H;
  let cw = sw, ch = sw / ta;
  if (ch > sh) { ch = sh; cw = sh * ta; }
  cw /= state.zoom; ch /= state.zoom;

  let sx = (sw - cw) / 2, sy = (sh - ch) / 2;
  let el = src, sW = cw, sH = ch, slot = 0;

  while (sW > W * 2 && sH > H * 2) {
    const tw = Math.max(W, Math.round(sW / 2));
    const th = Math.max(H, Math.round(sH / 2));
    const cvs = scratch[slot], ctx = sctxs[slot];
    if (cvs.width !== tw || cvs.height !== th) {
      cvs.width = tw; cvs.height = th;
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    }
    ctx.drawImage(el, sx, sy, sW, sH, 0, 0, tw, th);
    el = cvs; sx = 0; sy = 0; sW = tw; sH = th;
    slot ^= 1;
  }

  wctx.save();
  if (state.mirror) { wctx.translate(W, 0); wctx.scale(-1, 1); }
  wctx.drawImage(el, sx, sy, sW, sH, 0, 0, W, H);
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
function quantize(mode, amt) {
  const out = imgData.data;

  if (mode === 'bayer' || mode === 'cluster') {
    const ordered = mode === 'bayer' ? BAYER : CLUSTER;
    const mask = mode === 'bayer' ? 7 : 3;
    const shift = mode === 'bayer' ? 3 : 2;
    const spread = (mode === 'bayer' ? 110 : 150) * amt;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const j = (y * W + x) * 3;
        const t = ordered[((y & mask) << shift) + (x & mask)] * spread;
        const idx = nearest(buf[j] + t, buf[j + 1] + t, buf[j + 2] + t);
        emit(out, y * W + x, idx);
      }
    }
    return;
  }

  if (mode === 'none') {
    for (let p = 0, j = 0; p < W * H; p++, j += 3) {
      emit(out, p, nearest(buf[j], buf[j + 1], buf[j + 2]));
    }
    return;
  }

  /* Error diffusion. Floyd–Steinberg (serpentine) or Atkinson. */
  const atkinson = mode === 'atkinson';
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
    // horizontal: buf -> tmp
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
    // vertical: tmp -> buf
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
    case 'cel': {
      boxBlur(Math.round(state.smooth), 2);
      computeEdges();
      posterize(4);
      quantize('none', 0);
      inkEdges();
      break;
    }

    case 'vector': {
      boxBlur(Math.max(1, Math.round(state.smooth * 2)), 2);
      computeEdges();
      posterize(3);
      quantize('none', 0);
      inkEdges();
      break;
    }

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

/* --------------------------------------------------------------- pipeline */
let lastSource = null;   // {el, w, h} — video or imported still

function renderOnce() {
  if (!lastSource) return false;
  const src = grabFrame(lastSource.el, lastSource.w, lastSource.h);
  if (!src) return false;
  adjust(src);
  renderStyle();
  pctx.putImageData(imgData, 0, 0);
  return true;
}

let rafId = 0, lastDraw = 0, frozen = false;

function loop(ts) {
  rafId = requestAnimationFrame(loop);
  if (frozen) return;
  if (ts - lastDraw < 33) return;          // cap ~30fps
  lastDraw = ts;
  if (lastSource && lastSource.el === video) {
    if (video.readyState < 2 || !video.videoWidth) return;
    lastSource.w = video.videoWidth;
    lastSource.h = video.videoHeight;
  }
  renderOnce();
}

function kick() { if (frozen) renderOnce(); }

/* ----------------------------------------------------------------- camera */
let stream = null;

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('Camera unavailable', 'This browser has no camera access here. Serve the page over HTTPS, or import a photo with the button below.');
    return;
  }
  stopCamera();
  setStatus('Starting camera…', '');
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
    frozen = false;
    state.mirror = state.facing === 'user';
    syncMirrorBtn();
    clearStatus();
  } catch (err) {
    setStatus('No camera', err && err.name === 'NotAllowedError'
      ? 'Camera permission was denied. Allow it in your browser settings, or import a photo instead.'
      : 'Could not open the camera. You can still import a photo.');
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

/* ------------------------------------------------------------------ sizes */
function applySize() {
  const [a, b] = SIZES[state.size];
  if (state.orient === 'portrait') { W = b; H = a; } else { W = a; H = b; }
  allocate();
  kick();
}

/* ---------------------------------------------------------------- capture */
let shotIndices = null, shotW = 0, shotH = 0;

function capture() {
  if (!lastSource) return;
  if (!renderOnce()) return;

  shotW = W; shotH = H;
  shotIndices = indices.slice();
  shot.width = W; shot.height = H;
  sctx.imageSmoothingEnabled = false;
  sctx.drawImage(preview, 0, 0);

  /* Show it at a sensible on-screen size (integer upscale where possible). */
  const maxW = Math.min(window.innerWidth - 32, 520);
  const scale = Math.max(1, Math.floor(maxW / W)) || 1;
  shot.style.width = Math.min(maxW, W * scale) + 'px';

  const counts = [0, 0, 0, 0];
  for (let i = 0; i < shotIndices.length; i++) counts[shotIndices[i]]++;
  const total = shotIndices.length;
  $('shot-meta').textContent =
    `${W}×${H} · ` + PAL_NAMES
      .map((n, i) => `${n} ${Math.round(counts[i] / total * 100)}%`)
      .join(' · ');

  frozen = true;
  $('result').hidden = false;
  saveToGallery();
}

function endCapture() {
  $('result').hidden = true;
  frozen = false;
  shotIndices = null;
}

/* ----------------------------------------------------------------- export */
function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
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

function savePNG() {
  shot.toBlob(b => b && download(b, `eink-${shotW}x${shotH}-${stamp()}.png`), 'image/png');
}

/* 2 bits per pixel, MSB first, rows padded to a whole number of bytes. */
function packBin() {
  const rowBytes = Math.ceil(shotW / 4);
  const out = new Uint8Array(rowBytes * shotH);
  for (let y = 0; y < shotH; y++) {
    for (let x = 0; x < shotW; x++) {
      const code = shotIndices[y * shotW + x] & 3;
      const o = y * rowBytes + (x >> 2);
      out[o] |= code << (6 - 2 * (x & 3));
    }
  }
  return out;
}

function saveBIN() {
  if (!shotIndices) return;
  download(new Blob([packBin()], { type: 'application/octet-stream' }),
           `eink-${shotW}x${shotH}-${stamp()}.bin`);
}

async function share() {
  shot.toBlob(async blob => {
    if (!blob) return;
    const file = new File([blob], `eink-${shotW}x${shotH}.png`, { type: 'image/png' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'E-Ink photo' });
      }
    } catch (_) { /* user cancelled */ }
  }, 'image/png');
}

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
  list.unshift({ t: Date.now(), w: shotW, h: shotH, d: shot.toDataURL('image/png') });
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
      const group = btn.parentElement;
      group.querySelectorAll('.seg-btn').forEach(b => {
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

function applyPalette() {
  const m = PALETTE_MODES[state.palette] || PALETTE_MODES.full;
  inks = m.inks;
  warmth = m.warm;
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

function syncMirrorBtn() {
  $('btn-mirror').classList.toggle('is-on', state.mirror);
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

  $('btn-reset').addEventListener('click', resetAdjustments);
  $('shutter').addEventListener('click', capture);
  $('btn-retake').addEventListener('click', endCapture);
  $('btn-png').addEventListener('click', savePNG);
  $('btn-bin').addEventListener('click', saveBIN);

  if (navigator.canShare) {
    const btn = $('btn-share');
    btn.hidden = false;
    btn.addEventListener('click', share);
  }

  $('btn-mirror').addEventListener('click', () => {
    state.mirror = !state.mirror; syncMirrorBtn(); kick();
  });

  $('btn-flip').addEventListener('click', () => {
    state.facing = state.facing === 'environment' ? 'user' : 'environment';
    startCamera();
  });

  $('file-input').addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      stopCamera();
      state.mirror = false; syncMirrorBtn();
      lastSource = { el: img, w: img.naturalWidth, h: img.naturalHeight };
      frozen = true;
      clearStatus();
      renderOnce();
      URL.revokeObjectURL(url);
    };
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

  /* Tap the frozen preview to resume the live view. */
  preview.addEventListener('click', () => {
    if (frozen && $('result').hidden && lastSource && lastSource.el !== video) return;
    if (frozen && $('result').hidden) frozen = false;
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopCamera();
    else if (!stream && lastSource && lastSource.el === video) startCamera();
  });

  window.addEventListener('orientationchange', () => setTimeout(kick, 300));
}

/* -------------------------------------------------------------------- go */
applySize();
wire();
updateGalleryBadge(loadGallery().length);
startCamera();
rafId = requestAnimationFrame(loop);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

})();
