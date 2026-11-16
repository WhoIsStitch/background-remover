# Clearcut – background remover

Static site on GitHub Pages (repo WhoIsStitch/background-remover, branch main, root). No build step, no AI, no external scripts.

- `index.html`, `style.css`: UI
- `app.js`: UI logic, loading, compose() pipeline (edge flood → enclosed gaps + clicks → brush strokes → edge un-mixing), brush overlay canvas, undo history (state.actions)
- `imaging.js`: detectBackground, backgroundSeeds, floodRegion (adaptive background tracking), findGaps (enclosed patches of exact open-background colours; big or thin), applyStrokes (marker watershed for Keep/Remove brushes, bucket queue), unmixEdges (halo-free soft edges)
- `png.js`: lossless RGBA PNG encoder (uses CompressionStream)

Rules: never resize the image; never change RGB of fully opaque pixels; save via `encodePNG`, not canvas.toBlob.
The user did not want AI: don't add ML models.
Run: `python -m http.server 8765`. Deploy: push to main (Pages builds automatically).
