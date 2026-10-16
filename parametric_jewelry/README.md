# TPMS Jewelry Generator

An interactive, browser-only tool for designing jewelry filled with triply periodic minimal surfaces (TPMS). Open `index.html` from any static host (e.g. GitHub Pages) and share the link.

## Pieces
- **Ring**: inner diameter (US size shown), band thickness and width, front rise, edge rounding, tilt
- **Bangle**: same controls, sized for the wrist
- **Tiara**: an open arc with a head radius, arc span and peak height
- **Earring**: an ellipsoid drop with a small ear-hook loop

## Pattern
Gyroid, Schwarz D, Schwarz P, Neovius, Schoen I-WP, Lidinoid, Fischer-Koch S, or a custom formula `f(x, y, z) = 0`. The formula is checked against a whitelist before it runs. The pattern is wrapped around the band, so cells follow the curve and closed bands join seamlessly.
- **Sheet** (a thickened surface) or **Network** (one side filled, with a bias control)
- Cells around / across / through, twist, wall thickness, edge rails (or an outer shell on the earring)

## Mesh & export
- Implicit field Ã¢ÂÂ marching cubes (watertight) Ã¢ÂÂ removal of loose fragments Ã¢ÂÂ QEM simplification
- Adjustable voxel resolution (0.05Ã¢ÂÂ0.3 mm) and simplification level
- Binary STL or OBJ, in mm or inches
- Volume and estimated weight for common casting metals and print resins

## Files
- `index.html`: page layout
- `style.css`: styling (same look as Voronoi_Lattice_Generator)
- `app.js`: UI, three.js viewer and export
- `worker.js`: geometry (field, marching cubes, simplifier); runs in a Web Worker, with a main-thread fallback
