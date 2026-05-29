import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function loadDotEnv(cwd = process.cwd()): void {
	for (const envPath of candidateEnvPaths(cwd)) {
		if (!existsSync(envPath)) continue;

		for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
			const parsed = parseEnvLine(line);
			if (!parsed || process.env[parsed.key] !== undefined) continue;
			process.env[parsed.key] = parsed.value;
		}
	}
}

function candidateEnvPaths(cwd: string): string[] {
	const paths: string[] = [];
	let current = resolve(cwd);

	while (true) {
		paths.push(resolve(current, ".env"));
		const parent = dirname(current);
		if (parent === current) return paths;
		current = parent;
	}
}

function parseEnvLine(line: string): { key: string; value: string } | null {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#")) return null;
	const separatorIndex = trimmed.indexOf("=");
	if (separatorIndex <= 0) return null;

	const key = trimmed.slice(0, separatorIndex).trim();
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

	return { key, value: unquoteEnvValue(trimmed.slice(separatorIndex + 1).trim()) };
}

function unquoteEnvValue(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replaceAll("\\n", "\n").replaceAll('\\"', '"');
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1);
	}
	return value;
}
