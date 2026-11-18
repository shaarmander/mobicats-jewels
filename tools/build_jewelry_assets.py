"""Export Gemmo's fitted ring CAD as self-contained, indexed glTF binaries.

Usage: python tools/build_jewelry_assets.py PATH_TO_GEMMO_STUDIO
Requires Rust, Blender 5 (BLENDER_BIN or PATH), numpy, scipy and meshoptimizer.
"""

import argparse
import ctypes
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import os

import meshoptimizer
import numpy as np
from scipy.spatial import cKDTree
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

from lying_poses import build_poses
from cut_icons import build_icons
from setting_profiles import write as write_profile_binding

DEST = Path(__file__).resolve().parents[1] / "public" / "assets"
METAL_TRIANGLE_LIMIT = 64_000


def compact(value):
    if isinstance(value, float):
        return round(value, 7)
    if isinstance(value, dict):
        return {k: compact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [compact(v) for v in value]
    return value


def binary_json(value):
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode()


def lock_pave_contours(positions, normals, lock):
    # A broad, almost planar cheek otherwise collapses into strips running
    # from its bore to its rolled edge. Retain a regular spread of master
    # vertices there so those two distinct highlights interpolate locally.
    cheek = np.flatnonzero(
        (np.abs(normals[:, 2]) > 0.75)
        & (np.abs(positions[:, 2]) > 0.55)
        & (positions[:, 1] < 8.0)
    )
    cells = np.floor(positions[cheek] / 0.28).astype(int)
    _, first = np.unique(cells, axis=0, return_index=True)
    lock[cheek[first]] = 1
    # Preserve the rounded turn from the comfort-fit bore onto the cheek.
    # Keep samples on successive radial contours so a triangle cannot
    # interpolate a bevel normal across the flat wall beside the stones.
    r = np.linalg.norm(positions[:, :2], axis=1)
    bore = np.min(r)
    rim = np.flatnonzero(
        (r > bore + 0.12)
        & (r < bore + 0.61)
        & (np.abs(normals[:, 2]) > 0.15)
        & (np.abs(positions[:, 2]) > 0.65)
        & (positions[:, 1] < 8.0)
    )
    a = np.arctan2(positions[rim, 0], positions[rim, 1])
    chart = np.column_stack(
        [
            np.floor(a * bore / 0.14),
            np.floor((r[rim] - bore) / 0.045),
            np.sign(positions[rim, 2]),
        ]
    )
    _, keep = np.unique(chart, axis=0, return_index=True)
    lock[rim[keep]] = 1
    # The channel has a second rolled edge alongside the pavé beads. Pin
    # closely spaced radial rows through this transition, including the
    # flat surface on its inside, to confine a narrow highlight to the lip.
    crown = np.flatnonzero(
        (r > bore + 0.60)
        & (np.abs(normals[:, 2]) > 0.18)
        & (np.abs(positions[:, 2]) > 0.72)
        & (positions[:, 1] < 8.0)
    )
    a = np.arctan2(positions[crown, 0], positions[crown, 1])
    chart = np.column_stack(
        [
            np.floor(a * bore / 0.18),
            np.floor((r[crown] - bore) / 0.075),
            np.floor(positions[crown, 2] / 0.16),
        ]
    )
    _, keep = np.unique(chart, axis=0, return_index=True)
    lock[crown[keep]] = 1


def retriangulate_collinear_faces(positions, triangles):
    # The voxel master has regular contour rows. Simplification can leave three
    # successive samples on one straight line. Split the adjacent triangle at
    # the middle sample so both faces have area on the same polished surface.
    points = positions[triangles]
    cross = np.cross(points[:, 1] - points[:, 0], points[:, 2] - points[:, 0])
    for index in np.flatnonzero(np.all(cross == 0, axis=1)):
        face = triangles[index]
        points = positions[face]
        longest = np.argmax(np.sum((points - np.roll(points, -1, axis=0)) ** 2, axis=1))
        a, b, middle = np.roll(face, -longest)
        neighbour, corner = np.where(
            (triangles == b) & (np.roll(triangles, -1, axis=1) == a)
        )
        if len(neighbour) != 1:
            raise ValueError("Collinear face has no unique neighbour")
        other = triangles[neighbour[0], (corner[0] + 2) % 3]
        if np.any(
            np.any(triangles == middle, axis=1) & np.any(triangles == other, axis=1)
        ):
            raise ValueError("Collinear face has no free diagonal")
        triangles[index] = [b, middle, other]
        triangles[neighbour[0]] = [middle, a, other]
    return triangles


def welded_geometry(source):
    with np.load(source) as casting:
        positions, faces, normals = (
            casting[k] for k in ("positions", "faces", "normals")
        )
    # Keep the welded master's vertex normals paired with their original
    # positions. Shiny surfaces reveal normal errors long before silhouettes do.
    source_indices = np.ascontiguousarray(faces.ravel(), dtype=np.uint32)
    reduced = np.empty_like(source_indices)
    lock = np.zeros(len(positions), dtype=np.uint8)
    if source.stem.startswith(("pave-", "cluster-")):
        lock_pave_contours(positions, normals, lock)
    tree = None
    for repair_radius in (0.24, 0.36, 0.5, 0.7, 1.0, 1.4, 2.0, 2.8):
        used = meshoptimizer.simplify_with_attributes(
            reduced,
            source_indices,
            positions,
            normals,
            np.full(3, 0.22, dtype=np.float32),
            vertex_lock=lock,
            target_index_count=min(len(source_indices), METAL_TRIANGLE_LIMIT * 3),
            target_error=ctypes.c_float(1.0),
        )
        triangles = reduced[:used].reshape(-1, 3)
        # A collapsed pocket can leave coincident, oppositely wound triangles.
        # Cancel the zero-thickness pair before indexing or computing fit weights.
        ordered = np.sort(triangles, axis=1)
        _, groups, counts = np.unique(
            ordered, axis=0, return_inverse=True, return_counts=True
        )
        repeated = counts[groups] > 1
        bad = np.empty(0, dtype=np.uint32)
        if np.any(repeated):
            a, b, c = triangles[repeated].T
            winding = np.where((a < b) ^ (b < c) ^ (c < a), 1, -1)
            balance = np.bincount(
                groups[repeated], weights=winding, minlength=len(counts)
            )
            if np.any(counts[groups[repeated]] != 2) or np.any(balance):
                bad = np.unique(triangles[repeated])
            triangles = triangles[~repeated]
        # A narrow opening can also collapse to one edge shared by four
        # triangles. Retain the uncollapsed master around those edges and rerun
        # the reduction. Other areas can still use the normal triangle budget.
        edges = np.sort(triangles[:, [[0, 1], [1, 2], [2, 0]]].reshape(-1, 2), axis=1)
        base = len(positions)
        keys = edges[:, 0].astype(np.uint64) * base + edges[:, 1]
        unique, incidence = np.unique(keys, return_counts=True)
        pinched = unique[incidence != 2]
        if not len(pinched) and not len(bad):
            break
        bad = np.unique(
            np.r_[
                bad,
                (pinched // base).astype(np.uint32),
                (pinched % base).astype(np.uint32),
            ]
        )
        if tree is None:
            tree = cKDTree(positions)
        for neighbours in tree.query_ball_point(positions[bad], repair_radius):
            lock[neighbours] = 1
    else:
        raise ValueError(f"Unable to preserve the welded topology of {source.stem}")
    if len(triangles) > METAL_TRIANGLE_LIMIT:
        raise ValueError(f"Metal triangle budget exceeded for {source.stem}")
    triangles = retriangulate_collinear_faces(positions, triangles)
    vertices, indices = np.unique(triangles, return_inverse=True)
    faces = indices.reshape(-1, 3)
    graph = coo_matrix(
        (
            np.ones(faces.size, dtype=np.uint8),
            (faces.ravel(), faces[:, [1, 2, 0]].ravel()),
        ),
        shape=(len(vertices), len(vertices)),
    )
    count, labels = connected_components(graph, directed=False)
    if count > 1:
        # Polishing can collapse a detached voxel into a microscopic closed
        # speck. Discard sub-voxel debris, and report any detached setting part.
        main = np.bincount(labels).argmax()
        for part in range(count):
            if (
                part != main
                and np.ptp(positions[vertices[labels == part]], axis=0).max() >= 0.043
            ):
                raise ValueError(f"Detached metal component in {source.stem}")
        kept = triangles[labels[faces[:, 0]] == main]
        vertices, indices = np.unique(kept, return_inverse=True)
        faces = indices.reshape(-1, 3)
    return positions[vertices], normals[vertices], faces


class GLB:
    def __init__(self):
        self.blob = bytearray()
        self.doc = {
            "asset": {"version": "2.0", "generator": "Gemmo native ring CAD export"},
            "scene": 0,
            "scenes": [{"nodes": []}],
            "nodes": [],
            "meshes": [],
            "materials": [
                {
                    "name": "Polished alloy",
                    "pbrMetallicRoughness": {
                        "baseColorFactor": [0.73, 0.70, 0.67, 1],
                        "metallicFactor": 1,
                        "roughnessFactor": 0.13,
                    },
                },
                {
                    "name": "Faceted stone",
                    "pbrMetallicRoughness": {
                        "baseColorFactor": [0.78, 0.85, 0.88, 1],
                        "metallicFactor": 0.3,
                        "roughnessFactor": 0.03,
                    },
                },
            ],
            "bufferViews": [],
            "accessors": [],
        }

    def attribute(self, arr, dtype, layout, gl_type, target, bounds=False):
        arr = np.ascontiguousarray(arr, dtype=dtype)
        self.blob.extend(bytes(-len(self.blob) % 4))
        view = {
            "buffer": 0,
            "byteOffset": len(self.blob),
            "byteLength": arr.nbytes,
            "target": target,
        }
        self.blob.extend(arr.tobytes())
        index = len(self.doc["bufferViews"])
        self.doc["bufferViews"].append(view)
        accessor = {
            "bufferView": index,
            "componentType": gl_type,
            "count": len(arr),
            "type": layout,
        }
        if bounds:
            accessor.update(min=arr.min(axis=0).tolist(), max=arr.max(axis=0).tolist())
        self.doc["accessors"].append(accessor)
        return len(self.doc["accessors"]) - 1

    def mesh(self, name, positions, normals, faces, material, extras):
        assert np.isfinite(positions).all() and np.isfinite(normals).all()
        assert np.max(np.abs(np.linalg.norm(normals, axis=1) - 1)) < 1e-4
        assert faces.min() >= 0 and faces.max() < len(positions) <= 65535
        pos = self.attribute(positions, "<f4", "VEC3", 5126, 34962, bounds=True)
        nrm = self.attribute(normals, "<f4", "VEC3", 5126, 34962)
        idx = self.attribute(faces.ravel(), "<u2", "SCALAR", 5123, 34963)
        self.doc["meshes"].append(
            {
                "name": name,
                "extras": extras,
                "primitives": [
                    {
                        "attributes": {"POSITION": pos, "NORMAL": nrm},
                        "indices": idx,
                        "material": material,
                    }
                ],
            }
        )
        return len(self.doc["meshes"]) - 1

    def node(self, name, mesh, extras, **transform):
        self.doc["scenes"][0]["nodes"].append(len(self.doc["nodes"]))
        self.doc["nodes"].append(dict(name=name, mesh=mesh, extras=extras, **transform))

    def save(self, path):
        self.blob.extend(bytes(-len(self.blob) % 4))
        self.doc["buffers"] = [{"byteLength": len(self.blob)}]
        meta = binary_json(self.doc)
        meta += b" " * (-len(meta) % 4)
        size = 28 + len(meta) + len(self.blob)
        path.write_bytes(
            struct.pack("<4sII", b"glTF", 2, size)
            + struct.pack("<I4s", len(meta), b"JSON")
            + meta
            + struct.pack("<I4s", len(self.blob), b"BIN\x00")
            + self.blob
        )


def pack(source, output):
    data = json.loads(source.read_bytes())
    g = GLB()
    g.doc["scenes"][0]["extras"] = compact(
        {k: data[k] for k in ["bounds", "bandDiameter", "carats"]}
    )
    pos, normal, indices = welded_geometry(
        source.parent / "castings" / (source.stem + ".npz")
    )
    metal = g.mesh("band", pos, normal, indices, 0, {"role": "band"})
    g.node("band", metal, {"role": "band"})
    counts = {"center": 0, "side": 0, "pave": 0}
    gem_meshes = {}
    for stone in data["stones"]:
        role = stone["role"]
        name = "center" if role == "center" else f"{role}-{counts[role]}"
        counts[role] += 1
        key = (role, binary_json(stone["facets"]))
        if key not in gem_meshes:
            positions, normals, faces, planes = [], [], [], []
            for f in stone["facets"]:
                v, n = np.array(f["vertices"]), np.array(f["normal"])
                # The native cutter stores float32 vertices; long marquise facets vary by up to 1.3e-5 units.
                assert np.max(np.abs(v @ n - v[0] @ n)) < 2e-5
                planes.append([*n, float(v[0] @ n)])
                start = len(positions)
                # A facet is a closed planar convex polygon.
                for j in range(1, len(v) - 1):
                    tri = [start, start + j, start + j + 1]
                    if np.dot(np.cross(v[j] - v[0], v[j + 1] - v[0]), n) < 0:
                        tri[1], tri[2] = tri[2], tri[1]
                    faces.append(tri)
                positions.extend(v)
                normals.extend([n] * len(v))
            planes = compact(planes)
            extras = {"role": role, "cut": stone["cut"], "planes": planes}
            index = g.mesh(
                name,
                np.asarray(positions),
                np.asarray(normals),
                np.asarray(faces),
                1,
                extras,
            )
            gem_meshes[key] = index, extras
        index, extras = gem_meshes[key]
        g.node(
            name,
            index,
            dict(extras, mmPerUnit=stone["scale"], diamondCarats=stone["carats"]),
            translation=stone["translation"],
            rotation=stone["rotation"],
            scale=[stone["scale"]] * 3,
        )
    assert counts["center"] == 1
    g.save(output)
    print(f"{output.name}: {counts}, {output.stat().st_size:,} bytes", flush=True)


def export(studio, scratch):
    src = scratch / "src"
    src.mkdir(exist_ok=True)
    shutil.copyfile(Path(__file__).with_name("export_jewelry.rs"), src / "main.rs")
    crate = str((studio / "crates/gemmo_core").resolve()).replace("\\", "/")
    (scratch / "Cargo.toml").write_text(
        '[package]\nname="export_jewelry"\nedition="2024"\nversion="0.1.0"\n'
        f'[dependencies]\ngemmo_core={{path={json.dumps(crate)}}}\nserde_json="1"\n'
    )
    raw = scratch / "raw"
    subprocess.run(
        [
            "cargo",
            "run",
            "--release",
            "--manifest-path",
            str(scratch / "Cargo.toml"),
            "--",
            str(raw),
        ],
        cwd=studio,
        check=True,
    )
    return raw


def finish(raw, recast=False):
    build_icons(raw, DEST / "cuts")
    rings = DEST / "rings"
    rings.mkdir(parents=True, exist_ok=True)
    library = json.loads((raw / "library.json").read_bytes())
    (DEST / "library.json").write_bytes(binary_json(compact(library)))
    if recast or not all(
        (raw / "castings" / (s["id"] + "-" + c["id"] + ".npz")).exists()
        for s in library["settings"]
        for c in library["cuts"]
    ):
        blender = (
            os.environ.get("BLENDER_BIN")
            or shutil.which("blender")
            or r"C:\Program Files\Blender Foundation\Blender 5.0\blender.exe"
        )
        subprocess.run(
            [
                blender,
                "-b",
                "--python-exit-code",
                "1",
                "--python",
                str(Path(__file__).with_name("weld_rings.py")),
                "--",
                str(raw),
            ],
            check=True,
        )
    for setting in library["settings"]:
        for cut in library["cuts"]:
            stem = f"{setting['id']}-{cut['id']}"
            source = raw / (stem + ".json")
            glb = rings / (stem + ".glb")
            pack(source, glb)
            write_profile_binding(source, glb, DEST / "fit" / (stem + ".fit"))
    build_poses()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("studio", type=Path)
    parser.add_argument("--raw", type=Path, help="Reuse the Rust export directory")
    parser.add_argument(
        "--recast",
        action="store_true",
        help="Rebuild welded castings after editing the basket or shank",
    )
    args = parser.parse_args()
    if args.raw:
        finish(args.raw, recast=args.recast)
    else:
        with tempfile.TemporaryDirectory(prefix="mobicat-jewelry-") as tmp:
            finish(export(args.studio.resolve(), Path(tmp)))
