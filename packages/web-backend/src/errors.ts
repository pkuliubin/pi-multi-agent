import type { ApiErrorCode, ApiErrorResponse } from "./contract.ts";

export class ApiError extends Error {
	readonly code: ApiErrorCode;
	readonly status: number;
	readonly details: unknown;

	constructor(code: ApiErrorCode, message: string, status = 500, details?: unknown) {
		super(message);
		this.name = "ApiError";
		this.code = code;
		this.status = status;
		this.details = details;
	}
}

export function createApiErrorResponse(error: ApiError): ApiErrorResponse {
	return {
		error: {
			code: error.code,
			message: error.message,
			...(error.details === undefined ? {} : { details: error.details }),
		},
	};
}

export function toApiError(error: unknown): ApiError {
	if (error instanceof ApiError) return error;
	if (error instanceof Error) return new ApiError("INTERNAL_ERROR", error.message, 500);
	return new ApiError("INTERNAL_ERROR", "Internal error", 500, error);
}

export function invalidRequest(message: string, details?: unknown): ApiError {
	return new ApiError("INVALID_REQUEST", message, 400, details);
}

export function sessionNotStarted(): ApiError {
	return new ApiError("SESSION_NOT_STARTED", "Session has not been started", 409);
}

export function sessionAlreadyRunning(): ApiError {
	return new ApiError("SESSION_ALREADY_RUNNING", "A backend session is already running", 409);
}

export function invalidMode(message: string): ApiError {
	return new ApiError("INVALID_MODE", message, 409);
}

export function artifactNotFound(path: string): ApiError {
	return new ApiError("ARTIFACT_NOT_FOUND", `Artifact not found: ${path}`, 404);
}
