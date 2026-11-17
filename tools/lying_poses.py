"""Find the lying contact pose of each fitted GLB in millimetres, with the head toward +Z."""
import json
import math
import struct
from pathlib import Path

import numpy as np

ASSETS = Path(__file__).resolve().parents[1] / "public" / "assets"


def extract_geometry(path):
    data = path.read_bytes()
    length = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20:20+length])
    binary = memoryview(data)[28+length:]

    def read(index):
        a = gltf["accessors"][index]
        v = gltf["bufferViews"][a["bufferView"]]
        dtype = {5123: "<u2", 5125: "<u4", 5126: "<f4"}[a["componentType"]]
        axes = {"VEC3": 3, "SCALAR": 1}[a["type"]]
        start = v.get("byteOffset", 0) + a.get("byteOffset", 0)
        return np.frombuffer(binary, dtype, count=a["count"] * axes, offset=start).reshape(-1, axes)

    positions = []
    weighted_centre = np.zeros(3)
    mass = 0.
    for node in gltf["nodes"]:
        mesh = gltf["meshes"][node["mesh"]]["primitives"][0]
        v = read(mesh["attributes"]["POSITION"]).astype(float) * node.get("scale", [1, 1, 1])
        q = np.array(node.get("rotation", [0, 0, 0, 1]))
        v += 2 * np.cross(q[:3], np.cross(q[:3], v) + q[3] * v)
        v += node.get("translation", [0, 0, 0])
        positions.append(v)
        tris = v[read(mesh["indices"]).reshape(-1, 3)]
        # Integrate shell volume analytically; metal dominates the support edge.
        density = 20.7 if node["extras"]["role"] in ("band", "head") else 3.52
        tetra_mass = density/6 * np.einsum("ij,ij->i", tris[:, 0], np.cross(tris[:, 1], tris[:, 2]))
        mass += tetra_mass.sum()
        weighted_centre += np.sum(tetra_mass[:, None] * tris.sum(axis=1)/4, axis=0)
    return np.concatenate(positions), weighted_centre/mass


def find_pose(path):
    v, com = extract_geometry(path)
    # With X tipped −90°, the side-view pair (world z, world y) is (−Y, Z).
    lower = []
    for x, y in np.unique(np.column_stack((-v[:, 1], v[:, 2])), axis=0):
        while len(lower) >= 2:
            (ax, ay), (bx, by) = lower[-2:]
            if (bx-ax)*(y-ay) - (by-ay)*(x-ax) > 0:
                break
            lower.pop()
        lower.append((x, y))
    left, right = next((a,b) for a,b in zip(lower, lower[1:]) if a[0] <= -com[1] <= b[0])
    tilt = math.atan2(right[1]-left[1], right[0]-left[0])
    pitch = tilt - math.pi/2
    # Ry(pi) * Rx(pitch) places table at the front of the studio.
    q = [0., math.cos(pitch/2), -math.sin(pitch/2), 0.]
    x,y,z = v.T
    world_y = math.cos(pitch)*y - math.sin(pitch)*z
    shift = -world_y.min()
    contact = world_y + shift < .015
    assert np.ptp(v[contact,1]) > 9, "expected support on the back of the band and near the head"
    elevations = math.cos(pitch)
    assert elevations > 0, "table should face slightly upwards"
    print(path.stem, f"table elevation {math.degrees(math.asin(elevations)):.2f}°, shift {shift:.3f} mm")
    return {"rotation": [round(c,10) for c in q], "translation":[0,round(float(shift),8),0]}


def build_poses():
    poses = {p.stem:find_pose(p) for p in sorted((ASSETS/"rings").glob("*.glb"))}
    (ASSETS/"ring-poses.json").write_text(json.dumps(poses, separators=(",", ":")))


if __name__ == "__main__":
    build_poses()
