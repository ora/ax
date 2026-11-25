/**
 * One entry of a `trajectory` snapshot. Richer than the raw `step` events: a
 * tool call arrives merged with its result (status, duration, structured
 * output) plus ora's attribution of where the agent got the target from.
 */
export interface JourneyStep {
	id: number;
	turn: number;
	type: string; // "text" | "tool_call" | "tool_result" | …
	kind?: string; // for text steps: "reasoning" | "text" | "output"
	text?: string;
	thinking?: string;
	tool?: string;
	action?: string;
	input?: Record<string, unknown>;
	input_display?: string;
	summary?: string;
	label?: string;
	status?: number;
	duration_ms?: number;
	is_error?: boolean;
	output_structured?: { body?: string; links?: Array<{ title?: string; url?: string }> };
	elapsed_ms?: number;
	attribution?: {
		kind?: string; // "web_search" | "prior_knowledge" | "previous_artifact" | …
		method?: string;
		confidence?: string;
		/** For link-follows: the exact step this URL was discovered on. */
		referrer?: { step_id?: number; turn?: number; artifact_kind?: string; url_path?: string };
	};
}

export function decodeEventBlock(block: string): { event: string; data: string } | null {
	let event = "message";
	const payload: string[] = [];
	for (const row of block.split("\n")) {
		if (row.startsWith(":")) continue; // heartbeat comment
		if (row.startsWith("event:")) event = row.slice(6).trim();
		else if (row.startsWith("data:")) payload.push(row.slice(5).replace(/^ /, ""));
	}
	return payload.length ? { event, data: payload.join("\n") } : null;
}
