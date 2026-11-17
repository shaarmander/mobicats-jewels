const root = self.location.origin;
self.exports = {};
let tracker;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      importScripts(root + "/tracking-runtime/vision.js");
      const { FilesetResolver, HandLandmarker } = self.exports;
      const files = await FilesetResolver.forVisionTasks(
        root + "/tracking-runtime",
      );
      tracker = await HandLandmarker.createFromOptions(files, data.options);
      self.postMessage({ type: "ready" });
    } else {
      try {
        const result = tracker.detectForVideo(data.bitmap, data.time);
        self.postMessage({ type: "result", result });
      } finally {
        data.bitmap.close();
      }
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      message: String(error.message ?? error),
    });
  }
};
