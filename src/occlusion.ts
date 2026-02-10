/**
 * @module occlusion
 * Depth-mask based hand occlusion — makes the 3D umbrella appear to pass
 * *behind* the user's hand by writing to the depth buffer with a screen-
 * aligned plane whose alpha is driven by the MediaPipe segmentation mask.
 *
 * Provides a `dispose()` function to release GPU textures and canvases.
 */

import * as THREE from "three";
import {
  OCCLUSION_ENABLED,
  OCCLUSION_ALPHA_TEST,
  OCCLUSION_DEPTH_BIAS,
  OCCLUSION_FEATHER_ENABLED,
  OCCLUSION_FEATHER_RADIUS,
  OCCLUSION_STRENGTH,
  MULTI_LAYER_OCCLUSION,
  FINGER_DEPTH_OFFSET,
} from "./config";
import type { VideoLayout, Landmark, Disposable } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Occlusion State
// ─────────────────────────────────────────────────────────────────────────────

export interface OcclusionState extends Disposable {
  // Raw mask processing
  rawCanvas: HTMLCanvasElement;
  rawCtx: CanvasRenderingContext2D;
  rawImageData: ImageData | null;

  // Feathered / processed mask
  processedCanvas: HTMLCanvasElement;
  processedCtx: CanvasRenderingContext2D;

  // Display-sized canvas
  displayCanvas: HTMLCanvasElement;
  displayCtx: CanvasRenderingContext2D;

  // Three.js objects
  texture: THREE.CanvasTexture;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

  // Multi-layer (optional finger layer)
  fingerMesh?: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  fingerTexture?: THREE.CanvasTexture;

  // State tracking
  width: number;
  height: number;
  isVisible: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Create Occluder
// ─────────────────────────────────────────────────────────────────────────────

export function createOccluder(): OcclusionState {
  const rawCanvas = document.createElement("canvas");
  const rawCtx = rawCanvas.getContext("2d", { willReadFrequently: true })!;

  const processedCanvas = document.createElement("canvas");
  const processedCtx = processedCanvas.getContext("2d")!;

  const displayCanvas = document.createElement("canvas");
  const displayCtx = displayCanvas.getContext("2d")!;

  const texture = new THREE.CanvasTexture(displayCanvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;

  const material = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    transparent: true,
    alphaTest: OCCLUSION_ALPHA_TEST,
    alphaMap: texture,
    side: THREE.DoubleSide,
  });

  const geometry = new THREE.PlaneGeometry(1, 1);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 0;
  mesh.visible = false;
  mesh.name = "hand-occluder";

  const state: OcclusionState = {
    rawCanvas,
    rawCtx,
    rawImageData: null,
    processedCanvas,
    processedCtx,
    displayCanvas,
    displayCtx,
    texture,
    mesh,
    width: 0,
    height: 0,
    isVisible: false,
    dispose: () => disposeOccluder(state),
  };

  if (MULTI_LAYER_OCCLUSION) {
    const fingerCanvas = document.createElement("canvas");
    const fingerTexture = new THREE.CanvasTexture(fingerCanvas);
    fingerTexture.minFilter = THREE.LinearFilter;
    fingerTexture.magFilter = THREE.LinearFilter;

    const fingerMaterial = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
      transparent: true,
      alphaTest: OCCLUSION_ALPHA_TEST,
      alphaMap: fingerTexture,
    });

    state.fingerMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      fingerMaterial,
    );
    state.fingerMesh.frustumCulled = false;
    state.fingerMesh.renderOrder = 0;
    state.fingerMesh.visible = false;
    state.fingerMesh.name = "finger-occluder";
    state.fingerTexture = fingerTexture;
  }

  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ensure Buffer Size
// ─────────────────────────────────────────────────────────────────────────────

function ensureRawBuffer(state: OcclusionState, width: number, height: number): void {
  if (state.width === width && state.height === height && state.rawImageData) return;

  state.width = width;
  state.height = height;

  state.rawCanvas.width = width;
  state.rawCanvas.height = height;
  state.rawImageData = state.rawCtx.createImageData(width, height);

  state.processedCanvas.width = width;
  state.processedCanvas.height = height;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSS Filter-based blur (fast, GPU-accelerated on most browsers)
// ─────────────────────────────────────────────────────────────────────────────

function applyCanvasBlur(
  sourceCanvas: HTMLCanvasElement,
  targetCtx: CanvasRenderingContext2D,
  radius: number,
): void {
  targetCtx.filter = radius > 0 ? `blur(${radius}px)` : "none";
  targetCtx.drawImage(sourceCanvas, 0, 0);
  targetCtx.filter = "none";
}

// ─────────────────────────────────────────────────────────────────────────────
// Temporal Blending — persistent buffer for cross-frame smoothing
// ─────────────────────────────────────────────────────────────────────────────

let _prevMask: Float32Array | null = null;
const TEMPORAL_BLEND_ALPHA = 0.35; // weight of the new frame (lower = smoother but laggier)

/** Hermite smooth-step: suppresses noise below `edge0`, saturates above `edge1`. */
function smoothStep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// ─────────────────────────────────────────────────────────────────────────────
// Update Occlusion Mask
// ─────────────────────────────────────────────────────────────────────────────

export function updateOcclusionMask(
  state: OcclusionState,
  mask: {
    width: number;
    height: number;
    getAsFloat32Array?: () => Float32Array;
    getAsUint8Array?: () => Uint8Array;
  } | null,
  layout: VideoLayout,
): void {
  if (!OCCLUSION_ENABLED || !mask) {
    state.mesh.visible = false;
    state.isVisible = false;
    if (state.fingerMesh) state.fingerMesh.visible = false;
    return;
  }

  ensureRawBuffer(state, mask.width, mask.height);
  const imageData = state.rawImageData;
  if (!imageData) return;

  const floatMask = mask.getAsFloat32Array?.() ?? null;
  const byteMask = !floatMask ? (mask.getAsUint8Array?.() ?? null) : null;
  const data = imageData.data;
  const pixelCount = mask.width * mask.height;

  // Allocate / resize temporal buffer if needed.
  if (!_prevMask || _prevMask.length !== pixelCount) {
    _prevMask = new Float32Array(pixelCount);
  }

  for (let i = 0; i < pixelCount; i++) {
    // Read raw confidence value [0..1].
    const raw = floatMask
      ? floatMask[i]
      : byteMask
        ? byteMask[i] / 255
        : 0;

    // Smooth-step: suppresses sub-0.12 noise, saturates above 0.55.
    // This creates a soft gradient at hair/skin edges instead of a hard cutoff.
    const stepped = smoothStep(0.12, 0.55, raw);

    // Temporal blend: combine with previous frame to eliminate flicker.
    const blended = _prevMask[i] * (1 - TEMPORAL_BLEND_ALPHA) + stepped * TEMPORAL_BLEND_ALPHA;
    _prevMask[i] = blended;

    const value = Math.min(255, blended * 255);
    const offset = i * 4;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  }

  state.rawCtx.putImageData(imageData, 0, 0);

  if (OCCLUSION_FEATHER_ENABLED && OCCLUSION_FEATHER_RADIUS > 0) {
    applyCanvasBlur(state.rawCanvas, state.processedCtx, OCCLUSION_FEATHER_RADIUS);
  } else {
    state.processedCtx.drawImage(state.rawCanvas, 0, 0);
  }

  // Apply occlusion strength as a global alpha draw.
  if (OCCLUSION_STRENGTH < 1) {
    state.processedCtx.globalAlpha = OCCLUSION_STRENGTH;
    state.processedCtx.drawImage(state.processedCanvas, 0, 0);
    state.processedCtx.globalAlpha = 1;
  }

  if (
    state.displayCanvas.width !== layout.containerWidth ||
    state.displayCanvas.height !== layout.containerHeight
  ) {
    state.displayCanvas.width = layout.containerWidth;
    state.displayCanvas.height = layout.containerHeight;
  }

  state.displayCtx.clearRect(0, 0, layout.containerWidth, layout.containerHeight);
  state.displayCtx.drawImage(
    state.processedCanvas,
    0, 0, mask.width, mask.height,
    layout.offsetX, layout.offsetY,
    layout.displayWidth, layout.displayHeight,
  );

  state.texture.needsUpdate = true;
  state.mesh.visible = true;
  state.isVisible = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Update Occluder Plane Position
// ─────────────────────────────────────────────────────────────────────────────

/** Reusable forward vector to avoid per-frame allocation. */
const _forward = new THREE.Vector3();

export function updateOccluderPlane(
  state: OcclusionState,
  camera: THREE.PerspectiveCamera,
  depth: number,
  landmarks?: readonly Landmark[],
): void {
  const distance = Math.max(depth - OCCLUSION_DEPTH_BIAS, camera.near + 0.01);
  const height = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  const width = height * camera.aspect;

  _forward.set(0, 0, -1).applyQuaternion(camera.quaternion);

  state.mesh.scale.set(width, height, 1);
  state.mesh.position.copy(camera.position).addScaledVector(_forward, distance);
  state.mesh.quaternion.copy(camera.quaternion);

  if (MULTI_LAYER_OCCLUSION && state.fingerMesh && landmarks && landmarks.length >= 21) {
    const fingerDist = Math.max(
      depth - OCCLUSION_DEPTH_BIAS - FINGER_DEPTH_OFFSET,
      camera.near + 0.005,
    );
    const fh = 2 * fingerDist * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const fw = fh * camera.aspect;

    _forward.set(0, 0, -1).applyQuaternion(camera.quaternion);

    state.fingerMesh.scale.set(fw, fh, 1);
    state.fingerMesh.position.copy(camera.position).addScaledVector(_forward, fingerDist);
    state.fingerMesh.quaternion.copy(camera.quaternion);
    state.fingerMesh.visible = state.mesh.visible;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hide Occlusion
// ─────────────────────────────────────────────────────────────────────────────

export function hideOcclusion(state: OcclusionState): void {
  state.mesh.visible = false;
  state.isVisible = false;
  if (state.fingerMesh) state.fingerMesh.visible = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Get Occluder Meshes (for adding to scene)
// ─────────────────────────────────────────────────────────────────────────────

export function getOccluderMeshes(state: OcclusionState): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [state.mesh];
  if (state.fingerMesh) meshes.push(state.fingerMesh);
  return meshes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispose — release all GPU + canvas resources
// ─────────────────────────────────────────────────────────────────────────────

function disposeOccluder(state: OcclusionState): void {
  state.texture.dispose();
  (state.mesh.material as THREE.MeshBasicMaterial).dispose();
  state.mesh.geometry.dispose();

  if (state.fingerTexture) state.fingerTexture.dispose();
  if (state.fingerMesh) {
    (state.fingerMesh.material as THREE.MeshBasicMaterial).dispose();
    state.fingerMesh.geometry.dispose();
  }

  // Release canvas memory.
  state.rawCanvas.width = 0;
  state.rawCanvas.height = 0;
  state.processedCanvas.width = 0;
  state.processedCanvas.height = 0;
  state.displayCanvas.width = 0;
  state.displayCanvas.height = 0;
}
