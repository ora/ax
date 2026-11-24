import type { AxClient } from "../api/sets";
import { runIsLive, type StandaloneEvidence, type StandaloneRun } from "../api/standalone";
import { buildJourneyTree, drawJourneyTree, journeySummary } from "../ui/graph";
import { LivePanel } from "../ui/panel";

/** Report the last durable state even when the live connection ends early. */
export async function watchRun(
	client: Pick<AxClient, "getRun" | "followRun">,
	run: StandaloneRun,
	opts: { json: boolean; interrupt: AbortSignal; waitMinutes: number },
): Promise<StandaloneEvidence> {
	if (runIsLive(run)) {
		const panel = !opts.json && process.stdout.isTTY ? new LivePanel() : null;
		const timeout = AbortSignal.timeout(opts.waitMinutes * 60_000);
		const signal = AbortSignal.any([opts.interrupt, timeout]);
		try {
			panel?.open();
			await client.followRun(
				run.runId,
				(steps) => {
					if (!panel) return;
					const tree = drawJourneyTree(buildJourneyTree(steps, run.goal, false));
					panel.draw(
						[`  ${journeySummary(steps)}`, "", ...tree.map((line) => `  ${line}`)],
						"Running",
					);
				},
				signal,
			);
		} catch (error) {
			if (opts.interrupt.aborted) throw error;
			if (!timeout.aborted) console.error("Live updates ended. Reading the saved run.");
		} finally {
			panel?.close();
		}
	}
	return client.getRun(run.runId);
}
