/** The transcript's own duration formatting (`<1s`, `12s`, `3m 05s`, `1h 02m`),
 *  published verbatim as the activity API's `formatDuration`. */
export function formatBashDuration(ms: number): string {
	const safeMs = Math.max(0, Number.isFinite(ms) ? ms : 0);
	if (safeMs < 1_000) return "<1s";
	const totalSeconds = Math.floor(safeMs / 1_000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) return `${totalMinutes}m ${String(seconds).padStart(2, "0")}s`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}
