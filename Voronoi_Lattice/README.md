# Voronoi Lattice Generator

A browser tool for designing stochastic **Voronoi strut lattices** inside a box or a sphere, with a live 3D preview and STL / OBJ export. Everything runs in the visitor's browser: no server, no install.

## Features

- **Solid geometry:** box (length × width × height) or sphere (radius)
- **Units:** mm or inch for every length, and mm or inch for the exported file
- **Cells:** number of cells, **minimum cell size** (cube edge; seeds are kept at least this far apart so no cell is too small to print), **minimum strut length** (shorter struts are collapsed into one node, removing tight node clusters), random seed, Lloyd relaxation
- **Struts:** thickness (diameter), node fillet (% of thickness), rounded or flat-cut outer surface, **exact outer size** (trims fillet bulges so the part measures exactly the set size; the measured mesh size is shown), struts on the outer surface on/off
- **Mesh:** resolution from 0.5 mm down to 0.1 mm, live mesh preview, wireframe view
- **Export:** binary STL or OBJ, watertight (closed, manifold) mesh

## Publish with GitHub Pages

1. Push this folder to GitHub (`index.html` is the whole app).
2. In the repository: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, pick the branch and folder, and save.
3. The tool is then live at `https://<user>.github.io/<repo>/<path-to-this-folder>/`.

You can also open `index.html` directly in a browser (it needs an internet connection to load three.js and the fonts from their CDNs).

## How it works

1. Seed points are placed in the solid with Poisson-disk sampling (min cell size), then relaxed.
2. Each seed's Voronoi cell is built by clipping the solid's bounding box with bisector planes. For a sphere, cell faces are intersected with the sphere to make the curved outer struts. Struts shorter than the minimum strut length are then collapsed; nodes on the outer surface stay on it.
3. Cell edges become capsules. A smooth-union signed distance field blends them at the nodes (fillet).
4. With exact outer size on, the field is intersected with the outer solid, so nothing pokes out past it.
5. Marching cubes (streamed plane by plane in a Web Worker) turns the field into a triangle mesh.

## Python version

`voronoi_lattice.py` does the same thing offline (`pip install numpy scipy scikit-image`). Run `python voronoi_lattice.py -h` for options. The web tool and the script use different random number generators and relaxation methods, so the same seed gives different lattices in each.
