"""
Voronoi strut-based lattice generator  ->  STL / OBJ
=====================================================

Builds a stochastic Voronoi strut lattice inside a box or a sphere: the
edges of a 3D Voronoi tessellation become cylindrical struts, the outer
surface gets its own struts (cage / frame), and nodes can be smoothly
filleted.

How it works
------------
1. Random seed points are placed in the solid (reproducible via SEED).
   MIN_CELL_SIZE enforces a minimum distance between seeds (Poisson-disk
   sampling), so every cell is at least that wide -> no tiny cells that
   clog up / fuse when printed.  Optional Lloyd relaxation makes the
   cells more uniform.
   MIN_STRUT_LENGTH then collapses any strut shorter than that into a
   single node, which removes tight node clusters.
2. Voronoi tessellation clipped to the solid:
     box    -> seeds mirrored across the 6 faces (exact flat clipping)
     sphere -> Voronoi faces intersected with the sphere -> curved arcs
3. Every Voronoi edge -> capsule (cylinder with round ends).
4. All struts are combined into a signed-distance field (SDF); node
   fillets come from a smooth union of the struts.
5. Marching cubes -> watertight triangle mesh -> binary STL (or OBJ).

Requirements:  pip install numpy scipy scikit-image
(optional, for the preview window:  pip install matplotlib)

Usage
-----
Edit the PARAMETERS block below and run:
    python voronoi_lattice.py
or override from the command line, e.g.:
    python voronoi_lattice.py --shape box --size 20 20 20 --cells 40 --thickness 0.8 --fillet 0.5 --seed 7
    python voronoi_lattice.py --shape sphere --radius 12 --cells 60 --min-cell 3 --min-strut 1.2
    python voronoi_lattice.py -h          (list all options)
"""

import argparse
import os
import time

import numpy as np
from scipy.spatial import Voronoi, cKDTree
from skimage.measure import marching_cubes

# =============================================================================
# PARAMETERS  (all lengths in mm)
# =============================================================================
SHAPE = "box"                  # "box" or "sphere"
BOX_SIZE = (20.0, 20.0, 20.0)  # box: outer size X, Y, Z [mm]
SPHERE_RADIUS = 10.0           # sphere: outer radius [mm]
N_CELLS = 40                   # number of Voronoi cells (seed points)
MIN_CELL_SIZE = 3.0            # smallest allowed cell, as the edge of a cube [mm]:
                               #   seeds are kept >= this far apart, so every cell
                               #   contains a sphere of this diameter.
                               #   0 / None = no limit.  If N_CELLS cells don't fit,
                               #   fewer cells are placed (a warning is printed).
MIN_STRUT_LENGTH = 1.0         # shortest strut allowed [mm]: shorter struts are
                               #   collapsed into one node, which removes tight
                               #   clusters of nodes (well-spaced seeds can still
                               #   give cells with very short edges). 0 = off.
                               #   About 1-2 x STRUT_THICKNESS works well.
STRUT_THICKNESS = 0.8          # strut diameter [mm]
SEED = 42                      # random seed -> same seed = same lattice
FILLET = 0.5                   # node fillet, relative to strut thickness
                               #   0 = sharp joints, 0.3 light, 0.5 medium, 1.0 heavy
RELAX_ITERS = 2                # Lloyd relaxation steps (0 = fully random cells,
                               #   higher = more uniform / regular cell sizes)
BOUNDARY = "inset"             # "inset": strut surfaces touch the outer surface ->
                               #          outer dimensions exact, rounded frame
                               # "clip" : strut axes on the outer surface, then cut
                               #          flush -> flat / smooth outer faces
EXACT_SIZE = True              # True: trim anything past the outer surface (mainly
                               #   fillet bulges at outer nodes), so the part measures
                               #   exactly BOX_SIZE / SPHERE_RADIUS. False: outer nodes
                               #   keep their full round fillet, part is slightly
                               #   larger. "clip" boundary is always exact.
SURFACE_STRUTS = True          # True: keep struts on the outer surface (closed cage)
                               # False: open lattice, interior struts only
VOXEL_SIZE = None              # mesh resolution [mm]; None = thickness / 6
                               #   smaller = smoother but slower / bigger file
MIN_EDGE_FRAC = 0.5            # merge nodes closer than this x thickness
                               #   (removes tiny edges that create blobs)
OUTPUT = None                  # file name (.stl or .obj); None = auto name
                               #   (saved next to this script)
PREVIEW = False                # True = show a quick matplotlib preview of the struts


# =============================================================================
# Domain helpers
# =============================================================================
class Domain:
    """Skeleton domain (where strut axes live)."""

    def __init__(self, shape, size=None, radius=None, inset=0.0):
        self.shape = shape
        if shape == "box":
            self.size = np.asarray(size, float)
            self.lo = np.full(3, inset)
            self.hi = self.size - inset
            if np.any(self.hi <= self.lo):
                raise ValueError("Box too small for this strut thickness.")
        else:
            self.R_outer = float(radius)
            self.R = self.R_outer - inset
            if self.R <= 0:
                raise ValueError("Sphere too small for this strut thickness.")

    def volume(self):
        if self.shape == "box":
            return float(np.prod(self.hi - self.lo))
        return 4.0 / 3.0 * np.pi * self.R ** 3

    def sample(self, rng, n, margin=0.0):
        """Uniform random points at least `margin` inside the domain."""
        if self.shape == "box":
            lo, hi = self.lo + margin, self.hi - margin
            if np.any(hi < lo):
                lo = hi = (self.lo + self.hi) / 2
            return lo + rng.random((n, 3)) * (hi - lo)
        R = max(self.R - margin, 0.0)
        d = rng.normal(size=(n, 3))
        d /= np.linalg.norm(d, axis=1, keepdims=True)
        return d * (R * rng.random(n) ** (1 / 3))[:, None]

    def project(self, pts, margin=0.0):
        """Push points back to at least `margin` inside the domain."""
        if self.shape == "box":
            lo, hi = self.lo + margin, self.hi - margin
            return np.clip(pts, np.minimum(lo, hi), np.maximum(lo, hi))
        R = max(self.R - margin, 0.0)
        n = np.linalg.norm(pts, axis=1, keepdims=True)
        return np.where(n > R, pts / np.maximum(n, 1e-12) * R, pts)


# =============================================================================
# 1) Seeds: Poisson-disk (min cell size) + Lloyd relaxation
# =============================================================================
def poisson_seeds(dom, n, min_dist, rng):
    """Dart throwing: n seeds, pairwise >= min_dist, >= min_dist/2 from the wall."""
    if not min_dist:
        return dom.sample(rng, n)
    margin = min_dist / 2.0
    pts = []
    tree_pts = np.empty((0, 3))
    attempts, max_attempts = 0, min(3000 * n, 200000)
    batch = 256
    while len(pts) < n and attempts < max_attempts:
        cand = dom.sample(rng, batch, margin)
        attempts += batch
        for c in cand:
            if len(pts) and np.min(np.sum((tree_pts - c) ** 2, axis=1)) < min_dist ** 2:
                continue
            pts.append(c)
            tree_pts = np.vstack([tree_pts, c])
            if len(pts) >= n:
                break
    pts = np.array(pts)
    if len(pts) < n:
        print(f"WARNING: only {len(pts)} of {n} cells fit with MIN_CELL_SIZE = {min_dist} mm "
              f"-> using {len(pts)} cells (lower MIN_CELL_SIZE or enlarge the part).")
    return pts


def enforce_spacing(pts, dom, min_dist, iters=60):
    """Push apart seed pairs that are closer than min_dist."""
    if not min_dist or len(pts) < 2:
        return pts
    margin = min_dist / 2.0
    for _ in range(iters):
        pairs = cKDTree(pts).query_pairs(min_dist * 0.999, output_type="ndarray")
        if len(pairs) == 0:
            break
        d = pts[pairs[:, 1]] - pts[pairs[:, 0]]
        L = np.linalg.norm(d, axis=1, keepdims=True)
        push = d / np.maximum(L, 1e-9) * (min_dist - L) * 0.5 * 1.01
        delta = np.zeros_like(pts)
        np.add.at(delta, pairs[:, 0], -push)
        np.add.at(delta, pairs[:, 1], push)
        pts = dom.project(pts + delta, margin)
    return pts


def lloyd(pts, dom, rng, iters, min_dist):
    """Monte-Carlo Lloyd relaxation (works for any domain shape)."""
    margin = (min_dist or 0.0) / 2.0
    for _ in range(iters):
        samples = dom.sample(rng, max(20000, 400 * len(pts)))
        _, idx = cKDTree(pts).query(samples)
        cnt = np.bincount(idx, minlength=len(pts))
        cen = np.zeros_like(pts)
        np.add.at(cen, idx, samples)
        ok = cnt > 0
        pts = pts.copy()
        pts[ok] = cen[ok] / cnt[ok, None]
        pts = dom.project(pts, margin)
        pts = enforce_spacing(pts, dom, min_dist)
    return pts


# =============================================================================
# 2) Voronoi skeleton
# =============================================================================
def mirror_seeds(pts, lo, hi):
    out = [pts]
    for ax in range(3):
        for bound in (lo[ax], hi[ax]):
            m = pts.copy()
            m[:, ax] = 2.0 * bound - m[:, ax]
            out.append(m)
    return np.vstack(out)


def fibonacci_sphere(n, R):
    i = np.arange(n) + 0.5
    phi = np.arccos(1 - 2 * i / n)
    th = np.pi * (1 + 5 ** 0.5) * i
    return R * np.c_[np.cos(th) * np.sin(phi), np.sin(th) * np.sin(phi), np.cos(phi)]


def box_segments(seeds, dom):
    n = len(seeds)
    vor = Voronoi(mirror_seeds(seeds, dom.lo, dom.hi))
    segs = []
    for (p, q), rv in zip(vor.ridge_points, vor.ridge_vertices):
        if (p >= n and q >= n) or -1 in rv or len(rv) < 2:
            continue
        for k in range(len(rv)):
            segs.append((rv[k], rv[(k + 1) % len(rv)]))
    V = np.clip(vor.vertices, dom.lo, dom.hi)
    segs = np.array(segs)
    return V[segs[:, 0]], V[segs[:, 1]], np.zeros(len(segs), bool)


def clip_segment_ball(a, b, R):
    """Part of segment a-b inside the ball |x| <= R, or None."""
    d = b - a
    A, B, C = d @ d, 2 * a @ d, a @ a - R * R
    disc = B * B - 4 * A * C
    if A < 1e-18 or disc <= 0:
        return None
    s = np.sqrt(disc)
    t0, t1 = max((-B - s) / (2 * A), 0.0), min((-B + s) / (2 * A), 1.0)
    if t1 - t0 <= 1e-9:
        return None
    return a + t0 * d, a + t1 * d


def sphere_arcs(poly, normal, h, R, seg_len):
    """Arcs of (plane ∩ sphere) that lie inside the convex polygon `poly`."""
    if abs(h) >= R:
        return []
    c = normal * h
    rho = np.sqrt(R * R - h * h)
    u = np.cross(normal, [1, 0, 0] if abs(normal[0]) < 0.9 else [0, 1, 0])
    u /= np.linalg.norm(u)
    v = np.cross(normal, u)
    P2 = np.c_[(poly - c) @ u, (poly - c) @ v]
    # orient polygon counter-clockwise
    area = np.sum(P2[:, 0] * np.roll(P2[:, 1], -1) - np.roll(P2[:, 0], -1) * P2[:, 1])
    if area < 0:
        P2 = P2[::-1]
    E = np.roll(P2, -1, axis=0) - P2

    def inside(th):
        x = np.c_[rho * np.cos(th), rho * np.sin(th)]
        cr = E[:, 0][None] * (x[:, 1][:, None] - P2[:, 1][None]) - \
             E[:, 1][None] * (x[:, 0][:, None] - P2[:, 0][None])
        return np.all(cr >= -1e-12, axis=1)

    N = 720
    th = np.linspace(0, 2 * np.pi, N, endpoint=False)
    ins = inside(th)
    if not ins.any():
        return []

    def refine(t_in, t_out):
        for _ in range(40):
            m = 0.5 * (t_in + t_out)
            if inside(np.array([m]))[0]:
                t_in = m
            else:
                t_out = m
        return t_in

    runs = []
    if ins.all():
        runs.append((0.0, 2 * np.pi, True))
    else:
        start = np.argmax(~ins)  # rotate so we start outside
        order = (np.arange(N) + start) % N
        k = 0
        while k < N:
            if ins[order[k]]:
                j = k
                while j + 1 < N and ins[order[j + 1]]:
                    j += 1
                step = 2 * np.pi / N
                t_a = th[order[0]] + k * step   # monotonic angle along the run
                t_b = th[order[0]] + j * step
                a = refine(t_a, t_a - step)
                b = refine(t_b, t_b + step)
                runs.append((a, b, False))
                k = j + 1
            else:
                k += 1
    segs = []
    for a, b, closed in runs:
        L = rho * (b - a)
        nseg = max(int(np.ceil(L / seg_len)), 3 if closed else 1)
        ts = np.linspace(a, b, nseg + 1)
        pts = c + rho * (np.cos(ts)[:, None] * u + np.sin(ts)[:, None] * v)
        for i in range(nseg):
            segs.append((pts[i], pts[i + 1]))
    return segs


def sphere_segments(seeds, dom, seg_len):
    n = len(seeds)
    R = dom.R
    ghosts = fibonacci_sphere(80, 4.0 * R)
    vor = Voronoi(np.vstack([seeds, ghosts]))
    A, B, surf = [], [], []
    for (p, q), rv in zip(vor.ridge_points, vor.ridge_vertices):
        if p >= n or q >= n or -1 in rv or len(rv) < 3:
            continue
        poly = vor.vertices[rv]
        for k in range(len(rv)):
            s = clip_segment_ball(poly[k], poly[(k + 1) % len(rv)], R)
            if s is not None:
                A.append(s[0]); B.append(s[1]); surf.append(False)
        nrm = seeds[q] - seeds[p]
        nrm /= np.linalg.norm(nrm)
        h = nrm @ (seeds[p] + seeds[q]) / 2
        for a, b in sphere_arcs(poly, nrm, h, R, seg_len):
            A.append(a); B.append(b); surf.append(True)
    return np.array(A), np.array(B), np.array(surf)


def snap_to_domain(p, f, dom):
    p = np.array(p, float)
    if dom.shape == "box":
        for ax in range(3):
            if f & (1 << (2 * ax)):
                p[ax] = dom.lo[ax]
            if f & (1 << (2 * ax + 1)):
                p[ax] = dom.hi[ax]
        return p
    if f & 64:
        p *= dom.R / max(np.linalg.norm(p), 1e-12)
    return p


def dedupe_edges(E, surf, flags, dom):
    """Drop self-loops and duplicate edges. Box: an edge is a surface strut
    when both ends lie on the same face."""
    E = np.sort(np.asarray(E), axis=1)
    keep = E[:, 0] != E[:, 1]
    E, surf = E[keep], np.asarray(surf)[keep]
    if dom.shape == "box":
        surf = (flags[E[:, 0]] & flags[E[:, 1]]) != 0
    E, inv = np.unique(E, axis=0, return_inverse=True)
    s = np.zeros(len(E), bool)
    np.logical_or.at(s, inv.ravel(), surf)
    return E, s


def collapse_short(V, flags, E, surf, min_len, dom):
    """Collapse every strut (chain of edges between junctions) shorter than
    min_len into one node. Surface nodes stay on the surface, box corners and
    edges stay put. V and flags are updated in place."""
    for _ in range(60):
        chains = strut_chains(E, len(V))
        cand = []
        for ch in chains:
            ab = E[ch]
            length = np.linalg.norm(V[ab[:, 0]] - V[ab[:, 1]], axis=1).sum()
            if length < min_len:
                cand.append((length, np.unique(ab)))
        if not cand:
            break
        cand.sort(key=lambda c: c[0])
        locked = np.zeros(len(V), bool)
        rep = np.arange(len(V))
        done = 0
        for _, nodes in cand:
            if locked[nodes].any():
                continue
            f = int(np.bitwise_or.reduce(flags[nodes]))
            if dom.shape == "box" and (f & (f >> 1) & 0b010101):
                continue  # would pin the node to two opposite faces
            r0 = nodes[0]
            V[r0] = snap_to_domain(V[nodes].mean(0), f, dom)
            flags[r0] = f
            rep[nodes] = r0
            locked[nodes] = True
            done += 1
        if not done:
            break
        E, surf = dedupe_edges(rep[E], surf, flags, dom)
    return E, surf


def build_graph(A, B, surf, merge_tol, dom, surface_struts, min_strut=0.0):
    """Merge segment endpoints into nodes, dedupe edges, collapse short struts."""
    P = np.vstack([A, B])
    tree = cKDTree(P)
    parent = np.arange(len(P))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, j in tree.query_pairs(merge_tol):
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[rj] = ri
    roots = np.array([find(i) for i in range(len(P))])
    uniq, inv = np.unique(roots, return_inverse=True)
    V = np.zeros((len(uniq), 3))
    np.add.at(V, inv, P)
    V /= np.bincount(inv)[:, None]

    # keep surface nodes exactly on the surface; flags = which faces a node is on
    # (box: bit 2*axis for the low face, 2*axis+1 for the high face; sphere: 64)
    flags = np.zeros(len(uniq), dtype=np.int64)
    if dom.shape == "box":
        for ax in range(3):
            for side, bound in enumerate((dom.lo[ax], dom.hi[ax])):
                on = np.zeros(len(uniq), bool)
                np.logical_or.at(on, inv, np.isclose(P[:, ax], bound, atol=1e-6))
                flags[on] |= 1 << (2 * ax + side)
    else:
        on = np.zeros(len(uniq), bool)
        np.logical_or.at(on, inv, np.abs(np.linalg.norm(P, axis=1) - dom.R) < 1e-6)
        flags[on] = 64
    for i in np.nonzero(flags)[0]:
        V[i] = snap_to_domain(V[i], flags[i], dom)

    m = len(A)
    E, surf = dedupe_edges(np.c_[inv[:m], inv[m:]], surf, flags, dom)
    if min_strut > 0:
        E, surf = collapse_short(V, flags, E, surf, min_strut, dom)
    if not surface_struts:
        E = E[~surf]

    used = np.unique(E)
    remap = -np.ones(len(V), dtype=int)
    remap[used] = np.arange(len(used))
    return V[used], remap[E]


# =============================================================================
# 3) Signed distance field of the struts (with smooth-union fillets)
# =============================================================================
def strut_chains(E, n_nodes):
    """Group edges into chains through degree-2 nodes (e.g. a curved surface
    strut made of many short segments) so one chain = one smooth strut."""
    deg = np.bincount(E.ravel(), minlength=n_nodes)
    adj = [[] for _ in range(n_nodes)]
    for ei, (a, b) in enumerate(E):
        adj[a].append(ei)
        adj[b].append(ei)
    seen = np.zeros(len(E), bool)
    chains = []
    for e0 in range(len(E)):
        if seen[e0]:
            continue
        seen[e0] = True
        chain = [e0]
        for node in E[e0]:
            cur = node
            while deg[cur] == 2:
                nxt = [e for e in adj[cur] if not seen[e]]
                if not nxt:
                    break
                seen[nxt[0]] = True
                chain.append(nxt[0])
                a, b = E[nxt[0]]
                cur = b if a == cur else a
        chains.append(chain)
    return chains


def strut_sdf(V, E, radius, k, grid_lo, voxel, shape):
    """
    f < 0 inside material, f = 0 on the surface.
    k = 0 -> plain union;  k > 0 -> exponential smooth-min between struts
    d = -k ln(sum exp(-d_i/k))  (order independent, fillets of size ~k).
    """
    reach = radius + (8.0 * k if k > 0 else 0.0) + 2 * voxel
    acc = np.zeros(shape, np.float64) if k > 0 else np.full(shape, np.inf, np.float32)
    for chain in strut_chains(E, len(V)):
        P = V[E[chain].ravel()]
        i0 = np.maximum(np.floor((P.min(0) - reach - grid_lo) / voxel).astype(int), 0)
        i1 = np.minimum(np.ceil((P.max(0) + reach - grid_lo) / voxel).astype(int) + 1, shape)
        if np.any(i1 <= i0):
            continue
        xs, ys, zs = (grid_lo[i] + voxel * np.arange(i0[i], i1[i]) for i in range(3))
        X, Y, Z = np.meshgrid(xs, ys, zs, indexing="ij")
        d = np.full(X.shape, np.inf)
        for a_i, b_i in E[chain]:
            a, b = V[a_i], V[b_i]
            ab = b - a
            L2 = max(ab @ ab, 1e-12)
            PX, PY, PZ = X - a[0], Y - a[1], Z - a[2]
            t = np.clip((PX * ab[0] + PY * ab[1] + PZ * ab[2]) / L2, 0.0, 1.0)
            np.minimum(d, np.sqrt((PX - t * ab[0]) ** 2 + (PY - t * ab[1]) ** 2
                                  + (PZ - t * ab[2]) ** 2), out=d)
        sl = tuple(slice(i0[i], i1[i]) for i in range(3))
        if k > 0:
            acc[sl] += np.exp(-np.minimum(d - radius, 50 * k) / k)
        else:
            np.minimum(acc[sl], d.astype(np.float32), out=acc[sl])
    if k > 0:
        with np.errstate(divide="ignore"):
            f = -k * np.log(acc)
    else:
        f = acc - radius
    f[~np.isfinite(f)] = reach
    return f.astype(np.float32)


def outer_sdf(dom_shape, grid_lo, voxel, shape, size=None, R=None):
    axes = [grid_lo[i] + voxel * np.arange(shape[i]) for i in range(3)]
    X, Y, Z = np.meshgrid(*axes, indexing="ij")
    if dom_shape == "sphere":
        return (np.sqrt(X * X + Y * Y + Z * Z) - R).astype(np.float32)
    c, h = size / 2, size / 2
    q = np.stack([np.abs(X - c[0]) - h[0], np.abs(Y - c[1]) - h[1], np.abs(Z - c[2]) - h[2]])
    return (np.linalg.norm(np.maximum(q, 0), axis=0) + np.minimum(q.max(axis=0), 0)).astype(np.float32)


# =============================================================================
# 4) Mesh output
# =============================================================================
def write_stl(path, verts, faces):
    tri = verts[faces]
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    data = np.zeros(len(faces), dtype=[("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")])
    data["n"], data["v"] = n, tri
    with open(path, "wb") as fh:
        fh.write(b"Voronoi strut lattice (python)".ljust(80, b" "))
        fh.write(np.uint32(len(faces)).tobytes())
        fh.write(data.tobytes())


def write_obj(path, verts, faces):
    with open(path, "w") as fh:
        fh.write("# Voronoi strut lattice (python), units: mm\n")
        np.savetxt(fh, verts, fmt="v %.5f %.5f %.5f")
        np.savetxt(fh, faces + 1, fmt="f %d %d %d")


def mesh_volume(verts, faces):
    t = verts[faces]
    return np.einsum("ij,ij->i", t[:, 0], np.cross(t[:, 1], t[:, 2])).sum() / 6.0


def preview(V, E):
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Line3DCollection
    fig = plt.figure(figsize=(7, 7))
    ax = fig.add_subplot(111, projection="3d")
    ax.add_collection3d(Line3DCollection(V[E], colors="k", linewidths=1.2))
    lo, hi = V.min(0), V.max(0)
    ax.set_xlim(lo[0], hi[0]); ax.set_ylim(lo[1], hi[1]); ax.set_zlim(lo[2], hi[2])
    ax.set_box_aspect(hi - lo)
    plt.tight_layout()
    plt.show()


# =============================================================================
# main
# =============================================================================
def build(shape="box", size=BOX_SIZE, radius=SPHERE_RADIUS, n_cells=N_CELLS,
          min_cell=MIN_CELL_SIZE, thickness=STRUT_THICKNESS, seed=SEED, fillet=FILLET,
          relax_iters=RELAX_ITERS, boundary=BOUNDARY, surface_struts=SURFACE_STRUTS,
          voxel=VOXEL_SIZE, min_edge_frac=MIN_EDGE_FRAC, output=OUTPUT, show=PREVIEW,
          min_strut=MIN_STRUT_LENGTH, exact=EXACT_SIZE):
    t0 = time.time()
    r = thickness / 2.0
    voxel = voxel or thickness / 6.0
    k = max(fillet, 0.0) * thickness * 0.25  # smooth-union blend width [mm]
    if boundary not in ("inset", "clip"):
        raise ValueError("BOUNDARY must be 'inset' or 'clip'")
    inset = r if boundary == "inset" else 0.0
    dom = Domain(shape, size=size, radius=radius, inset=inset)
    min_cell = min_cell or 0.0

    rng = np.random.default_rng(seed)
    seeds = poisson_seeds(dom, n_cells, min_cell, rng)
    seeds = lloyd(seeds, dom, rng, relax_iters, min_cell)
    if len(seeds) > 1:
        dmin = cKDTree(seeds).query(seeds, k=2)[0][:, 1].min()
        print(f"Cells: {len(seeds)}, smallest seed spacing {dmin:.2f} mm"
              + (f" (limit {min_cell:g} mm)" if min_cell else ""))

    if shape == "box":
        A, B, surf = box_segments(seeds, dom)
    else:
        A, B, surf = sphere_segments(seeds, dom, seg_len=1.5 * thickness)
    V, E = build_graph(A, B, surf, min_edge_frac * thickness, dom, surface_struts,
                       min_strut or 0.0)
    if len(E) == 0:
        raise ValueError("No struts left: lower MIN_STRUT_LENGTH.")
    lens = np.linalg.norm(V[E[:, 0]] - V[E[:, 1]], axis=1)
    shortest = min(lens[ch].sum() for ch in strut_chains(E, len(V)))
    print(f"Skeleton: {len(V)} nodes, {len(E)} struts, "
          f"length mean {lens.mean():.2f} mm, shortest strut {shortest:.2f} mm"
          + (f" (limit {min_strut:g} mm)" if min_strut else ""))
    if show:
        preview(V, E)

    pad = 2 * voxel + 2 * k
    if shape == "box":
        size = np.asarray(size, float)
        grid_lo, ext = -np.full(3, pad), size + 2 * pad
    else:
        grid_lo, ext = -np.full(3, radius + pad), np.full(3, 2 * (radius + pad))
    gshape = tuple(np.ceil(ext / voxel).astype(int) + 1)
    print(f"Voxel grid: {gshape[0]} x {gshape[1]} x {gshape[2]}  (voxel {voxel:.3f} mm)")

    f = strut_sdf(V, E, r, k, grid_lo, voxel, gshape)
    if exact or boundary == "clip":  # trim everything past the outer surface
        f = np.maximum(f, outer_sdf(shape, grid_lo, voxel, gshape,
                                    size=np.asarray(size, float), R=radius))
    for ax in range(3):  # close the mesh at the grid border
        idx = [slice(None)] * 3
        idx[ax] = [0, -1]
        f[tuple(idx)] = voxel

    verts, faces, _, _ = marching_cubes(f, level=0.0, spacing=(voxel,) * 3)
    verts += grid_lo
    if mesh_volume(verts, faces) < 0:
        faces = faces[:, ::-1]

    if output is None:
        dims = (f"{size[0]:g}x{size[1]:g}x{size[2]:g}mm" if shape == "box" else f"R{radius:g}mm")
        output = (f"voronoi_{shape}_{dims}_n{len(seeds)}_t{thickness:g}_"
                  f"f{fillet:g}_seed{seed}.stl")
    if not os.path.isabs(output):
        output = os.path.join(os.path.dirname(os.path.abspath(__file__)), output)
    (write_obj if output.lower().endswith(".obj") else write_stl)(output, verts, faces)

    vol = mesh_volume(verts, faces)
    env = np.prod(size) if shape == "box" else 4 / 3 * np.pi * radius ** 3
    ext = verts.max(0) - verts.min(0)
    print(f"Mesh: {len(verts)} vertices, {len(faces)} triangles")
    if shape == "box":
        print(f"Outer size: {ext[0]:.2f} x {ext[1]:.2f} x {ext[2]:.2f} mm")
    else:
        print(f"Outer diameter: {2 * np.linalg.norm(verts, axis=1).max():.2f} mm")
    print(f"Solid volume: {vol:.1f} mm^3   relative density: {vol / env * 100:.1f} %")
    print(f"Saved: {output}   ({time.time() - t0:.1f} s)")
    return output


def main():
    p = argparse.ArgumentParser(description="Voronoi strut lattice -> STL / OBJ")
    p.add_argument("--shape", choices=["box", "sphere"], default=SHAPE)
    p.add_argument("--size", nargs=3, type=float, default=BOX_SIZE, metavar=("X", "Y", "Z"),
                   help="box outer size in mm")
    p.add_argument("--radius", type=float, default=SPHERE_RADIUS, help="sphere outer radius in mm")
    p.add_argument("--cells", type=int, default=N_CELLS, help="number of Voronoi cells")
    p.add_argument("--min-cell", type=float, default=MIN_CELL_SIZE,
                   help="minimum cell size (cube edge) in mm, 0 = off")
    p.add_argument("--min-strut", type=float, default=MIN_STRUT_LENGTH,
                   help="shortest strut in mm; shorter struts are collapsed, 0 = off")
    p.add_argument("--no-exact", action="store_true",
                   help="do not trim fillet bulges at the outer surface (part slightly larger)")
    p.add_argument("--thickness", type=float, default=STRUT_THICKNESS, help="strut diameter in mm")
    p.add_argument("--seed", type=int, default=SEED, help="random seed (reproducibility)")
    p.add_argument("--fillet", type=float, default=FILLET,
                   help="node fillet relative to strut thickness (0 none, 0.5 medium, 1 heavy)")
    p.add_argument("--relax", type=int, default=RELAX_ITERS, help="Lloyd relaxation iterations")
    p.add_argument("--boundary", choices=["inset", "clip"], default=BOUNDARY)
    p.add_argument("--no-surface", action="store_true", help="remove struts on the outer surface")
    p.add_argument("--voxel", type=float, default=VOXEL_SIZE, help="mesh resolution in mm")
    p.add_argument("--min-edge", type=float, default=MIN_EDGE_FRAC,
                   help="merge nodes closer than this x thickness")
    p.add_argument("--out", type=str, default=OUTPUT, help="output .stl or .obj path")
    p.add_argument("--preview", action="store_true", default=PREVIEW, help="show skeleton preview")
    a = p.parse_args()
    build(a.shape, a.size, a.radius, a.cells, a.min_cell, a.thickness, a.seed, a.fillet,
          a.relax, a.boundary, SURFACE_STRUTS and not a.no_surface, a.voxel, a.min_edge,
          a.out, a.preview, a.min_strut, EXACT_SIZE and not a.no_exact)


if __name__ == "__main__":
    main()
