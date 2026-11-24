import type { JourneyStep } from "../api/platform";
import type { AxClient, SetDocument } from "../api/sets";
import { buildJourneyTree, drawJourneyTree, journeySummary } from "../ui/graph";
import { LivePanel } from "../ui/panel";
import type { SetProgress } from "./set-progress";

/** One terminal tree, fed by the child run’s trajectory while the owning evaluation determines when grading finishes. */
export class JourneyProgress implements SetProgress {
	private readonly panel = new LivePanel();
	private readonly stop = new AbortController();
	private attached = false;
	private state = "preparing";
	private steps: JourneyStep[] = [];

	constructor(
		private readonly client: AxClient,
		private readonly goal: string,
	) {}

	show(set: SetDocument): void {
		this.state = set.state;
		this.panel.open();
		this.draw();
		if (this.attached || set.complete || !set.runs.started) return;
		this.attached = true;
		// The report still settles and its final evidence is read if the live stream closes early.
		void this.client
			.followRun(
				set.setId,
				(steps) => {
					if (this.stop.signal.aborted) return;
					this.steps = steps;
					this.draw();
				},
				this.stop.signal,
			)
			.catch(() => {});
	}

	private draw(): void {
		const tree = drawJourneyTree(buildJourneyTree(this.steps, this.goal, false));
		this.panel.draw(
			[`  ${journeySummary(this.steps)}`, "", ...tree.map((line) => `  ${line}`)],
			this.state,
		);
	}

	note(message: string): void {
		this.panel.draw([], message);
	}

	close(): void {
		this.stop.abort();
		this.panel.close();
	}

	leftOnScreen(): boolean {
		return false;
	}
}
