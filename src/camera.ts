/**
 * @module camera
 * Camera setup, teardown, and enumeration utilities.
 *
 * Cross-platform considerations:
 *  - iOS Safari requires `getUserMedia` inside a user-gesture callback AND
 *    the `<video>` must have `playsinline` + `muted` attributes.
 *  - Some Android browsers reject `ideal` constraints and need bare fallbacks.
 *  - Older devices may not support `facingMode` at all.
 *  - The progressive-fallback chain handles all of these gracefully.
 */

import { VIDEO_WIDTH, VIDEO_HEIGHT, IS_IOS } from "./config";

/** Maximum time (ms) we wait for the video element to become ready. */
const VIDEO_READY_TIMEOUT_MS = IS_IOS ? 15_000 : 10_000; // iOS is slower to initialise

/** Tracks which camera is currently active. */
let _currentFacingMode: "user" | "environment" = "user";

/** Returns the active camera direction. */
export function getCurrentFacingMode(): "user" | "environment" {
  return _currentFacingMode;
}

// ─────────────────────────────────────────────────────────────────────────────
// Camera Setup with fallback options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Requests camera access, attaches the stream to the given `<video>` element,
 * and waits until the video is ready to be used as a tracking source.
 *
 * **Must be called from a user-gesture event handler** (click / touchend) on
 * iOS Safari, otherwise the browser will reject the getUserMedia call.
 *
 * @throws {Error} If no camera can be accessed after all fallback attempts.
 */
export async function setupCamera(
  video: HTMLVideoElement,
  facingMode: "user" | "environment" = "user",
): Promise<MediaStream> {
  _currentFacingMode = facingMode;
  // Bail early with a descriptive error when the API is absent.
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      "Camera API is not available. Please use a modern browser with HTTPS.",
    );
  }

  // Try progressively simpler constraint sets.
  // Order: ideal → low-res → bare minimum (some Android/iOS combos only
  // accept the last one).
  const constraintOptions: MediaStreamConstraints[] = [
    {
      video: {
        facingMode,
        width: { ideal: VIDEO_WIDTH, max: 1920 },
        height: { ideal: VIDEO_HEIGHT, max: 1080 },
        frameRate: { ideal: 30, max: 60 },
      },
      audio: false,
    },
    {
      video: {
        facingMode,
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: false,
    },
    // Bare constraint — no facingMode, no resolution hints.
    // This works on virtually every device that has *any* camera.
    { video: true, audio: false },
  ];

  let stream: MediaStream | null = null;
  let lastError: Error | null = null;

  for (const constraints of constraintOptions) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn("Camera constraint failed, trying fallback:", constraints, error);
    }
  }

  if (!stream) {
    const reason =
      lastError?.name === "NotAllowedError"
        ? "Camera permission was denied. Please allow camera access and try again."
        : lastError?.name === "NotFoundError"
          ? "No camera found. Please connect a camera and try again."
          : lastError?.name === "NotReadableError"
            ? "Camera is in use by another application."
            : lastError?.message ?? "Unable to access camera";
    throw new Error(reason);
  }

  // Attach stream to the video element.
  // These attributes are critical for iOS Safari inline playback.
  video.srcObject = stream;
  video.setAttribute("playsinline", "true");
  video.setAttribute("muted", "true");
  video.setAttribute("autoplay", "true");
  video.muted = true; // Property, not just attribute — required on some iOS versions

  // iOS Safari can reject play() if it thinks there's no user gesture.
  // Catch and retry once after a short delay.
  try {
    await video.play();
  } catch (playError) {
    console.warn("[Camera] Initial play() rejected, retrying:", playError);
    await new Promise((r) => setTimeout(r, 300));
    await video.play();
  }

  // Wait until the video actually has dimensions.
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Video element did not become ready within the timeout."));
    }, VIDEO_READY_TIMEOUT_MS);

    const checkReady = () => {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        clearTimeout(timeout);
        resolve();
      } else {
        requestAnimationFrame(checkReady);
      }
    };

    if (video.readyState >= 2 && video.videoWidth > 0) {
      clearTimeout(timeout);
      resolve();
    } else {
      video.addEventListener(
        "loadeddata",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      checkReady();
    }
  });

  console.log(`Camera initialized: ${video.videoWidth}x${video.videoHeight}`);

  return stream;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stop Camera
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stops all tracks of the video element's stream and detaches it.
 * Safe to call even when no stream is attached.
 */
export function stopCamera(video: HTMLVideoElement): void {
  const stream = video.srcObject as MediaStream | null;
  if (stream) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    video.srcObject = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Switch Camera (front ↔ back)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stops the current camera stream and acquires the opposite-facing camera.
 * Returns the new stream.
 *
 * @throws {Error} If the new camera cannot be acquired.
 */
export async function switchCamera(video: HTMLVideoElement): Promise<MediaStream> {
  stopCamera(video);
  const newMode = _currentFacingMode === "user" ? "environment" : "user";
  console.log(`[Camera] Switching to ${newMode} camera`);
  return setupCamera(video, newMode);
}

// ─────────────────────────────────────────────────────────────────────────────
// Get Available Cameras
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enumerates video-input devices. Returns an empty array if enumeration
 * is not supported or permission has not been granted.
 */
export async function getAvailableCameras(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "videoinput");
  } catch {
    return [];
  }
}
