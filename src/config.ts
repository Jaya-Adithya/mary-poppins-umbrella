/**
 * @module config
 * Central configuration for the Holdable Umbrella AR application.
 * All tunable constants are exported from here so they can be
 * adjusted in one place without touching business logic.
 *
 * Objects are frozen at module level to prevent accidental mutation.
 */

// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM DETECTION (evaluated once at module load)
// ─────────────────────────────────────────────────────────────────────────────
const _ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
/** `true` on phones and tablets. */
export const IS_MOBILE = /Android|iPhone|iPad|iPod|webOS|BlackBerry|Opera Mini/i.test(_ua);
/** `true` specifically on Apple mobile devices. */
export const IS_IOS = /iPhone|iPad|iPod/i.test(_ua) ||
  (typeof navigator !== "undefined" && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

// ─────────────────────────────────────────────────────────────────────────────
// MODEL CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
/** Absolute path served from `/public` by Vite. */
export const MODEL_URL = "/umbrella.glb";
/** Base scale multiplier applied to the loaded model.
 *  A real umbrella canopy spans ~100cm.  0.95 keeps the model close to
 *  authored size so it reads as a real umbrella at arm's length. */
export const MODEL_SCALE = 2.0;

// ─────────────────────────────────────────────────────────────────────────────
// VIDEO & DISPLAY
// ─────────────────────────────────────────────────────────────────────────────
export const VIDEO_FIT: "cover" | "contain" = "cover";
export const MIRROR_VIEW = true;
/** Lower resolution on mobile for performance & battery. */
export const VIDEO_WIDTH = IS_MOBILE ? 640 : 1280;
export const VIDEO_HEIGHT = IS_MOBILE ? 480 : 720;

// ─────────────────────────────────────────────────────────────────────────────
// HAND TRACKING
// ─────────────────────────────────────────────────────────────────────────────
/** Slightly lower on mobile to save CPU/battery. */
export const HAND_TRACK_FPS = IS_MOBILE ? 24 : 30;
export const MAX_HANDS = 1;
export const MIN_HAND_DETECTION_CONFIDENCE = 0.4;
export const MIN_TRACKING_CONFIDENCE = 0.4;
export const MIN_PRESENCE_CONFIDENCE = 0.4;

// ─────────────────────────────────────────────────────────────────────────────
// SMOOTHING — Tuned for smooth, stable tracking
// ─────────────────────────────────────────────────────────────────────────────
/** Position smoothing (lower = smoother). */
export const POS_SMOOTHING = 0.12;
/** Rotation smoothing (lower = smoother). */
export const ROT_SMOOTHING = 0.10;
/** Scale smoothing. */
export const SCALE_SMOOTHING = 0.06;

export const ADAPTIVE_SMOOTHING_ENABLED = true;
/** Very smooth when still. */
export const ADAPTIVE_POS_MIN = 0.06;
/** More responsive when moving. */
export const ADAPTIVE_POS_MAX = 0.18;
/** Very smooth rotation when still. */
export const ADAPTIVE_ROT_MIN = 0.04;
/** More responsive rotation when moving. */
export const ADAPTIVE_ROT_MAX = 0.15;
export const MOTION_THRESHOLD_LOW = 0.002;
export const MOTION_THRESHOLD_HIGH = 0.02;

/** Slight prediction lookahead for responsiveness. */
export const PREDICTION_SECONDS = 0.008;
export const VELOCITY_SMOOTHING = 0.08;

// ─────────────────────────────────────────────────────────────────────────────
// DEPTH ESTIMATION
// ─────────────────────────────────────────────────────────────────────────────
export const PALM_WIDTH_METERS = 0.082;
export const HAND_LENGTH_METERS = 0.19;
export const MIN_DEPTH = 0.20;
export const MAX_DEPTH = 0.85;

export const USE_LANDMARK_Z_DEPTH = true;
export const LANDMARK_Z_WEIGHT = 0.25;

// ─────────────────────────────────────────────────────────────────────────────
// ANCHOR POSITIONING
// ─────────────────────────────────────────────────────────────────────────────
export const GRIP_POINT_BLEND = Object.freeze({
  wrist: 0.10,
  thumbCmc: 0.30,
  indexMcp: 0.35,
  middleMcp: 0.15,
  palmCenter: 0.10,
});

/**
 * Offset from grip point (in model local space, applied AFTER positioning).
 *
 * Y: Negative moves handle origin BELOW the grip point, so the hand
 *    appears to grip the shaft above the very end of the handle.
 * Z: **Negative** pushes the handle BEHIND the hand surface (away from
 *    camera). This is essential for hand-occlusion to work: the occluder
 *    plane sits between the camera and the handle, so the hand mask
 *    can clip the shaft where the fingers wrap around it.
 */
export const GRIP_OFFSET = Object.freeze({ x: 0, y: -0.05, z: -0.04 });

// ─────────────────────────────────────────────────────────────────────────────
// ORIENTATION
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Model rotation offset (Euler XYZ in radians, applied after orientation calc).
 * Set to zero when the model origin is correctly aligned in Blender.
 */
export const MODEL_ROTATION_OFFSET = Object.freeze({ x: 0, y: 0, z: 0 });

/**
 * How much the umbrella follows hand tilt.
 * 0 = always vertical, 1 = fully follow hand.
 * 0.92 makes the umbrella follow the fist almost 1:1 while
 * retaining a small 8% world-up bias for stability.
 */
export const HAND_TILT_INFLUENCE = 0.92;

/** World up direction used for orientation blending. */
export const WORLD_UP = Object.freeze({ x: 0, y: 1, z: 0 });

// ─────────────────────────────────────────────────────────────────────────────
// HAND POSE DETECTION
// ─────────────────────────────────────────────────────────────────────────────
export const ENABLE_GRIP_DETECTION = true;
/** Increased for better detection. */
export const FINGER_CURL_THRESHOLD = 0.12;
/** Increased for better detection. */
export const THUMB_CURL_THRESHOLD = 0.10;
export const GRIP_CONFIDENCE_THRESHOLD = 0.5;

// ─────────────────────────────────────────────────────────────────────────────
// MASK-BASED OCCLUSION (requires a segmentation mask source — e.g. a separate
// SelfieSegmentation model.  Note: HandLandmarker does NOT produce masks,
// so this system is inert unless an external mask provider is wired up.)
// ─────────────────────────────────────────────────────────────────────────────
export const OCCLUSION_ENABLED = true;
/** Lower threshold so softer mask edges still contribute to occlusion. */
export const OCCLUSION_ALPHA_TEST = 0.08;
/** Depth bias must be LARGE — the umbrella canopy is a 3D curved surface
 *  that can extend 8-15cm toward the camera from the grip point.  A small
 *  bias causes canopy polygons closer than the plane to slip through the
 *  depth test and render ON TOP of the person.  12cm safely covers the
 *  canopy's forward extent.  The video feed is unaffected because it is a
 *  CSS background, not a Three.js depth-tested object. */
export const OCCLUSION_DEPTH_BIAS = 0.04;
export const OCCLUSION_FEATHER_ENABLED = true;
/** Slight blur softens the body silhouette edge for a natural blend.
 *  4px at mask resolution (256×144 typical) ≈ ~8px on screen. */
export const OCCLUSION_FEATHER_RADIUS = 6;
export const OCCLUSION_STRENGTH = 1.0;
export const MULTI_LAYER_OCCLUSION = false;
export const FINGER_DEPTH_OFFSET = 0.02;

// ─────────────────────────────────────────────────────────────────────────────
// GRIP OCCLUDER — Landmark-based "virtual fist" depth mesh
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Instead of relying on a segmentation mask (which HandLandmarker cannot
 * produce), we place an invisible depth-only 3D ellipsoid at the grip
 * point.  Because the umbrella handle is pushed BEHIND the hand via
 * GRIP_OFFSET.z, this ellipsoid sits *between* the camera and the handle.
 * When the umbrella renders, any part of its shaft that falls behind the
 * ellipsoid fails the depth test and is not drawn — giving the illusion
 * that the fingers wrap around and hide the handle.
 *
 * Visible/hidden rules (selfie view, standard upright hold):
 *  ┌────────────────────────────────────────────────┐
 *  │  VISIBLE            │  HIDDEN (by fist)        │
 *  ├─────────────────────┼──────────────────────────┤
 *  │  Canopy (above)     │  ~7cm of shaft inside    │
 *  │  Shaft above fist   │  the grip zone           │
 *  │  J-hook below fist  │                          │
 *  │  Ribs / ferrule     │                          │
 *  └─────────────────────┴──────────────────────────┘
 */
export const GRIP_OCCLUDER_ENABLED = true;

/** Base radius of the fist approximation ellipsoid (metres).
 *  An average adult fist is ~82mm wide × ~95mm tall × ~80mm deep.
 *  60mm radius gives an effective 120mm diameter before shape scaling,
 *  which generously covers the full fist + fingers. */
export const GRIP_OCCLUDER_RADIUS = 0.06;

/** Offset *toward* the camera from the physical fist centre.
 *  With GRIP_OFFSET.z = -0.04, the handle is 4cm behind the fist.
 *  Nudging the occluder 1cm forward ensures its front surface is
 *  clearly in front of the handle for a clean depth-test cutoff. */
export const GRIP_OCCLUDER_Z_NUDGE = 0.01;

/** Non-uniform scale to shape the sphere into a realistic fist:
 *  - X: fist width   → 1.2  (slightly wider than a sphere)
 *  - Y: fist height  → 1.5  (tall along the shaft — covers all curled fingers)
 *  - Z: fist depth   → 1.1  (matches front-to-back fist depth) */
export const GRIP_OCCLUDER_SHAPE = Object.freeze({ x: 1.2, y: 1.5, z: 1.1 });

// ─────────────────────────────────────────────────────────────────────────────
// BODY OCCLUSION (SelfieSegmenter — makes canopy render behind user's body)
// ─────────────────────────────────────────────────────────────────────────────
/** Enable full-body segmentation so the umbrella canopy renders behind the
 *  user's head, shoulders, and torso instead of on top of them. */
export const BODY_OCCLUSION_ENABLED = true;
/** Body segmenter runs at a lower FPS than hand tracking to save GPU/battery.
 *  The latest mask is cached and reused between frames. */
export const BODY_SEGMENTER_FPS = IS_MOBILE ? 12 : 18;

// ─────────────────────────────────────────────────────────────────────────────
// CAMERA SWITCHING
// ─────────────────────────────────────────────────────────────────────────────
/** Allow toggling between front ("user") and back ("environment") cameras. */
export const CAMERA_SWITCH_ENABLED = true;

// ─────────────────────────────────────────────────────────────────────────────
// LIGHTING & RENDERING
// ─────────────────────────────────────────────────────────────────────────────
export const AMBIENT_INTENSITY = 0.95;
export const KEY_LIGHT_INTENSITY = 0.85;
export const FILL_LIGHT_INTENSITY = 0.4;
export const RIM_LIGHT_INTENSITY = 0.25;
export const USE_ENVIRONMENT_MAP = true;
export const ENVIRONMENT_INTENSITY = 0.5;
export const TONE_MAPPING_EXPOSURE = 1.0;

/** Self-shadowing on the umbrella model (shaft → canopy, ribs → fabric, etc.).
 *  Uses shadow maps — resolution adapts for mobile performance.
 *  Verified compatible: iOS Safari 15.4+, Android Chrome 90+, all desktop. */
export const SELF_SHADOW_ENABLED = true;
/** Shadow map resolution.  512 is plenty for mobile screens; 1024 for desktop. */
export const SHADOW_MAP_SIZE = IS_MOBILE ? 512 : 1024;
/** Shadow softness (higher = softer penumbra). */
export const SHADOW_RADIUS = 2.5;

/** Ground-plane contact shadow (a floating plane beneath the umbrella).
 *  Disabled by default in AR because there's no real surface to cast onto. */
export const CONTACT_SHADOW_ENABLED = false;
export const CONTACT_SHADOW_OPACITY = 0.25;

// ─────────────────────────────────────────────────────────────────────────────
// UI & UX
// ─────────────────────────────────────────────────────────────────────────────
export const SHOW_LOADING_PROGRESS = true;
export const SHOW_TRACKING_INDICATOR = true;
export const SHOW_GRIP_HINT = true;
export const GUIDANCE_SHOW_DELAY_MS = 2000;
export const GUIDANCE_HIDE_DELAY_MS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// DEBUG
// ─────────────────────────────────────────────────────────────────────────────
export const DEBUG_LANDMARK_SIZE = 5;
export const DEBUG_SHOW_GRIP_POINT = true;
export const DEBUG_SHOW_ORIENTATION_AXES = true;
export const DEBUG_SHOW_DEPTH_INFO = true;

// ─────────────────────────────────────────────────────────────────────────────
// Feature Detection (evaluated lazily via getters so they work at import time
// in environments where APIs may not exist, e.g. SSR / unit tests).
// ─────────────────────────────────────────────────────────────────────────────
export function detectFeatures() {
  const gl = (() => {
    try {
      const c = document.createElement("canvas");
      return !!(c.getContext("webgl2") || c.getContext("webgl"));
    } catch {
      return false;
    }
  })();

  return Object.freeze({
    webgl: gl,
    mediaDevices: typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia,
    wasm: typeof WebAssembly === "object",
  });
}
