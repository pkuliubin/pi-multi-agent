import type { FormEvent, KeyboardEvent } from "react";
import { useState } from "react";

interface PromptInputProps {
	pending: boolean;
	notice: string | null;
	onSubmit: (text: string) => Promise<void>;
	onAbort: () => Promise<void>;
}

export function PromptInput({ pending, notice, onSubmit, onAbort }: PromptInputProps) {
	const [text, setText] = useState("");
	const canSubmit = text.trim().length > 0 && !pending;

	async function submitPrompt() {
		if (!canSubmit) {
			return;
		}

		const prompt = text.trim();
		setText("");
		await onSubmit(prompt);
	}

	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		void submitPrompt();
	}

	function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
			return;
		}

		event.preventDefault();
		void submitPrompt();
	}

	return (
		<form className="prompt-bar" onSubmit={handleSubmit} aria-label="Send prompt to main agent">
			<textarea
				id="prompt-input"
				value={text}
				onChange={(event) => setText(event.currentTarget.value)}
				onKeyDown={handleKeyDown}
				placeholder="Ask the coordinator to run a multi-agent task..."
				rows={2}
			/>
			{notice ? <output>{notice}</output> : null}
			<button
				type={pending ? "button" : "submit"}
				className={pending ? "icon-button stop-button" : "icon-button send-button"}
				disabled={!pending && !canSubmit}
				onClick={pending ? onAbort : undefined}
				aria-label={pending ? "Stop" : "Send"}
			>
				{pending ? "■" : "➤"}
			</button>
		</form>
	);
}
