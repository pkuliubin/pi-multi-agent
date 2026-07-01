import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "../src/api/http-client.ts";
import { sessionSnapshot } from "./fixtures.ts";

describe("createApiClient", () => {
	it("returns successful JSON responses", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(sessionSnapshot));
		const client = createApiClient({ baseUrl: "http://backend/", fetchImpl });

		await expect(client.getState()).resolves.toEqual(sessionSnapshot);
		expect(fetchImpl).toHaveBeenCalledWith(
			"http://backend/api/state",
			expect.objectContaining({ headers: expect.any(Headers) }),
		);
	});

	it("throws typed API errors", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			jsonResponse(
				{
					error: {
						code: "SESSION_NOT_STARTED",
						message: "Start a session first",
					},
				},
				409,
			),
		);
		const client = createApiClient({ fetchImpl });

		await expect(client.sendPrompt("hello")).rejects.toMatchObject({
			status: 409,
			code: "SESSION_NOT_STARTED",
			message: "Start a session first",
		});
	});

	it("encodes artifact paths", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			jsonResponse({
				path: "folder/a b.json",
				artifact: null,
				content: { kind: "text", text: "", sizeBytes: 0, mimeType: null, truncated: false },
			}),
		);
		const client = createApiClient({ fetchImpl });

		await client.getSharedStateArtifact("folder/a b.json");
		const [url] = fetchImpl.mock.calls[0] ?? [];
		expect(String(url)).toContain("/api/shared-state/artifact?path=folder%2Fa+b.json");
	});

	it("posts replay control requests", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse(sessionSnapshot))
			.mockResolvedValueOnce(jsonResponse(sessionSnapshot));
		const client = createApiClient({ fetchImpl });

		await client.resetReplay(true);
		await client.setReplaySpeed(20);

		expect(fetchImpl).toHaveBeenNthCalledWith(
			1,
			"/api/replay/reset",
			expect.objectContaining({ body: JSON.stringify({ autoStart: true }), method: "POST" }),
		);
		expect(fetchImpl).toHaveBeenNthCalledWith(
			2,
			"/api/replay/speed",
			expect.objectContaining({ body: JSON.stringify({ speed: 20 }), method: "POST" }),
		);
	});

	it("wraps network failures", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
		const client = createApiClient({ fetchImpl });

		await expect(client.getState()).rejects.toBeInstanceOf(ApiError);
		await expect(client.getState()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
	});
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
