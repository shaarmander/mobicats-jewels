"""Export Gemmo's fitted ring CAD as self-contained, indexed glTF binaries.

Usage: python tools/build_jewelry_assets.py PATH_TO_GEMMO_STUDIO
Requires Rust, Blender 5 (BLENDER_BIN or PATH), numpy, scipy and fast-simplification.
"""

import argparse
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import os

from scipy.spatial import cKDTree
import fast_simplification
import numpy as np

from lying_poses import build_poses
from cut_icons import build_icons

DEST = Path(__file__).resolve().parents[1] / "public" / "assets"


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


def welded_geometry(source):
    with np.load(source) as casting:
        positions, faces, normals = (
            casting[k] for k in ("positions", "faces", "normals")
        )
    vertices, indices = fast_simplification.simplify(
        positions.astype(np.float64), faces, target_count=min(len(faces), 64000), agg=4
    )
    # Preserve normals from the high-resolution continuous casting after decimation.
    distance, neighbours = cKDTree(positions).query(vertices, k=4)
    weights = 1 / np.maximum(distance, 0.001) ** 2
    blended = (normals[neighbours] * weights[:, :, None]).sum(axis=1)
    blended /= np.maximum(np.linalg.norm(blended, axis=1, keepdims=True), 1e-12)
    return vertices, blended, indices


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


def finish(raw):
    build_icons(raw, DEST / "cuts")
    rings = DEST / "rings"
    rings.mkdir(parents=True, exist_ok=True)
    library = json.loads((raw / "library.json").read_bytes())
    (DEST / "library.json").write_bytes(binary_json(compact(library)))
    if not all(
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
            pack(raw / (stem + ".json"), rings / (stem + ".glb"))
    build_poses()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("studio", type=Path)
    parser.add_argument("--raw", type=Path, help="Reuse the Rust export directory")
    args = parser.parse_args()
    if args.raw:
        finish(args.raw)
    else:
        with tempfile.TemporaryDirectory(prefix="mobicat-jewelry-") as tmp:
            finish(export(args.studio.resolve(), Path(tmp)))
