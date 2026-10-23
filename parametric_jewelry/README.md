# TPMS Jewelry Generator

An interactive, browser-only tool for designing jewelry filled with triply periodic minimal surfaces (TPMS). Open `index.html` from any static host (e.g. GitHub Pages) and share the link.

## Pieces
- **Ring**: inner diameter (US size shown), band thickness and width, front rise, edge rounding, tilt
- **Bangle**: same controls, sized for the wrist
- **Tiara**: an open arc with a head radius, arc span and a scalloped peak outline (tall centre, smaller peaks to the sides)
- **Choker**: a collar band sized by neck circumference, with a back opening for a clasp and an optional front rise. "Show on body" fits it to the neck of the head scan
- **Earring**: an ellipsoid drop with a small ear-hook loop. Earrings are a pair: "Show on body" hangs a mirrored copy from the other ear, and the download contains both (left + mirrored right, side by side)

## Pattern
Gyroid, Schwarz D, Schwarz P, Neovius, Schoen I-WP, Lidinoid, Fischer-Koch S, or a custom formula `f(x, y, z) = 0`. The formula is checked against a whitelist before it runs. The pattern is wrapped around the band, so cells follow the curve and closed bands join seamlessly.
- **Sheet** (a thickened surface) or **Network** (one side filled, with a bias control)
- Cells around / across / through, twist, wall thickness, edge rails (or an outer shell on the earring)
- **Pattern map**: drag a frame grid and drop attractor points to grade the cells (denser or more open). On bands it is the band unrolled; on the earring it is the drop seen from the front

## Mesh & export
- Implicit field -> marching cubes (watertight) -> removal of loose fragments -> QEM simplification
- Adjustable voxel resolution (0.05-0.3 mm) and simplification level
- Binary STL or OBJ, in mm or inches
- Volume and estimated weight for common casting metals and print resins

## Files
- `index.html`: page layout
- `style.css`: styling (same look as Voronoi_Lattice_Generator)
- `app.js`: UI, three.js viewer and export
- `worker.js`: geometry (field, marching cubes, simplifier); runs in a Web Worker, with a main-thread fallback
