"""Bake overhead illumination onto the floor underneath a resting ring.

python tools/bake_ring_floor.py [solitaire-round ...]
Dependencies: numpy, scipy, pillow, numba, trimesh. Uses the exported GLBs and
ring-poses.json shared with the web viewer. Covers X/Z = [-29, 29] millimeters.
Texel rows run from -Z to +Z. Red is blocked direct irradiance, green and
blue are sqrt(gem irradiance / 2) for center and accent stones.
Use --directional to bake four raking key positions at each of two IORs.
The 2 x 4 atlas stores log(1 + 32 * irradiance) / log(513) in R and G.
"""

import argparse
import json
import math
import struct
import time
from pathlib import Path

import numpy as np
import trimesh
from numba import njit, prange
from PIL import Image
from scipy.ndimage import gaussian_filter
from scipy.spatial.transform import Rotation

ROOT = Path(__file__).resolve().parents[1] / "public" / "assets"
SIDE = 512
WIDTH = 58.0
TEXEL = WIDTH / SIDE
SAMPLES = 192
EPS = 0.00002


def load_ring(path, support=None):
    document = path.read_bytes()
    length = struct.unpack_from("<I", document, 12)[0]
    nodes = {n["name"]: n for n in json.loads(document[20 : 20 + length])["nodes"]}
    scene = trimesh.load(path, force="scene", process=False)
    if support is None:
        support = json.loads((ROOT / "ring-poses.json").read_text())[path.stem]
    pose = np.eye(4)
    pose[:3, :3] = Rotation.from_quat(support["rotation"]).as_matrix()
    pose[:3, 3] = support["translation"]
    triangles, roles, gems = [], [], []
    for node in sorted(scene.graph.nodes_geometry):
        transform, name = scene.graph[node]
        transform = pose @ transform
        mesh = scene.geometry[name]
        verts = trimesh.transform_points(mesh.vertices, transform)
        tri = np.ascontiguousarray(verts[mesh.faces])
        data = nodes[node]["extras"]
        role = data["role"]
        index = -1
        if role not in ("band", "head"):
            index = len(gems)
            # Some repeated shoulder stones refer to the same mesh/plane set.
            base = data.get("planes") or nodes[name]["extras"]["planes"]
            p = np.asarray(base)
            linear = transform[:3, :3]
            normal = p[:, :3] @ np.linalg.inv(linear)
            distance = p[:, 3] + normal @ transform[:3, 3]
            magnitudes = np.linalg.norm(normal, axis=1)
            planes = np.column_stack(
                (normal / magnitudes[:, None], distance / magnitudes)
            )
            gems.append((index, role == "center", tri, np.ascontiguousarray(planes)))
        triangles.append(tri)
        roles.append(np.full(len(tri), index, np.int32))
    return np.concatenate(triangles), np.concatenate(roles), gems


def bvh(triangles, roles):
    centers = triangles.mean(axis=1)
    lowers = triangles.min(axis=1)
    uppers = triangles.max(axis=1)
    boxes, ranges, ordered = [], [], []

    def build(ids):
        node = len(boxes)
        lo, hi = lowers[ids].min(axis=0), uppers[ids].max(axis=0)
        boxes.append(np.r_[lo, hi])
        ranges.append([0, 0, 0])
        if len(ids) <= 10:
            start = len(ordered)
            ordered.extend(ids)
            ranges[node] = [start, len(ids), node + 1]
        else:
            axis = np.ptp(centers[ids], axis=0).argmax()
            sorted_ids = ids[np.argsort(centers[ids, axis])]
            mid = len(ids) // 2
            build(sorted_ids[:mid])
            build(sorted_ids[mid:])
            ranges[node] = [0, 0, len(boxes)]

    build(np.arange(len(triangles)))
    tri = triangles[ordered].copy()
    tri[:, 1:] -= tri[:, 0:1]
    return np.asarray(boxes), np.asarray(ranges, np.int32), tri, roles[ordered]


@njit
def blocked(x, y, z, dx, dy, dz, distance, own, boxes, ranges, packed, roles):
    """Stackless, bounded any-hit BVH; ignore the launching convex gem."""
    invx = 1 / dx if abs(dx) > 1e-12 else 1e12
    invy = 1 / dy if abs(dy) > 1e-12 else 1e12
    invz = 1 / dz if abs(dz) > 1e-12 else 1e12
    i = 0
    while i < len(boxes):
        bx = boxes[i]
        ax, bx1 = (bx[0] - x) * invx, (bx[3] - x) * invx
        ay, by = (bx[1] - y) * invy, (bx[4] - y) * invy
        az, bz = (bx[2] - z) * invz, (bx[5] - z) * invz
        near = max(EPS, min(ax, bx1), min(ay, by), min(az, bz))
        far = min(distance, max(ax, bx1), max(ay, by), max(az, bz))
        if near > far:
            i = ranges[i, 2]
            continue
        start, count, _ = ranges[i]
        for t in range(start, start + count):
            if roles[t] == own:
                continue
            tr = packed[t]
            e1x, e1y, e1z = tr[1]
            e2x, e2y, e2z = tr[2]
            px, py, pz = dy * e2z - dz * e2y, dz * e2x - dx * e2z, dx * e2y - dy * e2x
            det = px * e1x + py * e1y + pz * e1z
            if abs(det) < 1e-12:
                continue
            tx, ty, tz = x - tr[0, 0], y - tr[0, 1], z - tr[0, 2]
            u = (tx * px + ty * py + tz * pz) / det
            if u < 0 or u > 1:
                continue
            qx, qy, qz = ty * e1z - tz * e1y, tz * e1x - tx * e1z, tx * e1y - ty * e1x
            v = (dx * qx + dy * qy + dz * qz) / det
            if v < 0 or u + v > 1:
                continue
            d = (e2x * qx + e2y * qy + e2z * qz) / det
            if EPS < d < distance:
                return True
        i += 1
    return False


@njit
def slopes(u, v):
    # A broad overhead source with a smaller central emitter. Each component
    # samples cosine-weighted solid angle within its cone.
    if u < 0.30:
        sin_theta = math.sin(math.radians(7)) * math.sqrt(u / 0.30)
    else:
        sin_theta = math.sin(math.radians(29)) * math.sqrt((u - 0.30) / 0.70)
    cos_theta = math.sqrt(1 - sin_theta * sin_theta)
    slope = sin_theta / cos_theta
    return slope * math.cos(v * 2 * math.pi), slope * math.sin(v * 2 * math.pi)


@njit(parallel=True)
def direct(triangles, floor_y):
    masks = np.zeros((SAMPLES, SIDE, SIDE), np.uint8)
    for sample in prange(SAMPLES):
        sx, sz = slopes(
            (sample + 0.5) / SAMPLES, ((sample + 1) * 0.6180339887498949) % 1
        )
        ox = (SIDE - 1) * 0.5 + ((sample + 0.5) * 0.7548776662466927) % 1 - 0.5
        oz = (SIDE - 1) * 0.5 + ((sample + 0.5) * 0.5698402909980532) % 1 - 0.5
        mask = masks[sample]
        for t in triangles:
            ax = (t[0, 0] + (t[0, 1] - floor_y) * sx) / TEXEL + ox
            az = (t[0, 2] + (t[0, 1] - floor_y) * sz) / TEXEL + oz
            bx = (t[1, 0] + (t[1, 1] - floor_y) * sx) / TEXEL + ox
            bz = (t[1, 2] + (t[1, 1] - floor_y) * sz) / TEXEL + oz
            cx = (t[2, 0] + (t[2, 1] - floor_y) * sx) / TEXEL + ox
            cz = (t[2, 2] + (t[2, 1] - floor_y) * sz) / TEXEL + oz
            # Projected front-facing triangles alone cover the silhouette.
            det = (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
            if det >= -1e-8:
                continue
            for iz in range(
                max(0, math.ceil(min(az, bz, cz))),
                min(SIDE, math.floor(max(az, bz, cz)) + 1),
            ):
                for ix in range(
                    max(0, math.ceil(min(ax, bx, cx))),
                    min(SIDE, math.floor(max(ax, bx, cx)) + 1),
                ):
                    ab = (ix - ax) * (bz - az) - (iz - az) * (bx - ax)
                    bc = (ix - bx) * (cz - bz) - (iz - bz) * (cx - bx)
                    ca = (ix - cx) * (az - cz) - (iz - cz) * (ax - cx)
                    if min(ab, bc, ca) >= 0:
                        mask[iz, ix] = 1
    return masks


@njit
def fresnel(c, ct, n1, n2):
    rs = (n1 * c - n2 * ct) / (n1 * c + n2 * ct)
    rp = (n2 * c - n1 * ct) / (n2 * c + n1 * ct)
    return (rs * rs + rp * rp) * 0.5


@njit(parallel=True)
def photons(
    own,
    triangles,
    normals,
    cdf,
    planes,
    area,
    floor_y,
    shots,
    boxes,
    ranges,
    packed,
    roles,
    key_x=0.0,
    key_z=0.0,
    spread=1.0,
    index=2.417,
):
    work = 32
    tiles = np.zeros((work, SIDE, SIDE), np.float32)
    for tile in prange(work):
        np.random.seed(9701 + tile + own * 103)
        for _ in range(tile, shots, work):
            k = np.searchsorted(cdf, np.random.random())
            nx, ny, nz = normals[k]
            sx, sz = slopes(np.random.random(), np.random.random())
            sx = key_x + sx * spread
            sz = key_z + sz * spread
            inv = 1 / math.sqrt(1 + sx * sx + sz * sz)
            dx, dy, dz = sx * inv, -inv, sz * inv
            c = -(dx * nx + dy * ny + dz * nz)
            if c <= 0:
                continue
            t = triangles[k]
            a = math.sqrt(np.random.random())
            b = np.random.random()
            w0, w1, w2 = 1 - a, a * (1 - b), a * b
            x = w0 * t[0, 0] + w1 * t[1, 0] + w2 * t[2, 0]
            y = w0 * t[0, 1] + w1 * t[1, 1] + w2 * t[2, 1]
            z = w0 * t[0, 2] + w1 * t[1, 2] + w2 * t[2, 2]
            if blocked(
                x, y, z, -dx, -dy, -dz, 120.0, own, boxes, ranges, packed, roles
            ):
                continue
            ct = math.sqrt(1 - (1 - c * c) / (index * index))
            energy = (
                area
                / (shots * TEXEL * TEXEL)
                * c
                / inv
                * (1 - fresnel(c, ct, 1.0, index))
            )
            # The external crown reflection also lights the receiver when the
            # ring is lying down. It is achromatic before Fresnel weighting.
            reflected = fresnel(c, ct, 1.0, index)
            rx, ry, rz = dx + 2 * c * nx, dy + 2 * c * ny, dz + 2 * c * nz
            if ry < -1e-6:
                travel = (floor_y - y) / ry
                fx = (x + rx * travel) / TEXEL + SIDE * 0.5
                fz = (z + rz * travel) / TEXEL + SIDE * 0.5
                if (
                    0 <= fx < SIDE
                    and 0 <= fz < SIDE
                    and not blocked(
                        x, y, z, rx, ry, rz, travel, own, boxes, ranges, packed, roles
                    )
                ):
                    tiles[tile, int(fz), int(fx)] += (
                        area / (shots * TEXEL * TEXEL) * c / inv * reflected
                    )
            tangent = c / index - ct
            dx, dy, dz = (
                dx / index + tangent * nx,
                dy / index + tangent * ny,
                dz / index + tangent * nz,
            )
            for bounce in range(32):
                nearest = 1e9
                hit = -1
                for j in range(len(planes)):
                    nx, ny, nz, h = planes[j]
                    den = dx * nx + dy * ny + dz * nz
                    if den > 1e-7:
                        t_ = (h - (x * nx + y * ny + z * nz)) / den
                        if EPS < t_ < nearest:
                            nearest = t_
                            hit = j
                if hit < 0:
                    break
                x += nearest * dx
                y += nearest * dy
                z += nearest * dz
                nx, ny, nz, _h = planes[hit]
                c = min(1.0, max(0.0, dx * nx + dy * ny + dz * nz))
                trans = 1 - index * index * (1 - c * c)
                if trans > 0.0 and np.random.random() > fresnel(
                    c, math.sqrt(trans), index, 1.0
                ):
                    tangent = math.sqrt(trans) - index * c
                    dx, dy, dz = (
                        index * dx + tangent * nx,
                        index * dy + tangent * ny,
                        index * dz + tangent * nz,
                    )
                    if dy < 0.0:
                        length = (floor_y - y) / dy
                        fx = (x + dx * length) / TEXEL + SIDE * 0.5
                        fz = (z + dz * length) / TEXEL + SIDE * 0.5
                        if (
                            0 <= fx < SIDE
                            and 0 <= fz < SIDE
                            and not blocked(
                                x,
                                y,
                                z,
                                dx,
                                dy,
                                dz,
                                length,
                                own,
                                boxes,
                                ranges,
                                packed,
                                roles,
                            )
                        ):
                            tiles[tile, int(fz), int(fx)] += energy
                    break
                dx -= 2 * c * nx
                dy -= 2 * c * ny
                dz -= 2 * c * nz
    return tiles


def bake(path, directional=False):
    start = time.monotonic()
    triangles, roles, gems = load_ring(path)
    floor_y = triangles[:, :, 1].min() - 0.015
    if not directional:
        shadow = gaussian_filter(direct(triangles, floor_y).mean(axis=0), 0.65)
    tree = bvh(triangles, roles)
    keys = [(-1.75, 0), (0, -1.75), (1.75, 0), (0, 1.75)] if directional else [(0, 0)]
    indices = (1.59, 2.417) if directional else (1.79,)
    maps = np.zeros((len(indices), len(keys), SIDE, SIDE, 2), np.float32)
    for own, center, tri, planes in gems:
        vec = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        lengths = np.linalg.norm(vec, axis=1)
        keep = lengths > 1e-9
        if not np.all(keep):
            tri = tri[keep]
            vec = vec[keep]
            lengths = lengths[keep]
        normals = vec / lengths[:, None]
        area = lengths.sum() / 2
        cdf = np.cumsum(lengths) / lengths.sum()
        cdf[-1] = 1.0
        shots = max(65000, round(area * 68000))
        for row, ior in enumerate(indices):
            for idx, (key_x, key_z) in enumerate(keys):
                spread = 0.18 if directional else 1.0
                values = photons(
                    own,
                    tri,
                    normals,
                    cdf,
                    planes,
                    area,
                    floor_y,
                    shots,
                    *tree,
                    key_x,
                    key_z,
                    spread,
                    ior,
                )
                maps[row, idx, :, :, 0 if center else 1] += values.sum(axis=0)
    if directional:
        atlas = np.zeros((4 * SIDE, 2 * SIDE, 3), np.uint8)
        for row, family in enumerate(maps):
            for idx, flux in enumerate(family):
                flux = gaussian_filter(flux, sigma=(1.0, 1.0, 0))
                # Log encoding preserves both faint branches and sharp bright peaks.
                encoded = (
                    (255 * np.clip(np.log1p(flux * 32) / np.log(513), 0, 1))
                    .round()
                    .astype(np.uint8)
                )
                y, x = (2 * row + idx // 2) * SIDE, (idx % 2) * SIDE
                atlas[y : y + SIDE, x : x + SIDE, :2] = encoded
        output = ROOT / "floors" / f"{path.stem}-key.png"
        Image.fromarray(atlas).save(output, optimize=True)
        print(path.stem, "key", round(time.monotonic() - start, 1), "s", flush=True)
        return
    caustics = maps[0, 0]
    # A narrow reconstruction kernel suppresses photon shot noise before the
    # square-root encoding. The material and illumination remain fixed-size bakes.
    for channel in range(2):
        caustics[:, :, channel] = gaussian_filter(caustics[:, :, channel], 1.45)
    # Feather the edge of the finite floor footprint to clear light.
    e = np.clip(
        np.minimum(np.arange(SIDE) + 0.5, SIDE - np.arange(SIDE) - 0.5) / 14, 0, 1
    )
    edge = np.minimum(e[:, None], e[None, :])
    channels = np.dstack((shadow * edge, np.sqrt(caustics * edge[:, :, None] / 2)))
    encoded = np.uint8(np.rint(255 * np.clip(channels, 0, 1)))
    encoded[[0, -1], :, :] = 0
    encoded[:, [0, -1], :] = 0
    out = ROOT / "floors" / f"{path.stem}.png"
    out.parent.mkdir(exist_ok=True)
    Image.fromarray(encoded).save(out, optimize=True)
    print(
        path.stem,
        "seconds",
        round(time.monotonic() - start, 2),
        "bytes",
        out.stat().st_size,
        "floorY",
        round(floor_y, 5),
        "ranges",
        encoded.max(axis=(0, 1)).tolist(),
        "flux mm²",
        (caustics.sum(axis=(0, 1)) * TEXEL**2).round(3).tolist(),
        flush=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "rings", nargs="*", help="setting-cut GLB stems; default all rings"
    )
    parser.add_argument(
        "--directional",
        action="store_true",
        help="Bake the four-position key-light atlas",
    )
    args = parser.parse_args()
    paths = [ROOT / "rings" / f"{name}.glb" for name in args.rings] or sorted(
        (ROOT / "rings").glob("*.glb")
    )
    for path in paths:
        bake(path, args.directional)
