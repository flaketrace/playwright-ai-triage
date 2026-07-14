import type { ClassifiedFailure } from './classify.js';
import { CLASS_BADGE as BADGE, CLASS_ORDER as ORDER } from './render/badges.js';

/** Minimal stdout summary; rich outputs live in render/.
 * `model: null` = no API call was made this run (keyless) — the cost line must
 * not name a model that was never called. */
export function renderStdoutSummary(
  classified: ClassifiedFailure[],
  costUsd: number | undefined,
  notes: string[],
  model: string | null,
): string {
  // Fail-closed honesty: UNCLASSIFIED (incl. overflow) is not "triaged".
  const unclassified = classified.filter((c) => c.classification.class === 'UNCLASSIFIED').length;
  const triagedCount = classified.length - unclassified;
  const suffix = unclassified > 0 ? ` · ${unclassified} unclassified` : '';
  const lines: string[] = [
    '',
    `playwright-ai-triage — ${triagedCount} failure(s) triaged${suffix}`,
  ];

  for (const cls of ORDER) {
    const group = classified.filter((c) => c.classification.class === cls);
    if (group.length === 0) continue;
    lines.push('', `${BADGE[cls]} (${group.length})`);
    for (const { payload, classification } of group) {
      const confidence = Math.round(classification.confidence * 100);
      lines.push(`  • ${payload.title} — ${classification.why} [${confidence}%]`);
      if (classification.suggestedFix) lines.push(`    fix: ${classification.suggestedFix}`);
      lines.push(`    ${payload.file}:${payload.line}`);
    }
  }

  for (const note of notes) lines.push('', `note: ${note}`);

  lines.push(
    '',
    model === null
      ? `cost of this run: $${(costUsd ?? 0).toFixed(4)} (no API calls made)`
      : costUsd === undefined
        ? `model: ${model} · cost unavailable for this model`
        : `cost of this run: $${costUsd.toFixed(4)} (${model})`,
  );
  return lines.join('\n');
}

/** Degraded summary when classification is unavailable (no API key). */
export function renderPlainSummary(
  failures: { title: string; file: string; line: number }[],
): string {
  const lines = ['', `playwright-ai-triage — ${failures.length} failure(s), not classified`];
  for (const f of failures) lines.push(`  • ${f.title} (${f.file}:${f.line})`);
  lines.push(
    '',
    'hint: set ANTHROPIC_API_KEY to enable AI failure classification (https://console.anthropic.com/)',
  );
  return lines.join('\n');
}
