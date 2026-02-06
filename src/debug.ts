/**
 * @module debug
 * Canvas-2D debug overlay for hand landmarks, grip point, shaft direction,
 * and live telemetry.  Only drawn when debug mode is active.
 */

import {
  DEBUG_LANDMARK_SIZE,
  DEBUG_SHOW_GRIP_POINT,
  DEBUG_SHOW_ORIENTATION_AXES,
  DEBUG_SHOW_DEPTH_INFO,
} from "./config";
import type { HandPose, VideoLayout, AnchorData, HandState } from "./types";
import { LANDMARK } from "./types";
import { mapLandmarkToContainerPixels } from "./layout";
import { getGripPointPixels, getShaftDirection } from "./anchor";

// ─────────────────────────────────────────────────────────────────────────────
// Colour Palette (frozen to prevent accidental mutation)
// ─────────────────────────────────────────────────────────────────────────────

const COLORS = Object.freeze({
  landmark: "rgba(90, 209, 255, 0.8)",
  landmarkOpen: "rgba(90, 209, 255, 0.8)",
  landmarkCurled: "rgba(255, 150, 50, 0.9)",
  gripPoint: "rgba(255, 80, 80, 1)",
  gripPointRing: "rgba(255, 80, 80, 0.3)",
  connection: "rgba(90, 209, 255, 0.4)",
  axisX: "rgba(255, 100, 100, 0.9)",
  axisY: "rgba(100, 255, 100, 0.9)",
  axisZ: "rgba(100, 100, 255, 0.9)",
  text: "rgba(255, 255, 255, 0.9)",
  textBg: "rgba(0, 0, 0, 0.6)",
  shaft: "#00FF00",
});

// ─────────────────────────────────────────────────────────────────────────────
// Finger Connections (skeleton)
// ─────────────────────────────────────────────────────────────────────────────

const FINGER_CONNECTIONS: ReadonlyArray<readonly [number, number]> = Object.freeze([
  [LANDMARK.WRIST, LANDMARK.THUMB_CMC],
  [LANDMARK.THUMB_CMC, LANDMARK.THUMB_MCP],
  [LANDMARK.THUMB_MCP, LANDMARK.THUMB_IP],
  [LANDMARK.THUMB_IP, LANDMARK.THUMB_TIP],
  [LANDMARK.WRIST, LANDMARK.INDEX_MCP],
  [LANDMARK.INDEX_MCP, LANDMARK.INDEX_PIP],
  [LANDMARK.INDEX_PIP, LANDMARK.INDEX_DIP],
  [LANDMARK.INDEX_DIP, LANDMARK.INDEX_TIP],
  [LANDMARK.WRIST, LANDMARK.MIDDLE_MCP],
  [LANDMARK.MIDDLE_MCP, LANDMARK.MIDDLE_PIP],
  [LANDMARK.MIDDLE_PIP, LANDMARK.MIDDLE_DIP],
  [LANDMARK.MIDDLE_DIP, LANDMARK.MIDDLE_TIP],
  [LANDMARK.WRIST, LANDMARK.RING_MCP],
  [LANDMARK.RING_MCP, LANDMARK.RING_PIP],
  [LANDMARK.RING_PIP, LANDMARK.RING_DIP],
  [LANDMARK.RING_DIP, LANDMARK.RING_TIP],
  [LANDMARK.WRIST, LANDMARK.PINKY_MCP],
  [LANDMARK.PINKY_MCP, LANDMARK.PINKY_PIP],
  [LANDMARK.PINKY_PIP, LANDMARK.PINKY_DIP],
  [LANDMARK.PINKY_DIP, LANDMARK.PINKY_TIP],
  [LANDMARK.INDEX_MCP, LANDMARK.MIDDLE_MCP],
  [LANDMARK.MIDDLE_MCP, LANDMARK.RING_MCP],
  [LANDMARK.RING_MCP, LANDMARK.PINKY_MCP],
]);

const FINGER_TIPS: ReadonlySet<number> = new Set([
  LANDMARK.THUMB_TIP,
  LANDMARK.INDEX_TIP,
  LANDMARK.MIDDLE_TIP,
  LANDMARK.RING_TIP,
  LANDMARK.PINKY_TIP,
]);

// ─────────────────────────────────────────────────────────────────────────────
// Skeleton Drawing
// ─────────────────────────────────────────────────────────────────────────────

function drawConnections(
  ctx: CanvasRenderingContext2D,
  pose: HandPose,
  layout: VideoLayout,
): void {
  ctx.strokeStyle = COLORS.connection;
  ctx.lineWidth = 2;

  for (const [from, to] of FINGER_CONNECTIONS) {
    const p1 = mapLandmarkToContainerPixels(pose.landmarks[from], layout);
    const p2 = mapLandmarkToContainerPixels(pose.landmarks[to], layout);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Entry Point — Draw Landmarks
// ─────────────────────────────────────────────────────────────────────────────

/** Draw the full debug overlay onto the given canvas context. */
export function drawLandmarks(
  ctx: CanvasRenderingContext2D,
  pose: HandPose | null,
  layout: VideoLayout,
  handState?: HandState | null,
  anchor?: AnchorData | null,
): void {
  ctx.clearRect(0, 0, layout.containerWidth, layout.containerHeight);
  if (!pose) return;

  drawConnections(ctx, pose, layout);

  // Individual landmarks.
  for (let i = 0; i < pose.landmarks.length; i++) {
    const point = mapLandmarkToContainerPixels(pose.landmarks[i], layout);

    let isCurled = false;
    if (handState) {
      if (i === LANDMARK.INDEX_TIP || i === LANDMARK.INDEX_DIP) isCurled = handState.fingers.index;
      if (i === LANDMARK.MIDDLE_TIP || i === LANDMARK.MIDDLE_DIP) isCurled = handState.fingers.middle;
      if (i === LANDMARK.RING_TIP || i === LANDMARK.RING_DIP) isCurled = handState.fingers.ring;
      if (i === LANDMARK.PINKY_TIP || i === LANDMARK.PINKY_DIP) isCurled = handState.fingers.pinky;
      if (i === LANDMARK.THUMB_TIP || i === LANDMARK.THUMB_IP) isCurled = handState.fingers.thumb;
    }

    ctx.fillStyle = isCurled ? COLORS.landmarkCurled : COLORS.landmarkOpen;
    const size = FINGER_TIPS.has(i) ? DEBUG_LANDMARK_SIZE * 1.3 : DEBUG_LANDMARK_SIZE;

    ctx.beginPath();
    ctx.arc(point.x, point.y, size, 0, Math.PI * 2);
    ctx.fill();
  }

  // Grip point.
  if (DEBUG_SHOW_GRIP_POINT) {
    const gp = getGripPointPixels(pose.landmarks, layout);

    ctx.strokeStyle = COLORS.gripPointRing;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(gp.x, gp.y, DEBUG_LANDMARK_SIZE * 3, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = COLORS.gripPoint;
    ctx.beginPath();
    ctx.arc(gp.x, gp.y, DEBUG_LANDMARK_SIZE * 1.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = COLORS.gripPoint;
    ctx.lineWidth = 1;
    const cs = DEBUG_LANDMARK_SIZE * 4;
    ctx.beginPath();
    ctx.moveTo(gp.x - cs, gp.y);
    ctx.lineTo(gp.x + cs, gp.y);
    ctx.moveTo(gp.x, gp.y - cs);
    ctx.lineTo(gp.x, gp.y + cs);
    ctx.stroke();
  }

  // Shaft direction arrow.
  if (DEBUG_SHOW_ORIENTATION_AXES) {
    const gp = anchor?.gripPoint2D
      ? {
          x: anchor.gripPoint2D.x * layout.containerWidth,
          y: anchor.gripPoint2D.y * layout.containerHeight,
        }
      : getGripPointPixels(pose.landmarks, layout);

    const shaftDir = getShaftDirection();
    const axisLen = 60;
    const sx = shaftDir.x * axisLen;
    const sy = -shaftDir.y * axisLen;

    ctx.strokeStyle = COLORS.shaft;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(gp.x, gp.y);
    ctx.lineTo(gp.x + sx, gp.y + sy);
    ctx.stroke();

    const angle = Math.atan2(sy, sx);
    const arrowSize = 14;
    ctx.beginPath();
    ctx.moveTo(gp.x + sx, gp.y + sy);
    ctx.lineTo(
      gp.x + sx - arrowSize * Math.cos(angle - Math.PI / 5),
      gp.y + sy - arrowSize * Math.sin(angle - Math.PI / 5),
    );
    ctx.lineTo(
      gp.x + sx - arrowSize * Math.cos(angle + Math.PI / 5),
      gp.y + sy - arrowSize * Math.sin(angle + Math.PI / 5),
    );
    ctx.closePath();
    ctx.fillStyle = COLORS.shaft;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(gp.x, gp.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.shaft;
    ctx.fill();
  }

  if (DEBUG_SHOW_DEPTH_INFO && (anchor || handState)) {
    drawDebugInfo(ctx, layout, anchor, handState);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug Info Panel
// ─────────────────────────────────────────────────────────────────────────────

function drawDebugInfo(
  ctx: CanvasRenderingContext2D,
  layout: VideoLayout,
  anchor?: AnchorData | null,
  handState?: HandState | null,
): void {
  const padding = 10;
  const lineHeight = 16;
  const lines: string[] = [];

  if (anchor) {
    lines.push(`Depth: ${(anchor.depth * 100).toFixed(1)}cm`);
    lines.push(`Conf: ${(anchor.confidence * 100).toFixed(0)}%`);
    lines.push(`Palm: ${anchor.palmWidthPx.toFixed(0)}px`);
    if (anchor.gripPoint2D) {
      lines.push(
        `Grip: ${(anchor.gripPoint2D.x * 100).toFixed(0)}%, ${(anchor.gripPoint2D.y * 100).toFixed(0)}%`,
      );
    }
    lines.push(
      `Pos: ${anchor.position.x.toFixed(2)}, ${anchor.position.y.toFixed(2)}, ${anchor.position.z.toFixed(2)}`,
    );
  }
  if (handState) {
    lines.push(`State: ${handState.grip}`);
    lines.push(`Facing: ${handState.palmFacing}`);
  }
  if (lines.length === 0) return;

  ctx.font = "12px monospace";
  const maxWidth = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const panelWidth = maxWidth + padding * 2;
  const panelHeight = lines.length * lineHeight + padding * 2;

  const panelX = layout.containerWidth - panelWidth - 10;
  const panelY = 10;

  ctx.fillStyle = COLORS.textBg;
  ctx.fillRect(panelX, panelY, panelWidth, panelHeight);

  ctx.fillStyle = COLORS.text;
  ctx.textBaseline = "top";
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], panelX + padding, panelY + padding + i * lineHeight);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Status Indicator Overlay
// ─────────────────────────────────────────────────────────────────────────────

/** Draw a centered loading / status screen. */
export function drawStatusIndicator(
  ctx: CanvasRenderingContext2D,
  layout: VideoLayout,
  status: string,
  progress?: number,
): void {
  const cx = layout.containerWidth / 2;
  const cy = layout.containerHeight / 2;

  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.fillRect(0, 0, layout.containerWidth, layout.containerHeight);

  ctx.fillStyle = COLORS.text;
  ctx.font = "16px 'Space Grotesk', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(status, cx, cy);

  if (progress !== undefined) {
    const bw = 200;
    const bh = 4;
    const bx = cx - bw / 2;
    const by = cy + 25;

    ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = "rgba(90, 209, 255, 0.9)";
    ctx.fillRect(bx, by, bw * (progress / 100), bh);
  }

  ctx.textAlign = "start";
}

// ─────────────────────────────────────────────────────────────────────────────
// Guidance Overlay
// ─────────────────────────────────────────────────────────────────────────────

/** Draw a hand-outline hint when no hand is visible for a while. */
export function drawGuidanceOverlay(
  ctx: CanvasRenderingContext2D,
  layout: VideoLayout,
  message: string,
): void {
  const cx = layout.containerWidth / 2;
  const cy = layout.containerHeight / 2;

  ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 10]);

  const hw = 80;
  const hh = 100;

  ctx.beginPath();
  ctx.ellipse(cx, cy, hw, hh, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  ctx.font = "14px 'Space Grotesk', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(message, cx, cy + hh + 30);
  ctx.textAlign = "start";
}
