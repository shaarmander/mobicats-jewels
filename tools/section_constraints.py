"""Fair the fitting fields across solder joints and preserve transverse sections."""

import numpy as np
from scipy.spatial import cKDTree
from scipy.sparse import coo_matrix, eye
from scipy.sparse.linalg import splu


def reinforce(vertices, faces, fields, curves, profiles, stones, shifts, foot):
    active = np.flatnonzero(vertices[:, 1] > 7.3)
    lookup = np.full(len(vertices), -1)
    lookup[active] = np.arange(len(active))
    tri = faces[(lookup[faces] >= 0).all(axis=1)]
    tri = lookup[tri]
    v = vertices[active]
    coords = v[tri]
    tree = cKDTree(coords.mean(axis=1))
    # A quadratic B-spline cage spreads corrections smoothly across adjacent
    # triangles. Its spacing is smaller than a claw but larger than a facet.
    spacing = 0.40
    grid = v / spacing
    nearest = np.floor(grid + 0.5).astype(int)
    offsets = np.stack(
        np.meshgrid([-1, 0, 1], [-1, 0, 1], [-1, 0, 1]), axis=-1
    ).reshape(-1, 3)
    keys = nearest[:, None, :] + offsets
    low = keys.min(axis=(0, 1))
    dims = keys.max(axis=(0, 1)) - low + 1
    flat = np.ravel_multi_index((keys - low).transpose(2, 0, 1), dims)
    cells, index = np.unique(flat, return_inverse=True)
    dist = np.abs(grid[:, None, :] - keys)
    weights = np.where(dist < 0.5, 0.75 - dist**2, 0.5 * (1.5 - dist) ** 2).prod(axis=2)
    cage = coo_matrix(
        (weights.ravel(), (np.repeat(np.arange(len(v)), 27), index.ravel())),
        shape=(len(v), index.max() + 1),
    ).tocsr()
    rows = []
    cols = []
    values = []
    targets = []
    minimum = []
    chords = []
    for kind, path, width, depth, center in curves:
        gallery = kind == "gallery"
        sections = range(1, len(path) - 1) if gallery else range(10, 47)
        for k in sections:
            p = path[k]
            tangent = path[k + 1] - path[k - 1]
            tangent /= np.linalg.norm(tangent)
            side = np.eye(3)[np.argmin(np.abs(tangent))]
            side -= tangent.dot(side) * tangent
            side /= np.linalg.norm(side)
            up = np.cross(tangent, side)
            ids = tree.query_ball_point(p, 1.75)
            ts = coords[ids]
            e1 = ts[:, 1] - ts[:, 0]
            e2 = ts[:, 2] - ts[:, 0]
            dp = p - ts[:, 0]
            q = np.cross(dp, e1)
            for ang in np.arange(12) * np.pi / 12:
                axis = side * np.cos(ang) + up * np.sin(ang)
                pp = np.cross(axis, e2)
                det = np.sum(e1 * pp, axis=1)
                det[np.abs(det) < 1e-12] = np.nan
                u = np.sum(dp * pp, axis=1) / det
                w = q @ axis / det
                ds = np.where(
                    (u >= 0) & (w >= 0) & (u + w <= 1),
                    np.sum(e2 * q, axis=1) / det,
                    np.nan,
                )
                plus = np.argmin(np.where(ds > 0, ds, np.inf))
                minus = np.argmax(np.where(ds < 0, ds, -np.inf))
                if not ds[plus] > 0 or not ds[minus] < 0:
                    continue
                span = ds[plus] - ds[minus]
                if not 0.24 < span < max(1.9, 3.8 * max(width[k], depth[k])):
                    continue
                row = len(targets)
                for j, sign in [(plus, 1), (minus, -1)]:
                    rows.extend([row] * 3)
                    cols.extend(tri[ids[j]])
                    values.extend(sign * np.array([1 - u[j] - w[j], u[j], w[j]]))
                # Preserve full supporting stock. The dome and cut bearing
                # retain their native taper and stone contact constraints.
                sizes = profiles[:, 3 if gallery else 2] * (1 if center else 0.73)
                scale = np.maximum(0, (sizes + 0.18) / max(0.45, span) - 1)
                scale = np.minimum(scale, 1.8)
                minimum.append(sizes)
                chords.append(span * axis)
                targets.append(
                    np.r_[np.zeros(3), (scale[:, None] * span * axis).ravel()]
                )
    C = coo_matrix((values, (rows, cols)), shape=(len(targets), len(v))).tocsc()
    source = fields[active].reshape(-1, 12)
    constraints = C @ cage
    prior = cage.T @ cage
    reg = eye(cage.shape[1], format="csc") * 0.28
    from scipy.spatial.transform import Rotation

    # Anchor the surface of each bearing to the measured crown and pavilion.
    # The exterior of the claw is free to carry the extra metal.
    anchors = []
    anchor_values = []
    for st, shift in zip(stones, shifts):
        o = np.array(st["translation"])
        rot = Rotation.from_quat(st["rotation"])
        facets = st["facets"]
        n = np.array([f["normal"] for f in facets])
        distance = (
            np.sum(n * np.array([f["vertices"][0] for f in facets]), axis=1)
            * st["scale"]
        )
        local = rot.inv().apply(v - o)
        possible = np.flatnonzero(
            (np.linalg.norm(local, axis=1) < st["scale"] * 1.55) & (local[:, 1] > -0.5)
        )
        signed = (local[possible] @ n.T - distance).max(axis=1)
        keep = possible[(signed > -0.09) & (signed < 0.055)]
        if not len(keep):
            continue
        anchors.extend(keep)
        target = np.zeros((len(keep), 12))
        target[:, :3] = v[keep] - [0, foot, 0] if st["role"] == "center" else shift
        anchor_values.extend(target)
    rhs = cage.T @ source
    if anchors:
        seat = cage[anchors]
        prior += 110 * (seat.T @ seat)
        rhs += 110 * (seat.T @ np.array(anchor_values))
    # Penalize curvature of the displacement, including near joined wires.
    # Affine expansion of a free cross-section incurs no bending penalty.
    indices = np.arange(len(cells))
    rr = []
    cc = []
    vv = []
    nrows = 0
    ijk = np.array(np.unravel_index(cells, dims)).T
    for axis, stride in enumerate([dims[1] * dims[2], dims[2], 1]):
        lower = np.minimum(np.searchsorted(cells, cells - stride), len(cells) - 1)
        upper = np.minimum(np.searchsorted(cells, cells + stride), len(cells) - 1)
        ids = indices[
            (ijk[:, axis] > 0)
            & (ijk[:, axis] < dims[axis] - 1)
            & (cells[lower] == cells - stride)
            & (cells[upper] == cells + stride)
        ]
        rr.extend(np.repeat(np.arange(nrows, nrows + len(ids)), 3))
        nrows += len(ids)
        cc.extend(np.column_stack([lower[ids], ids, upper[ids]]).ravel())
        vv.extend(np.tile([1, -2, 1], len(ids)))
    curvature = coo_matrix((vv, (rr, cc)), shape=(nrows, len(cells))).tocsr()
    reg += 85 * (curvature.T @ curvature)

    output = np.zeros_like(source)
    for cols, strength in [(slice(0, 3), 75), (slice(3, 12), 60)]:
        M = (prior + reg + strength * (constraints.T @ constraints)).tocsc()
        output[:, cols] = cage @ splu(M).solve(
            rhs[:, cols] + strength * (constraints.T @ np.asarray(targets)[:, cols])
        )
    # Audit the continuous carat interval analytically. Every chord is affine
    # in stone scale. Correct deficient support sections without pulling the
    # neighboring, already adequate sections toward an arbitrary thickness.
    chord = np.array(chords)
    floors = np.asarray(minimum)
    shift = C @ output[:, :3]
    lo = np.cbrt(0.5 * 3.52 / (1.5 * 7.08)) - 1
    hi = np.cbrt(3 * 3.52 / (1.5 * 1.08)) - 1
    for j in range(3):
        sl = slice(3 + j * 3, 6 + j * 3)
        for _ in range(5):
            D = chord + C @ output[:, sl]
            t = np.clip(
                -np.sum(D * shift, axis=1)
                / np.maximum((shift**2).sum(axis=1), 1.0e-14),
                lo,
                hi,
            )
            worst = D + shift * t[:, None]
            length = np.linalg.norm(worst, axis=1)
            # Allow for section directions falling between sampled chords
            # and for quantization in the browser fit field.
            missing = floors[:, j] + 0.048 - length
            keep = missing > 0.004
            if not np.any(keep):
                break
            activeC = constraints[keep]
            correction = (
                worst[keep]
                * (np.minimum(missing[keep], 0.24) / np.maximum(length[keep], 0.01))[
                    :, None
                ]
            )
            stiff = 2500
            Q = (
                prior
                + reg
                + 25 * (constraints.T @ constraints)
                + stiff * (activeC.T @ activeC)
            )
            output[:, sl] += cage @ splu(Q.tocsc()).solve(
                stiff * (activeC.T @ correction)
            )
    # Feather the cage into the untouched lower shank.
    w = np.clip((v[:, 1] - 7.3) / 0.6, 0, 1)[:, None]
    fields[active] = (source + (output - source) * w).reshape(-1, 4, 3)
    return fields
