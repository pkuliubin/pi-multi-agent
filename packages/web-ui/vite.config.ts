import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const backendUrl = process.env.PI_WEB_UI_BACKEND_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
	plugins: [react()],
	server: {
		proxy: {
			"/api": {
				target: backendUrl,
				changeOrigin: true,
			},
		},
	},
});
