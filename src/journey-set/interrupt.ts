/** A signal that aborts on the first Ctrl-C, and the call that stops listening. */
export function onInterrupt(): { signal: AbortSignal; stop: () => void } {
	const controller = new AbortController();
	const handler = () => controller.abort();
	process.once("SIGINT", handler);
	return { signal: controller.signal, stop: () => process.removeListener("SIGINT", handler) };
}
