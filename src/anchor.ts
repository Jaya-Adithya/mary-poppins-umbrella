/**
 * @module anchor
 * Computes the 3D anchor (position + orientation) for the umbrella model
 * based on MediaPipe hand landmarks and the camera projection.
 *
 * Design constraints:
 *  - **Zero per-frame heap allocations** in the hot path.
 *  - Smoothed shaft direction to prevent orientation jitter.
 *  - Anchor caching for brief tracking dropouts.
 */

import * as THREE from "three";
import {
  MAX_DEPTH,
  MIN_DEPTH,
  PALM_WIDTH_METERS,
  HAND_LENGTH_METERS,
  USE_LANDMARK_Z_DEPTH,
  LANDMARK_Z_WEIGHT,
  GRIP_POINT_BLEND,
  GRIP_OFFSET,
  MODEL_ROTATION_OFFSET,
  HAND_TILT_INFLUENCE,
  WORLD_UP,
} from "./config";
import type { AnchorData, HandPose, Landmark, VideoLayout, HandState } from "./types";
import { LANDMARK, EXPECTED_LANDMARK_COUNT } from "./types";
import { mapLandmarkToContainer, mapLandmarkToContainerPixels } from "./layout";

// ─────────────────────────────────────────────────────────────────────────────
// Anchor Caching & Stability
// ─────────────────────────────────────────────────────────────────────────────

let lastValidAnchor: AnchorData | null = null;
let framesSinceValidAnchor = 0;
const MAX_FRAMES_TO_KEEP_ANCHOR = 15;

// ─────────────────────────────────────────────────────────────────────────────
// Reusable temporaries — allocated once, mutated in place, never exposed.
// ─────────────────────────────────────────────────────────────────────────────

const _shaftSmoothed = new THREE.Vector3(0, 1, 0);
const _shaftRaw = new THREE.Vector3();
const _worldUpVec = new THREE.Vector3();
const _handDir = new THREE.Vector3();
const _modelUp = new THREE.Vector3(0, 1, 0);
const _axis = new THREE.Vector3();
const _alignQuat = new THREE.Quaternion();
const _modelOffset = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _position = new THREE.Vector3();
const _localOffset = new THREE.Vector3();
const SHAFT_DIRECTION_SMOOTHING = 0.15;

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions (inlined for performance)
// ─────────────────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function isFiniteNum(n: number): boolean {
  return typeof n === "number" && isFinite(n);
}

function isValidVector3(v: THREE.Vector3): boolean {
  return isFiniteNum(v.x) && isFiniteNum(v.y) && isFiniteNum(v.z);
}

function isValidQuaternion(q: THREE.Quaternion): boolean {
  return (
    isFiniteNum(q.x) &&
    isFiniteNum(q.y) &&
    isFiniteNum(q.z) &&
    isFiniteNum(q.w) &&
    Math.abs(q.lengthSq() - 1) < 0.02
  );
}

// Landmark averaging — writes into an object from caller to avoid alloc.
function averageLandmarksInto(out: { x: number; y: number; z: number }, landmarks: readonly Landmark[]): void {
  let ax = 0, ay = 0, az = 0;
  for (let i = 0; i < landmarks.length; i++) {
    ax += landmarks[i].x;
    ay += landmarks[i].y;
    az += landmarks[i].z;
  }
  const c = landmarks.length || 1;
  out.x = ax / c;
  out.y = ay / c;
  out.z = az / c;
}

// Re-usable scratch landmark objects.
const _lmAvg: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
const _lmGrip: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };

function weightedAverageLandmarks(
  out: { x: number; y: number; z: number },
  landmarks: readonly Landmark[],
  weights: readonly number[],
): void {
  let ax = 0, ay = 0, az = 0, tw = 0;
  for (let i = 0; i < landmarks.length; i++) {
    const w = weights[i] ?? 0;
    ax += landmarks[i].x * w;
    ay += landmarks[i].y * w;
    az += landmarks[i].z * w;
    tw += w;
  }
  if (tw === 0) {
    out.x = landmarks[0].x;
    out.y = landmarks[0].y;
    out.z = landmarks[0].z;
    return;
  }
  out.x = ax / tw;
  out.y = ay / tw;
  out.z = az / tw;
}

function safeNormalize(v: THREE.Vector3): THREE.Vector3 {
  const len = v.length();
  if (len < 0.0001) {
    return v.set(0, 1, 0);
  }
  return v.divideScalar(len);
}

// ─────────────────────────────────────────────────────────────────────────────
// Grip Point
// ─────────────────────────────────────────────────────────────────────────────

/** Static arrays reused per call — avoids creating arrays on every frame. */
const _gripLandmarks: Landmark[] = new Array(5);
const _gripWeights = [
  GRIP_POINT_BLEND.wrist,
  GRIP_POINT_BLEND.thumbCmc,
  GRIP_POINT_BLEND.indexMcp,
  GRIP_POINT_BLEND.middleMcp,
  GRIP_POINT_BLEND.palmCenter,
];

function computeGripPoint(landmarks: readonly Landmark[]): { x: number; y: number; z: number } {
  const wrist = landmarks[LANDMARK.WRIST];
  const indexMcp = landmarks[LANDMARK.INDEX_MCP];
  const middleMcp = landmarks[LANDMARK.MIDDLE_MCP];
  const pinkyMcp = landmarks[LANDMARK.PINKY_MCP];

  // Palm center average — writes into _lmAvg.
  averageLandmarksInto(_lmAvg, [wrist, indexMcp, middleMcp, pinkyMcp]);

  _gripLandmarks[0] = wrist;
  _gripLandmarks[1] = landmarks[LANDMARK.THUMB_CMC];
  _gripLandmarks[2] = indexMcp;
  _gripLandmarks[3] = middleMcp;
  _gripLandmarks[4] = _lmAvg as Landmark;

  weightedAverageLandmarks(_lmGrip, _gripLandmarks, _gripWeights);
  return _lmGrip;
}

// ─────────────────────────────────────────────────────────────────────────────
// Depth Estimation
// ─────────────────────────────────────────────────────────────────────────────

function estimateDepth(
  landmarks: readonly Landmark[],
  worldLandmarks: readonly Landmark[] | undefined,
  layout: VideoLayout,
  camera: THREE.PerspectiveCamera,
): number {
  const focalPx =
    (layout.containerHeight * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));

  const indexPx = mapLandmarkToContainerPixels(landmarks[LANDMARK.INDEX_MCP], layout);
  const pinkyPx = mapLandmarkToContainerPixels(landmarks[LANDMARK.PINKY_MCP], layout);
  const palmWidthPx = Math.hypot(indexPx.x - pinkyPx.x, indexPx.y - pinkyPx.y);
  const safePalmWidth = Math.max(palmWidthPx, 10);
  const depthFromPalmWidth = (PALM_WIDTH_METERS * focalPx) / safePalmWidth;

  const wristPx = mapLandmarkToContainerPixels(landmarks[LANDMARK.WRIST], layout);
  const middleTipPx = mapLandmarkToContainerPixels(landmarks[LANDMARK.MIDDLE_TIP], layout);
  const handLengthPx = Math.hypot(wristPx.x - middleTipPx.x, wristPx.y - middleTipPx.y);
  const safeHandLength = Math.max(handLengthPx, 20);
  const depthFromHandLength = (HAND_LENGTH_METERS * focalPx) / safeHandLength;

  let depth = depthFromPalmWidth * 0.7 + depthFromHandLength * 0.3;

  if (
    USE_LANDMARK_Z_DEPTH &&
    worldLandmarks &&
    worldLandmarks.length >= EXPECTED_LANDMARK_COUNT
  ) {
    const palmZ =
      (worldLandmarks[LANDMARK.WRIST].z +
        worldLandmarks[LANDMARK.INDEX_MCP].z +
        worldLandmarks[LANDMARK.MIDDLE_MCP].z +
        worldLandmarks[LANDMARK.PINKY_MCP].z) /
      4;

    if (isFiniteNum(palmZ)) {
      const zOffset = Math.abs(palmZ) * 0.4;
      depth = lerp(depth, depth + zOffset, LANDMARK_Z_WEIGHT);
    }
  }

  return clamp(depth, MIN_DEPTH, MAX_DEPTH);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shaft Direction
// ─────────────────────────────────────────────────────────────────────────────

/** Returns a **copy** of the current smoothed shaft direction. */
export function getShaftDirection(): THREE.Vector3 {
  return _shaftSmoothed.clone();
}

function computeShaftDirection(
  landmarks: readonly Landmark[],
  worldLandmarks: readonly Landmark[] | undefined,
): THREE.Vector3 {
  // Use MIDDLE_MCP (landmark 9) as the single target — it sits at the
  // centre of the knuckle ridge and stays stable even when fingers curl
  // into a fist.  Averaging INDEX/MIDDLE/PINKY MCPs caused the direction
  // to skew because curled-finger MCP detections shift unpredictably.

  if (worldLandmarks && worldLandmarks.length >= EXPECTED_LANDMARK_COUNT) {
    // World landmarks are in metres, Y-down — negate Y, zero Z.
    // Z (depth toward camera) is noisy and causes the canopy to tilt
    // toward the viewer, showing inner rods.  Depth is handled
    // separately by the depth-estimation pipeline.
    const wW = worldLandmarks[LANDMARK.WRIST];
    const mW = worldLandmarks[LANDMARK.MIDDLE_MCP];
    _handDir.set(mW.x - wW.x, -(mW.y - wW.y), 0);
  } else {
    // Fallback: image-space landmarks.  Y is inverted (MediaPipe Y-down
    // → Three.js Y-up).  Z is in different units and very noisy for a
    // closed fist, so we drop it entirely.
    const wrist = landmarks[LANDMARK.WRIST];
    const middleMcp = landmarks[LANDMARK.MIDDLE_MCP];
    _handDir.set(
      middleMcp.x - wrist.x,
      -(middleMcp.y - wrist.y),
      0,
    );
  }
  safeNormalize(_handDir);

  _worldUpVec.set(WORLD_UP.x, WORLD_UP.y, WORLD_UP.z).normalize();

  _shaftRaw
    .set(0, 0, 0)
    .addScaledVector(_worldUpVec, 1 - HAND_TILT_INFLUENCE)
    .addScaledVector(_handDir, HAND_TILT_INFLUENCE);
  safeNormalize(_shaftRaw);

  _shaftSmoothed.lerp(_shaftRaw, SHAFT_DIRECTION_SMOOTHING);
  _shaftSmoothed.normalize();

  return _shaftSmoothed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orientation
// ─────────────────────────────────────────────────────────────────────────────

function computeOrientation(
  landmarks: readonly Landmark[],
  worldLandmarks: readonly Landmark[] | undefined,
): THREE.Quaternion {
  const shaftDir = computeShaftDirection(landmarks, worldLandmarks);

  _modelUp.set(0, 1, 0);
  const dot = _modelUp.dot(shaftDir);

  if (dot > 0.9999) {
    _alignQuat.identity();
  } else if (dot < -0.9999) {
    _axis.set(1, 0, 0);
    _alignQuat.setFromAxisAngle(_axis, Math.PI);
  } else {
    _alignQuat.setFromUnitVectors(_modelUp, shaftDir);
  }

  if (
    MODEL_ROTATION_OFFSET.x !== 0 ||
    MODEL_ROTATION_OFFSET.y !== 0 ||
    MODEL_ROTATION_OFFSET.z !== 0
  ) {
    _euler.set(MODEL_ROTATION_OFFSET.x, MODEL_ROTATION_OFFSET.y, MODEL_ROTATION_OFFSET.z, "XYZ");
    _modelOffset.setFromEuler(_euler);
    _alignQuat.multiply(_modelOffset);
  }

  if (!isValidQuaternion(_alignQuat)) {
    console.warn("Invalid quaternion, falling back to identity");
    _alignQuat.identity();
  }

  return _alignQuat.normalize();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Anchor Computation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the 3D anchor for the umbrella from a hand pose.
 *
 * @returns `null` when tracking data is invalid and the anchor cache
 *          has also expired.
 */
export function computeAnchor(
  hand: HandPose,
  handState: HandState,
  layout: VideoLayout,
  camera: THREE.PerspectiveCamera,
): AnchorData | null {
  const landmarks = hand.landmarks;

  if (!landmarks || landmarks.length < EXPECTED_LANDMARK_COUNT) {
    return handleInvalidFrame();
  }

  // Grip point (writes into _lmGrip).
  const gripPoint = computeGripPoint(landmarks);
  const gripPoint2D = mapLandmarkToContainer(gripPoint as Landmark, layout);

  const clampedGrip = {
    x: clamp(gripPoint2D.x, 0.02, 0.98),
    y: clamp(gripPoint2D.y, 0.02, 0.98),
  };

  const depth = estimateDepth(landmarks, hand.worldLandmarks, layout, camera);

  const aspectRatio = camera.aspect;
  const fovRad = THREE.MathUtils.degToRad(camera.fov);
  const halfHeight = depth * Math.tan(fovRad / 2);
  const halfWidth = halfHeight * aspectRatio;

  _position.set(
    (clampedGrip.x - 0.5) * 2 * halfWidth,
    -(clampedGrip.y - 0.5) * 2 * halfHeight,
    -depth,
  );

  if (!isValidVector3(_position)) {
    return handleInvalidFrame();
  }

  const quaternion = computeOrientation(landmarks, hand.worldLandmarks);

  // Apply grip offset in local space.
  _localOffset.set(GRIP_OFFSET.x, GRIP_OFFSET.y, GRIP_OFFSET.z);
  if (_localOffset.lengthSq() > 0) {
    _localOffset.applyQuaternion(quaternion);
    _position.add(_localOffset);
  }

  // Palm width for scale.
  const indexPx = mapLandmarkToContainerPixels(landmarks[LANDMARK.INDEX_MCP], layout);
  const pinkyPx = mapLandmarkToContainerPixels(landmarks[LANDMARK.PINKY_MCP], layout);
  const palmWidthPx = Math.hypot(indexPx.x - pinkyPx.x, indexPx.y - pinkyPx.y);

  const shaftDir = getShaftDirection();

  const anchor: AnchorData = {
    position: _position.clone(),
    quaternion: _alignQuat.clone().normalize(),
    depth,
    palmWidthPx: Math.max(palmWidthPx, 10),
    handState,
    confidence: handState.curlConfidence,
    gripPoint2D: clampedGrip,
    forearmDirection: shaftDir,
  };

  lastValidAnchor = anchor;
  framesSinceValidAnchor = 0;

  return anchor;
}

// ─────────────────────────────────────────────────────────────────────────────
// Invalid Frame Handling
// ─────────────────────────────────────────────────────────────────────────────

function handleInvalidFrame(): AnchorData | null {
  framesSinceValidAnchor++;
  if (lastValidAnchor && framesSinceValidAnchor <= MAX_FRAMES_TO_KEEP_ANCHOR) {
    return lastValidAnchor;
  }
  return null;
}

/** Reset cache when hand is truly lost. */
export function resetAnchorCache(): void {
  lastValidAnchor = null;
  framesSinceValidAnchor = 0;
  _shaftSmoothed.set(0, 1, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility Exports
// ─────────────────────────────────────────────────────────────────────────────

/** Returns the grip-point position in container pixels. */
export function getGripPointPixels(
  landmarks: readonly Landmark[],
  layout: VideoLayout,
): { x: number; y: number } {
  const gripPoint = computeGripPoint(landmarks);
  return mapLandmarkToContainerPixels(gripPoint as Landmark, layout);
}
