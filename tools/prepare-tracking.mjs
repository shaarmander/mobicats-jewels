import { mkdir, copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const sdk = dirname(
  createRequire(import.meta.url).resolve("@mediapipe/tasks-vision"),
);
const output = new URL("../public/tracking-runtime/", import.meta.url);
await mkdir(output, { recursive: true });
await copyFile(join(sdk, "vision_bundle.cjs"), new URL("vision.js", output));
for (const variant of ["internal", "nosimd_internal"]) {
  for (const extension of ["js", "wasm"]) {
    const file = "vision_wasm_" + variant + "." + extension;
    await copyFile(join(sdk, "wasm", file), new URL(file, output));
  }
}
