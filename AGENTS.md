# Clearcut – background remover

Static site on GitHub Pages (repo WhoIsStitch/background-remover, branch main, root). No build step, no AI, no external scripts.

- `index.html`, `style.css`: UI
- `app.js`: UI logic, loading, compose() pipeline (edge flood → enclosed gaps + clicks)
- `imaging.js`: detectBackground, backgroundSeeds, floodCut (adaptive background tracking + edge un-mixing with local background), findGaps (enclosed patches matching the removed background's colour histogram)
- `png.js`: lossless RGBA PNG encoder (uses CompressionStream)

Rules: never resize the image; never change RGB of fully opaque pixels; save via `encodePNG`, not canvas.toBlob.
The user did not want AI: don't add ML models.
Run: `python -m http.server 8765`. Deploy: push to main (Pages builds automatically).
