// Sample the finished canvas underneath the transparent mark. A pixel-pack
// buffer and fence let the GPU complete the read without stalling the turntable.
export class BrandContrast {
  constructor(renderer, mark) {
    this.renderer = renderer;
    this.mark = mark;
    this.gl = renderer.getContext();
    this.pack = this.gl.createBuffer();
    this.pixels = new Uint8Array(2048);
    this.due = 0;
    this.gl.bindBuffer(this.gl.PIXEL_PACK_BUFFER, this.pack);
    this.gl.bufferData(
      this.gl.PIXEL_PACK_BUFFER,
      this.pixels.byteLength,
      this.gl.STREAM_DRAW,
    );
    this.gl.bindBuffer(this.gl.PIXEL_PACK_BUFFER, null);
  }
  update(now, rig) {
    const gl = this.gl;
    if (this.fence) {
      const state = gl.clientWaitSync(this.fence, 0, 0);
      if (state === gl.TIMEOUT_EXPIRED) return true;
      gl.deleteSync(this.fence);
      this.fence = null;
      if (state !== gl.WAIT_FAILED) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pack);
        gl.getBufferSubData(
          gl.PIXEL_PACK_BUFFER,
          0,
          this.pixels,
          0,
          this.width * 4,
        );
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        const linear = (n) => {
          const x = n / 255;
          return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        };
        const luminances = Array.from(
          { length: 9 },
          (_, j) => 4 * Math.floor((j * (this.width - 1)) / 8),
        )
          .map(
            (i) =>
              0.2126 * linear(this.pixels[i]) +
              0.7152 * linear(this.pixels[i + 1]) +
              0.0722 * linear(this.pixels[i + 2]),
          )
          .sort((a, b) => a - b);
        this.lightInk = luminances[4] < (this.lightInk ? 0.205 : 0.17);
        const ink = this.lightInk
          ? "#fff7e9"
          : {
              window: "#25303b",
              gallery: "#392519",
              softbox: "#211d2d",
              spotlights: "#142831",
              darkfield: "#201b2b",
            }[rig];
        document.body.style.setProperty("--brand-ink", ink);
      }
    }
    if (now < this.due) return false;
    this.due = now + 450;
    const canvas = this.renderer.domElement;
    const r = this.mark.getBoundingClientRect(),
      c = canvas.getBoundingClientRect();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pack);
    const scale = canvas.width / c.width;
    const x = Math.max(
      0,
      Math.min(
        canvas.width - 1,
        Math.floor((r.left + r.width * 0.12 - c.left) * scale),
      ),
    );
    const y = Math.max(
      0,
      Math.min(
        canvas.height - 1,
        Math.floor(
          ((c.bottom - r.top - r.height * 0.5) * canvas.height) / c.height,
        ),
      ),
    );
    this.width = Math.max(
      1,
      Math.min(512, canvas.width - x, Math.ceil(r.width * 0.76 * scale)),
    );
    gl.readPixels(x, y, this.width, 1, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    return true;
  }
}
