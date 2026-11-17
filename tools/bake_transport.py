"""Offline OpenGL 4.3 caustic transport bake. Requires moderngl in addition to bake_ring_floor dependencies."""

import math
import sys
from pathlib import Path
import moderngl
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter
from bake_ring_floor import ROOT, SIDE, WIDTH, bvh, direct, load_ring


class FloorBaker:
    def __init__(self):
        self.gl = moderngl.create_standalone_context(require=430)
        self.shader = self.gl.compute_shader(
            Path(__file__).with_name("floor_transport.comp").read_text()
        )
        self.output = self.gl.buffer(reserve=SIDE * SIDE * 12)

    def render(self, path):
        gl, shader = self.gl, self.shader
        triangles, roles, gems = load_ring(path)
        floor_y = triangles[:, :, 1].min() - 0.015
        base = ROOT / "floors" / (path.stem + ".png")
        mask = gaussian_filter(direct(triangles, floor_y).mean(axis=0), 0.65)
        Image.fromarray(np.rint(255 * mask).astype("uint8")).save(base)
        boxes, ranges, obstacles, ids = bvh(triangles, roles)
        nodes = np.zeros((len(boxes), 12), np.float32)
        nodes[:, :3] = boxes[:, :3]
        nodes[:, 4:7] = boxes[:, 3:]
        nodes.view(np.int32)[:, 8:11] = ranges
        geometry = np.zeros((len(obstacles), 3, 4), np.float32)
        geometry[:, :, :3] = obstacles
        geometry[:, 0, 3] = ids
        buffers = [gl.buffer(nodes), gl.buffer(geometry)]
        for i, buf in enumerate(buffers):
            buf.bind_to_storage_buffer(i)
        self.output.bind_to_storage_buffer(4)
        for key, val in dict(
            width=WIDTH, size=SIDE, nodeCount=len(nodes), floorY=floor_y
        ).items():
            shader[key].value = val
        stones = []
        for own, center, tri, planes in gems:
            edges = tri.copy()
            edges[:, 1:] -= tri[:, :1]
            weights = np.linalg.norm(np.cross(edges[:, 1], edges[:, 2]), axis=1)
            edges = edges[weights > 1e-8]
            weights = weights[weights > 1e-8]
            surface = np.zeros((len(edges), 3, 4), np.float32)
            surface[:, :, :3] = edges
            surface[:, 0, 3] = np.cumsum(weights) / weights.sum()
            surface[-1, 0, 3] = 1.0
            area = weights.sum() / 2
            pl = gl.buffer(planes.astype("f4"))
            sr = gl.buffer(surface)
            buffers.extend([pl, sr])
            stones.append(
                (
                    int(not center),
                    pl,
                    sr,
                    dict(
                        own=own,
                        area=area,
                        shots=max(90000, round(area * 72000)),
                        faceCount=len(planes),
                        triangleCount=len(edges),
                    ),
                )
            )
        roles = 1 + int(len(stones) > 1)
        atlas = np.zeros((roles * 3 * SIDE, 6 * SIDE, 3), "uint8")
        for family, ior in enumerate((1.59, 2.417)):
            shader["ior"].value = ior
            for k in range(9):
                angle = k * math.pi / 4
                shader["key"].value = (
                    (0, 0)
                    if k == 8
                    else (-1.75 * math.cos(angle), -1.75 * math.sin(angle))
                )
                shader["spread"].value = 1.0 if k == 8 else 0.18
                for role in range(roles):
                    self.output.clear()
                    for stone_role, pl, sr, uniforms in stones:
                        if stone_role != role:
                            continue
                        pl.bind_to_storage_buffer(2)
                        sr.bind_to_storage_buffer(3)
                        for key, val in uniforms.items():
                            shader[key].value = val
                        shader.run((uniforms["shots"] + 127) // 128)
                        gl.memory_barrier()
                    flux = (
                        np.frombuffer(self.output.read(), dtype="u4")
                        .reshape(SIDE, SIDE, 3)
                        .astype("f4")
                        / 16777216
                    )
                    flux = gaussian_filter(flux, sigma=(1.0, 1.0, 0))
                    out = np.zeros_like(flux)
                    out[:, :, :2] = np.log1p(32 * flux[:, :, :2]) / np.log(513)
                    # Conditional attenuation moment. Kept separate from uncolored crown reflections.
                    keep = flux[:, :, 1] > 0.00025
                    out[:, :, 2][keep] = 1.0 - np.clip(
                        flux[:, :, 2][keep] / flux[:, :, 1][keep], 0, 1
                    )
                    x = (family * 3 + k % 3) * SIDE
                    y = (role * 3 + k // 3) * SIDE
                    atlas[y : y + SIDE, x : x + SIDE] = np.rint(
                        255 * np.clip(out, 0, 1)
                    ).astype("uint8")
        # Omit quantization tails from the length channel where there is no encoded light.
        atlas[:, :, 2][atlas[:, :, 1] == 0] = 0
        Image.fromarray(atlas).save(
            ROOT / "floors" / (path.stem + "-transport.png"), compress_level=5
        )
        for buf in buffers:
            buf.release()
        print(path.stem, flush=True)


if __name__ == "__main__":
    baker = FloorBaker()
    paths = [ROOT / "rings" / (k + ".glb") for k in sys.argv[1:]] or sorted(
        (ROOT / "rings").glob("*.glb")
    )
    for p in paths:
        baker.render(p)
