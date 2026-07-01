#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { loadDotEnv } from "./env-loader.ts";
import { createWebBackendApp } from "./server.ts";

loadDotEnv();

const host = process.env.PI_WEB_BACKEND_HOST ?? "127.0.0.1";
const port = parsePort(process.env.PI_WEB_BACKEND_PORT ?? "8787");
const { app } = createWebBackendApp();

serve({
	fetch: app.fetch,
	hostname: host,
	port,
});

console.log(`pi web backend listening on http://${host}:${port}`);

function parsePort(value: string): number {
	const port = Number(value);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`Invalid PI_WEB_BACKEND_PORT: ${value}`);
	}
	return port;
}
