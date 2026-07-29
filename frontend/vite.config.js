import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
var crossOriginHeaders = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "cross-origin",
};
export default defineConfig({
    plugins: [react()],
    server: {
        headers: crossOriginHeaders,
    },
    preview: {
        headers: crossOriginHeaders,
    },
    optimizeDeps: {
        exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util", "@ffmpeg/core"],
    },
});
