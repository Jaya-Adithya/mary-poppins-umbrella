/**
 * @module layout
 * Computes the relationship between the raw video feed and the on-screen
 * container so that landmark coordinates can be translated between
 * normalised [0-1] video space and container pixel space.
 */

import { VIDEO_FIT } from "./config";
import type { Landmark, VideoLayout } from "./types";

/**
 * Calculate how the video is displayed inside the container, accounting for
 * `object-fit: cover | contain` and the resulting letterboxing / cropping.
 */
export function computeVideoLayout(
  containerWidth: number,
  containerHeight: number,
  videoWidth: number,
  videoHeight: number,
): VideoLayout {
  // Guard against divide-by-zero when the video has not yet loaded.
  if (videoWidth <= 0 || videoHeight <= 0) {
    return {
      containerWidth,
      containerHeight,
      videoWidth: 1,
      videoHeight: 1,
      displayWidth: containerWidth,
      displayHeight: containerHeight,
      offsetX: 0,
      offsetY: 0,
      scale: 1,
    };
  }

  const scaleX = containerWidth / videoWidth;
  const scaleY = containerHeight / videoHeight;
  const scale =
    VIDEO_FIT === "cover" ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);

  const displayWidth = videoWidth * scale;
  const displayHeight = videoHeight * scale;
  const offsetX = (containerWidth - displayWidth) * 0.5;
  const offsetY = (containerHeight - displayHeight) * 0.5;

  return {
    containerWidth,
    containerHeight,
    videoWidth,
    videoHeight,
    displayWidth,
    displayHeight,
    offsetX,
    offsetY,
    scale,
  };
}

/**
 * Maps a landmark from normalised video space ([0-1]) to normalised
 * container space ([0-1]), accounting for scaling and offset.
 */
export function mapLandmarkToContainer(
  landmark: Landmark,
  layout: VideoLayout,
): { x: number; y: number } {
  const xPx = landmark.x * layout.videoWidth * layout.scale + layout.offsetX;
  const yPx = landmark.y * layout.videoHeight * layout.scale + layout.offsetY;

  return {
    x: xPx / layout.containerWidth,
    y: yPx / layout.containerHeight,
  };
}

/**
 * Maps a landmark from normalised video space to container **pixel**
 * coordinates, suitable for Canvas 2D drawing.
 */
export function mapLandmarkToContainerPixels(
  landmark: Landmark,
  layout: VideoLayout,
): { x: number; y: number } {
  const xPx = landmark.x * layout.videoWidth * layout.scale + layout.offsetX;
  const yPx = landmark.y * layout.videoHeight * layout.scale + layout.offsetY;

  return { x: xPx, y: yPx };
}
