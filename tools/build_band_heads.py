"""Bake detachable, polished setting heads and bind them to the original fitted metal.
Run with the same native raw exports and installed Blender used by build_jewelry_assets.py:
python tools/build_band_heads.py RAW_DIRECTORY SCRATCH_DIRECTORY
"""

from pathlib import Path
import argparse, concurrent.futures, ctypes, gzip, json, os, struct, subprocess, sys

ROOT = Path(__file__).resolve().parents[1]


def pack(source, casting, output):
    import numpy as np
    import meshoptimizer
    from scipy.spatial import cKDTree

    with np.load(casting) as data:
        p, n, f = (data[k] for k in ("positions", "normals", "faces"))
    indices = np.ascontiguousarray(f.ravel(), dtype=np.uint32)
    reduced = np.empty_like(indices)
    used = meshoptimizer.simplify_with_attributes(
        reduced,
        indices,
        p,
        n,
        np.full(3, 0.22, np.float32),
        target_index_count=min(len(indices), 18000 * 3),
        target_error=ctypes.c_float(1.0),
    )
    v, tri = np.unique(reduced[:used], return_inverse=True)
    assert len(v) < 65536
    blob = source.read_bytes()
    size = struct.unpack_from("<I", blob, 12)[0]
    doc = json.loads(blob[20 : 20 + size])
    acc = doc["accessors"][doc["meshes"][0]["primitives"][0]["attributes"]["POSITION"]]
    offset = doc["bufferViews"][acc["bufferView"]].get("byteOffset", 0)
    original = np.frombuffer(blob, "<f4", acc["count"] * 3, 28 + size + offset).reshape(
        -1, 3
    )
    distance, drivers = cKDTree(original).query(p[v], k=3)
    weights = 1 / np.maximum(distance, 0.012) ** 2
    weights /= weights.sum(axis=1)[:, None]
    # Packed interleaved rows with byte-aligned sections. Positions in micrometers.
    rows = np.column_stack(
        [
            np.rint(p[v] * 1000),
            np.rint(n[v] * 32767),
            drivers,
            np.rint(weights[:, :2] * 10000),
        ]
    ).astype("<i2")
    output.write_bytes(
        gzip.compress(
            struct.pack("<4sII", b"HED1", len(v), used)
            + rows.tobytes()
            + tri.astype("<u2").tobytes(),
            mtime=0,
        )
    )


if __name__ == "__main__":
    if "--" in sys.argv:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from weld_rings import weld

        raw, scratch, *keys = sys.argv[sys.argv.index("--") + 1 :]
        for k in keys:
            weld(
                Path(raw) / (k + ".json"), Path(scratch) / (k + ".npz"), head_only=True
            )
    else:
        import shutil

        ap = argparse.ArgumentParser(description=__doc__)
        ap.add_argument("raw", type=Path)
        ap.add_argument("scratch", type=Path)
        ap.add_argument("keys", nargs="*")
        args = ap.parse_args()
        assets = ROOT / "public/assets"
        dest = assets / "heads"
        dest.mkdir(exist_ok=True)
        args.scratch.mkdir(parents=True, exist_ok=True)
        blender = (
            os.environ.get("BLENDER_BIN")
            or shutil.which("blender")
            or r"C:\Program Files\Blender Foundation\Blender 5.0\blender.exe"
        )
        keys = args.keys or sorted(p.stem for p in (assets / "rings").glob("*.glb"))

        def batch(group):
            if not group:
                return
            subprocess.run(
                [
                    blender,
                    "-b",
                    "-t",
                    "3",
                    "--python-exit-code",
                    "1",
                    "--python",
                    str(Path(__file__).resolve()),
                    "--",
                    str(args.raw.resolve()),
                    str(args.scratch.resolve()),
                    *group,
                ],
                check=True,
            )
            for k in group:
                pack(
                    assets / "rings" / (k + ".glb"),
                    args.scratch / (k + ".npz"),
                    dest / (k + ".head"),
                )

        with concurrent.futures.ThreadPoolExecutor(4) as pool:
            list(pool.map(batch, (keys[i : i + 6] for i in range(0, len(keys), 6))))
