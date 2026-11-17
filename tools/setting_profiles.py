"""Bind the welded casting to its native claw and gallery sections, in millimetres.

One signed 16-bit displacement per axis/vertex for size and each profile.
Only the selected design is fetched. Sections move with the stone, while their
transverse dimensions are set independently in absolute millimetres.
"""

import gzip
import json
import struct
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree
from basket import basket
from section_constraints import reinforce

# Band width and radial depth, center claw stock and free gallery diameter.
PROFILES = np.array(
    [[1.8, 1.7, 0.95, 0.75], [2, 1.8, 1.10, 0.90], [2.4, 2, 1.30, 1.10]]
)


def smooth(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def bind(data, setting, v, faces):
    curves = []
    center = next(s for s in data["stones"] if s["role"] == "center")
    c = np.asarray(center["translation"])
    foot = min(c[1] - 1.5, 9.5)
    radii = np.linalg.norm(v[:, :2], axis=1)
    direction = v[:, :2] / radii[:, None]
    palm = v[v[:, 1] < -0.985 * radii]
    inner = np.min(np.linalg.norm(palm[:, :2], axis=1))
    palm_depth = np.ptp(np.linalg.norm(palm[:, :2], axis=1))
    palm_width = np.ptp(palm[:, 2])
    # Preserve intentional broad styles and their bore. Fine may narrow the
    # band, but cannot reduce the measured palm section below the Fine target.
    profiles = []
    for w, h, _, _ in PROFILES:
        radial = np.maximum(0, radii - inner) * (
            max(h, palm_depth + h - 1.7) / palm_depth - 1
        )
        axial = v[:, 2] * (max(w, palm_width + w - 2) / palm_width - 1)
        # A slim palm may taper, but keep the full native supporting shoulder
        # on every split arm. Profile broadening remains available there.
        if w < 2:
            axial *= 1 - smooth((v[:, 1] + 3) / 4)
        profiles.append(np.column_stack([direction * radial[:, None], axial]))
    offsets = np.stack(profiles, axis=1)
    # Hold the bridge and shoulders at full section while their claw feet stay
    # embedded. Extend the head upward only from that joint.
    motion = np.zeros_like(v)
    base_weight = np.ones(len(v))
    total = np.ones(len(v))
    accum = np.zeros((len(v), 4, 3))
    shifts = []
    for stone in data["stones"]:
        o = np.array(stone["translation"])
        if stone is center:
            shift = o - [0, foot, 0]
        else:
            w = smooth((o[1] - (foot - 1.5)) / max(0.1, c[1] - 0.65 - (foot - 1.5)))
            half = np.max(
                np.abs(
                    np.concatenate([f["vertices"] for f in center["facets"]])
                    * center["scale"]
                ),
                axis=0,
            )
            dx = o - c
            for i in [0, 2]:
                extra = max(0, abs(dx[i]) - half[i] - 0.55)
                if extra:
                    dx[i] = np.sign(dx[i]) * (
                        half[i] + 0.55 + extra / (1 + extra / 0.35)
                    )
            dx[1] = o[1] - foot
            shift = w * dx
        shifts.append(shift)
    # Accent seats and small pave beads travel with their own stones.
    for stone, shift in zip(data["stones"], shifts):
        if stone is center:
            continue
        o = np.array(stone["translation"])
        radius = (
            np.max(
                np.linalg.norm(
                    np.concatenate([f["vertices"] for f in stone["facets"]]), axis=1
                )
            )
            * stone["scale"]
        )
        w = smooth(
            (radius + 0.8 - np.linalg.norm(v - o, axis=1)) / (0.8 + 0.2 * radius)
        )
        motion += (shift - motion) * w[:, None]
        offsets *= 1 - w[:, None, None]
    for part in data["parts"]:
        if not part["name"].startswith("head"):
            continue
        is_center = part["name"] == "head-centre"
        idx = next(
            i
            for i, s in enumerate(data["stones"])
            if (is_center and s is center)
            or (
                not is_center
                and s["role"] == "side"
                and (s["translation"][0] > 0) == part["name"].endswith("right")
            )
        )
        stone = data["stones"][idx]
        o = np.array(stone["translation"])
        low = np.array(stone["rotation"][:3])
        # Transform the stone axis into ring coordinates.
        up = np.array([0.0, 1.0, 0.0])
        up += 2 * np.cross(low, np.cross(low, up) + stone["rotation"][3] * up)

        def record(kind, path, width, depth):
            curves.append((kind, path, width, depth, is_center))
            gallery = kind == "gallery"
            line = np.vstack([path, path[0]]) if gallery else path
            a = line[:-1]
            seg = np.diff(line, axis=0)
            tree = cKDTree((line[1:] + a) / 2)
            _, k = tree.query(v, k=1)
            u = np.clip(
                np.einsum("ij,ij->i", v - a[k], seg[k])
                / np.maximum((seg[k] ** 2).sum(axis=1), 1e-10),
                0,
                1,
            )
            spine = a[k] + seg[k] * u[:, None]
            off = v - spine
            radius = np.maximum(width[k], depth[k])
            distance = np.linalg.norm(off, axis=1)
            weight = smooth((radius + 0.26 - distance) / 0.16)
            # The medial curve locates a section even in the blended intersections.
            mask = weight > 0.00001
            if not mask.any():
                return
            local = spine - o
            height = local @ up
            outward = local - height[:, None] * up
            outward /= np.maximum(np.linalg.norm(outward, axis=1)[:, None], 0.001)
            # Anchor the stone-facing edge of each wire. Added stock goes around
            # and outside the seat; a change of carat translates this section.
            inner_delta = off + outward * depth[k, None]
            root = smooth((spine[:, 1] - 9.30) / 1.45) if is_center else np.ones(len(v))
            anchor = spine - outward * depth[k, None]
            move = (
                (anchor - np.array([0, foot, 0])) * root[:, None]
                if is_center
                else np.broadcast_to(shifts[idx], v.shape)
            )
            native = (
                2 * min(width.min(), depth.min())
                if gallery
                else 2 * np.min(np.minimum(width, depth)[10:42])
            )
            strength = (
                np.ones(len(v)) if gallery else 0.48 + 0.52 * smooth((k + u) / 12)
            )
            field = [move]
            for _, __, claw, rail in PROFILES:
                target = rail if gallery else claw
                if not is_center:
                    target *= 0.73
                # The small allowance absorbs the polished voxel fillet loss.
                grow = max(0, (target + 0.055) / native - 1)
                field.append(inner_delta * (strength * grow)[:, None])
            base_weight[:] = np.minimum(base_weight, 1 - weight)
            total[:] += weight
            accum[:] += np.stack(field, axis=1) * weight[:, None, None]

        # Consume each generator once; record receives its original section curves.
        for _ in basket(part, stone, setting, record):
            pass
    base = np.concatenate([motion[:, None], offsets], axis=1)
    fields = (accum + base * base_weight[:, None, None]) / (total - 1 + base_weight)[
        :, None, None
    ]
    return (
        reinforce(v, faces, fields, curves, PROFILES, data["stones"], shifts, foot),
        shifts,
    )


def write(raw, glb, dest):
    raw_data = json.loads(raw.read_bytes())
    data = glb.read_bytes()
    length = struct.unpack_from("<I", data, 12)[0]
    doc = json.loads(data[20 : 20 + length])
    band = next(n for n in doc["nodes"] if n["name"] == "band")
    prim = doc["meshes"][band["mesh"]]["primitives"][0]
    acc = doc["accessors"][prim["attributes"]["POSITION"]]
    view = doc["bufferViews"][acc["bufferView"]]
    v = (
        np.frombuffer(
            data,
            "<f4",
            acc["count"] * 3,
            28 + length + view.get("byteOffset", 0) + acc.get("byteOffset", 0),
        )
        .reshape(-1, 3)
        .astype(float)
    )
    idx = doc["accessors"][prim["indices"]]
    iv = doc["bufferViews"][idx["bufferView"]]
    faces = np.frombuffer(
        data, "<u2", idx["count"], 28 + length + iv.get("byteOffset", 0)
    ).reshape(-1, 3)
    fields, shifts = bind(raw_data, raw.stem.split("-")[0], v, faces)
    quant = np.round(fields * 1000)
    assert np.isfinite(quant).all() and np.abs(quant).max() < 32768
    # Component-major storage clusters adjacent values for compression.
    payload = (
        struct.pack("<4sII", b"FIT1", len(v), len(shifts))
        + np.asarray(shifts, "<f4").tobytes()
        + quant.transpose(1, 2, 0).astype("<i2").tobytes()
    )
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(gzip.compress(payload, compresslevel=3, mtime=0))


if __name__ == "__main__":
    import concurrent.futures

    raw = Path(sys.argv[1])
    assets = Path(__file__).resolve().parents[1] / "public/assets"
    keys = sys.argv[2:] or sorted(p.stem for p in (assets / "rings").glob("*.glb"))
    with concurrent.futures.ProcessPoolExecutor(6) as pool:
        jobs = [
            pool.submit(
                write,
                raw / (k + ".json"),
                assets / "rings" / (k + ".glb"),
                assets / "fit" / (k + ".fit"),
            )
            for k in keys
        ]
        for i, j in enumerate(jobs):
            j.result()
            if i % 30 == 0:
                print(i + 1, "/", len(jobs), flush=True)
