import type { Quaternion, Vector3 } from "three";

// ─────────────────────────────────────────────────────────────────────────────
// Hand Landmarks
// ─────────────────────────────────────────────────────────────────────────────
export interface Landmark {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** MediaPipe Hand Landmark indices (21 key-points). */
export const LANDMARK = Object.freeze({
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const);

/** Total expected landmarks from MediaPipe hand model. */
export const EXPECTED_LANDMARK_COUNT = 21 as const;

// ─────────────────────────────────────────────────────────────────────────────
// Hand Pose & State
// ─────────────────────────────────────────────────────────────────────────────
export interface HandPose {
  readonly landmarks: readonly Landmark[];
  readonly worldLandmarks?: readonly Landmark[];
  readonly handedness?: "Left" | "Right";
}

export type GripState = "open" | "relaxed" | "gripping" | "fist";

export interface FingerState {
  readonly index: boolean; // true = curled
  readonly middle: boolean;
  readonly ring: boolean;
  readonly pinky: boolean;
  readonly thumb: boolean;
}

export interface HandState {
  readonly grip: GripState;
  readonly fingers: FingerState;
  readonly curlConfidence: number; // 0-1, how confident we are about the grip state
  readonly palmFacing: "camera" | "away" | "side";
}

// ─────────────────────────────────────────────────────────────────────────────
// Anchor Data
// ─────────────────────────────────────────────────────────────────────────────
export interface AnchorData {
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  readonly depth: number;
  readonly palmWidthPx: number;
  readonly handState: HandState;
  readonly confidence: number; // Overall tracking confidence

  // Debug data
  readonly gripPoint2D?: { readonly x: number; readonly y: number };
  readonly forearmDirection?: Vector3;
}

// ─────────────────────────────────────────────────────────────────────────────
// Video Layout
// ─────────────────────────────────────────────────────────────────────────────
export interface VideoLayout {
  readonly containerWidth: number;
  readonly containerHeight: number;
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly scale: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tracking Result
// ─────────────────────────────────────────────────────────────────────────────
export interface TrackingQuality {
  readonly fps: number;
  readonly latency: number;
  readonly handVisible: boolean;
  readonly handStable: boolean;
  readonly depthConfidence: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Application State (discriminated union for the state machine)
// ─────────────────────────────────────────────────────────────────────────────
export type AppState =
  | "idle"
  | "loading-camera"
  | "loading-model"
  | "loading-tracker"
  | "ready"
  | "tracking"
  | "error";

export interface LoadingProgress {
  readonly stage: string;
  readonly progress: number; // 0-100
  readonly message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature Support Detection
// ─────────────────────────────────────────────────────────────────────────────
export interface FeatureSupport {
  readonly webgl2: boolean;
  readonly mediaDevices: boolean;
  readonly wasm: boolean;
  readonly offscreenCanvas: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Disposable Interface
// ─────────────────────────────────────────────────────────────────────────────
export interface Disposable {
  dispose(): void;
}
