/**
 * @module smoothing
 * Signal-processing filters for hand-tracking pose data.
 *
 * Key design goals:
 *  - **Zero per-frame heap allocations** — all temporary vectors / quats are
 *    pre-allocated as module-level or instance-level objects and reused.
 *  - **Adaptive smoothing** — smoothing strength adjusts automatically based
 *    on motion magnitude (still hand = extra smooth, fast hand = responsive).
 *  - **Prediction** — a small velocity-based lookahead compensates for the
 *    inherent latency of the hand-tracking pipeline.
 */

import * as THREE from "three";
import {
  PREDICTION_SECONDS,
  ADAPTIVE_SMOOTHING_ENABLED,
  ADAPTIVE_POS_MIN,
  ADAPTIVE_POS_MAX,
  ADAPTIVE_ROT_MIN,
  ADAPTIVE_ROT_MAX,
  MOTION_THRESHOLD_LOW,
  MOTION_THRESHOLD_HIGH,
  VELOCITY_SMOOTHING,
} from "./config";
import type { Disposable } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Smoothed Pose Output
// ─────────────────────────────────────────────────────────────────────────────

export interface SmoothedPose {
  readonly position: THREE.Vector3;
  readonly predictedPosition: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  readonly velocity: THREE.Vector3;
  readonly angularVelocity: number;
  readonly motionMagnitude: number;
  readonly isStable: boolean;
}

// ─── Reusable temporaries (module-level to avoid per-frame allocation) ────

const _tmpQuat = new THREE.Quaternion();

// ─────────────────────────────────────────────────────────────────────────────
// Quaternion Smoother
// ─────────────────────────────────────────────────────────────────────────────

class QuaternionSmoother {
  private readonly current = new THREE.Quaternion();
  private initialized = false;
  private readonly history: THREE.Quaternion[] = [];
  private readonly historySize = 5;

  /** Pool of reusable quaternions for history entries. */
  private readonly pool: THREE.Quaternion[] = [];

  private getFromPool(): THREE.Quaternion {
    return this.pool.pop() ?? new THREE.Quaternion();
  }

  update(target: THREE.Quaternion, alpha: number): THREE.Quaternion {
    if (!this.initialized) {
      this.current.copy(target);
      this.initialized = true;
      return this.current;
    }

    // Prevent quaternion flip (shortest path).
    _tmpQuat.copy(target);
    if (this.current.dot(_tmpQuat) < 0) {
      _tmpQuat.set(-_tmpQuat.x, -_tmpQuat.y, -_tmpQuat.z, -_tmpQuat.w);
    }

    this.current.slerp(_tmpQuat, alpha);
    this.current.normalize();

    // Track history for stability detection — recycle old entries.
    const entry = this.getFromPool().copy(this.current);
    this.history.push(entry);
    if (this.history.length > this.historySize) {
      const old = this.history.shift()!;
      this.pool.push(old);
    }

    return this.current;
  }

  isStable(threshold = 0.02): boolean {
    if (this.history.length < 2) return false;
    for (let i = 1; i < this.history.length; i++) {
      if (this.history[i].angleTo(this.history[i - 1]) > threshold) return false;
    }
    return true;
  }

  reset(): void {
    this.initialized = false;
    // Return history entries to pool.
    for (const q of this.history) this.pool.push(q);
    this.history.length = 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// One-Euro Filter — jitter reduction with low latency
// ─────────────────────────────────────────────────────────────────────────────

class OneEuroFilter {
  private xPrev = 0;
  private dxPrev = 0;
  private tPrev = 0;
  private initialized = false;

  constructor(
    private readonly minCutoff: number = 1.0,
    private readonly beta: number = 0.0,
    private readonly dCutoff: number = 1.0,
  ) {}

  private alpha(cutoff: number, dt: number): number {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / dt);
  }

  filter(x: number, t: number): number {
    if (!this.initialized) {
      this.xPrev = x;
      this.dxPrev = 0;
      this.tPrev = t;
      this.initialized = true;
      return x;
    }

    const dt = Math.max(0.001, t - this.tPrev);
    this.tPrev = t;

    const dx = (x - this.xPrev) / dt;
    const edAlpha = this.alpha(this.dCutoff, dt);
    const edx = edAlpha * dx + (1 - edAlpha) * this.dxPrev;
    this.dxPrev = edx;

    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    const a = this.alpha(cutoff, dt);
    const result = a * x + (1 - a) * this.xPrev;
    this.xPrev = result;

    return result;
  }

  reset(): void {
    this.initialized = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vector3 One-Euro Filter (wraps 3 scalar filters)
// ─────────────────────────────────────────────────────────────────────────────

class Vector3OneEuroFilter {
  private readonly filterX: OneEuroFilter;
  private readonly filterY: OneEuroFilter;
  private readonly filterZ: OneEuroFilter;

  /** Pre-allocated output vector — returned by reference; callers must copy. */
  private readonly _out = new THREE.Vector3();

  constructor(minCutoff = 1.0, beta = 0.3, dCutoff = 1.0) {
    this.filterX = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.filterY = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.filterZ = new OneEuroFilter(minCutoff, beta, dCutoff);
  }

  /** Returns a **shared** vector — do NOT store a direct reference. */
  filter(v: THREE.Vector3, t: number): THREE.Vector3 {
    return this._out.set(
      this.filterX.filter(v.x, t),
      this.filterY.filter(v.y, t),
      this.filterZ.filter(v.z, t),
    );
  }

  reset(): void {
    this.filterX.reset();
    this.filterY.reset();
    this.filterZ.reset();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Pose Smoother
// ─────────────────────────────────────────────────────────────────────────────

export class PoseSmoother implements Disposable {
  // ── Internal state ─────────────────────────────────────────────────────
  private readonly position = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly quaternionSmoother = new QuaternionSmoother();
  private readonly positionFilter: Vector3OneEuroFilter;

  private readonly prevPosition = new THREE.Vector3();
  private initialized = false;
  private lastTime = 0;

  private readonly motionHistory: number[] = [];
  private readonly motionHistorySize = 10;

  private stableFrames = 0;
  private readonly stableFrameThreshold = 8;

  // ── Reusable temporaries (instance-level) ──────────────────────────────
  private readonly _posDelta = new THREE.Vector3();
  private readonly _instantVel = new THREE.Vector3();
  private readonly _predicted = new THREE.Vector3();
  private readonly _velScaled = new THREE.Vector3();

  // ── Output objects (reused every frame) ────────────────────────────────
  private readonly _outPosition = new THREE.Vector3();
  private readonly _outPredicted = new THREE.Vector3();
  private readonly _outVelocity = new THREE.Vector3();
  private readonly _outQuat = new THREE.Quaternion();

  constructor(
    private readonly basePosAlpha: number,
    private readonly baseRotAlpha: number,
    private readonly predictionSeconds = PREDICTION_SECONDS,
  ) {
    this.positionFilter = new Vector3OneEuroFilter(0.8, 0.4, 1.0);
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private computeAdaptiveAlpha(
    baseAlpha: number,
    minAlpha: number,
    maxAlpha: number,
    motionMagnitude: number,
  ): number {
    if (!ADAPTIVE_SMOOTHING_ENABLED) return baseAlpha;
    const t = THREE.MathUtils.clamp(
      (motionMagnitude - MOTION_THRESHOLD_LOW) /
        (MOTION_THRESHOLD_HIGH - MOTION_THRESHOLD_LOW),
      0,
      1,
    );
    return THREE.MathUtils.lerp(minAlpha, maxAlpha, t);
  }

  private updateMotionHistory(magnitude: number): number {
    this.motionHistory.push(magnitude);
    if (this.motionHistory.length > this.motionHistorySize) {
      this.motionHistory.shift();
    }
    let sum = 0;
    for (let i = 0; i < this.motionHistory.length; i++) sum += this.motionHistory[i];
    return sum / this.motionHistory.length;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Feed a raw pose sample and get a smoothed result.
   * The returned object's vectors are **reused** between calls — copy them
   * if you need to retain values across frames.
   */
  update(
    targetPos: THREE.Vector3,
    targetQuat: THREE.Quaternion,
    timeMs: number,
  ): SmoothedPose {
    const timeSec = timeMs / 1000;

    if (!this.initialized) {
      this.position.copy(targetPos);
      this.prevPosition.copy(targetPos);
      this.velocity.set(0, 0, 0);
      this.lastTime = timeSec;
      this.initialized = true;
      this.positionFilter.reset();
      this.quaternionSmoother.reset();

      const q = this.quaternionSmoother.update(targetQuat, 1.0);

      this._outPosition.copy(this.position);
      this._outPredicted.copy(this.position);
      this._outQuat.copy(q);
      this._outVelocity.set(0, 0, 0);

      return {
        position: this._outPosition,
        predictedPosition: this._outPredicted,
        quaternion: this._outQuat,
        velocity: this._outVelocity,
        angularVelocity: 0,
        motionMagnitude: 0,
        isStable: false,
      };
    }

    const dt = Math.max(0.001, timeSec - this.lastTime);

    // Motion delta
    this._posDelta.copy(targetPos).sub(this.position);
    this._instantVel.copy(this._posDelta).divideScalar(dt);
    const motionMagnitude = this._posDelta.length();

    const avgMotion = this.updateMotionHistory(motionMagnitude);

    // Adaptive smoothing
    const posAlpha = this.computeAdaptiveAlpha(
      this.basePosAlpha, ADAPTIVE_POS_MIN, ADAPTIVE_POS_MAX, avgMotion,
    );
    const rotAlpha = this.computeAdaptiveAlpha(
      this.baseRotAlpha, ADAPTIVE_ROT_MIN, ADAPTIVE_ROT_MAX, avgMotion,
    );

    // Smooth velocity
    this.velocity.lerp(this._instantVel, VELOCITY_SMOOTHING);

    // One-Euro filtered position (returns shared vector — safe to pass to lerp).
    const filteredTarget = this.positionFilter.filter(targetPos, timeSec);

    this.prevPosition.copy(this.position);
    this.position.lerp(filteredTarget, posAlpha);

    // Smooth rotation
    const smoothedQuat = this.quaternionSmoother.update(targetQuat, rotAlpha);

    this.lastTime = timeSec;

    // Stability detection
    const isPositionStable = avgMotion < MOTION_THRESHOLD_LOW;
    const isRotationStable = this.quaternionSmoother.isStable();
    if (isPositionStable && isRotationStable) {
      this.stableFrames++;
    } else {
      this.stableFrames = Math.max(0, this.stableFrames - 1);
    }

    // Predict only when there is meaningful motion.
    const predAmt = avgMotion > MOTION_THRESHOLD_LOW ? this.predictionSeconds : 0;
    this._velScaled.copy(this.velocity).multiplyScalar(predAmt);
    this._predicted.copy(this.position).add(this._velScaled);

    // Fill output (reused objects).
    this._outPosition.copy(this.position);
    this._outPredicted.copy(this._predicted);
    this._outQuat.copy(smoothedQuat);
    this._outVelocity.copy(this.velocity);

    return {
      position: this._outPosition,
      predictedPosition: this._outPredicted,
      quaternion: this._outQuat,
      velocity: this._outVelocity,
      angularVelocity: 0,
      motionMagnitude: avgMotion,
      isStable: this.stableFrames >= this.stableFrameThreshold,
    };
  }

  reset(): void {
    this.initialized = false;
    this.motionHistory.length = 0;
    this.stableFrames = 0;
    this.positionFilter.reset();
    this.quaternionSmoother.reset();
  }

  dispose(): void {
    this.reset();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scale Smoother
// ─────────────────────────────────────────────────────────────────────────────

export class ScaleSmoother implements Disposable {
  private scale = 1;
  private referenceValue: number | null = null;
  private initialized = false;
  private readonly scaleHistory: number[] = [];
  private readonly historySize = 8;

  /** Pre-allocated sort buffer to avoid per-frame array creation. */
  private readonly _sortBuf: number[] = [];

  constructor(
    private readonly alpha: number,
    private readonly minScale: number = 0.8,
    private readonly maxScale: number = 1.2,
  ) {}

  /**
   * Compute smoothed scale from the current palm-width measurement.
   * Uses a **median** filter on a rolling window for outlier rejection.
   */
  update(palmWidthPx: number, baseScale: number): number {
    if (!this.initialized || !this.referenceValue) {
      if (palmWidthPx > 0) {
        this.referenceValue = palmWidthPx;
        this.scale = baseScale;
        this.initialized = true;
      }
      return this.scale;
    }

    const ratio = palmWidthPx / this.referenceValue;
    const targetScale = THREE.MathUtils.clamp(
      ratio * baseScale,
      this.minScale * baseScale,
      this.maxScale * baseScale,
    );

    this.scaleHistory.push(targetScale);
    if (this.scaleHistory.length > this.historySize) {
      this.scaleHistory.shift();
    }

    // Median via reusable buffer.
    this._sortBuf.length = this.scaleHistory.length;
    for (let i = 0; i < this.scaleHistory.length; i++) {
      this._sortBuf[i] = this.scaleHistory[i];
    }
    this._sortBuf.sort((a, b) => a - b);
    const medianScale = this._sortBuf[Math.floor(this._sortBuf.length / 2)];

    this.scale = THREE.MathUtils.lerp(this.scale, medianScale, this.alpha);

    return this.scale;
  }

  reset(): void {
    this.initialized = false;
    this.referenceValue = null;
    this.scale = 1;
    this.scaleHistory.length = 0;
  }

  dispose(): void {
    this.reset();
  }
}
