"""Check the final welded mesh cross-sections throughout the supported carat range."""

from pathlib import Path
import argparse, struct, json, gzip, concurrent.futures
from functools import partial
import numpy as np
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation

root = Path(__file__).resolve().parents[1]
from basket import basket


def corner_cap_spread(vertices, faces, fields, center, shift, claws):
    """Compare corresponding points on the four polished caps, in millimetres."""
    inverse = Rotation.from_quat(center["rotation"]).inv()
    local = inverse.apply(vertices - center["translation"])
    triangles = local[faces]
    patches = []
    for path in claws:
        tip = inverse.apply(path[[57, 60, 63]] - center["translation"])
        signs = [np.sign(tip[-1, 0]), 1, np.sign(tip[-1, 2])]
        samples = []
        for point in tip:
            # Cast upward from inside the tip. The first intersection follows
            # the same claw even when an accent setting sits beside it.
            a, b, c = (triangles[:, j] - point for j in range(3))
            ba, ca = b - a, c - a
            det = ba[:, 0] * ca[:, 2] - ba[:, 2] * ca[:, 0]
            det[np.abs(det) < 1e-12] = np.nan
            u = (-a[:, 0] * ca[:, 2] + a[:, 2] * ca[:, 0]) / det
            v = (-ba[:, 0] * a[:, 2] + ba[:, 2] * a[:, 0]) / det
            y = a[:, 1] + u * ba[:, 1] + v * ca[:, 1]
            hits = np.where((u >= 0) & (v >= 0) & (u + v <= 1) & (y >= 0), y, np.inf)
            index = np.argmin(hits)
            if hits[index] > 0.9:
                return float("inf")
            weights = [1 - u[index] - v[index], u[index], v[index]]
            ids = faces[index]
            rest = weights @ local[ids]
            deltas = inverse.apply(np.einsum("i,kij->kj", weights, fields[:, ids]))
            deltas[0] -= inverse.apply(shift)
            samples.append((rest, deltas))
        patches.append((signs, samples))

    worst = 0.0
    for carats in (0.5, 1.5, 3.0):
        scale = np.cbrt(carats / center["carats"])
        for profile in range(1, 4):
            caps = [
                [
                    (rest + delta[0] * (scale - 1) + delta[profile]) * signs
                    for rest, delta in samples
                ]
                for signs, samples in patches
            ]
            worst = max(worst, np.ptp(caps, axis=0).max())
    return float(worst)


def audit(key, raw):
    p = root / "public/assets"
    data = (p / "rings" / (key + ".glb")).read_bytes()
    ln = struct.unpack_from("<I", data, 12)[0]
    d = json.loads(data[20 : 20 + ln])
    buf = data[28 + ln :]

    def read(i):
        a = d["accessors"][i]
        view = d["bufferViews"][a["bufferView"]]
        size = 3 if a["type"] == "VEC3" else 1
        return np.frombuffer(
            buf,
            {5126: "<f4", 5123: "<u2"}[a["componentType"]],
            size * a["count"],
            view.get("byteOffset", 0),
        ).reshape(-1, size)

    g = d["meshes"][0]["primitives"][0]
    v = read(g["attributes"]["POSITION"])
    f = read(g["indices"]).reshape(-1, 3)
    tris = v[f]
    tree = cKDTree(tris.mean(axis=1))
    b = gzip.decompress((p / "fit" / (key + ".fit")).read_bytes())
    _, nv, ns = struct.unpack_from("<4sII", b)
    fields = (
        np.frombuffer(b, "<i2", offset=12 + 12 * ns)
        .reshape(4, 3, nv)
        .transpose(0, 2, 1)
        * 0.001
    )
    surfaces = np.concatenate([v[None], fields], axis=0)

    def chord(pos, axis):
        ids = tree.query_ball_point(pos, 2.1)
        tri = tris[ids]
        e1 = tri[:, 1] - tri[:, 0]
        e2 = tri[:, 2] - tri[:, 0]
        P = np.cross(axis, e2)
        det = (e1 * P).sum(axis=1)
        det[np.abs(det) < 1e-12] = np.nan
        dp = pos - tri[:, 0]
        u = (dp * P).sum(axis=1) / det
        Q = np.cross(dp, e1)
        w = Q @ axis / det
        hits = (u >= 0) & (w >= 0) & (u + w <= 1)
        t = np.where(hits, (e2 * Q).sum(axis=1) / det, np.nan)
        if not np.any(t < 0) or not np.any(t > 0):
            return None

        def point(i):
            j = f[ids[i]]
            return (
                (1 - u[i] - w[i]) * surfaces[:, j[0]]
                + u[i] * surfaces[:, j[1]]
                + w[i] * surfaces[:, j[2]]
            )

        return point(np.argmin(np.where(t > 0, t, np.inf))) - point(
            np.argmax(np.where(t < 0, t, -np.inf))
        )

    samples = {}

    def add(label, section, axis):
        h = chord(section, axis)
        if h is None:
            return
        samples.setdefault(label, []).append(h)

    d = json.loads((raw / (key + ".json")).read_bytes())
    center = next(s for s in d["stones"] if s["role"] == "center")

    claws = []

    def record(kind, path, w, h):
        if kind == "claw":
            claws.append(path)
        for k in (
            [22, 30, 37] if kind == "claw" else [10, 29, 46, 64, 82, 102, 121, 136]
        ):
            tangent = path[k + 1] - path[k - 1]
            tangent /= np.linalg.norm(tangent)
            a = np.array([1.0, 0, 0])
            a -= a.dot(tangent) * tangent
            if np.linalg.norm(a) < 0.05:
                a = np.cross(tangent, [0, 0, 1])
            a /= np.linalg.norm(a)
            b = np.cross(tangent, a)
            for ang in np.arange(6) * np.pi / 6:
                add(kind, path[k], a * np.cos(ang) + b * np.sin(ang))

    for _ in basket(
        next(p for p in d["parts"] if p["name"] == "head-centre"),
        center,
        key.split("-")[0],
        record,
    ):
        pass
    # Pick solid shoulder intervals, including each arm of a split style, at +/-55 degrees.
    for ang in np.radians([-55, 55]):
        r = np.array([np.sin(ang), np.cos(ang), 0])
        t = np.array([np.cos(ang), -np.sin(ang), 0])
        near = v[(np.abs(v @ t) < 0.16) & (v @ r > 7)]
        for z in np.quantile(near[:, 2], [0.25, 0.5, 0.75]):
            pos = np.mean(near, axis=0)
            pos[2] = z
            for axis in [r, np.array([0, 0, 1.0])]:
                h = chord(pos, axis)
                if h is not None and 0.7 < np.linalg.norm(h[0]) < 6:
                    samples.setdefault("shoulder", []).append(h)
    result = {}
    for label, seq in samples.items():
        arr = np.stack(seq)
        for j, name in enumerate(["fine", "classic", "bold"]):
            base = arr[:, 0] + arr[:, j + 2]
            ds = arr[:, 1]
            # Analytic minimum of each measured chord over the entire supported
            # size interval, including the densest and lightest library materials.
            lo = (0.5 * 3.52 / (1.5 * 7.08)) ** (1 / 3) - 1
            hi = (3 * 3.52 / (1.5 * 1.08)) ** (1 / 3) - 1
            t = np.clip(
                -np.sum(base * ds, axis=1)
                / np.maximum(1.0e-15, np.sum(ds * ds, axis=1)),
                lo,
                hi,
            )
            vals = np.linalg.norm(base + t[:, None] * ds, axis=1)
            result[label + "-" + name] = [
                round(vals.min(), 3),
                round(np.min(vals / np.linalg.norm(base, axis=1)), 3),
                len(vals),
            ]
    if center["cut"] in ("baguette", "princess") and len(claws) == 4:
        index = d["stones"].index(center)
        shift = np.frombuffer(b, "<f4", count=3, offset=12 + index * 12)
        result["corner-spread"] = corner_cap_spread(v, f, fields, center, shift, claws)
    return key, result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("raw", type=Path, help="Directory of native ring JSON exports")
    parser.add_argument(
        "design", nargs="*", help="Specific setting-cut keys (default: all)"
    )
    parser.add_argument("--jobs", type=int, default=4)
    args = parser.parse_args()
    keys = args.design or sorted(
        p.stem for p in (root / "public/assets/rings").glob("*.glb")
    )
    with concurrent.futures.ProcessPoolExecutor(args.jobs) as ex:
        rows = dict(ex.map(partial(audit, raw=args.raw), keys))
    failed = False
    for family, limits in [
        ("claw", [0.95, 1.10, 1.30]),
        ("gallery", [0.75, 0.90, 1.10]),
        ("shoulder", [1, 1, 1]),
    ]:
        for profile, limit in zip(["fine", "classic", "bold"], limits):
            label = family + "-" + profile
            index = 1 if family == "shoulder" else 0
            value, key = min(
                (r.get(label, [0, 0, 0])[index], k) for k, r in rows.items()
            )
            print(f"{label}: {value:.3f} ({key})")
            failed |= value < limit
    rectangular = [
        (r["corner-spread"], k) for k, r in rows.items() if "corner-spread" in r
    ]
    if rectangular:
        spread, key = max(rectangular)
        print(f"Mirrored claw cap spread: {spread:.3f} mm ({key})")
        failed |= spread > 0.12
    raise SystemExit(int(failed))
