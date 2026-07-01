import type {
	AbortRequest,
	AbortResponse,
	AgentHistoryResponse,
	AgentsResponse,
	ApiErrorResponse,
	MessagesResponse,
	PromptRequest,
	PromptResponse,
	ReplayResetRequest,
	ReplaySpeedRequest,
	RoleSessionsResponse,
	SessionSnapshot,
	SharedStateArtifactResponse,
	SharedStateManifestResponse,
	StartSessionRequest,
	StopSessionRequest,
} from "./contracts.ts";

export class ApiError extends Error {
	readonly status: number;
	readonly code: ApiErrorResponse["error"]["code"] | "NETWORK_ERROR" | "INVALID_RESPONSE";
	readonly details: unknown;

	constructor(message: string, status: number, code: ApiError["code"], details?: unknown) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

export interface ApiClientOptions {
	baseUrl?: string;
	fetchImpl?: typeof fetch;
}

export interface ApiClient {
	getState(): Promise<SessionSnapshot>;
	getMessages(): Promise<MessagesResponse>;
	getAgents(): Promise<AgentsResponse>;
	getAgentHistory(agentId: string): Promise<AgentHistoryResponse>;
	getRoleSessions(): Promise<RoleSessionsResponse>;
	getSharedStateManifest(): Promise<SharedStateManifestResponse>;
	getSharedStateArtifact(path: string): Promise<SharedStateArtifactResponse>;
	startSession(request: StartSessionRequest): Promise<SessionSnapshot>;
	stopSession(request?: StopSessionRequest): Promise<SessionSnapshot>;
	sendPrompt(text: string): Promise<PromptResponse>;
	abortTurn(reason?: string): Promise<AbortResponse>;
	resetReplay(autoStart?: boolean): Promise<SessionSnapshot>;
	setReplaySpeed(speed: number): Promise<SessionSnapshot>;
}

const defaultBaseUrl = import.meta.env.VITE_PI_WEB_UI_API_BASE_URL ?? "";

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
	const baseUrl = normalizeBaseUrl(options.baseUrl ?? defaultBaseUrl);
	const fetchImpl = options.fetchImpl ?? fetch;

	async function request<TResponse>(path: string, init?: RequestInit): Promise<TResponse> {
		let response: Response;

		try {
			const headers = new Headers(init?.headers);
			headers.set("Accept", "application/json");

			if (hasBody(init)) {
				headers.set("Content-Type", "application/json");
			}

			response = await fetchImpl(`${baseUrl}${path}`, {
				...init,
				headers,
			});
		} catch (error) {
			throw new ApiError(
				error instanceof Error ? error.message : "Network request failed",
				0,
				"NETWORK_ERROR",
				error,
			);
		}

		const body = await readJson(response);

		if (!response.ok) {
			const apiError = parseApiError(body);
			throw new ApiError(apiError.message, response.status, apiError.code, apiError.details);
		}

		return body as TResponse;
	}

	function post<TRequest extends object, TResponse>(path: string, body: TRequest): Promise<TResponse> {
		return request<TResponse>(path, {
			method: "POST",
			body: JSON.stringify(body),
		});
	}

	return {
		getState: () => request<SessionSnapshot>("/api/state"),
		getMessages: () => request<MessagesResponse>("/api/messages"),
		getAgents: () => request<AgentsResponse>("/api/agents"),
		getAgentHistory: (agentId: string) =>
			request<AgentHistoryResponse>(`/api/agents/${encodeURIComponent(agentId)}/history`),
		getRoleSessions: () => request<RoleSessionsResponse>("/api/role-sessions"),
		getSharedStateManifest: () => request<SharedStateManifestResponse>("/api/shared-state/manifest"),
		getSharedStateArtifact: (path: string) => {
			const params = new URLSearchParams({ path });
			return request<SharedStateArtifactResponse>(`/api/shared-state/artifact?${params}`);
		},
		startSession: (requestBody: StartSessionRequest) =>
			post<StartSessionRequest, SessionSnapshot>("/api/session/start", requestBody),
		stopSession: (requestBody: StopSessionRequest = {}) =>
			post<StopSessionRequest, SessionSnapshot>("/api/session/stop", requestBody),
		sendPrompt: (text: string) => post<PromptRequest, PromptResponse>("/api/prompt", { text }),
		abortTurn: (reason?: string) => {
			const body: AbortRequest = reason ? { reason } : {};
			return post<AbortRequest, AbortResponse>("/api/abort", body);
		},
		resetReplay: (autoStart?: boolean) => {
			const body: ReplayResetRequest = autoStart === undefined ? {} : { autoStart };
			return post<ReplayResetRequest, SessionSnapshot>("/api/replay/reset", body);
		},
		setReplaySpeed: (speed: number) => post<ReplaySpeedRequest, SessionSnapshot>("/api/replay/speed", { speed }),
	};
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function hasBody(init: RequestInit | undefined): boolean {
	return typeof init?.body === "string";
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch (error) {
		if (response.ok) {
			throw new ApiError("Backend returned invalid JSON", response.status, "INVALID_RESPONSE", error);
		}

		return null;
	}
}

function parseApiError(body: unknown): ApiErrorResponse["error"] {
	if (isApiErrorResponse(body)) {
		return body.error;
	}

	return {
		code: "INTERNAL_ERROR",
		message: "Backend request failed",
		details: body,
	};
}

function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		"error" in value &&
		typeof value.error === "object" &&
		value.error !== null &&
		"code" in value.error &&
		typeof value.error.code === "string" &&
		"message" in value.error &&
		typeof value.error.message === "string"
	);
}
