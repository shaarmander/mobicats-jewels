"""Blender background bake of the joined, polished CAD surface. Units are mm."""

import sys, json, math
from pathlib import Path
import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from basket import basket, shells


def shoulder_rail(angles, radius, height, section):
    points = np.stack(
        (radius * np.sin(angles), radius * np.cos(angles), height), axis=1
    )
    tangent = np.gradient(points, axis=0)
    tangent /= np.linalg.norm(tangent, axis=1)[:, None]
    radial = np.stack((np.sin(angles), np.cos(angles), angles * 0), axis=1)
    across = np.cross(tangent, radial)
    across /= np.linalg.norm(across, axis=1)[:, None]
    up = np.cross(across, tangent)
    phi = np.arange(20) * math.tau / 20
    vertices = points[:, None, :] + section * (
        np.cos(phi)[None, :, None] * up[:, None, :]
        + np.sin(phi)[None, :, None] * across[:, None, :]
    )
    faces = []
    for i in range(len(angles) - 1):
        for j in range(20):
            a = i * 20 + j
            b = i * 20 + (j + 1) % 20
            faces.extend([(a, b, b + 20), (a, b + 20, a + 20)])
    faces.extend([(0, j + 1, j) for j in range(1, 19)])
    last = (len(angles) - 1) * 20
    faces.extend([(last, last + j, last + j + 1) for j in range(1, 19)])
    return vertices.reshape(-1, 3).tolist(), faces


def solder_pin(start, end, radius):
    axis = end - start
    axis /= np.linalg.norm(axis)
    u = np.cross(axis, [0, 0, 1])
    u /= np.linalg.norm(u)
    v = np.cross(axis, u)
    a = np.arange(32) * math.tau / 32
    loop = radius * (np.cos(a)[:, None] * u + np.sin(a)[:, None] * v)
    verts = np.concatenate((start + loop, end + loop, [start, end]))
    faces = []
    for i in range(32):
        j = (i + 1) % 32
        faces.extend(
            [(i, j, 32 + j), (i, 32 + j, 32 + i), (64, j, i), (65, 32 + i, 32 + j)]
        )
    return verts.tolist(), faces


def round_beads(part):
    """Reconstruct polished pave beads from their diametrically opposite poles."""
    phi = math.tau * np.arange(40) / 40
    lat = np.pi * np.arange(1, 24) / 24
    unit = np.stack(
        np.broadcast_arrays(
            np.sin(lat[:, None]) * np.cos(phi),
            np.cos(lat[:, None]),
            np.sin(lat[:, None]) * np.sin(phi),
        ),
        axis=-1,
    )
    rows, cols = unit.shape[:2]
    i, j = np.meshgrid(np.arange(rows - 1), np.arange(cols), indexing="ij")
    a = i * cols + j
    b = i * cols + (j + 1) % cols
    index = np.arange(cols)
    last = (rows - 1) * cols
    top = rows * cols
    faces = np.concatenate(
        [
            np.stack((a, a + cols, b + cols), -1).reshape(-1, 3),
            np.stack((a, b + cols, b), -1).reshape(-1, 3),
            np.stack((0 * index + top, index, (index + 1) % cols), 1),
            np.stack((0 * index + top + 1, last + (index + 1) % cols, last + index), 1),
        ]
    )
    for group in shells(part):
        poles = group[-2:]
        if poles[0, 1] < poles[1, 1]:
            poles = poles[::-1]
        center = poles.mean(axis=0)
        radius = np.linalg.norm(poles[0] - center)
        verts = np.concatenate([(center + radius * unit).reshape(-1, 3), poles])
        volume = np.einsum(
            "ij,ij->",
            verts[faces[:, 0]],
            np.cross(verts[faces[:, 1]], verts[faces[:, 2]]),
        )
        yield verts.tolist(), (faces if volume > 0 else faces[:, ::-1]).tolist()


SCULPTED = {
    "cable",
    "ribbon",
    "wishbone",
    "bypass",
    "interlace",
    "double",
    "marquise",
    "fluted",
}


def band_sweep(a, r, z, radial_width, axial_width, twist=0):
    """Sweep a rounded elliptical section along a ring, in millimetres."""
    angles = np.arange(32) * math.tau / 32
    du = np.asarray(radial_width)[..., None] * np.cos(angles)
    dv = np.asarray(axial_width)[..., None] * np.sin(angles)
    roll = np.asarray(twist)[..., None]
    rr = np.asarray(r)[..., None] + du * np.cos(roll) - dv * np.sin(roll)
    zz = np.asarray(z)[..., None] + du * np.sin(roll) + dv * np.cos(roll)
    x, y, z = np.broadcast_arrays(np.sin(a[:, None]) * rr, np.cos(a[:, None]) * rr, zz)
    v = np.stack([x, y, z], axis=-1).reshape(-1, 3)
    i, j = np.meshgrid(np.arange(len(a) - 1), np.arange(32), indexing="ij")
    p = i * 32 + j
    q = i * 32 + (j + 1) % 32
    faces = np.concatenate(
        (
            np.stack((p, q, q + 32), -1).reshape(-1, 3),
            np.stack((p, q + 32, p + 32), -1).reshape(-1, 3),
        )
    )
    cap = [(0, j + 1, j) for j in range(1, 31)]
    end = len(v) - 32
    cap.extend((end, end + j, end + j + 1) for j in range(1, 31))
    faces = np.concatenate((faces, cap))
    if (
        np.einsum("ij,ij->", v[faces[:, 0]], np.cross(v[faces[:, 1]], v[faces[:, 2]]))
        < 0
    ):
        faces = faces[:, ::-1]
    return v.tolist(), faces.tolist()


def sculpted_band(style):
    a = np.linspace(-math.pi, math.pi, 361)
    # A short saddle under the head carries the claw feet into both shoulders.
    neck = np.linspace(-0.86, 0.86, 100)
    taper = np.clip((0.86 - np.abs(neck)) / 0.28, 0.08, 1.0)
    yield band_sweep(neck, 9.31, 0, 1.05 * taper, 1.21 * taper)
    if style == "cable":
        for sign in [-1, 1]:
            yield band_sweep(
                a,
                9.38 + sign * 0.44 * np.cos(12 * a),
                sign * 0.53 * np.sin(12 * a),
                0.67,
                0.67,
            )
    elif style == "ribbon":
        yield band_sweep(a, 9.55, 0, 0.74, 1.56, 1.01 * np.sin(3 * a))
    elif style == "wishbone":
        # A chevron in the plane across the finger, with a rounded apex.
        yield band_sweep(
            a,
            9.36,
            1.9 * np.exp(-((a / 0.39) ** 2)) - 0.97 * np.exp(-((a / 0.99) ** 2)),
            0.77,
            1.08,
        )
    elif style == "bypass":
        t = np.linspace(0.17, math.tau - 0.17, 340)
        z = (
            1.55
            * np.sin(t * 0.5 + math.pi * 0.5)
            * np.exp(-((np.minimum(t, math.tau - t) / 0.91) ** 2))
        )
        yield band_sweep(
            t,
            9.33 + 1.5 * np.exp(-((np.minimum(t, math.tau - t) / 0.52) ** 2)),
            z,
            0.84,
            1.03,
        )
    elif style == "interlace":
        for sign in [-1, 1]:
            yield band_sweep(
                a,
                9.46 + sign * 0.30 * np.sin(3 * a),
                sign * 0.98 * np.cos(3 * a),
                0.69,
                0.71,
            )
    elif style == "double":
        for sign in [-1, 1]:
            yield band_sweep(a, 9.31, sign * 1.02, 0.83, 0.66)
        for angle in [-2.32, 2.32, 0]:
            radial = np.array([math.sin(angle), math.cos(angle), 0]) * 9.31
            yield solder_pin(radial + [0, 0, -1.04], radial + [0.035, 0, 1.04], 0.57)
    elif style == "marquise":
        for sign in [-1, 1]:
            yield band_sweep(
                a, 9.31, sign * (0.28 + 1.14 * np.sin(3 * a) ** 2), 0.70, 0.55
            )
    elif style == "fluted":
        for rib in range(-2, 3):
            yield band_sweep(
                a, 9.39 - 0.1 * abs(rib), rib * 0.73, 0.93 - 0.065 * abs(rib), 0.61
            )


def metal_parts(data, setting):
    parts = []
    for p in data["parts"]:
        if p["name"].startswith("head"):
            center = p["name"] == "head-centre"
            stone = next(
                stone
                for stone in data["stones"]
                if (center and stone["role"] == "center")
                or (
                    not center
                    and stone["role"] == "side"
                    and (stone["translation"][0] > 0) == p["name"].endswith("right")
                )
            )
            parts.extend(basket(p, stone, setting))
        elif p["name"] == "pave-beads":
            parts.extend(round_beads(p))
        elif setting not in SCULPTED | {"split"} or p["name"] != "shank":
            parts.append((p["vertices"], p["triangles"]))
    center = data["stones"][0]
    if setting in SCULPTED:
        parts.extend(sculpted_band(setting))
    if setting == "petal":
        # Four open lobes spring from the shank and meet the basket just below the girdle.
        for sx in [-1, 1]:
            for sz in [-1, 1]:
                t = np.linspace(0, 1, 85)
                a = sx * (0.75 * (1 - t) + 0.13 * t)
                r = (
                    9.32
                    + (center["translation"][1] - 9.95) * np.sin(t * math.pi / 2) ** 1.3
                )
                z = sz * (0.42 + 1.58 * np.sin(math.pi * t))
                parts.append(shoulder_rail(a, r, z, 0.40))
    if setting == "split":
        a = np.linspace(-math.pi, math.pi, 220)
        fork = np.exp(-((np.abs(a) / 0.85) ** 3))
        for sign in [-1, 1]:
            parts.append(
                shoulder_rail(a, 9.05 + 0.6 * fork, sign * (0.17 + 1.25 * fork), 0.83)
            )
    if setting == "cathedral":
        for sign in [-1, 1]:
            a = np.linspace(sign * 1.23, sign * 0.13, 64)
            t = np.linspace(0, 1, len(a))
            r = 9.05 + (center["translation"][1] - 9.65) * t**1.55
            parts.append(shoulder_rail(a, r, a * 0, 0.74))
    return parts


def weld(source, destination):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    data = json.loads(source.read_bytes())
    vertices, faces = [], []
    for v, f in metal_parts(data, source.stem.split("-")[0]):
        off = len(vertices)
        vertices.extend(v)
        faces.extend((i + off, j + off, k + off) for i, j, k in f)
    mesh = bpy.data.meshes.new("Casting")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("Casting", mesh)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    # OpenVDB joins penetrating CAD shells, including the basket-to-shoulder junction.
    # Small fillets remove cusps where prongs and gallery rails meet.
    mesh.remesh_voxel_size = 0.043
    mesh.use_remesh_preserve_volume = False
    bpy.ops.object.voxel_remesh()
    smooth = obj.modifiers.new("Polish welded joints", "SMOOTH")
    smooth.factor = 0.85
    smooth.iterations = 12
    bpy.ops.object.modifier_apply(modifier=smooth.name)
    mesh = obj.data
    mesh.calc_loop_triangles()
    pos = np.empty(len(mesh.vertices) * 3, np.float32)
    normals = np.empty_like(pos)
    faces = np.empty(len(mesh.loop_triangles) * 3, np.int32)
    mesh.vertices.foreach_get("co", pos)
    mesh.vertices.foreach_get("normal", normals)
    mesh.loop_triangles.foreach_get("vertices", faces)
    np.savez(
        destination,
        positions=pos.reshape(-1, 3),
        normals=normals.reshape(-1, 3),
        faces=faces.reshape(-1, 3),
    )
    print("Welded", source.stem, flush=True)


if __name__ == "__main__":
    raw = Path(sys.argv[sys.argv.index("--") + 1])
    target = raw / "castings"
    target.mkdir(exist_ok=True)
    for source in sorted(
        raw.glob("*.json"), key=lambda p: (p.stem != "trilogy-emerald", p.stem)
    ):
        selected = sys.argv[sys.argv.index("--") + 2 :]
        if source.stem != "library" and (not selected or source.stem in selected):
            weld(source, target / (source.stem + ".npz"))
