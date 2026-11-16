# Clearcut – background remover

Static site on GitHub Pages (repo WhoIsStitch/background-remover, branch main, root). No build step, no AI, no external scripts.

- `index.html`, `style.css`: UI
- `app.js`: UI + pipeline. plan() picks the method (colour / subject / box); getBase() computes and caches the automatic cut; compose() applies Select clicks (wand), brush strokes, trim, then unmixEdges. Undo history = state.actions ({box} | {wand} | {stroke}). Overlay canvases: #marks (strokes, box), #hl (hover highlight, box drag).
- `imaging.js`:
  - detectBackground, backgroundSeeds, floodRegion (adaptive background tracking), findGaps (enclosed patches of exact open-background colours; big or thin)
  - subjectCut (GrabCut-style: colour histograms → confident seeds → watershed, 4 iterations, speck removal)
  - watershed (bucket queue), applyStrokes, regionAt (Select tool), shrinkEdge, unmixEdges
- `png.js`: lossless RGBA PNG encoder (uses CompressionStream)

Rules: never resize the image; never change RGB of fully opaque pixels; save via `encodePNG`, not canvas.toBlob.
The user does not want AI: don't add ML models. They prefer automatic results over brushing.
Run: `python -m http.server 8765`. Deploy: push to main (Pages builds automatically).
