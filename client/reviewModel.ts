import type { Finding, Placement } from "./logic/review/findings";
import { placeFinding } from "./logic/review/findings";
import type { Review } from "./logic/review/state";
import type { Theme } from "./style";

export type PlacedFinding = { finding: Finding; placement: Placement };

export function placedFindings(review: Review | null): PlacedFinding[] {
  if (!review?.report) return [];
  return review.report.findings.map((finding) => ({ finding, placement: placeFinding(finding, review.files) }));
}

export const SEVERITY_EMOJI = { critical: "🔴", high: "🟠", medium: "🟡", low: "🟢" } as const;

export function severityColor(severity: Finding["severity"], theme: Theme): string {
  switch (severity) {
    case "critical":
      return theme.colors.statusDanger;
    case "high":
      return theme.colors.statusWarning;
    case "medium":
      return theme.colors.accent;
    default:
      return theme.colors.statusSuccess;
  }
}
