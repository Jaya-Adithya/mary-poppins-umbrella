# Holdable Umbrella — WebAR

A production-ready WebAR experience that places a virtual umbrella in the user's hand using real-time hand tracking. No app install required — runs entirely in the browser on **all** platforms.

## Features

| Feature | Description |
|---|---|
| **Hand tracking** | MediaPipe HandLandmarker detects 21 landmarks at 24-30 FPS |
| **Grip detection** | Finger-curl analysis determines when the user is "holding" the umbrella |
| **Grip occlusion** | Invisible depth-mesh at the fist hides the handle through the fingers |
| **Body occlusion** | MediaPipe ImageSegmenter (SelfieSegmenter) mask makes the canopy render *behind* the user's head and body |
| **Real-time lighting** | PBR materials, 3-point light rig, environment map, self-shadowing (shadow maps) |
| **Camera switching** | Toggle between front (selfie) and back camera on mobile |
| **Smooth tracking** | One-Euro filter (position), quaternion slerp (rotation), median filter (scale) |
| **3D rendering** | Three.js with ACES filmic tone mapping, adaptive shadow map resolution |
| **Cross-platform** | iOS Safari, Android Chrome/Firefox, Samsung Internet, desktop browsers |
| **Responsive** | Safe-area insets, landscape layout, 44px touch targets, DPR-aware |
| **Accessible** | ARIA roles, live regions, skip-link, keyboard nav, focus-visible, reduced-motion |
| **Photo capture** | Composites video + 3D overlay into a downloadable image |

## Quick Start

```bash
# Install dependencies
npm install

# Start dev server (accessible on local network)
npm run dev

# Production build
npm run build

# Preview production build
npm run preview
```

Open the local URL on your phone or desktop. Tap **Start Camera**, make a fist, and the umbrella appears.

## Project Structure

```
src/
  main.ts            Orchestrator — lifecycle, render loop, event handlers
  config.ts          All tunable constants in one place
  handTracker.ts     MediaPipe HandLandmarker wrapper + grip analysis
  bodySegmenter.ts   MediaPipe ImageSegmenter (SelfieSegmenter) + auto-throttle
  anchor.ts          3D position/orientation from hand landmarks
  smoothing.ts       One-Euro, slerp, and median filters
  occlusion.ts       Depth-mask pipeline (body silhouette → depth plane)
  camera.ts          Camera setup, switching, teardown
  layout.ts          Video ↔ container coordinate mapping
  debug.ts           Landmark visualisation overlay
  types.ts           Shared TypeScript interfaces
  style.css          Responsive UI with safe-area and accessibility support
index.html           Single-page shell with ARIA markup
public/
  umbrella.glb       3D umbrella model (loaded at runtime)
```

## How It Works

### Hand Tracking Pipeline

```
Camera frame
  → MediaPipe HandLandmarker (21 landmarks + grip state)
  → Grip-point blend (wrist, thumb CMC, index/middle MCP)
  → Depth estimation (palm width + hand length + landmark Z)
  → Shaft direction (wrist → finger MCPs, Y-negated for Three.js)
  → Smoothing (One-Euro position, slerp rotation, median scale)
  → Three.js pose update
```

### Lighting & Shadows

The GLB model receives production-quality PBR lighting that works identically on **all** platforms:

| Component | Details |
|---|---|
| **Hemisphere light** | Warm sky + cool ground ambient (0.95 intensity) |
| **Key light** | Warm directional (0.85), casts shadow maps |
| **Fill light** | Cool directional (0.4), fills opposite side |
| **Rim light** | Back directional (0.25), edge definition |
| **Environment map** | Generated sky-gradient PMREM — no external HDR needed |
| **Self-shadowing** | Shadow maps (512px mobile / 1024px desktop) with `normalBias` to avoid acne on curved canopy surfaces |
| **Tone mapping** | ACES Filmic for cinematic look |

Every feature above uses **WebGL 1.0** standard calls — no extensions required beyond what iOS Safari 15.4+ and Android Chrome 90+ already ship.

### Occlusion System

Two independent occlusion layers work together:

1. **Grip occluder** — An invisible fist-shaped ellipsoid (depth-write only) positioned at the hand centre. The umbrella handle is pushed behind the hand via `GRIP_OFFSET.z`, so the shaft section through the fist fails the depth test and disappears.

2. **Body occluder** — The ImageSegmenter (SelfieSegmenter model) produces a per-frame person silhouette mask. This mask drives a screen-aligned depth plane so the umbrella canopy renders behind the user's head, shoulders, and torso.

### Camera Switching

The app supports both front and back cameras:
- **Front camera (selfie)**: Mirrored view, user sees themselves holding the umbrella.
- **Back camera**: Unmirrored, user can show the AR umbrella to others.

Switching stops the current stream, acquires the opposite-facing camera, and updates the mirror state automatically.

## Configuration

All tunables live in `src/config.ts`:

| Constant | Default | Description |
|---|---|---|
| `MODEL_SCALE` | 0.65 | Base scale of the umbrella model |
| `HAND_TRACK_FPS` | 30 (desktop) / 24 (mobile) | Hand detection frequency |
| `BODY_SEGMENTER_FPS` | 12 (desktop) / 8 (mobile) | Body segmentation frequency (auto-throttles on slow devices) |
| `GRIP_OFFSET` | `{x:0, y:-0.05, z:-0.025}` | Handle offset from grip point |
| `HAND_TILT_INFLUENCE` | 0.55 | 0 = always vertical, 1 = fully follow hand |
| `GRIP_OCCLUDER_RADIUS` | 0.04 | Fist occluder size (metres) |
| `BODY_OCCLUSION_ENABLED` | true | Enable/disable body segmentation |
| `SELF_SHADOW_ENABLED` | true | Enable/disable real-time shadow maps on the GLB |
| `SHADOW_MAP_SIZE` | 1024 (desktop) / 512 (mobile) | Shadow resolution — adapts automatically |
| `CAMERA_SWITCH_ENABLED` | true | Show camera switch button |

## Cross-Platform Compatibility

### MediaPipe Solutions — Official Support Matrix

Source: [MediaPipe Solutions Guide](https://ai.google.dev/edge/mediapipe/solutions/guide)

| Solution we use | Android | **Web** | Python | iOS (native) |
|---|---|---|---|---|
| Hand landmark detection | Yes | **Yes** | Yes | Yes |
| Image segmentation (SelfieSegmenter) | Yes | **Yes** | Yes | — |

Our app runs via the **Web** column (WASM + WebGL inside the browser). The "iOS native" column refers to the native Swift SDK, which does not affect our browser-based app.

### Verified Platform Support

| Platform | Status | Notes |
|---|---|---|
| **iOS Safari 15.4+** | Supported | `playsinline`, play() retry, 15s timeout, GPU→CPU fallback |
| **Android Chrome 90+** | Supported | GPU→CPU delegate fallback, orientation change handler |
| **Android Firefox** | Supported | Bare constraint fallback for `getUserMedia` |
| **Samsung Internet** | Supported | Standard WebRTC/WebGL path |
| **Desktop Chrome/Edge** | Supported | Primary dev target, full feature set |
| **Desktop Firefox** | Supported | Full feature set |
| **Desktop Safari 15.4+** | Supported | WebKit-compatible rendering |

### WebGL Features Audit (iOS compatibility)

Every rendering feature has been verified against iOS Safari's WebGL implementation:

| Feature | WebGL Requirement | iOS Safari 15.4+ |
|---|---|---|
| `MeshStandardMaterial` (PBR) | WebGL 1.0 | Yes |
| `PMREMGenerator` (env map) | WebGL 1.0 + framebuffers | Yes |
| `PCFSoftShadowMap` | WebGL 1.0 + depth texture | Yes |
| `ACESFilmicToneMapping` | Fragment shader | Yes |
| `CanvasTexture` | WebGL 1.0 | Yes |
| Shadow maps (512x512) | Depth texture | Yes |
| `SRGBColorSpace` | WebGL 1.0 | Yes |

### Mobile Optimisations

- Lower video resolution (640x480 vs 1280x720)
- Reduced tracking FPS (24 vs 30) and body segmenter FPS (8 vs 12)
- **Auto-throttle**: Body segmenter automatically halves its FPS if inference exceeds 60ms for 8+ consecutive frames, preventing main-thread starvation on weaker GPUs
- Shadow maps use 512px on mobile (vs 1024px desktop) — unnoticeable on smaller screens
- WebGL context loss/restore handlers with automatic recovery
- GPU delegate with automatic CPU fallback for both MediaPipe models
- Orientation change listener + debounced resize
- 44px minimum touch targets (Apple HIG)
- Safe-area insets for notch / Dynamic Island / home indicator
- `-webkit-tap-highlight-color: transparent`
- `touch-action: manipulation` on buttons

### Fallback Chain

```
GPU delegate (fast)
  → fails? CPU delegate (slower but universal)
GLB model load
  → fails? Procedural fallback umbrella (zero network dependency)
WebGL context lost
  → automatic restore on next frame
Camera getUserMedia
  → ideal constraints → min constraints → bare constraints
```

## Tech Stack

| Library | Version | Purpose |
|---|---|---|
| [Three.js](https://threejs.org) | 0.182.0 | 3D rendering, PBR, shadow maps |
| [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/guide) | 0.10.32 | Hand tracking + body segmentation |
| [Vite](https://vitejs.dev) | 7.3.1 | Build tool |
| [TypeScript](https://typescriptlang.org) | 5.9.3 | Type safety |

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `d` | Toggle debug landmark overlay |
| `[` / `]` | Cycle model rotation presets |

## License

Private project.
