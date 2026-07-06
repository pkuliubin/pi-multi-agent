#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const artifactRoot = join(repoRoot, "dist", "pi-web-backend-sidecar");
const runtimeRoot = join(artifactRoot, "runtime");
const runtimeNodeModules = join(runtimeRoot, "node_modules");
const runtimeBackend = join(runtimeRoot, "web-backend");
const fixtureSource = join(repoRoot, "tmp", "gui-sse-captures", "2026-07-02T02-09-43-487Z-replay.json");

execFileSync("npm", ["--prefix", join(repoRoot, "packages", "web-backend"), "run", "build"], {
	cwd: repoRoot,
	stdio: "inherit",
});

rmSync(artifactRoot, { recursive: true, force: true });
mkdirSync(join(artifactRoot, "bin"), { recursive: true });
mkdirSync(runtimeRoot, { recursive: true });
mkdirSync(join(artifactRoot, "fixtures"), { recursive: true });

copyDirectory(join(repoRoot, "node_modules"), runtimeNodeModules);
copyPackageDist("web-backend", runtimeBackend);

if (existsSync(fixtureSource)) {
	cpSync(fixtureSource, join(artifactRoot, "fixtures", "replay.json"));
}

const wrapperPath = join(artifactRoot, "bin", "web-backend");
writeFileSync(
	wrapperPath,
	`#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
export NODE_PATH="$DIR/runtime/node_modules${"${NODE_PATH:+:$NODE_PATH}"}"
exec node "$DIR/runtime/web-backend/dist/cli.js" "$@"
`,
);
chmodSync(wrapperPath, 0o755);

const webBackendPackage = JSON.parse(readFileSync(join(repoRoot, "packages", "web-backend", "package.json"), "utf8"));
const manifest = {
	kind: "pi-web-backend-sidecar",
	schemaVersion: 1,
	version: webBackendPackage.version,
	build: {
		gitSha: gitOutput(["rev-parse", "HEAD"]),
		builtAt: new Date().toISOString(),
		platform: `${process.platform}-${process.arch}`,
	},
	entrypoint: {
		command: "bin/web-backend",
		args: ["--port", "$PORT", "--config-dir", "$CONFIG_DIR", "--log-dir", "$LOG_DIR"],
	},
	contract: {
		basePath: "/api",
		endpoints: [
			"/api/state",
			"/api/messages",
			"/api/agents",
			"/api/agents/:agentId/history",
			"/api/shared-state/manifest",
			"/api/shared-state/artifact",
			"/api/events",
		],
		replaySources: ["sse_capture"],
	},
};
writeFileSync(join(artifactRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Built ${artifactRoot}`);

function copyDirectory(source, destination) {
	cpSync(source, destination, {
		recursive: true,
		dereference: true,
		force: true,
		filter: (sourcePath) => !sourcePath.includes(`${artifactRoot}/`),
	});
}

function copyPackageDist(packageName, destination) {
	const source = join(repoRoot, "packages", packageName);
	mkdirSync(destination, { recursive: true });
	cpSync(join(source, "dist"), join(destination, "dist"), { recursive: true, force: true });
	cpSync(join(source, "package.json"), join(destination, "package.json"));
}

function gitOutput(args) {
	try {
		return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}
