import type { ClassifiedFailure } from '../classify.js';
import { CLASS_BADGE, CLASS_ORDER } from './badges.js';

const REPO_URL = 'https://github.com/Jarroslav/playwright-ai-triage';

/** Detail bullets across the whole comment; catastrophic runs summarize the rest. */
const MAX_LISTED = 50;
/** GitHub caps issue-comment bodies at 65536 chars; stay safely under. */
const MAX_BODY_CHARS = 60_000;

export interface RenderContext {
  model: string;
  costUsd: number | undefined;
  notes: string[];
  shard: { current: number; total: number } | null;
  projectByTestId?: Record<string, string>;
  /** cross-run delta (R3); absent ⇒ unlabeled rendering, identical to pre-delta output */
  delta?: DeltaContext;
}

export interface DeltaContext {
  labelByTestId: Record<string, 'new' | 'persisting'>;
  resolvedCount: number;
}

/**
 * Model- and page-controlled text must never carry live HTML or break out of
 * its markdown slot: HTML entities are escaped, link syntax is defanged, and
 * backticks are stripped (they would terminate our code spans).
 */
function sanitize(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll('`', "'");
}

function renderGroup(
  classified: ClassifiedFailure[],
  lines: string[],
  budget: { left: number },
  delta?: DeltaContext,
): void {
  for (const cls of CLASS_ORDER) {
    if (budget.left <= 0) return; // no dangling group headers once capped
    const group = classified.filter((c) => c.classification.class === cls);
    if (group.length === 0) continue;
    lines.push('', `**${CLASS_BADGE[cls]} (${group.length})**`, '');
    for (const { payload, classification } of group) {
      if (budget.left <= 0) {
        return;
      }
      budget.left -= 1;
      const confidence = Math.round(classification.confidence * 100);
      const label = delta?.labelByTestId[payload.testId];
      if (label === 'persisting') {
        // R3: already announced on a previous run — one line, no why/fix re-announcement
        lines.push(
          `- ⏳ **${sanitize(payload.title)}** _(${confidence}%)_ · \`${sanitize(payload.file)}:${payload.line}\``,
        );
        continue;
      }
      const prefix = label === 'new' ? '🆕 ' : '';
      lines.push(
        `- ${prefix}**${sanitize(payload.title)}** — ${sanitize(classification.why)} _(${confidence}%)_`,
      );
      if (classification.suggestedFix) {
        lines.push(`  - fix: \`${sanitize(classification.suggestedFix)}\``);
      }
      lines.push(`  - \`${sanitize(payload.file)}:${payload.line}\``);
    }
  }
}

/** Shared summary body for the PR comment (and the basis of other rich outputs). */
export function renderMarkdownSummary(classified: ClassifiedFailure[], ctx: RenderContext): string {
  // Fail-closed honesty: UNCLASSIFIED (incl. overflow) is not "triaged".
  const unclassified = classified.filter((c) => c.classification.class === 'UNCLASSIFIED').length;
  const triagedCount = classified.length - unclassified;
  const unclassifiedSuffix = unclassified > 0 ? ` · ${unclassified} unclassified` : '';
  const shard = ctx.shard ? ` · shard ${ctx.shard.current}/${ctx.shard.total}` : '';
  const lines: string[] = [
    `### 🧭 AI triage — ${triagedCount} failure(s) triaged${unclassifiedSuffix}${shard}`,
  ];
  if (ctx.delta && ctx.delta.resolvedCount > 0) {
    lines.push('', `✅ **${ctx.delta.resolvedCount} failure(s) resolved since the last run.**`);
  }
  const budget = { left: MAX_LISTED };

  const projects = ctx.projectByTestId ?? {};
  const projectNames = [...new Set(Object.values(projects))];
  if (projectNames.length > 1) {
    for (const project of projectNames) {
      lines.push('', `#### ${sanitize(project)}`);
      renderGroup(
        classified.filter((c) => projects[c.payload.testId] === project),
        lines,
        budget,
        ctx.delta,
      );
    }
    const ungrouped = classified.filter((c) => !projects[c.payload.testId]);
    if (ungrouped.length > 0) {
      lines.push('', '#### (no project)');
      renderGroup(ungrouped, lines, budget, ctx.delta);
    }
  } else {
    renderGroup(classified, lines, budget, ctx.delta);
  }

  const unlisted = classified.length - Math.min(classified.length, MAX_LISTED);
  if (unlisted > 0) {
    lines.push('', `_…and ${unlisted} more failure(s) not listed (comment size limit)._`);
  }

  for (const note of ctx.notes) lines.push('', `> note: ${sanitize(note)}`);

  const cost = ctx.costUsd === undefined ? 'cost unavailable' : `$${ctx.costUsd.toFixed(4)}`;
  lines.push(
    '',
    '---',
    `_Triaged by [playwright-ai-triage](${REPO_URL}) · ${ctx.model} · ${cost}_`,
  );

  const body = lines.join('\n');
  if (body.length <= MAX_BODY_CHARS) return body;
  // hard safety net: keep the footer, truncate the middle
  const footer = lines.slice(-3).join('\n');
  return `${body.slice(0, MAX_BODY_CHARS - footer.length - 40)}\n\n_…truncated (size limit)._\n\n${footer}`;
}

/**
 * R1: the comment a green run flips the previous red report to. `resolvedCount`
 * is null when the previous comment predates fingerprint blocks (count unknown).
 * No model/cost line — nothing was classified on this run.
 */
export function renderAllClearSummary(
  resolvedCount: number | null,
  shard: RenderContext['shard'],
): string {
  const shardSuffix = shard ? ` · shard ${shard.current}/${shard.total}` : '';
  const resolved =
    resolvedCount === null
      ? 'All previously reported failures resolved.'
      : `${resolvedCount} previously reported failure(s) resolved.`;
  return [
    `### 🧭 AI triage — all clear ✅${shardSuffix}`,
    '',
    resolved,
    '',
    '---',
    `_Triaged by [playwright-ai-triage](${REPO_URL})_`,
  ].join('\n');
}
