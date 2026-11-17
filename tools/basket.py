"""Sweep a fitted open basket in the local millimetre coordinates of its gemstone."""

import math

import numpy as np


def shells(part):
    vertices = np.asarray(part["vertices"])
    faces = np.asarray(part["triangles"])
    ends = np.arange(len(vertices))
    np.maximum.at(ends, faces.min(axis=1), faces.max(axis=1))
    cuts = np.flatnonzero(np.maximum.accumulate(ends) == np.arange(len(vertices))) + 1
    return np.split(vertices, cuts[:-1])


def cubic(a, b, c, d, count):
    t = np.linspace(0.0, 1.0, count)[:, None]
    return (
        (1 - t) ** 3 * a + 3 * t * (1 - t) ** 2 * b + 3 * t * t * (1 - t) * c + t**3 * d
    )


def tube(path, width, depth, guide, closed=False):
    """Sweep an elliptical wire, with smoothly domed ends on an open claw."""
    tangent = (
        np.roll(path, -1, axis=0) - np.roll(path, 1, axis=0)
        if closed
        else np.gradient(path, axis=0)
    )
    tangent /= np.maximum(1e-10, np.linalg.norm(tangent, axis=1)[:, None])
    across = guide - (tangent @ guide)[:, None] * tangent
    across /= np.maximum(1e-10, np.linalg.norm(across, axis=1)[:, None])
    up = np.cross(tangent, across)
    a = np.arange(32) * math.tau / 32
    section = (
        np.broadcast_to(width, len(path))[:, None, None]
        * across[:, None]
        * np.cos(a)[None, :, None]
        + np.broadcast_to(depth, len(path))[:, None, None]
        * up[:, None]
        * np.sin(a)[None, :, None]
    )
    rings = path[:, None] + section
    if not closed:
        caps = []
        for end, sign in [(0, -1), (-1, 1)]:
            phi = np.linspace(0, math.pi / 2, 8, endpoint=False)[1:]
            if end == 0:
                phi = phi[::-1]
            length = np.linalg.norm(section[end, 0]) * 0.88
            caps.append(
                path[end]
                + np.cos(phi)[:, None, None] * section[end]
                + (sign * length * np.sin(phi))[:, None, None] * tangent[end]
            )
        rings = np.concatenate([caps[0], rings, caps[1]])
    nr, nc = rings.shape[:2]
    i, j = np.meshgrid(
        np.arange(nr if closed else nr - 1), np.arange(nc), indexing="ij"
    )
    a = i * nc + j
    b = i * nc + (j + 1) % nc
    c = ((i + 1) % nr) * nc + j
    d = ((i + 1) % nr) * nc + (j + 1) % nc
    faces = np.concatenate(
        [np.stack((a, b, d), -1).reshape(-1, 3), np.stack((a, d, c), -1).reshape(-1, 3)]
    )
    verts = rings.reshape(-1, 3)
    if not closed:
        j = np.arange(nc)
        k = (j + 1) % nc
        m = len(verts)
        verts = np.concatenate(
            [
                verts,
                [
                    path[0] - 0.88 * np.linalg.norm(section[0, 0]) * tangent[0],
                    path[-1] + 0.88 * np.linalg.norm(section[-1, 0]) * tangent[-1],
                ],
            ]
        )
        faces = np.concatenate(
            [
                faces,
                np.stack((j * 0 + m, k, j), 1),
                np.stack((j * 0 + m + 1, (nr - 1) * nc + j, (nr - 1) * nc + k), 1),
            ]
        )
    return verts, faces


def basket(part, stone, setting):
    q = np.asarray(stone["rotation"])
    quat = q[:3]
    # Rows are the transformed local basis vectors.
    basis = np.eye(3) + 2 * np.cross(quat, np.cross(quat, np.eye(3)) + q[3] * np.eye(3))
    origin = np.asarray(stone["translation"])
    normals = np.array([f["normal"] for f in stone["facets"]])
    plane = (
        np.einsum("ij,ij->i", normals, [f["vertices"][0] for f in stone["facets"]])
        * stone["scale"]
    )
    gem_vertices = (
        np.concatenate([f["vertices"] for f in stone["facets"]]) * stone["scale"]
    )
    ymin = gem_vertices[:, 1].min()

    def exterior(directions, heights, offset):
        dot = directions @ normals.T
        bounds = (
            plane + offset - normals[:, 1] * np.asarray(heights)[:, None]
        ) / np.maximum(dot, 1e-8)
        return np.where(dot > 1e-6, bounds, np.inf).min(axis=1)

    def finish(vertices, faces, seat=False):
        if seat:
            # Cut the bearing against the actual crown/pavilion faces. The upper
            # claw can curl over the girdle without filling the gemstone.
            dist = vertices @ normals.T - plane
            face = dist.argmax(axis=1)
            penetration = np.minimum(dist[np.arange(len(vertices)), face], 0.0)
            vertices -= penetration[:, None] * normals[face]
        verts = vertices @ basis + origin
        if (
            np.einsum(
                "ij,ij->",
                verts[faces[:, 0]],
                np.cross(verts[faces[:, 1]], verts[faces[:, 2]]),
            )
            < 0
        ):
            faces = faces[:, ::-1]
        return verts.tolist(), faces.tolist()

    groups = shells(part)
    rails = []
    thickness = []
    for group in groups:
        if len(group) == 48 * 8:
            continue
        raw = group[:-2].reshape(-1, 10, 3)
        centers = (raw.mean(axis=1) - origin) @ basis.T
        radii = np.linalg.norm(raw[:, 0] - raw.mean(axis=1), axis=1)
        foot = centers[1].copy()
        tip = centers[-2].copy()
        neck = centers[np.argmin(abs(centers[:, 1]))].copy()
        direction = neck.copy()
        direction[1] = 0
        direction /= np.linalg.norm(direction)
        width = float(np.median(radii[2:-2]))
        # Start inside the solid shoulder. A split shank has two off-axis
        # shoulders, while a knife edge has a much narrower central ridge.
        world = foot @ basis + origin
        r = np.linalg.norm(world[:2])
        world[:2] *= min(r, 8.94 if setting == "knife" else 9.18) / r
        if setting == "split":
            world[2] = 1.22 if world[2] >= 0 else -1.22
        else:
            width_limit = 0.35 if setting == "knife" else 0.65
            world[2] = np.clip(world[2] * 0.68, -width_limit, width_limit)
        foot = (world - origin) @ basis.T
        tip -= direction * width * 0.22
        rise = neck[1] - foot[1]
        delta = neck - foot
        flat = delta.copy()
        flat[1] = 0
        up = np.array([0.0, 1.0, 0.0])
        # Flare from the shoulder, arrive vertically at the bearing, then turn
        # inward over the crown. No horizontal ledge around the culet.
        body = cubic(
            foot,
            foot + 0.38 * flat + 0.20 * rise * up,
            neck - 0.40 * rise * up,
            neck,
            48,
        )
        crown_height = max(0.08, tip[1] - neck[1])
        crown = cubic(
            neck,
            neck + 0.66 * crown_height * up,
            tip + 0.40 * np.linalg.norm((neck - tip)[[0, 2]]) * direction,
            tip,
            18,
        )
        path = np.concatenate([body, crown[1:]])
        along = np.linspace(0, 1, len(path))
        width_profile = width * np.interp(
            along, [0, 0.22, 0.58, 0.78, 1], [1.12, 0.89, 0.80, 0.88, 0.59]
        )
        depth_profile = width_profile * np.interp(
            along, [0, 0.68, 1], [0.92, 1.0, 0.73]
        )
        h = path[:, 1]
        within = h >= ymin + 0.02
        unit = path.copy()
        unit[:, 1] = 0
        radius = np.linalg.norm(unit, axis=1)
        unit /= np.maximum(radius[:, None], 1e-8)
        limit = exterior(unit[within], h[within], 0.0) + depth_profile[within] * 0.66
        current = radius[within]
        path[within] += unit[within] * np.maximum(0, limit - current)[:, None]
        # Set the claw over the crown. Pull the top of the wire toward the
        # actual convex faces before cutting its bearing, so the contact remains
        # broad even on shallow roses and elongated step cuts.
        closing = 0.75 * direction + 0.66 * up
        closing /= np.linalg.norm(closing)
        denom = normals @ closing
        eligible = denom > 0.08
        excess = (
            path @ normals[eligible].T - plane[eligible] - 0.30 * depth_profile[:, None]
        )
        travel = np.maximum(0.0, np.max(excess / denom[eligible], axis=1))
        pressure = np.clip((along - 0.69) / 0.21, 0.0, 1.0)
        path -= closing * (pressure**2 * (3 - 2 * pressure) * travel)[:, None]
        guide = np.cross(up, direction)
        yield finish(*tube(path, width_profile, depth_profile, guide), seat=True)
        rails.append(path)
        thickness.append(width)

    if len(rails) < 3 or not any(len(g) == 48 * 8 for g in groups):
        return
    # A scalloped gallery joins the bearing supports and opens a window beneath
    # the stone. Its cross-section is oval; its plan follows the individual cut.
    height = ymin * 0.31
    knots = np.array(
        [[np.interp(height, r[:, 1], r[:, k]) for k in [0, 2]] for r in rails]
    )
    angles = np.mod(np.arctan2(knots[:, 1], knots[:, 0]), math.tau)
    order = np.argsort(angles)
    angles = angles[order]
    knots = knots[order]

    def unit_at(a):
        return np.stack([np.cos(a), np.zeros_like(a), np.sin(a)], axis=1)

    base = exterior(unit_at(angles), np.full_like(angles, height), 0.0)
    offset = np.linalg.norm(knots, axis=1) - base
    count = 144
    a = np.arange(count) * math.tau / count
    phase = np.interp(
        a,
        np.r_[angles[-1] - math.tau, angles, angles[0] + math.tau],
        np.arange(-1, len(angles) + 1),
    )
    dip = np.sin(math.pi * phase) ** 2
    h = height - dip * np.minimum(0.52, -ymin * 0.17)
    line = exterior(unit_at(a), h, 0.0) + np.interp(a, angles, offset, period=math.tau)
    # Ease corners on stepped cuts while keeping the rail joined at the posts.
    line = (
        np.roll(line, 2)
        + 4 * np.roll(line, 1)
        + 6 * line
        + 4 * np.roll(line, -1)
        + np.roll(line, -2)
    ) / 16
    path = unit_at(a) * line[:, None]
    path[:, 1] = h
    width = np.median(thickness)
    yield finish(
        *tube(path, width * 0.56, width * 0.61, np.array([0.0, 1.0, 0.0]), closed=True)
    )
