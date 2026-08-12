/* Generates a diagnostic test card at panel resolution.
 *
 * Upload it through the panel software, then look at what comes back. Each
 * band fails in a different, recognisable way, so the result says which stage
 * of the upload is doing the damage rather than leaving it to guesswork.
 *
 *   node tools/testcard.mjs            -> testcard-296x128.png, testcard-400x300.png
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const K = 0, W = 1, Y = 2, R = 3;
const PALETTE = [[0,0,0],[255,255,255],[255,255,0],[255,0,0]];

function build(w, h) {
  const px = new Uint8Array(w * h).fill(W);
  const set = (x, y, c) => {
    if (x >= 0 && x < w && y >= 0 && y < h) px[y * w + x] = c;
  };
  const rect = (x0, y0, x1, y1, c) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c);
  };

  const band = Math.floor(h / 4);

  /* 1 — solid blocks. Any colour shift shows here, with no dithering or
     thin detail involved to muddy the question. */
  const cols = [K, W, Y, R];
  for (let i = 0; i < 4; i++) {
    rect(Math.round(i * w / 4), 0, Math.round((i + 1) * w / 4) - 1, band - 1, cols[i]);
  }

  /* 2 — one-pixel checkerboard, then one-pixel vertical lines. The
     checkerboard is the most fragile thing on the card: it survives only if
     nothing rescaled the image. */
  const y0 = band, y1 = band * 2 - 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = 0; x < Math.floor(w / 2); x++) set(x, y, (x + y) % 2 ? W : K);
    for (let x = Math.floor(w / 2); x < w; x++) if (x % 2 === 0) set(x, y, K);
  }

  /* 3 — horizontal lines at 1, 2 and 3 pixels. Whichever widths come back
     intact says how much line weight the pipeline costs you. */
  const y2 = band * 2, y3 = band * 3 - 1;
  const third = Math.floor(w / 3);
  for (let y = y2; y <= y3; y++) {
    const r = y - y2;
    if (r % 2 === 0)              rect(0, y, third - 1, y, K);
    if (Math.floor(r / 2) % 2===0) rect(third, y, third * 2 - 1, y, K);
    if (Math.floor(r / 3) % 2===0) rect(third * 2, y, w - 1, y, K);
  }

  /* 4 — yellow and red hairlines on white, plus isolated single pixels.
     Contrast on the physical panel, and whether lone pixels survive. */
  const y4 = band * 3;
  for (let y = y4; y < h; y++) {
    const r = y - y4;
    if (r % 2 === 0) {
      rect(0, y, Math.floor(w / 2) - 1, y, Y);
      rect(Math.floor(w / 2), y, w - 1, y, R);
    }
  }
  for (let i = 0; i < 6; i++) {
    set(10 + i * 12, h - 4, [K, R, Y, K, R, Y][i]);
  }

  /* Registration: one pixel in each corner. If any is missing, the image was
     cropped or scaled. */
  set(0, 0, R); set(w - 1, 0, R); set(0, h - 1, R); set(w - 1, h - 1, R);
  return px;
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const page = await (await browser.newContext()).newPage();

for (const [w, h] of [[296, 128], [400, 300]]) {
  const px = build(w, h);
  const url = await page.evaluate(([w, h, px, pal]) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const im = ctx.createImageData(w, h);
    for (let p = 0; p < w * h; p++) {
      const col = pal[px[p]], o = p * 4;
      im.data[o] = col[0]; im.data[o+1] = col[1]; im.data[o+2] = col[2]; im.data[o+3] = 255;
    }
    ctx.putImageData(im, 0, 0);
    return c.toDataURL('image/png');
  }, [w, h, Array.from(px), PALETTE]);
  const name = `testcard-${w}x${h}.png`;
  fs.writeFileSync(new URL(name, import.meta.url).pathname,
                   Buffer.from(url.split(',')[1], 'base64'));
  console.log(name);
}
await browser.close();
