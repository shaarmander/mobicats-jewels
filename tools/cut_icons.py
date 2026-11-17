"""Draw orthographic cut-picker thumbnails from the native crown facets."""
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def build_icons(raw, dest):
    dest.mkdir(exist_ok=True)
    library = json.loads((raw / "library.json").read_bytes())
    for cut in library["cuts"]:
        data = json.loads((raw / f"solitaire-{cut['id']}.json").read_bytes())
        facets = next(s["facets"] for s in data["stones"] if s["role"] == "center")
        crown = [f for f in facets if f["normal"][1] > .0001]
        points = np.concatenate([np.array(f["vertices"])[:, [0, 2]] for f in crown])
        origin = .5 * (points.min(axis=0) + points.max(axis=0))
        scale = 195 / np.ptp(points, axis=0).max()
        image = Image.new("RGBA", (276, 228))
        draw = ImageDraw.Draw(image)
        # Through the flat table, include the projected pavilion pattern. This
        # makes step tiers and brilliant mains legible at phone icon sizes.
        pavilion = Image.new("RGBA", image.size)
        lower = ImageDraw.Draw(pavilion)
        for face in facets:
            n = np.asarray(face["normal"])
            if n[1] >= -.001:
                continue
            v = np.asarray(face["vertices"])
            coords = (v[:, [0, 2]] - origin) * scale + [138, 114]
            tone = .5 + .5 * np.cos(6*n[0]+3*n[2]-n[1])
            ink = tuple(np.rint([96,116,110] + tone*np.array([141,124,128])).astype(int))
            lower.polygon([tuple(x) for x in coords], fill=ink, outline=(93,113,106), width=2)
        for face in sorted(crown, key=lambda f: np.mean(np.array(f["vertices"])[:, 1])):
            normal = np.asarray(face["normal"])
            reflection = 2 * normal[1] * normal - [0, 1, 0]
            brightness = np.clip(.50 + .31 * np.cos(5 * reflection[0] - 3 * reflection[2])
                                 + .22 * np.dot(normal, [-.6, .5, .6]), 0, 1)
            color = tuple(np.rint([52, 77, 73] + brightness * np.array([192, 169, 161])).astype(int))
            coords = (np.array(face["vertices"])[:, [0, 2]] - origin) * scale + [138, 114]
            poly = [tuple(x) for x in coords]
            draw.polygon(poly, fill=color)
            if normal[1] > .999:
                mask = Image.new("L", image.size)
                ImageDraw.Draw(mask).polygon(poly, fill=255)
                image.paste(pavilion, (0, 0), mask)
            draw.line(poly + poly[:1], fill=(73, 89, 85), width=2)
        image.resize((138, 114), Image.Resampling.LANCZOS).save(dest / (cut["id"] + ".webp"), lossless=True)
