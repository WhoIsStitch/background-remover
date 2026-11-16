# Clearcut – background remover

Static site on GitHub Pages (repo WhoIsStitch/background-remover, branch main, root). No build step, no AI, no external scripts.

- `index.html`, `style.css`: UI
- `app.js`: UI + pipeline. plan() picks the method (colour / subject / box); getBase() computes and caches the automatic cut; compose() applies Select clicks (wand), brush strokes, trim, then unmixEdges. Undo history = state.actions ({box} | {wand} | {stroke}). Overlay canvases: #marks (strokes, box), #hl (hover highlight, box drag).
- `imaging.js`:
  - detectBackground, backgroundSeeds, floodRegion (adaptive background tracking), findGaps (enclosed patches of exact open-background colours; big or thin)
  - grabCut (blurred colour histograms + graph cut via maxflow.js on a ~0.3 MP copy, 5 rounds, speck removal, full-res re-trace by watershed); matteEdges (sampling-based soft edges for Subject mode)
  - Tried and rejected (worse on tests): Gaussian mixture models, 32-level histograms, edge-trace background hint.
  - watershed (bucket queue), applyStrokes, regionAt (Select tool), shrinkEdge, unmixEdges
- `maxflow.js`: Boykov–Kolmogorov max-flow on a 4-connected grid (verified against Edmonds–Karp on 300 random grids).
- `effects.js`: applyEffects (outline via exact distance transform, colour/blur background, crop to content).
- `zip.js`: store-only ZIP writer for batch downloads.
- `png.js`: lossless RGBA PNG encoder (uses CompressionStream)

Rules: never resize the image; never change RGB of fully opaque pixels; save via `encodePNG`, not canvas.toBlob.
The user does not want AI: don't add ML models. They prefer automatic results over brushing.
Run: `python -m http.server 8765`. Deploy: push to main (Pages builds automatically).
