/**
 * @module bodySegmenter
 * Wraps MediaPipe ImageSegmenter with the SelfieSegmenter model to provide a
 * per-frame body silhouette mask.  This mask is fed into the existing
 * occlusion pipeline so the umbrella canopy renders *behind* the user's
 * head, shoulders, and torso — not on top of them.
 *
 * Design:
 *  - Throttled to a lower FPS than hand tracking (saves GPU/battery).
 *  - GPU delegate with automatic CPU fallback.
 *  - Caches the latest mask between frames for smooth occlusion.
 *  - Implements `Disposable` for clean resource release.
 */

import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";
import type { Disposable } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A body silhouette mask compatible with the occlusion module's
 * `updateOcclusionMask` function.
 */
export interface BodyMask {
  readonly width: number;
  readonly height: number;
  getAsFloat32Array?: () => Float32Array;
  getAsUint8Array?: () => Uint8Array;
}

// ─────────────────────────────────────────────────────────────────────────────
// Model URL
// ─────────────────────────────────────────────────────────────────────────────

const SELFIE_SEGMENTER_MODEL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite";

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a MediaPipe `ImageSegmenter` configured for VIDEO mode with the
 * SelfieSegmenter model.  Tries GPU first, falls back to CPU.
 */
export async function createImageSegmenter(
  onProgress?: (progress: number, message: string) => void,
): Promise<ImageSegmenter> {
  onProgress?.(5, "Loading body segmentation WASM…");

  const resolver = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm",
  );

  onProgress?.(30, "Loading selfie segmenter model…");

  const sharedOptions = {
    runningMode: "VIDEO" as const,
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  };

  let segmenter: ImageSegmenter;
  try {
    segmenter = await ImageSegmenter.createFromOptions(resolver, {
      baseOptions: { modelAssetPath: SELFIE_SEGMENTER_MODEL, delegate: "GPU" },
      ...sharedOptions,
    });
    console.log("[BodySegmenter] Using GPU delegate");
  } catch (gpuError) {
    console.warn("[BodySegmenter] GPU failed, falling back to CPU:", gpuError);
    onProgress?.(50, "GPU unavailable — using CPU fallback…");
    segmenter = await ImageSegmenter.createFromOptions(resolver, {
      baseOptions: { modelAssetPath: SELFIE_SEGMENTER_MODEL, delegate: "CPU" },
      ...sharedOptions,
    });
    console.log("[BodySegmenter] Using CPU delegate");
  }

  onProgress?.(100, "Body segmenter ready");
  return segmenter;
}

// ─────────────────────────────────────────────────────────────────────────────
// BodySegmenter Class
// ─────────────────────────────────────────────────────────────────────────────

export class BodySegmenter implements Disposable {
  private segmenter: ImageSegmenter;
  private fps: number;
  private readonly minFps: number;
  private lastTime = 0;
  private latestMask: BodyMask | null = null;
  private disposed = false;

  /** Reusable Float32Array for copying mask data (avoids per-frame alloc). */
  private _maskBuf: Float32Array | null = null;

  // Performance monitoring — auto-throttle on slow devices
  private slowFrameCount = 0;
  private readonly SLOW_THRESHOLD_MS = 60;  // >60ms per inference = too slow
  private readonly SLOW_FRAME_LIMIT = 8;    // throttle after 8 consecutive slow frames

  constructor(segmenter: ImageSegmenter, fps: number) {
    this.segmenter = segmenter;
    this.fps = fps;
    this.minFps = Math.max(2, Math.floor(fps / 4)); // floor: never go below ~2 FPS
  }

  /**
   * Run selfie segmentation at the configured FPS.
   * Returns the cached mask on frames where segmentation is skipped.
   *
   * **Performance guard**: If inference consistently exceeds `SLOW_THRESHOLD_MS`,
   * the FPS is halved (down to `minFps`) to keep the main thread responsive.
   * This prevents body segmentation from starving hand tracking on weaker GPUs.
   */
  segment(video: HTMLVideoElement, timeMs: number): BodyMask | null {
    if (this.disposed || video.readyState < 2) return this.latestMask;

    const interval = 1000 / this.fps;
    if (timeMs - this.lastTime < interval) return this.latestMask;
    this.lastTime = timeMs;

    try {
      const t0 = performance.now();
      const result = this.segmenter.segmentForVideo(video, timeMs);
      const elapsed = performance.now() - t0;

      // Auto-throttle if consistently slow
      if (elapsed > this.SLOW_THRESHOLD_MS) {
        this.slowFrameCount++;
        if (this.slowFrameCount >= this.SLOW_FRAME_LIMIT && this.fps > this.minFps) {
          const newFps = Math.max(this.minFps, Math.floor(this.fps / 2));
          console.warn(
            `[BodySegmenter] Inference too slow (${elapsed.toFixed(1)}ms). ` +
            `Throttling ${this.fps} → ${newFps} FPS`,
          );
          this.fps = newFps;
          this.slowFrameCount = 0;
        }
      } else {
        // Decay the counter when frames are fast
        this.slowFrameCount = Math.max(0, this.slowFrameCount - 1);
      }

      const masks = result.confidenceMasks;

      if (masks && masks.length > 0) {
        // SelfieSegmenter outputs 2 classes:
        //   confidenceMasks[0] = background confidence
        //   confidenceMasks[1] = person confidence
        // We want the *person* mask for occlusion.
        // If only one mask is returned (some model variants), use it directly.
        const personMask = masks.length > 1 ? masks[1] : masks[0];

        // CRITICAL: Copy the float data immediately.  MediaPipe reuses
        // internal GPU/WASM buffers across frames — the reference would
        // point to stale or overwritten data on the next segmentForVideo().
        const srcFloat = personMask.getAsFloat32Array?.();
        if (srcFloat && srcFloat.length > 0) {
          const w = (personMask as unknown as { width: number }).width;
          const h = (personMask as unknown as { height: number }).height;
          if (w > 0 && h > 0) {
            // Reuse the backing buffer if size unchanged.
            if (!this._maskBuf || this._maskBuf.length !== srcFloat.length) {
              this._maskBuf = new Float32Array(srcFloat.length);
            }
            this._maskBuf.set(srcFloat);

            const buf = this._maskBuf;
            this.latestMask = {
              width: w,
              height: h,
              getAsFloat32Array: () => buf,
            };
          }
        }
      }

      // Close the result to free GPU/WASM resources held by MediaPipe.
      // Not all versions expose .close(); guard against it.
      (result as unknown as { close?: () => void }).close?.();
    } catch (error) {
      console.warn("[BodySegmenter] Segmentation error:", error);
    }

    return this.latestMask;
  }

  /** Current effective FPS (may be lower than initial if auto-throttled). */
  get effectiveFps(): number {
    return this.fps;
  }

  /** Release MediaPipe GPU/WASM resources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.segmenter.close();
  }
}
