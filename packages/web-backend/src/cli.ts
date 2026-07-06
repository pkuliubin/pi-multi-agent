#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { loadDotEnv } from "./env-loader.ts";
import { createWebBackendApp } from "./server.ts";

interface CliOptions {
	host?: string;
	port?: string;
	configDir?: string;
	logDir?: string;
	replay?: string;
}

loadDotEnv();

const options = parseCliOptions(process.argv.slice(2));
const host = options.host ?? process.env.PI_WEB_BACKEND_HOST ?? "127.0.0.1";
const port = parsePort(options.port ?? process.env.PI_WEB_BACKEND_PORT ?? "8787");
prepareRuntimeDirs(options);
if (options.replay) process.env.PI_WEB_BACKEND_REPLAY_LOG = options.replay;

const { app } = createWebBackendApp();

serve({
	fetch: app.fetch,
	hostname: host,
	port,
});

console.log(`pi web backend listening on http://${host}:${port}`);

function parseCliOptions(args: string[]): CliOptions {
	const options: CliOptions = {};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
		const [name, inlineValue] = arg.split("=", 2);
		const value = inlineValue ?? args[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
		if (inlineValue === undefined) index += 1;

		switch (name) {
			case "--host":
				options.host = value;
				break;
			case "--port":
				options.port = value;
				break;
			case "--config-dir":
				options.configDir = value;
				break;
			case "--log-dir":
				options.logDir = value;
				break;
			case "--replay":
				options.replay = value;
				break;
			default:
				throw new Error(`Unknown option: ${name}`);
		}
	}
	return options;
}

function prepareRuntimeDirs(options: CliOptions): void {
	if (options.configDir) {
		mkdirSync(options.configDir, { recursive: true });
		process.env.PI_WEB_BACKEND_CONFIG_DIR = options.configDir;
	}
	if (options.logDir) {
		mkdirSync(options.logDir, { recursive: true });
		process.env.PI_WEB_BACKEND_LOG_DIR = options.logDir;
	}
}

function parsePort(value: string): number {
	const port = Number(value);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`Invalid PI_WEB_BACKEND_PORT: ${value}`);
	}
	return port;
}
