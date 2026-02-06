This folder is optional for static hosting.

If you want to serve assets without bundling, place your model here as `umbrella.glb`
and update `MODEL_URL` in `src/config.ts` to `/umbrella.glb`.

Recommended:
- Draco-compress the mesh.
- Use KTX2/Basis textures.
- Keep the model under 10-50k vertices for mobile.
