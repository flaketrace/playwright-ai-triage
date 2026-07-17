import type { ClassifiedFailure } from '../classify.js';
import { CLASS_BADGE, CLASS_ORDER } from './badges.js';
import type { RenderContext } from './markdown.js';

/** Slack caps section text at 3000 chars and payloads at 50 blocks. */
const MAX_SECTION_CHARS = 2900;
const MAX_LISTED = 30;

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number }>;

export type SendResult = { ok: true } | { ok: false; note: string };

/** Slack mrkdwn requires &, <, > escaped in all interpolated text. */
function escapeMrkdwn(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function buildSlackPayload(classified: ClassifiedFailure[], ctx: RenderContext): object {
  // Fail-closed honesty: UNCLASSIFIED (incl. overflow) is not "triaged".
  const unclassified = classified.filter((c) => c.classification.class === 'UNCLASSIFIED').length;
  const triagedCount = classified.length - unclassified;
  const unclassifiedSuffix = unclassified > 0 ? ` · ${unclassified} unclassified` : '';
  const shard = ctx.shard ? ` · shard ${ctx.shard.current}/${ctx.shard.total}` : '';
  const blocks: object[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `AI triage — ${triagedCount} failure(s) triaged${unclassifiedSuffix}${shard}`,
        emoji: true,
      },
    },
  ];

  let listed = 0;
  for (const cls of CLASS_ORDER) {
    const group = classified.filter((c) => c.classification.class === cls);
    if (group.length === 0) continue;
    const lines: string[] = [];
    for (const { payload, classification } of group) {
      if (listed >= MAX_LISTED) break;
      listed += 1;
      const confidence = Math.round(classification.confidence * 100);
      lines.push(
        `• *${escapeMrkdwn(payload.title)}* — ${escapeMrkdwn(classification.why)} (${confidence}%)`,
      );
    }
    if (lines.length === 0) continue;
    let text = `*${CLASS_BADGE[cls]} (${group.length})*\n${lines.join('\n')}`;
    if (text.length > MAX_SECTION_CHARS) text = `${text.slice(0, MAX_SECTION_CHARS - 1)}…`;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  }

  if (classified.length > listed) {
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `…and ${classified.length - listed} more failure(s) not listed` },
      ],
    });
  }

  for (const note of ctx.notes) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `note: ${escapeMrkdwn(note)}` }],
    });
  }

  const cost = ctx.costUsd === undefined ? 'cost unavailable' : `$${ctx.costUsd.toFixed(4)}`;
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Triaged by <https://github.com/flaketrace/playwright-ai-triage|playwright-ai-triage> · ${ctx.model} · ${cost}`,
      },
    ],
  });

  return { blocks };
}

export async function postSlackMessage(
  payload: object,
  webhookUrl: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<SendResult> {
  try {
    const res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, note: `Slack webhook returned ${res.status}` };
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, note: `Slack webhook failed: ${message}` };
  }
}
