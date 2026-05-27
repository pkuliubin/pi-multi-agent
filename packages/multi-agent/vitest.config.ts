import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const multiAgentSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@earendil-works\/pi-multi-agent$/, replacement: multiAgentSrcIndex },
		],
	},
});
