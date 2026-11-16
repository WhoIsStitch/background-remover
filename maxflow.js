// Boykov–Kolmogorov max-flow / min-cut on a 4-connected pixel grid.
// (Y. Boykov, V. Kolmogorov, "An Experimental Comparison of Min-Cut/Max-Flow
// Algorithms for Energy Minimization in Vision", PAMI 2004.)
//
// tcap: Int32Array(n). >0 = capacity from the source (subject) terminal,
//       <0 = capacity to the sink (background) terminal.
// rcap: Int32Array(n*4). Capacity of the arc leaving pixel i in direction d
//       (0 = right, 1 = left, 2 = down, 3 = up). Arcs leaving the image are ignored.
// Both arrays are used as scratch space and modified.
// Returns { label: Uint8Array (1 = source/subject side), flow }.

const TERMINAL = -1, ORPHAN = -2, NONE = -3;

export function gridMaxflow(w, h, tcap, rcap) {
  const n = w * h;
  const off = [1, -1, w, -w];
  const tr = tcap;
  const tree = new Uint8Array(n);          // 0 = free, 1 = source tree, 2 = sink tree
  const parent = new Int32Array(n).fill(NONE); // arc from node to its parent
  const ts = new Int32Array(n), dist = new Int32Array(n);
  let TIME = 0, flow = 0;

  const valid = (i, d) => d === 0 ? i % w !== w - 1 : d === 1 ? i % w !== 0 : d === 2 ? i < n - w : i >= w;
  const headOf = (a) => (a >> 2) + off[a & 3];
  const sister = (a) => (headOf(a) << 2) | ((a & 3) ^ 1);

  // Active nodes: FIFO ring buffer, each node at most once.
  const Q = new Int32Array(n), inQ = new Uint8Array(n);
  let qh = 0, qt = 0, qlen = 0;
  const activate = (v) => { if (inQ[v]) return; inQ[v] = 1; Q[qt] = v; qt = qt + 1 === n ? 0 : qt + 1; qlen++; };
  const nextActive = () => { const v = Q[qh]; qh = qh + 1 === n ? 0 : qh + 1; qlen--; inQ[v] = 0; return v; };

  // Orphans: FIFO.
  let orphans = new Int32Array(1024), oh = 0, ot = 0;
  const addOrphan = (v) => {
    parent[v] = ORPHAN;
    if (ot === orphans.length) {
      if (oh > 0) { orphans.copyWithin(0, oh, ot); ot -= oh; oh = 0; }
      if (ot === orphans.length) { const b = new Int32Array(orphans.length * 2); b.set(orphans); orphans = b; }
    }
    orphans[ot++] = v;
  };

  for (let i = 0; i < n; i++) {
    if (tr[i] > 0) { tree[i] = 1; parent[i] = TERMINAL; dist[i] = 1; activate(i); }
    else if (tr[i] < 0) { tree[i] = 2; parent[i] = TERMINAL; dist[i] = 1; activate(i); }
  }

  let current = -1;
  for (;;) {
    // ---- Growth ----
    let i = current;
    if (i < 0 || !tree[i]) {
      i = -1;
      while (qlen) { const v = nextActive(); if (tree[v]) { i = v; break; } }
      if (i < 0) break;
    }
    current = -1;
    const ti = tree[i];
    let mid = -1;
    for (let d = 0; d < 4; d++) {
      if (!valid(i, d)) continue;
      const a = (i << 2) | d, j = i + off[d], sa = (j << 2) | (d ^ 1);
      if (ti === 1 ? rcap[a] <= 0 : rcap[sa] <= 0) continue;
      if (!tree[j]) {
        tree[j] = ti; parent[j] = sa; ts[j] = ts[i]; dist[j] = dist[i] + 1; activate(j);
      } else if (tree[j] !== ti) {
        mid = ti === 1 ? a : sa;
        break;
      } else if (ts[j] <= ts[i] && dist[j] > dist[i]) {
        parent[j] = sa; ts[j] = ts[i]; dist[j] = dist[i] + 1;
      }
    }
    if (mid < 0) continue;
    current = i;
    TIME++;

    // ---- Augmentation ---- (mid goes from the source tree to the sink tree)
    const sN = mid >> 2, tN = headOf(mid);
    let f = rcap[mid];
    for (let v = sN; ;) {
      const p = parent[v];
      if (p === TERMINAL) { if (tr[v] < f) f = tr[v]; break; }
      const sp = sister(p); if (rcap[sp] < f) f = rcap[sp];
      v = headOf(p);
    }
    for (let v = tN; ;) {
      const p = parent[v];
      if (p === TERMINAL) { if (-tr[v] < f) f = -tr[v]; break; }
      if (rcap[p] < f) f = rcap[p];
      v = headOf(p);
    }
    rcap[mid] -= f; rcap[sister(mid)] += f;
    for (let v = sN; ;) {
      const p = parent[v];
      if (p === TERMINAL) { tr[v] -= f; if (!tr[v]) addOrphan(v); break; }
      const sp = sister(p), next = headOf(p);
      rcap[sp] -= f; rcap[p] += f;
      if (!rcap[sp]) addOrphan(v);
      v = next;
    }
    for (let v = tN; ;) {
      const p = parent[v];
      if (p === TERMINAL) { tr[v] += f; if (!tr[v]) addOrphan(v); break; }
      const next = headOf(p);
      rcap[p] -= f; rcap[sister(p)] += f;
      if (!rcap[p]) addOrphan(v);
      v = next;
    }
    flow += f;

    // ---- Adoption ----
    while (oh < ot) {
      const v = orphans[oh++];
      const t = tree[v];
      let best = NONE, dMin = 0x7fffffff;
      for (let d = 0; d < 4; d++) {
        if (!valid(v, d)) continue;
        const a = (v << 2) | d, u = v + off[d];
        if (tree[u] !== t) continue;
        if (t === 1 ? rcap[(u << 2) | (d ^ 1)] <= 0 : rcap[a] <= 0) continue;
        // Is u still connected to its terminal?
        let x = u, dd = 0, ok = true;
        for (;;) {
          if (ts[x] === TIME) { dd += dist[x]; break; }
          const p = parent[x];
          dd++;
          if (p === TERMINAL) { ts[x] = TIME; dist[x] = 1; break; }
          if (p === ORPHAN || p === NONE) { ok = false; break; }
          x = headOf(p);
        }
        if (!ok) continue;
        if (dd < dMin) { best = a; dMin = dd; }
        for (x = u; ts[x] !== TIME; x = headOf(parent[x])) { ts[x] = TIME; dist[x] = dd--; }
      }
      if (best !== NONE) {
        parent[v] = best; ts[v] = TIME; dist[v] = dMin + 1;
        continue;
      }
      // No new parent: v becomes free.
      for (let d = 0; d < 4; d++) {
        if (!valid(v, d)) continue;
        const a = (v << 2) | d, u = v + off[d];
        if (tree[u] !== t) continue;
        if (t === 1 ? rcap[(u << 2) | (d ^ 1)] > 0 : rcap[a] > 0) activate(u);
        const p = parent[u];
        if (p !== TERMINAL && p !== ORPHAN && p !== NONE && headOf(p) === v) addOrphan(u);
      }
      tree[v] = 0;
      parent[v] = NONE;
    }
    oh = ot = 0;
  }

  const label = new Uint8Array(n);
  for (let i = 0; i < n; i++) label[i] = tree[i] === 1 ? 1 : 0;
  return { label, flow };
}
