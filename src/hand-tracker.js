const options = {
  baseOptions: {
    modelAssetPath: "/assets/try-on/hand_landmarker.task",
    delegate: "CPU",
  },
  numHands: 1,
  runningMode: "VIDEO",
  minHandDetectionConfidence: 0.55,
  minTrackingConfidence: 0.55,
};

// Only one frame can be in flight. Frames, model inference, and the resulting
// landmarks stay in this origin. The fallback also works without worker WebGL.
export class HandTracker {
  async open() {
    if (
      typeof OffscreenCanvas !== "undefined" &&
      typeof createImageBitmap === "function"
    ) {
      try {
        this.worker = new Worker("/assets/try-on/track.js");
        this.worker.onmessage = ({ data }) => {
          if (data.type === "error")
            this.pending?.reject(new Error(data.message));
          else this.pending?.resolve(data.result);
          this.pending = null;
        };
        this.worker.onerror = (event) =>
          this.pending?.reject(new Error(event.message));
        await this.send({ type: "init", options });
        return;
      } catch (error) {
        this.stopWorker();
        if (this.closed) throw error;
      }
    }
    await this.openMain();
  }
  async openMain() {
    const { FilesetResolver, HandLandmarker } = await import(
      "@mediapipe/tasks-vision"
    );
    if (this.closed) return;
    const files = await FilesetResolver.forVisionTasks("/tracking-runtime");
    if (this.closed) return;
    const model = await HandLandmarker.createFromOptions(files, options);
    if (this.closed) model.close();
    else this.model = model;
  }
  send(message, transfer = []) {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker.postMessage(message, transfer);
    });
  }
  async detect(canvas, time) {
    if (this.worker) {
      try {
        const bitmap = await createImageBitmap(canvas);
        if (this.closed) {
          bitmap.close();
          return;
        }
        return await this.send({ type: "frame", time, bitmap }, [bitmap]);
      } catch (error) {
        if (this.closed) return;
        this.stopWorker();
        await this.openMain();
      }
    }
    if (!this.closed) return this.model.detectForVideo(canvas, time);
  }
  stopWorker() {
    this.worker?.terminate();
    this.worker = null;
    this.pending?.reject(new Error("Tracking stopped"));
    this.pending = null;
  }
  close() {
    this.closed = true;
    this.stopWorker();
    this.model?.close();
    this.model = null;
  }
}
