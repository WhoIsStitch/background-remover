// Finishing effects applied to the cut-out (RGBA, non-premultiplied).
// Solid subject pixels always keep their exact colour.

// fx = { outline: {width, color:[r,g,b]}, bg: 'none'|'color'|'blur', bgColor:[r,g,b], crop: {on, pad} }
// Returns { data, w, h } — cropped if fx.crop.on.
export function applyEffects(cut, w, h, src, fx) {
  let layer = cut;
  if (fx.outline && fx.outline.width > 0) layer = addOutline(layer, w, h, fx.outline.width, fx.outline.color);
  const box = fx.crop && fx.crop.on ? contentBox(layer, w, h, fx.crop.pad) : [0, 0, w, h];
  if (fx.bg === 'color') layer = over(layer, w, h, (i, o) => [fx.bgColor[0], fx.bgColor[1], fx.bgColor[2]]);
  else if (fx.bg === 'blur') {
    const bl = blurRGB(src, w, h, Math.max(4, Math.round(Math.min(w, h) * 0.02)));
    layer = over(layer, w, h, (i, o) => [bl[o], bl[o + 1], bl[o + 2]]);
  }
  return crop(layer, w, h, box);
}

function over(fg, w, h, bgAt) {
  const out = new Uint8ClampedArray(fg.length);
  for (let i = 0, o = 0; i < w * h; i++, o += 4) {
    const a = fg[o + 3] / 255;
    if (a === 1) { out[o] = fg[o]; out[o + 1] = fg[o + 1]; out[o + 2] = fg[o + 2]; out[o + 3] = 255; continue; }
    const b = bgAt(i, o);
    out[o] = fg[o] * a + b[0] * (1 - a);
    out[o + 1] = fg[o + 1] * a + b[1] * (1 - a);
    out[o + 2] = fg[o + 2] * a + b[2] * (1 - a);
    out[o + 3] = 255;
  }
  return out;
}

// Sticker outline: a solid band `width` px wide around the subject, under it.
function addOutline(fg, w, h, width, color) {
  const n = w * h;
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = fg[i * 4 + 3] >= 128 ? 1 : 0;
  const d = edt(inside, w, h);
  const out = new Uint8ClampedArray(fg.length);
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    let ao = width + 0.5 - d[i];
    ao = ao < 0 ? 0 : ao > 1 ? 1 : ao;
    const as = fg[o + 3] / 255;
    const a = as + ao * (1 - as);
    if (a <= 0) continue;
    if (as === 1) { out[o] = fg[o]; out[o + 1] = fg[o + 1]; out[o + 2] = fg[o + 2]; out[o + 3] = 255; continue; }
    for (let c = 0; c < 3; c++) out[o + c] = (fg[o + c] * as + color[c] * ao * (1 - as)) / a;
    out[o + 3] = Math.round(a * 255);
  }
  return out;
}

// Exact Euclidean distance to the nearest `inside` pixel (Felzenszwalb & Huttenlocher).
function edt(inside, w, h) {
  const INF = 1e20, n = w * h;
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) g[i] = inside[i] ? 0 : INF;
  const m = Math.max(w, h);
  const f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
  const pass = (len, get, set) => {
    for (let q = 0; q < len; q++) f[q] = get(q);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) ** 2 + f[v[k]]; set(q, d[q]); }
  };
  for (let x = 0; x < w; x++) pass(h, (q) => g[q * w + x], (q, val) => { g[q * w + x] = val; });
  for (let y = 0; y < h; y++) pass(w, (q) => g[y * w + q], (q, val) => { g[y * w + q] = val; });
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sqrt(g[i]);
  return out;
}

function blurRGB(src, w, h, r) {
  let a = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { a[i * 3] = src[i * 4]; a[i * 3 + 1] = src[i * 4 + 1]; a[i * 3 + 2] = src[i * 4 + 2]; }
  const tmp = new Float32Array(a.length);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let x = -r; x <= r; x++) s += a[(y * w + Math.min(w - 1, Math.max(0, x))) * 3 + c];
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * 3 + c] = s / (2 * r + 1);
        s += a[(y * w + Math.min(w - 1, x + r + 1)) * 3 + c] - a[(y * w + Math.max(0, x - r)) * 3 + c];
      }
    }
    for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[(Math.min(h - 1, Math.max(0, y)) * w + x) * 3 + c];
      for (let y = 0; y < h; y++) {
        a[(y * w + x) * 3 + c] = s / (2 * r + 1);
        s += tmp[(Math.min(h - 1, y + r + 1) * w + x) * 3 + c] - tmp[(Math.max(0, y - r) * w + x) * 3 + c];
      }
    }
  }
  return a;
}

export function contentBox(rgba, w, h, pad) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (rgba[(y * w + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return [0, 0, w, h];
  return [Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(w, x1 + 1 + pad), Math.min(h, y1 + 1 + pad)];
}

function crop(rgba, w, h, [x0, y0, x1, y1]) {
  if (x0 === 0 && y0 === 0 && x1 === w && y1 === h) return { data: rgba, w, h };
  const cw = x1 - x0, ch = y1 - y0, out = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) out.set(rgba.subarray(((y + y0) * w + x0) * 4, ((y + y0) * w + x1) * 4), y * cw * 4);
  return { data: out, w: cw, h: ch };
}
