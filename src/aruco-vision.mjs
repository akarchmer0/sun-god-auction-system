import { MarkerRaiseLatch } from "./vision-bidding.mjs";
import { AR } from "../vendor/js-aruco2/aruco.js";

const DEFAULT_WIDTH = 640;
const DEFAULT_FPS = 8;
const DICTIONARY_NAME = "ARUCO_MIP_36h12";

export class ArucoVision {
  constructor({
    width = DEFAULT_WIDTH,
    fps = DEFAULT_FPS,
    onDetections = () => {},
    onMarkerRaised = () => {},
    onStateChange = () => {},
    labelForMarker = (id) => `Marker ${id}`,
    colorForMarker = () => "#f05d23"
  } = {}) {
    this.width = width;
    this.fps = fps;
    this.frameInterval = 1000 / fps;
    this.onDetections = onDetections;
    this.onMarkerRaised = onMarkerRaised;
    this.onStateChange = onStateChange;
    this.labelForMarker = labelForMarker;
    this.colorForMarker = colorForMarker;
    this.latch = new MarkerRaiseLatch();
    this.processingCanvas = document.createElement("canvas");
    this.processingContext = this.processingCanvas.getContext("2d", { willReadFrequently: true });
    this.video = null;
    this.overlay = null;
    this.running = false;
    this.frameRequest = null;
    this.lastFrameAt = 0;
    this.detector = null;
  }

  attach(video, overlay) {
    this.video = video;
    this.overlay = overlay;
  }

  setProfile({ width, fps }) {
    if (!Number.isInteger(width) || width < 320) throw new Error("Vision width must be at least 320 pixels.");
    if (!Number.isFinite(fps) || fps < 1) throw new Error("Vision frame rate must be at least 1 FPS.");
    this.width = width;
    this.fps = fps;
    this.frameInterval = 1000 / fps;
    this.lastFrameAt = 0;
    this.onStateChange({
      status: this.running ? "scanning" : "standby",
      scanWidth: this.width,
      scanFps: this.fps
    });
  }

  start() {
    if (this.running) return;
    this.detector ||= new AR.Detector({
      dictionaryName: DICTIONARY_NAME,
      maxHammingDistance: 5
    });
    this.running = true;
    this.lastFrameAt = 0;
    this.onStateChange({ status: "scanning", scanWidth: this.width, scanFps: this.fps });
    this.frameRequest = requestAnimationFrame((now) => this.tick(now));
  }

  stop() {
    this.running = false;
    if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
    this.frameRequest = null;
    this.latch.reset();
    this.clearOverlay();
    this.onDetections([], { detectionMs: 0, width: this.width, fps: this.fps });
    this.onStateChange({ status: "standby", scanWidth: this.width, scanFps: this.fps });
  }

  tick(now) {
    if (!this.running) return;
    if (now - this.lastFrameAt >= this.frameInterval) {
      this.lastFrameAt = now;
      this.scan(now);
    }
    this.frameRequest = requestAnimationFrame((nextNow) => this.tick(nextNow));
  }

  scan(now) {
    const video = this.video;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return;

    try {
      const aspect = video.videoWidth / video.videoHeight;
      const width = this.width;
      const height = Math.max(240, Math.min(768, Math.round(width / aspect)));
      if (this.processingCanvas.width !== width || this.processingCanvas.height !== height) {
        this.processingCanvas.width = width;
        this.processingCanvas.height = height;
      }
      this.processingContext.drawImage(video, 0, 0, width, height);
      const image = this.processingContext.getImageData(0, 0, width, height);
      const startedAt = performance.now();
      const markers = this.detector.detect(image);
      const detectionMs = performance.now() - startedAt;
      this.drawOverlay(markers, width, height);
      this.onDetections(markers, { detectionMs, width: this.width, fps: this.fps });
      const raisedIds = this.latch.update(markers.map((marker) => marker.id), now);
      if (raisedIds.length) this.onMarkerRaised(raisedIds, now);
    } catch (error) {
      this.running = false;
      this.onStateChange({ status: "error", error: error.message || "Marker detection failed." });
    }
  }

  drawOverlay(markers, width, height) {
    const canvas = this.overlay;
    if (!canvas) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, width, height);
    const displayScale = width / DEFAULT_WIDTH;
    context.lineWidth = 4 * displayScale;
    context.font = `700 ${18 * displayScale}px "Manrope", sans-serif`;

    for (const marker of markers) {
      const corners = marker.corners.map((corner) => ({ x: width - corner.x, y: corner.y }));
      const color = this.colorForMarker(marker.id);
      context.strokeStyle = color;
      context.fillStyle = color;
      context.beginPath();
      context.moveTo(corners[0].x, corners[0].y);
      for (let index = 1; index < corners.length; index += 1) context.lineTo(corners[index].x, corners[index].y);
      context.closePath();
      context.stroke();

      const centerX = corners.reduce((sum, corner) => sum + corner.x, 0) / corners.length;
      const top = Math.min(...corners.map((corner) => corner.y));
      const label = this.labelForMarker(marker.id);
      const labelPadding = 9 * displayScale;
      const labelWidth = context.measureText(label).width + labelPadding * 2;
      const edgePadding = 4 * displayScale;
      const labelX = Math.max(edgePadding, Math.min(width - labelWidth - edgePadding, centerX - labelWidth / 2));
      const labelY = Math.max(25 * displayScale, top - 7 * displayScale);
      context.fillRect(labelX, labelY - 22 * displayScale, labelWidth, 26 * displayScale);
      context.fillStyle = "#11110f";
      context.fillText(label, labelX + labelPadding, labelY - 3 * displayScale);
    }
  }

  clearOverlay() {
    const context = this.overlay?.getContext("2d");
    if (context) context.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }
}

export function generateArucoCardSvg(markerId) {
  return new AR.Dictionary(DICTIONARY_NAME).generateSVG(markerId);
}
