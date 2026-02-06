/**
 * @module main
 * Application entry point for the Holdable Umbrella WebAR experience.
 *
 * Production-quality patterns:
 *  - **Feature gating** — checks WebGL + camera API before starting.
 *  - **Lifecycle management** — `start()` / `stop()` / `dispose()` with full
 *    resource cleanup (GPU textures, camera streams, animation frame).
 *  - **Error boundaries** — the render loop is wrapped in try/catch with
 *    automatic retry + graceful degradation.
 *  - **Accessibility** — ARIA live regions, focus management, keyboard nav.
 *  - **Safe DOM queries** — every `querySelector` is null-checked.
 */

import "./style.css";
import * as THREE from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { computeAnchor, resetAnchorCache } from "./anchor";
import { BodySegmenter, createImageSegmenter } from "./bodySegmenter";
import { setupCamera, stopCamera, switchCamera, getCurrentFacingMode } from "./camera";
import {
  HAND_TRACK_FPS,
  MAX_DEPTH,
  MIRROR_VIEW,
  MODEL_SCALE,
  MODEL_URL,
  POS_SMOOTHING,
  ROT_SMOOTHING,
  SCALE_SMOOTHING,
  VIDEO_FIT,
  AMBIENT_INTENSITY,
  KEY_LIGHT_INTENSITY,
  FILL_LIGHT_INTENSITY,
  RIM_LIGHT_INTENSITY,
  USE_ENVIRONMENT_MAP,
  ENVIRONMENT_INTENSITY,
  CONTACT_SHADOW_ENABLED,
  CONTACT_SHADOW_OPACITY,
  SELF_SHADOW_ENABLED,
  SHADOW_MAP_SIZE,
  SHADOW_RADIUS,
  TONE_MAPPING_EXPOSURE,
  SHOW_LOADING_PROGRESS,
  GUIDANCE_SHOW_DELAY_MS,
  OCCLUSION_ENABLED,
  GRIP_OCCLUDER_ENABLED,
  GRIP_OCCLUDER_RADIUS,
  GRIP_OCCLUDER_Z_NUDGE,
  GRIP_OCCLUDER_SHAPE,
  GRIP_OFFSET,
  BODY_OCCLUSION_ENABLED,
  BODY_SEGMENTER_FPS,
  CAMERA_SWITCH_ENABLED,
  detectFeatures,
} from "./config";
import { drawLandmarks } from "./debug";
import { HandTracker, createHandLandmarker } from "./handTracker";
import { computeVideoLayout } from "./layout";
import {
  createOccluder,
  updateOccluderPlane,
  updateOcclusionMask,
  hideOcclusion,
  getOccluderMeshes,
} from "./occlusion";
import type { OcclusionState } from "./occlusion";
import { PoseSmoother, ScaleSmoother } from "./smoothing";
import type { AnchorData, VideoLayout, AppState } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Safe DOM Helpers
// ─────────────────────────────────────────────────────────────────────────────

function requireElement<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Required DOM element not found: ${selector}`);
  return el;
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM Elements (fail fast if the HTML contract is broken)
// ─────────────────────────────────────────────────────────────────────────────

const stage = requireElement<HTMLElement>("#stage");
const video = requireElement<HTMLVideoElement>("#video");
const canvas = requireElement<HTMLCanvasElement>("#three");
const debugCanvas = requireElement<HTMLCanvasElement>("#debug");
const startButton = requireElement<HTMLButtonElement>("#start");
const captureButton = requireElement<HTMLButtonElement>("#capture");
const debugButton = requireElement<HTMLButtonElement>("#toggle-debug");
const switchCamButton = document.querySelector<HTMLButtonElement>("#switch-camera");
const statusEl = requireElement<HTMLDivElement>("#status");
const hintEl = requireElement<HTMLDivElement>("#hint");

const debugCtx = debugCanvas.getContext("2d")!;

video.style.objectFit = VIDEO_FIT;

// ─────────────────────────────────────────────────────────────────────────────
// Three.js Setup
// ─────────────────────────────────────────────────────────────────────────────

const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: true,
  preserveDrawingBuffer: true,
  powerPreference: "high-performance",
});
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
renderer.shadowMap.enabled = SELF_SHADOW_ENABLED;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

let dpr = Math.min(window.devicePixelRatio, 2);
renderer.setPixelRatio(dpr);
renderer.setClearColor(0x000000, 0);

// ── WebGL context loss / restore (critical on mobile) ────────────────────
// Mobile browsers aggressively kill WebGL contexts when backgrounded or
// under memory pressure.  Without these handlers the app silently dies.
let webglContextLost = false;

canvas.addEventListener("webglcontextlost", (e: Event) => {
  e.preventDefault(); // Allows restoration.
  webglContextLost = true;
  console.warn("[WebGL] Context lost — pausing render loop.");
  setStatus("Recovering graphics\u2026");
}, false);

canvas.addEventListener("webglcontextrestored", () => {
  webglContextLost = false;
  console.log("[WebGL] Context restored — resuming.");
  // Three.js re-uploads textures automatically on the next render call.
  dpr = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(dpr);
  if (running) setStatus("Tracking");
}, false);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 10);
camera.position.set(0, 0, 0);
camera.lookAt(0, 0, -1);

// ─────────────────────────────────────────────────────────────────────────────
// Umbrella Model Groups
// ─────────────────────────────────────────────────────────────────────────────

const anchorRoot = new THREE.Group();
const umbrellaRoot = new THREE.Group();
anchorRoot.add(umbrellaRoot);
umbrellaRoot.renderOrder = 1;
umbrellaRoot.visible = false;
scene.add(anchorRoot);

// ─────────────────────────────────────────────────────────────────────────────
// Lighting — realistic 3-point setup
// ─────────────────────────────────────────────────────────────────────────────

const ambient = new THREE.HemisphereLight(0xffffff, 0x303040, AMBIENT_INTENSITY);
scene.add(ambient);

const keyLight = new THREE.DirectionalLight(0xfffaf0, KEY_LIGHT_INTENSITY);
keyLight.position.set(1, 2, 2);
keyLight.castShadow = SELF_SHADOW_ENABLED;
if (SELF_SHADOW_ENABLED) {
  keyLight.shadow.mapSize.width = SHADOW_MAP_SIZE;
  keyLight.shadow.mapSize.height = SHADOW_MAP_SIZE;
  keyLight.shadow.camera.near = 0.01;
  keyLight.shadow.camera.far = 5;
  keyLight.shadow.camera.left = -0.5;
  keyLight.shadow.camera.right = 0.5;
  keyLight.shadow.camera.top = 0.5;
  keyLight.shadow.camera.bottom = -0.5;
  keyLight.shadow.bias = -0.002;
  keyLight.shadow.normalBias = 0.02;  // Reduces acne on curved surfaces (canopy)
  keyLight.shadow.radius = SHADOW_RADIUS;
}
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xf0f5ff, FILL_LIGHT_INTENSITY);
fillLight.position.set(-1.5, 1, 1);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xffffff, RIM_LIGHT_INTENSITY);
rimLight.position.set(0, 0.5, -2);
scene.add(rimLight);

// ─────────────────────────────────────────────────────────────────────────────
// Environment Map
// ─────────────────────────────────────────────────────────────────────────────

let environmentMap: THREE.Texture | null = null;

async function loadEnvironmentMap(): Promise<void> {
  if (!USE_ENVIRONMENT_MAP) return;

  try {
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();

    const gradientCanvas = document.createElement("canvas");
    gradientCanvas.width = 256;
    gradientCanvas.height = 128;
    const gCtx = gradientCanvas.getContext("2d")!;

    const gradient = gCtx.createLinearGradient(0, 0, 0, gradientCanvas.height);
    gradient.addColorStop(0, "#87CEEB");
    gradient.addColorStop(0.4, "#E0E8F0");
    gradient.addColorStop(1, "#F5F5F5");

    gCtx.fillStyle = gradient;
    gCtx.fillRect(0, 0, gradientCanvas.width, gradientCanvas.height);

    const gradientTexture = new THREE.CanvasTexture(gradientCanvas);
    gradientTexture.mapping = THREE.EquirectangularReflectionMapping;

    environmentMap = pmremGenerator.fromEquirectangular(gradientTexture).texture;
    scene.environment = environmentMap;
    scene.environmentIntensity = ENVIRONMENT_INTENSITY;

    pmremGenerator.dispose();
    gradientTexture.dispose();
    // Free the gradient canvas memory.
    gradientCanvas.width = 0;
    gradientCanvas.height = 0;
  } catch (error) {
    console.warn("Failed to create environment map:", error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Contact Shadow Plane
// ─────────────────────────────────────────────────────────────────────────────

let shadowPlane: THREE.Mesh | null = null;

function createShadowPlane(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(0.3, 0.3);
  const material = new THREE.ShadowMaterial({
    opacity: CONTACT_SHADOW_OPACITY,
    transparent: true,
  });
  const plane = new THREE.Mesh(geometry, material);
  plane.receiveShadow = true;
  plane.rotation.x = -Math.PI / 2;
  plane.visible = false;
  return plane;
}

// ─────────────────────────────────────────────────────────────────────────────
// Occlusion (mask-based — only active if an external mask provider is wired)
// ─────────────────────────────────────────────────────────────────────────────

let occlusion: OcclusionState | null = null;

function initOcclusion(): void {
  if (!OCCLUSION_ENABLED) return;
  occlusion = createOccluder();
  for (const mesh of getOccluderMeshes(occlusion)) {
    scene.add(mesh);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Grip Occluder — invisible depth-only ellipsoid at the fist position
//
// This is the PRIMARY occlusion mechanism.  It creates the illusion that the
// user's fingers wrap around the umbrella handle by preventing the shaft from
// rendering inside the "virtual fist" zone.
//
// How it works:
//   1. The umbrella handle is pushed BEHIND the hand (GRIP_OFFSET.z < 0).
//   2. The grip occluder sits AT the hand, slightly toward the camera.
//   3. Because the occluder writes to the depth buffer (colorWrite=false,
//      depthWrite=true), the shaft section that falls behind the occluder
//      fails the depth test and is not drawn.
//   4. Above and below the ellipsoid, the shaft emerges naturally — the
//      J-hook is visible below the fist, and the shaft runs up to the canopy.
//
// Visible/hidden anatomy (selfie, standard upright hold):
//   ┌─ Canopy ──────────────────────────────────────────┐
//   │  ★ Visible: entire outer canopy + ribs + ferrule  │
//   │  ★ Behind-head portion: renders on top (no body   │
//   │    segmentation — acceptable for WebAR).          │
//   ├─ Shaft above fist ───────────────────────────────-┤
//   │  ★ Visible: shaft from canopy down to top of fist │
//   ├─ FIST ZONE (grip occluder active) ───────────────-┤
//   │  ✗ Hidden: ~7–8 cm of shaft inside the ellipsoid  │
//   ├─ Shaft below fist / J-hook ──────────────────────-┤
//   │  ★ Visible: shaft stub + J-hook below the fist    │
//   └───────────────────────────────────────────────────-┘
// ─────────────────────────────────────────────────────────────────────────────

let gripOccluder: THREE.Mesh | null = null;

/** Reusable temp vector to reverse GRIP_OFFSET in updatePose. */
const _gripOffsetTmp = new THREE.Vector3();

function createGripOccluder(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1, 20, 14);
  const mat = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 0; // Render BEFORE the umbrella (renderOrder 1).
  mesh.visible = false;
  mesh.name = "grip-occluder";
  return mesh;
}

function initGripOccluder(): void {
  if (!GRIP_OCCLUDER_ENABLED) return;
  gripOccluder = createGripOccluder();
  scene.add(gripOccluder);
  console.log("[GripOccluder] Created — radius:", GRIP_OCCLUDER_RADIUS, "shape:", GRIP_OCCLUDER_SHAPE);
}

// ─────────────────────────────────────────────────────────────────────────────
// Smoothing
// ─────────────────────────────────────────────────────────────────────────────

const poseSmoother = new PoseSmoother(POS_SMOOTHING, ROT_SMOOTHING);
// Wider scale range (0.7x–1.5x) so the umbrella can grow to realistic size.
const scaleSmoother = new ScaleSmoother(SCALE_SMOOTHING, 0.7, 1.5);

// ─────────────────────────────────────────────────────────────────────────────
// Application State
// ─────────────────────────────────────────────────────────────────────────────

let appState: AppState = "idle";
let tracker: HandTracker | null = null;
let bodySegmenter: BodySegmenter | null = null;
let running = false;
let debugEnabled = false;
let layout: VideoLayout | null = null;
let lastHandDetectedTime = 0;
let showingGuidance = false;
let animFrameId = 0; // Tracks rAF for cancellation.
let consecutiveRenderErrors = 0;
const MAX_RENDER_ERRORS = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Mirror
// ─────────────────────────────────────────────────────────────────────────────

if (MIRROR_VIEW) {
  stage.classList.add("mirror");
}

// ─────────────────────────────────────────────────────────────────────────────
// Status & UI
// ─────────────────────────────────────────────────────────────────────────────

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function setHint(text: string, visible = true): void {
  hintEl.textContent = text;
  hintEl.style.opacity = visible ? "1" : "0";
  // ARIA live region will announce changes automatically.
}

function updateAppState(newState: AppState): void {
  appState = newState;
  statusEl.setAttribute("data-state", newState);

  switch (newState) {
    case "idle":
      setStatus("Ready");
      setHint("Tap 'Start Camera' to begin");
      startButton.focus();
      break;
    case "loading-camera":
      setStatus("Starting camera\u2026");
      setHint("Please allow camera access", true);
      break;
    case "loading-tracker":
      setStatus("Loading hand tracker\u2026");
      setHint("Preparing AI model\u2026", true);
      break;
    case "loading-model":
      setStatus("Loading umbrella\u2026");
      setHint("Almost ready\u2026", true);
      break;
    case "ready":
      setStatus("Ready");
      setHint("Show your hand to see the umbrella");
      break;
    case "tracking":
      setStatus("Tracking");
      setHint("Hold your hand as if gripping an umbrella", true);
      break;
    case "error":
      setStatus("Error");
      setHint("Something went wrong. Please refresh.", true);
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fallback Umbrella
// ─────────────────────────────────────────────────────────────────────────────

function buildFallbackUmbrella(): THREE.Group {
  const group = new THREE.Group();

  const canopyGeo = new THREE.ConeGeometry(0.25, 0.15, 32, 1, true);
  const canopyMat = new THREE.MeshStandardMaterial({
    color: 0x2f6bff,
    roughness: 0.35,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
  const canopy = new THREE.Mesh(canopyGeo, canopyMat);
  canopy.position.set(0, 0.08, 0);
  canopy.castShadow = SELF_SHADOW_ENABLED;
  canopy.receiveShadow = SELF_SHADOW_ENABLED;

  const shaftGeo = new THREE.CylinderGeometry(0.008, 0.01, 0.32, 16);
  const shaftMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a,
    roughness: 0.5,
    metalness: 0.3,
  });
  const shaft = new THREE.Mesh(shaftGeo, shaftMat);
  shaft.position.set(0, -0.08, 0);
  shaft.castShadow = SELF_SHADOW_ENABLED;
  shaft.receiveShadow = SELF_SHADOW_ENABLED;

  const hookGeo = new THREE.TorusGeometry(0.035, 0.008, 12, 24, Math.PI);
  const hookMat = new THREE.MeshStandardMaterial({
    color: 0x2a2a2a,
    roughness: 0.4,
    metalness: 0.2,
  });
  const hook = new THREE.Mesh(hookGeo, hookMat);
  hook.position.set(0, -0.24, 0.02);
  hook.rotation.set(Math.PI / 2, 0, 0);
  hook.castShadow = SELF_SHADOW_ENABLED;
  hook.receiveShadow = SELF_SHADOW_ENABLED;

  const finialGeo = new THREE.SphereGeometry(0.012, 16, 12);
  const finial = new THREE.Mesh(finialGeo, shaftMat);
  finial.position.set(0, 0.155, 0);
  finial.castShadow = SELF_SHADOW_ENABLED;
  finial.receiveShadow = SELF_SHADOW_ENABLED;

  group.add(canopy, shaft, hook, finial);
  group.scale.setScalar(0.85);

  return group;
}

// ─────────────────────────────────────────────────────────────────────────────
// Load Umbrella Model
// ─────────────────────────────────────────────────────────────────────────────

let dracoLoader: DRACOLoader | null = null;

async function loadUmbrellaModel(
  onProgress?: (progress: number) => void,
): Promise<THREE.Object3D> {
  console.log("Loading umbrella model from:", MODEL_URL);

  const loader = new GLTFLoader();

  try {
    dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(
      "https://www.gstatic.com/draco/versioned/decoders/1.5.6/",
    );
    loader.setDRACOLoader(dracoLoader);
  } catch (e) {
    console.warn("DRACO loader setup failed, continuing without:", e);
  }

  return new Promise<THREE.Object3D>((resolve) => {
    loader.load(
      MODEL_URL,
      (gltf) => {
        console.log("GLB loaded successfully!");
        const model = gltf.scene;

        model.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            // Cast AND receive shadows for self-shadowing between parts
            // (e.g. shaft shadow on canopy, ribs on fabric)
            child.castShadow = SELF_SHADOW_ENABLED;
            child.receiveShadow = SELF_SHADOW_ENABLED;
            if (child.material) {
              const materials = Array.isArray(child.material)
                ? child.material
                : [child.material];
              for (const mat of materials) {
                if (mat instanceof THREE.MeshStandardMaterial) {
                  mat.envMapIntensity = ENVIRONMENT_INTENSITY;
                  // Ensure PBR properties exist for realistic light response.
                  // Only touch roughness/metalness if they look like defaults
                  // that the artist didn't intentionally set (avoids overriding
                  // carefully authored materials from the GLB).
                  mat.needsUpdate = true;
                }
              }
            }
          }
        });

        onProgress?.(100);
        resolve(model);
      },
      (xhr) => {
        if (xhr.total > 0) {
          const progress = (xhr.loaded / xhr.total) * 100;
          onProgress?.(progress);
        }
      },
      (error) => {
        console.error("GLB load error:", error);
        console.warn("Using fallback umbrella model");
        onProgress?.(100);
        resolve(buildFallbackUmbrella());
      },
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout
// ─────────────────────────────────────────────────────────────────────────────

function updateLayout(): void {
  const rect = stage.getBoundingClientRect();
  layout = computeVideoLayout(
    rect.width,
    rect.height,
    video.videoWidth,
    video.videoHeight,
  );

  dpr = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(rect.width, rect.height, false);
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();

  debugCanvas.width = rect.width;
  debugCanvas.height = rect.height;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pose Update
// ─────────────────────────────────────────────────────────────────────────────

function updatePose(anchor: AnchorData, timeMs: number): void {
  const smoothed = poseSmoother.update(
    anchor.position,
    anchor.quaternion,
    timeMs,
  );

  umbrellaRoot.position.copy(smoothed.predictedPosition);
  umbrellaRoot.quaternion.copy(smoothed.quaternion).multiply(runtimeRotationOffset);

  const scale = scaleSmoother.update(anchor.palmWidthPx, MODEL_SCALE);
  umbrellaRoot.scale.setScalar(scale);

  // ── Grip occluder: position at the raw hand centre ─────────────────────
  // smoothed.predictedPosition already includes GRIP_OFFSET (applied in
  // anchor.ts).  Reverse the offset to recover the physical fist centre.
  if (GRIP_OCCLUDER_ENABLED && gripOccluder) {
    // Step 1: Reverse rotated GRIP_OFFSET to find the physical fist centre.
    _gripOffsetTmp.set(GRIP_OFFSET.x, GRIP_OFFSET.y, GRIP_OFFSET.z);
    _gripOffsetTmp.applyQuaternion(smoothed.quaternion);
    gripOccluder.position
      .copy(smoothed.predictedPosition)
      .sub(_gripOffsetTmp);

    // Step 2: Nudge toward camera so the occluder front surface sits
    // firmly between the camera and the handle (which is pushed back by
    // GRIP_OFFSET.z).  Use the actual camera direction instead of just
    // world +Z so it works correctly even when the hand is tilted.
    _gripOffsetTmp
      .copy(camera.position)
      .sub(gripOccluder.position)
      .normalize();
    gripOccluder.position.addScaledVector(_gripOffsetTmp, GRIP_OCCLUDER_Z_NUDGE);

    // Step 3: Orient to match the umbrella so the ellipsoid aligns with the
    // shaft direction (fist is taller along the shaft than across it).
    gripOccluder.quaternion
      .copy(smoothed.quaternion)
      .multiply(runtimeRotationOffset);

    // Step 4: Scale into a fist-shaped ellipsoid.
    gripOccluder.scale.set(
      GRIP_OCCLUDER_RADIUS * GRIP_OCCLUDER_SHAPE.x,
      GRIP_OCCLUDER_RADIUS * GRIP_OCCLUDER_SHAPE.y,
      GRIP_OCCLUDER_RADIUS * GRIP_OCCLUDER_SHAPE.z,
    );

    gripOccluder.visible = true;
  }

  if (shadowPlane) {
    shadowPlane.position.copy(smoothed.predictedPosition);
    shadowPlane.position.y -= 0.15;
    shadowPlane.visible = true;
  }

  keyLight.target.position.copy(smoothed.predictedPosition);
  keyLight.target.updateMatrixWorld();
}

// ─────────────────────────────────────────────────────────────────────────────
// Clear Pose
// ─────────────────────────────────────────────────────────────────────────────

function clearPose(): void {
  umbrellaRoot.visible = false;
  if (occlusion) hideOcclusion(occlusion);
  if (gripOccluder) gripOccluder.visible = false;
  if (shadowPlane) shadowPlane.visible = false;
  debugCtx.clearRect(0, 0, debugCanvas.width, debugCanvas.height);
  poseSmoother.reset();
  scaleSmoother.reset();
}

// ─────────────────────────────────────────────────────────────────────────────
// Guidance
// ─────────────────────────────────────────────────────────────────────────────

function updateGuidance(handDetected: boolean, timeMs: number): void {
  if (handDetected) {
    lastHandDetectedTime = timeMs;
    if (showingGuidance) {
      showingGuidance = false;
      setHint("Hold your hand as if gripping an umbrella", true);
    }
  } else {
    const elapsed = timeMs - lastHandDetectedTime;
    if (elapsed > GUIDANCE_SHOW_DELAY_MS && !showingGuidance) {
      showingGuidance = true;
      setHint("Show your palm to the camera", true);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature Gate
// ─────────────────────────────────────────────────────────────────────────────

function checkFeatures(): string | null {
  const features = detectFeatures();
  if (!features.webgl) return "WebGL is not supported by your browser.";
  if (!features.mediaDevices) return "Camera access is not available (HTTPS required).";
  if (!features.wasm) return "WebAssembly is required for hand tracking.";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Start Application
// ─────────────────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  // Feature gate.
  const featureError = checkFeatures();
  if (featureError) {
    updateAppState("error");
    setStatus(featureError);
    return;
  }

  updateAppState("loading-camera");
  startButton.disabled = true;

  try {
    await setupCamera(video);
    updateLayout();

    updateAppState("loading-model");
    await loadEnvironmentMap();
    initOcclusion();
    initGripOccluder();

    updateAppState("loading-tracker");
    const landmarker = await createHandLandmarker((progress, message) => {
      if (SHOW_LOADING_PROGRESS) setStatus(`${message} (${progress.toFixed(0)}%)`);
    });
    tracker = new HandTracker(landmarker, HAND_TRACK_FPS);

    // Body segmenter — runs alongside hand tracking at lower FPS.
    if (BODY_OCCLUSION_ENABLED) {
      try {
        const imgSegmenter = await createImageSegmenter((progress, message) => {
          if (SHOW_LOADING_PROGRESS) setStatus(`${message} (${progress.toFixed(0)}%)`);
        });
        bodySegmenter = new BodySegmenter(imgSegmenter, BODY_SEGMENTER_FPS);
        console.log("[BodySegmenter] Initialized at", BODY_SEGMENTER_FPS, "FPS");
      } catch (bodyErr) {
        console.warn("[BodySegmenter] Failed to initialize (non-critical):", bodyErr);
        // Body occlusion is an enhancement — app works without it.
      }
    }

    updateAppState("loading-model");
    const model = await loadUmbrellaModel((progress) => {
      if (SHOW_LOADING_PROGRESS) setStatus(`Loading umbrella\u2026 ${progress.toFixed(0)}%`);
    });

    umbrellaRoot.clear();
    umbrellaRoot.add(model);
    umbrellaRoot.visible = true;

    if (CONTACT_SHADOW_ENABLED) {
      shadowPlane = createShadowPlane();
      scene.add(shadowPlane);
    }

    running = true;
    consecutiveRenderErrors = 0;
    captureButton.disabled = false;
    if (switchCamButton && CAMERA_SWITCH_ENABLED) switchCamButton.disabled = false;
    updateAppState("ready");
    lastHandDetectedTime = performance.now();

    animFrameId = requestAnimationFrame(renderLoop);
  } catch (error) {
    console.error("Startup error:", error);
    updateAppState("error");
    setStatus(
      `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    startButton.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stop / Dispose
// ─────────────────────────────────────────────────────────────────────────────

function stop(): void {
  running = false;

  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = 0;
  }

  // Release tracker (closes MediaPipe WASM).
  tracker?.dispose();
  tracker = null;

  // Release body segmenter.
  bodySegmenter?.dispose();
  bodySegmenter = null;

  // Stop camera stream.
  stopCamera(video);

  // Release DRACO decoder.
  dracoLoader?.dispose();
  dracoLoader = null;

  // Release occlusion GPU resources.
  occlusion?.dispose();
  occlusion = null;

  // Dispose grip occluder.
  if (gripOccluder) {
    gripOccluder.geometry.dispose();
    (gripOccluder.material as THREE.Material).dispose();
    scene.remove(gripOccluder);
    gripOccluder = null;
  }

  // Release environment map.
  if (environmentMap) {
    environmentMap.dispose();
    environmentMap = null;
    scene.environment = null;
  }

  // Dispose shadow plane.
  if (shadowPlane) {
    (shadowPlane.geometry as THREE.BufferGeometry).dispose();
    (shadowPlane.material as THREE.Material).dispose();
    scene.remove(shadowPlane);
    shadowPlane = null;
  }

  // Dispose umbrella model materials & geometries.
  umbrellaRoot.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) {
        child.material.forEach((m) => m.dispose());
      } else {
        child.material?.dispose();
      }
    }
  });
  umbrellaRoot.clear();

  poseSmoother.dispose();
  scaleSmoother.dispose();

  captureButton.disabled = true;
  startButton.disabled = false;
  updateAppState("idle");
}

// ─────────────────────────────────────────────────────────────────────────────
// Render Loop — with error boundary
// ─────────────────────────────────────────────────────────────────────────────

let framesWithoutGrip = 0;
let framesWithGrip = 0;
let modelVisible = false;

const FRAMES_TO_SHOW = 3;
const FRAMES_TO_HIDE = 12;

function renderLoop(timeMs: number): void {
  if (!running || !layout || !tracker) return;

  // Skip rendering while the browser has killed our WebGL context (mobile bg).
  if (webglContextLost) {
    animFrameId = requestAnimationFrame(renderLoop);
    return;
  }

  try {
    const result = tracker.detect(video, timeMs);
    const hasHand = result.pose !== null;

    updateGuidance(hasHand, timeMs);

    if (result.pose && result.handState) {
      const anchor = computeAnchor(result.pose, result.handState, layout, camera);
      const isGripping =
        result.handState.grip === "gripping" || result.handState.grip === "fist";

      if (debugEnabled) {
        drawLandmarks(debugCtx, result.pose, layout, result.handState, anchor);
      }

      // Visibility hysteresis.
      if (isGripping) {
        framesWithGrip++;
        framesWithoutGrip = 0;
        if (framesWithGrip >= FRAMES_TO_SHOW) modelVisible = true;
      } else {
        framesWithoutGrip++;
        framesWithGrip = Math.max(0, framesWithGrip - 1);
        if (framesWithoutGrip >= FRAMES_TO_HIDE) modelVisible = false;
      }

      if (modelVisible && anchor) {
        umbrellaRoot.visible = true;
        updatePose(anchor, timeMs);

        // Body occlusion — feed the selfie segmenter mask into the
        // existing occlusion pipeline so the canopy renders BEHIND
        // the user's head/body, not on top of it.
        if (OCCLUSION_ENABLED && occlusion) {
          const bodyMask = bodySegmenter?.segment(video, timeMs) ?? null;
          updateOcclusionMask(occlusion, bodyMask, layout);
          updateOccluderPlane(
            occlusion,
            camera,
            Math.min(anchor.depth, MAX_DEPTH),
            result.pose.landmarks,
          );
        }

        if (appState !== "tracking") updateAppState("tracking");
      } else {
        umbrellaRoot.visible = false;
        if (gripOccluder) gripOccluder.visible = false;
        if (appState === "tracking") updateAppState("ready");
      }
    } else {
      if (debugEnabled) {
        debugCtx.clearRect(0, 0, debugCanvas.width, debugCanvas.height);
      }

      framesWithGrip = 0;
      framesWithoutGrip++;

      if (framesWithoutGrip >= FRAMES_TO_HIDE) {
        modelVisible = false;
        clearPose();
        resetAnchorCache();
        if (appState === "tracking") updateAppState("ready");
      }
    }

    renderer.render(scene, camera);
    consecutiveRenderErrors = 0; // Reset on success.
  } catch (error) {
    consecutiveRenderErrors++;
    console.error(`Render error (${consecutiveRenderErrors}/${MAX_RENDER_ERRORS}):`, error);

    if (consecutiveRenderErrors >= MAX_RENDER_ERRORS) {
      console.error("Too many consecutive render errors — stopping.");
      updateAppState("error");
      setStatus("Rendering stopped due to repeated errors. Please refresh.");
      stop();
      return;
    }
  }

  animFrameId = requestAnimationFrame(renderLoop);
}

// ─────────────────────────────────────────────────────────────────────────────
// Photo Capture
// ─────────────────────────────────────────────────────────────────────────────

function capturePhoto(): void {
  if (!layout) return;

  const width = layout.containerWidth * dpr;
  const height = layout.containerHeight * dpr;

  const captureCanvas = document.createElement("canvas");
  captureCanvas.width = width;
  captureCanvas.height = height;

  const ctx = captureCanvas.getContext("2d")!;
  ctx.save();

  if (MIRROR_VIEW) {
    ctx.scale(-1, 1);
    ctx.drawImage(video, -width, 0, width, height);
    ctx.drawImage(renderer.domElement, -width, 0, width, height);
  } else {
    ctx.drawImage(video, 0, 0, width, height);
    ctx.drawImage(renderer.domElement, 0, 0, width, height);
  }

  ctx.restore();

  // Subtle vignette.
  const gradient = ctx.createRadialGradient(
    width / 2, height / 2, 0,
    width / 2, height / 2, Math.max(width, height) * 0.7,
  );
  gradient.addColorStop(0.7, "rgba(0,0,0,0)");
  gradient.addColorStop(1, "rgba(0,0,0,0.15)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const dataUrl = captureCanvas.toDataURL("image/png");
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = `umbrella-ar-${Date.now()}.png`;
  link.click();

  // Free canvas memory immediately.
  captureCanvas.width = 0;
  captureCanvas.height = 0;

  // Flash feedback.
  stage.style.opacity = "0.7";
  setTimeout(() => {
    stage.style.opacity = "1";
  }, 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug Toggle
// ─────────────────────────────────────────────────────────────────────────────

function toggleDebug(): void {
  debugEnabled = !debugEnabled;
  debugButton.textContent = debugEnabled ? "Debug On" : "Debug";
  debugButton.classList.toggle("active", debugEnabled);
  debugButton.setAttribute("aria-pressed", String(debugEnabled));

  if (!debugEnabled) {
    debugCtx.clearRect(0, 0, debugCanvas.width, debugCanvas.height);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime Rotation Adjustment (debugging aid)
// ─────────────────────────────────────────────────────────────────────────────

const rotationPresets = Object.freeze([
  { name: "Default (no offset)", x: 0, y: 0, z: 0 },
  { name: "X+90", x: Math.PI / 2, y: 0, z: 0 },
  { name: "X-90", x: -Math.PI / 2, y: 0, z: 0 },
  { name: "Y+180", x: 0, y: Math.PI, z: 0 },
  { name: "X+180", x: Math.PI, y: 0, z: 0 },
  { name: "Z+90", x: 0, y: 0, z: Math.PI / 2 },
  { name: "Z-90", x: 0, y: 0, z: -Math.PI / 2 },
]);

let currentPresetIndex = 0;
const runtimeRotationOffset = new THREE.Quaternion();

function updateRuntimeRotation(): void {
  const preset = rotationPresets[currentPresetIndex];
  runtimeRotationOffset.setFromEuler(
    new THREE.Euler(preset.x, preset.y, preset.z, "XYZ"),
  );
  console.log(`Rotation: ${preset.name}`);
  if (currentPresetIndex !== 0) {
    setHint(`Rotation: ${preset.name}`, true);
  }
}

function cycleRotationPreset(direction: number): void {
  currentPresetIndex =
    (currentPresetIndex + direction + rotationPresets.length) %
    rotationPresets.length;
  updateRuntimeRotation();
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Listeners
// ─────────────────────────────────────────────────────────────────────────────

// ── Debounced resize — fires rapidly on mobile (keyboard, rotation) ──────
let _resizeTimer = 0;
function debouncedResize(): void {
  if (_resizeTimer) clearTimeout(_resizeTimer);
  _resizeTimer = window.setTimeout(() => {
    if (running) updateLayout();
  }, 120);
}

window.addEventListener("resize", debouncedResize);

// ── Orientation change — some mobile browsers fire this *instead of* resize
window.addEventListener("orientationchange", () => {
  // Delay to let the browser finish the orientation animation.
  setTimeout(() => { if (running) updateLayout(); }, 200);
});

// ── Visibility change — pause/resume for battery savings ─────────────────
document.addEventListener("visibilitychange", () => {
  if (document.hidden && running) {
    // intentionally left for future use (could pause tracking here)
  }
});

window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (!running) return;
  switch (e.key) {
    case "ArrowLeft":
    case "[":
      cycleRotationPreset(-1);
      break;
    case "ArrowRight":
    case "]":
      cycleRotationPreset(1);
      break;
    case "d":
      toggleDebug();
      break;
  }
});

startButton.addEventListener("click", start);
captureButton.addEventListener("click", capturePhoto);
debugButton.addEventListener("click", toggleDebug);

// ── Camera switching (front ↔ back) ─────────────────────────────────────
if (switchCamButton && CAMERA_SWITCH_ENABLED) {
  switchCamButton.addEventListener("click", async () => {
    if (!running) return;
    switchCamButton.disabled = true;
    setStatus("Switching camera…");

    try {
      await switchCamera(video);
      updateLayout();

      // Mirror only the front (selfie) camera.
      const isBackCamera = getCurrentFacingMode() === "environment";
      if (isBackCamera) {
        stage.classList.remove("mirror");
      } else if (MIRROR_VIEW) {
        stage.classList.add("mirror");
      }

      setStatus("Tracking");
    } catch (err) {
      console.error("[CameraSwitch] Failed:", err);
      setHint("Could not switch camera", true);
    } finally {
      switchCamButton.disabled = false;
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup on page unload (release camera & GPU early)
// ─────────────────────────────────────────────────────────────────────────────

window.addEventListener("beforeunload", () => {
  if (running) stop();
});

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

updateRuntimeRotation();
updateAppState("idle");
