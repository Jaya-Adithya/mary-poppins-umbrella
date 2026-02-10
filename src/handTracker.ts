/**
 * @module handTracker
 * Wraps MediaPipe HandLandmarker to provide:
 *  - Throttled detection at a configurable FPS.
 *  - Finger-curl / grip-state analysis with temporal stabilisation.
 *  - A clean `dispose()` path for releasing GPU & WASM resources.
 */

import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import type { HandLandmarkerResult } from "@mediapipe/tasks-vision";
import {
  HAND_TRACK_FPS,
  MAX_HANDS,
  MIN_HAND_DETECTION_CONFIDENCE,
  MIN_TRACKING_CONFIDENCE,
  MIN_PRESENCE_CONFIDENCE,
  ENABLE_GRIP_DETECTION,
  FINGER_CURL_THRESHOLD,
  THUMB_CURL_THRESHOLD,
} from "./config";
import type {
  HandPose,
  HandState,
  GripState,
  FingerState,
  Landmark,
  Disposable,
} from "./types";
import { LANDMARK, EXPECTED_LANDMARK_COUNT } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Segmentation Mask Type
// ─────────────────────────────────────────────────────────────────────────────

export interface SegmentationMask {
  readonly width: number;
  readonly height: number;
  getAsFloat32Array?: () => Float32Array;
  getAsUint8Array?: () => Uint8Array;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tracking Result
// ─────────────────────────────────────────────────────────────────────────────

export interface HandTrackingResult {
  readonly pose: HandPose | null;
  readonly segmentationMask: SegmentationMask | null;
  readonly handState: HandState | null;
  readonly confidence: number;
  readonly processingTime: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Grip State Stabiliser (hysteresis prevents rapid flickering)
// ─────────────────────────────────────────────────────────────────────────────

class GripStateStabilizer {
  private currentState: GripState = "open";
  private readonly stateHistory: GripState[] = [];
  private readonly historySize = 8;
  private readonly enterGripThreshold = 5;
  private readonly exitGripThreshold = 4;

  update(rawState: GripState): GripState {
    this.stateHistory.push(rawState);
    if (this.stateHistory.length > this.historySize) {
      this.stateHistory.shift();
    }

    const counts: Record<GripState, number> = { open: 0, relaxed: 0, gripping: 0, fist: 0 };
    for (const state of this.stateHistory) counts[state]++;

    const isCurrentlyGripping =
      this.currentState === "gripping" || this.currentState === "fist";
    const gripFrames = counts.gripping + counts.fist;
    const nonGripFrames = counts.open + counts.relaxed;

    if (isCurrentlyGripping) {
      if (nonGripFrames >= this.exitGripThreshold) {
        this.currentState = counts.open > counts.relaxed ? "open" : "relaxed";
      } else {
        this.currentState = counts.fist > counts.gripping ? "fist" : "gripping";
      }
    } else {
      if (gripFrames >= this.enterGripThreshold) {
        this.currentState = counts.fist > counts.gripping ? "fist" : "gripping";
      } else if (counts.relaxed > counts.open) {
        this.currentState = "relaxed";
      } else {
        this.currentState = "open";
      }
    }

    return this.currentState;
  }

  reset(): void {
    this.currentState = "open";
    this.stateHistory.length = 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hand Landmarker Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create and return a MediaPipe `HandLandmarker` configured for VIDEO mode.
 * Reports progress through the optional callback.
 */
export async function createHandLandmarker(
  onProgress?: (progress: number, message: string) => void,
): Promise<HandLandmarker> {
  onProgress?.(10, "Loading vision WASM modules...");

  const filesetResolver = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm",
  );

  onProgress?.(40, "Loading hand detection model...");

  // NOTE: HandLandmarker does NOT support `outputSegmentationMasks`.
  // That option is only available on PoseLandmarker / ImageSegmenter.
  // Hand occlusion is instead handled by a landmark-based grip occluder
  // (see GRIP_OCCLUDER_ENABLED in config.ts).  If a body-level
  // segmentation mask is needed in the future, wire up a separate
  // SelfieSegmentation model and feed its mask into the occlusion module.

  const modelUrl =
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

  const sharedOptions = {
    runningMode: "VIDEO" as const,
    numHands: MAX_HANDS,
    minHandDetectionConfidence: MIN_HAND_DETECTION_CONFIDENCE,
    minTrackingConfidence: MIN_TRACKING_CONFIDENCE,
    minHandPresenceConfidence: MIN_PRESENCE_CONFIDENCE,
  };

  // Try GPU delegate first (fastest), fall back to CPU if it fails.
  // Some mobile devices (older Android, certain iOS browsers) lack WebGL2
  // support for the GPU delegate, so the fallback is essential.
  let landmarker: HandLandmarker;
  try {
    landmarker = await HandLandmarker.createFromOptions(filesetResolver, {
      baseOptions: { modelAssetPath: modelUrl, delegate: "GPU" },
      ...sharedOptions,
    });
    console.log("[HandTracker] Using GPU delegate");
  } catch (gpuError) {
    console.warn("[HandTracker] GPU delegate failed, falling back to CPU:", gpuError);
    onProgress?.(60, "GPU unavailable — using CPU fallback…");
    landmarker = await HandLandmarker.createFromOptions(filesetResolver, {
      baseOptions: { modelAssetPath: modelUrl, delegate: "CPU" },
      ...sharedOptions,
    });
    console.log("[HandTracker] Using CPU delegate (slower but compatible)");
  }

  onProgress?.(100, "Hand tracker ready");
  return landmarker;
}

// ─────────────────────────────────────────────────────────────────────────────
// Distance Utilities
// ─────────────────────────────────────────────────────────────────────────────

function landmarkDistance(a: Landmark, b: Landmark): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function landmarkDistance2D(a: Landmark, b: Landmark): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// ─────────────────────────────────────────────────────────────────────────────
// Finger Curl Detection
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_FINGER_STATE: FingerState = Object.freeze({
  index: false,
  middle: false,
  ring: false,
  pinky: false,
  thumb: false,
});

function detectFingerCurl(landmarks: readonly Landmark[]): FingerState {
  const palmSize = landmarkDistance2D(landmarks[LANDMARK.WRIST], landmarks[LANDMARK.MIDDLE_MCP]);
  if (palmSize < 0.001) return DEFAULT_FINGER_STATE;

  const palmCenter: Landmark = {
    x: (landmarks[LANDMARK.WRIST].x + landmarks[LANDMARK.MIDDLE_MCP].x) / 2,
    y: (landmarks[LANDMARK.WRIST].y + landmarks[LANDMARK.MIDDLE_MCP].y) / 2,
    z: (landmarks[LANDMARK.WRIST].z + landmarks[LANDMARK.MIDDLE_MCP].z) / 2,
  };

  const isFingerCurled = (tip: number, pip: number, mcp: number): boolean => {
    const tipLm = landmarks[tip];
    const pipLm = landmarks[pip];
    const mcpLm = landmarks[mcp];

    const tipToMcp = landmarkDistance(tipLm, mcpLm) / palmSize;
    const tipToPalm = landmarkDistance(tipLm, palmCenter) / palmSize;
    const tipToPip = landmarkDistance(tipLm, pipLm) / palmSize;

    // Relaxed thresholds (5x instead of 4x) to catch back-of-hand fists
    // where landmark positions are noisier.
    const curlThreshold = FINGER_CURL_THRESHOLD * 5;
    const palmThreshold = FINGER_CURL_THRESHOLD * 4;

    return (
      tipToMcp < curlThreshold ||
      tipToPalm < palmThreshold ||
      tipToPip < curlThreshold * 0.5
    );
  };

  // Thumb has different geometry.
  const thumbTip = landmarks[LANDMARK.THUMB_TIP];
  const thumbIp = landmarks[LANDMARK.THUMB_IP];
  const indexMcp = landmarks[LANDMARK.INDEX_MCP];

  const thumbToIndex = landmarkDistance(thumbTip, indexMcp) / palmSize;
  const thumbToIp = landmarkDistance(thumbTip, thumbIp) / palmSize;
  const thumbCurled =
    thumbToIndex < THUMB_CURL_THRESHOLD * 5 || thumbToIp < THUMB_CURL_THRESHOLD * 2.5;

  // ── Compactness check ──────────────────────────────────────────────────
  // When viewing the back of a fist, individual curl detection can fail
  // because MediaPipe can't accurately place tips behind the knuckles.
  // Instead, check if ALL fingertips cluster tightly together — a strong
  // indicator of a closed fist from any viewing angle.
  const tips = [
    landmarks[LANDMARK.INDEX_TIP],
    landmarks[LANDMARK.MIDDLE_TIP],
    landmarks[LANDMARK.RING_TIP],
    landmarks[LANDMARK.PINKY_TIP],
  ];
  let maxTipSpread = 0;
  for (let i = 0; i < tips.length; i++) {
    for (let j = i + 1; j < tips.length; j++) {
      maxTipSpread = Math.max(maxTipSpread, landmarkDistance2D(tips[i], tips[j]));
    }
  }
  const compactFist = (maxTipSpread / palmSize) < 0.6;

  if (compactFist) {
    // All tips are bunched together → strong fist signal from any angle.
    return { index: true, middle: true, ring: true, pinky: true, thumb: thumbCurled };
  }

  return {
    index: isFingerCurled(LANDMARK.INDEX_TIP, LANDMARK.INDEX_PIP, LANDMARK.INDEX_MCP),
    middle: isFingerCurled(LANDMARK.MIDDLE_TIP, LANDMARK.MIDDLE_PIP, LANDMARK.MIDDLE_MCP),
    ring: isFingerCurled(LANDMARK.RING_TIP, LANDMARK.RING_PIP, LANDMARK.RING_MCP),
    pinky: isFingerCurled(LANDMARK.PINKY_TIP, LANDMARK.PINKY_PIP, LANDMARK.PINKY_MCP),
    thumb: thumbCurled,
  };
}

function determineGripState(fingers: FingerState): { state: GripState; confidence: number } {
  const curledCount = [fingers.index, fingers.middle, fingers.ring, fingers.pinky].filter(Boolean).length;
  const thumbCurled = fingers.thumb;

  if (curledCount >= 3 && thumbCurled) return { state: "fist", confidence: 0.95 };
  if (curledCount >= 3) return { state: "gripping", confidence: 0.85 };
  if (curledCount >= 2 && thumbCurled) return { state: "gripping", confidence: 0.75 };
  if (curledCount >= 2) return { state: "relaxed", confidence: 0.65 };
  return { state: "open", confidence: 0.7 };
}

function detectPalmFacing(landmarks: readonly Landmark[]): "camera" | "away" | "side" {
  const wrist = landmarks[LANDMARK.WRIST];
  const indexMcp = landmarks[LANDMARK.INDEX_MCP];
  const pinkyMcp = landmarks[LANDMARK.PINKY_MCP];
  const middleMcp = landmarks[LANDMARK.MIDDLE_MCP];

  const avgEdgeZ = (indexMcp.z + pinkyMcp.z + wrist.z) / 3;
  const zDiff = middleMcp.z - avgEdgeZ;

  if (Math.abs(zDiff) < 0.02) return "side";
  return zDiff > 0 ? "away" : "camera";
}

function analyzeHandState(
  landmarks: readonly Landmark[],
  stabilizer: GripStateStabilizer,
): HandState {
  if (!ENABLE_GRIP_DETECTION || landmarks.length < EXPECTED_LANDMARK_COUNT) {
    return {
      grip: "relaxed",
      fingers: DEFAULT_FINGER_STATE,
      curlConfidence: 0.5,
      palmFacing: "camera",
    };
  }

  const fingers = detectFingerCurl(landmarks);
  const { state: rawState, confidence } = determineGripState(fingers);
  const palmFacing = detectPalmFacing(landmarks);
  const stableState = stabilizer.update(rawState);

  return { grip: stableState, fingers, curlConfidence: confidence, palmFacing };
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty result singleton (avoids allocating a new object every no-hand frame).
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_RESULT: HandTrackingResult = Object.freeze({
  pose: null,
  segmentationMask: null,
  handState: null,
  confidence: 0,
  processingTime: 0,
});

// ─────────────────────────────────────────────────────────────────────────────
// Hand Tracker Class
// ─────────────────────────────────────────────────────────────────────────────

export class HandTracker implements Disposable {
  private lastDetectTime = 0;
  private latestResult: HandTrackingResult = EMPTY_RESULT;

  private readonly detectionHistory: boolean[] = [];
  private readonly historySize = 10;
  private readonly gripStabilizer = new GripStateStabilizer();
  private disposed = false;

  constructor(
    private readonly landmarker: HandLandmarker,
    private readonly fps = HAND_TRACK_FPS,
  ) { }

  /** Ratio of recent frames where a hand was detected. */
  get detectionRate(): number {
    if (this.detectionHistory.length === 0) return 0;
    let count = 0;
    for (let i = 0; i < this.detectionHistory.length; i++) {
      if (this.detectionHistory[i]) count++;
    }
    return count / this.detectionHistory.length;
  }

  /**
   * Run detection on the current video frame (throttled to `fps`).
   * Returns the most recent result if called faster than the target interval.
   */
  detect(video: HTMLVideoElement, timeMs: number): HandTrackingResult {
    if (this.disposed) return EMPTY_RESULT;
    if (video.readyState < 2) return this.latestResult;

    const interval = 1000 / this.fps;
    if (timeMs - this.lastDetectTime < interval) return this.latestResult;

    const startTime = performance.now();

    try {
      const result: HandLandmarkerResult = this.landmarker.detectForVideo(video, timeMs);
      this.lastDetectTime = timeMs;

      const hasHand = result.landmarks && result.landmarks.length > 0;

      this.detectionHistory.push(hasHand);
      if (this.detectionHistory.length > this.historySize) {
        this.detectionHistory.shift();
      }

      if (hasHand) {
        const landmarks = result.landmarks[0];
        const worldLandmarks = result.worldLandmarks?.[0];
        const handedness = result.handedness?.[0]?.[0]?.categoryName as
          | "Left"
          | "Right"
          | undefined;

        const pose: HandPose = { landmarks, worldLandmarks, handedness };
        const handState = analyzeHandState(landmarks, this.gripStabilizer);
        const confidence = this.calculateConfidence(result);

        // `segmentationMasks` exists at runtime when the option is enabled
        // but is absent from the published TS types — access via unknown.
        const masks = (result as unknown as { segmentationMasks?: SegmentationMask[] })
          .segmentationMasks;

        this.latestResult = {
          pose,
          segmentationMask: masks?.[0] ?? null,
          handState,
          confidence,
          processingTime: performance.now() - startTime,
        };
      } else {
        this.latestResult = {
          pose: null,
          segmentationMask: null,
          handState: null,
          confidence: 0,
          processingTime: performance.now() - startTime,
        };
      }
    } catch (error) {
      console.warn("Hand tracking error:", error);
    }

    return this.latestResult;
  }

  // ── Confidence calculation ─────────────────────────────────────────────

  private calculateConfidence(result: HandLandmarkerResult): number {
    let confidence = this.detectionRate * 0.5;

    if (result.landmarks?.[0]) {
      const landmarks = result.landmarks[0];
      let validLandmarks = 0;
      for (const lm of landmarks) {
        if (lm.x >= 0 && lm.x <= 1 && lm.y >= 0 && lm.y <= 1) validLandmarks++;
      }
      confidence += (validLandmarks / EXPECTED_LANDMARK_COUNT) * 0.3;
    }

    if (result.handedness?.[0]?.[0]?.score) {
      confidence += result.handedness[0][0].score * 0.2;
    }

    return Math.min(1, confidence);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  reset(): void {
    this.detectionHistory.length = 0;
    this.gripStabilizer.reset();
    this.latestResult = EMPTY_RESULT;
  }

  /**
   * Release the underlying MediaPipe landmarker. After calling this the
   * tracker instance must not be reused.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.landmarker.close();
    } catch {
      // MediaPipe may throw during teardown — safe to swallow.
    }
    this.reset();
  }
}
