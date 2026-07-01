import type { ReactNode } from "react";

interface MarkdownBlock {
	kind: "heading" | "paragraph" | "ul" | "ol" | "code" | "hr" | "table";
	level?: 2 | 3 | 4;
	text?: string;
	items?: string[];
	language?: string;
	headers?: string[];
	rows?: string[][];
}
export function MarkdownLite({ markdown }: { markdown: string }) {
	return parseMarkdown(markdown).map((block, index) => {
		const key = `${block.kind}-${index}`;
		if (block.kind === "heading") {
			const children = renderInline(block.text ?? "");
			if (block.level === 2) return <h2 key={key}>{children}</h2>;
			if (block.level === 3) return <h3 key={key}>{children}</h3>;
			return <h4 key={key}>{children}</h4>;
		}
		if (block.kind === "ul") {
			return (
				<ul key={key}>
					{(block.items ?? []).map((item) => (
						<li key={`${key}-${stableKey(item)}`}>{renderInline(item)}</li>
					))}
				</ul>
			);
		}
		if (block.kind === "ol") {
			return (
				<ol key={key}>
					{(block.items ?? []).map((item) => (
						<li key={`${key}-${stableKey(item)}`}>{renderInline(item)}</li>
					))}
				</ol>
			);
		}
		if (block.kind === "code") {
			return (
				<pre key={key} className="markdown-code" data-language={block.language ?? undefined}>
					<code>{block.text ?? ""}</code>
				</pre>
			);
		}
		if (block.kind === "table") {
			return (
				<div key={key} className="markdown-table-wrap">
					<table className="markdown-table">
						<thead>
							<tr>
								{(block.headers ?? []).map((header) => (
									<th key={`${key}-head-${stableKey(header)}`}>{renderInline(header)}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{(block.rows ?? []).map((row) => (
								<tr key={`${key}-row-${stableKey(row.join("|"))}`}>
									{row.map((cell) => (
										<td key={`${key}-cell-${stableKey(row.join("|"))}-${stableKey(cell)}`}>
											{renderInline(cell)}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		}
		if (block.kind === "hr") return <hr key={key} />;
		return <p key={key}>{renderInline(block.text ?? "")}</p>;
	});
}

function parseMarkdown(markdown: string): MarkdownBlock[] {
	const blocks: MarkdownBlock[] = [];
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	let paragraph: string[] = [];
	let index = 0;

	function flushParagraph() {
		if (paragraph.length === 0) return;
		blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
		paragraph = [];
	}

	while (index < lines.length) {
		const line = lines[index] ?? "";
		const trimmed = line.trim();

		if (trimmed.length === 0) {
			flushParagraph();
			index += 1;
			continue;
		}

		if (trimmed.startsWith("```")) {
			flushParagraph();
			const language = trimmed.slice(3).trim() || undefined;
			const codeLines: string[] = [];
			index += 1;
			while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
				codeLines.push(lines[index] ?? "");
				index += 1;
			}
			blocks.push({ kind: "code", language, text: codeLines.join("\n") });
			index += 1;
			continue;
		}

		const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
		if (heading) {
			flushParagraph();
			blocks.push({ kind: "heading", level: Math.min(heading[1].length + 1, 4) as 2 | 3 | 4, text: heading[2] });
			index += 1;
			continue;
		}

		if (/^[-*_]{3,}$/.test(trimmed)) {
			flushParagraph();
			blocks.push({ kind: "hr" });
			index += 1;
			continue;
		}

		if (isMarkdownTableHeader(lines, index)) {
			flushParagraph();
			const headers = splitTableRow(lines[index] ?? "");
			const rows: string[][] = [];
			index += 2;
			while (index < lines.length && isTableRow(lines[index] ?? "")) {
				const row = splitTableRow(lines[index] ?? "");
				rows.push(normalizeTableRow(row, headers.length));
				index += 1;
			}
			blocks.push({ kind: "table", headers, rows });
			continue;
		}

		if (/^[-*]\s+/.test(trimmed)) {
			flushParagraph();
			const items: string[] = [];
			while (index < lines.length) {
				const item = /^[-*]\s+(.+)$/.exec((lines[index] ?? "").trim());
				if (!item) break;
				items.push(item[1]);
				index += 1;
			}
			blocks.push({ kind: "ul", items });
			continue;
		}

		if (/^\d+\.\s+/.test(trimmed)) {
			flushParagraph();
			const items: string[] = [];
			while (index < lines.length) {
				const item = /^\d+\.\s+(.+)$/.exec((lines[index] ?? "").trim());
				if (!item) break;
				items.push(item[1]);
				index += 1;
			}
			blocks.push({ kind: "ol", items });
			continue;
		}

		paragraph.push(line);
		index += 1;
	}

	flushParagraph();
	return blocks;
}

function isMarkdownTableHeader(lines: string[], index: number): boolean {
	const header = lines[index] ?? "";
	const divider = lines[index + 1] ?? "";
	return isTableRow(header) && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(divider);
}

function isTableRow(line: string): boolean {
	return line.includes("|") && splitTableRow(line).length >= 2;
}

function splitTableRow(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim());
}

function normalizeTableRow(row: string[], length: number): string[] {
	if (row.length >= length) return row.slice(0, length);
	return [...row, ...Array.from({ length: length - row.length }, () => "")];
}

function renderInline(text: string): ReactNode[] {
	const nodes: ReactNode[] = [];
	const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
	let lastIndex = 0;
	let match = pattern.exec(text);

	while (match !== null) {
		if (match.index > lastIndex) {
			nodes.push(...renderSoftBreaks(text.slice(lastIndex, match.index), nodes.length));
		}
		const token = match[0];
		if (token.startsWith("**")) {
			nodes.push(<strong key={`strong-${match.index}`}>{token.slice(2, -2)}</strong>);
		} else {
			nodes.push(<code key={`code-${match.index}`}>{token.slice(1, -1)}</code>);
		}
		lastIndex = match.index + token.length;
		match = pattern.exec(text);
	}

	if (lastIndex < text.length) {
		nodes.push(...renderSoftBreaks(text.slice(lastIndex), nodes.length));
	}

	return nodes;
}

function renderSoftBreaks(text: string, offset: number): ReactNode[] {
	const parts = text.split("\n");
	const nodes: ReactNode[] = [];
	let cursor = 0;

	for (const part of parts) {
		if (cursor > 0) {
			nodes.push(<br key={`br-${offset}-${cursor}-${stableKey(part)}`} />);
		}
		nodes.push(part);
		cursor += 1;
	}

	return nodes;
}

function stableKey(value: string): string {
	return value.length > 48 ? value.slice(0, 48) : value;
}
