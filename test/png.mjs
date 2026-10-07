// Minimal PNG reader (8-bit rgb/rgba, no interlace) so the harness can look at what it captured.
import zlib from 'node:zlib';

export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let o = 8, w = 0, h = 0, depth = 0, type = 0, inter = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), tag = buf.toString('ascii', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (tag === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; inter = data[12]; }
    else if (tag === 'IDAT') idat.push(data);
    else if (tag === 'IEND') break;
    o += 12 + len;
  }
  if (depth !== 8 || (type !== 6 && type !== 2) || inter) throw new Error(`png depth=${depth} type=${type} interlace=${inter}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = type === 6 ? 4 : 3, stride = w * bpp, out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++], line = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride), prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev ? prev[x] : 0, c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; }
      cur[x] = v;
    }
  }
  return { w, h, bpp, data: out };
}

// mean absolute difference between adjacent row means — scanlines push this up
export function stripes(img) {
  const rows = new Float64Array(img.h);
  for (let y = 0; y < img.h; y++) {
    let s = 0;
    for (let x = 0; x < img.w; x++) {
      const i = y * img.w * img.bpp + x * img.bpp;
      s += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
    }
    rows[y] = s / img.w;
  }
  let d = 0;
  for (let y = 1; y < img.h; y++) d += Math.abs(rows[y] - rows[y - 1]);
  return d / (img.h - 1);
}

// mean absolute per-channel difference between two frames (0 = identical), sampled every pixel step
export function meanDiff(a, b) {
  if (a.w !== b.w || a.h !== b.h) return 999;
  const step = 4;
  let sum = 0, n = 0;
  for (let i = 0; i < a.data.length; i += a.bpp * step) {
    sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    n += 3;
  }
  return sum / n;
}

// brightest luma in a box around a point — tolerant of small features
export function maxBox(img, x, y, r = 3) {
  let best = 0;
  for (let py = Math.max(0, Math.floor(y - r)); py <= Math.min(img.h - 1, Math.ceil(y + r)); py++)
    for (let px = Math.max(0, Math.floor(x - r)); px <= Math.min(img.w - 1, Math.ceil(x + r)); px++) {
      const i = py * img.w * img.bpp + px * img.bpp;
      const l = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
      if (l > best) best = l;
    }
  return best;
}

// average rgb of a square patch, in screenshot pixels
export function patch(img, x, y, r = 3) {
  const x0 = Math.max(0, Math.min(img.w - 1, Math.floor(x - r))), y0 = Math.max(0, Math.min(img.h - 1, Math.floor(y - r)));
  const x1 = Math.max(x0 + 1, Math.min(img.w, Math.ceil(x + r) + 1)), y1 = Math.max(y0 + 1, Math.min(img.h, Math.ceil(y + r) + 1));
  let R = 0, G = 0, B = 0, n = 0;
  for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
    const i = py * img.w * img.bpp + px * img.bpp;
    R += img.data[i]; G += img.data[i + 1]; B += img.data[i + 2]; n++;
  }
  return [R / n, G / n, B / n];
}

const RAMP = ' .:-=+*#%@';
// coarse luminance map: enough to see the board, the snake and the hud in a terminal
export function ascii(img, cols = 84, rows = 30) {
  const lines = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c / cols) * img.w), x1 = Math.floor(((c + 1) / cols) * img.w);
      const y0 = Math.floor((r / rows) * img.h), y1 = Math.floor(((r + 1) / rows) * img.h);
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = y * img.w * img.bpp + x * img.bpp;
        sum += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]; n++;
      }
      const l = sum / Math.max(1, n);
      line += RAMP[Math.min(RAMP.length - 1, Math.floor((l / 255) * RAMP.length))];
    }
    lines.push(line);
  }
  return lines.join('\n');
}

export function meanLuma(img) {
  let sum = 0, n = 0;
  for (let i = 0; i < img.data.length; i += img.bpp * 7) { sum += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]; n++; }
  return sum / n;
}
