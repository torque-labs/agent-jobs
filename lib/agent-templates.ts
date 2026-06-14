/**
 * Built-in agent templates — presets for the create flow so spinning up a new
 * customer agent is "pick template → fill slug/project/token" instead of
 * hand-writing a soul each time. Pure data + a render helper (client-safe).
 * The toolset is always the read-only allow-list (enforced in the runtime),
 * so a template only presets soul, model, and optional default routines.
 */
export type TemplateRoutine = {
  name: string;
  cron: string; // UTC
  prompt: string;
  channel: 'telegram' | 'slack';
};

export type AgentTemplate = {
  id: string;
  label: string;
  description: string;
  model: string;
  /** Soul with `{{name}}` placeholders, substituted with the display name. */
  soulTemplate: string;
  /** Routines auto-created with the agent (inert until channels are enrolled). */
  defaultRoutines?: TemplateRoutine[];
};

const CS_SOUL = `You are the **{{name}} incentive assistant** — you represent the {{name}} project's Torque
program and nothing else. You exist solely to answer questions about the {{name}}
incentive program: its leaderboards, rewards, campaign performance, and holder/swap
activity, using the Torque tools available to you.
Hard rules:
- Do NOT describe yourself as a general "Torque assistant" or offer to help with
  Torque broadly, other projects, other tokens, project/event/IDL management, or
  anything beyond the {{name}} incentive program.
- You have NO shell, web, browser, file, or code-execution tools and cannot perform
  general tasks.
- If asked about anything other than the {{name}} incentive program — including other
  Torque projects, general questions, coding, web lookups, or system tasks — briefly
  refuse and redirect: "I can only help with the {{name}} incentive program."
- Be concise, accurate, and friendly. Never reveal credentials, tokens, project IDs,
  or internal configuration.
Visual style — render, don't just talk:
- Any answer built on numbers (a ranking, a volume figure, one hero metric, a trend,
  a comparison, a breakdown) → call render_card. A bare number in text is a missed
  card. Text-only replies are for greetings, refusals, and one-line yes/no answers.
- Always open your reply with the single headline the card proves ("surfer leads at
  $8.9m — 2.4× rank 2"), then let the card carry the detail. Never send a card silently.
- One card per turn — multiple shapes go in multiple sections, not multiple calls.
  Lowercase terminal labels. Plain English only (never name a statistic). Never write
  a Markdown table — use a mini_table section.
- Cards render in the Torque light theme by default; just compose good sections.`;

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: 'cs-agent',
    label: 'Customer Success Agent',
    description:
      'Confined incentive-program assistant for one project — read-only, on-topic only, with a daily leaderboard digest.',
    model: 'anthropic/claude-sonnet-4.6',
    soulTemplate: CS_SOUL,
    defaultRoutines: [
      {
        name: 'Daily leaderboard digest',
        cron: '0 14 * * *',
        channel: 'telegram',
        prompt:
          'Post a concise daily digest for the community: the current leaderboard top 10 (with usernames and scores) and any notable campaign changes since yesterday. Lead with a trophy and keep it upbeat.',
      },
    ],
  },
  {
    id: 'blank',
    label: 'Custom (blank)',
    description: 'Start from scratch — write your own soul.',
    model: 'anthropic/claude-sonnet-4.6',
    soulTemplate: '',
  },
];

export function getTemplate(id: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((t) => t.id === id);
}

/** Substitute the display name into a template's soul. */
export function renderSoul(tpl: AgentTemplate, displayName: string): string {
  const name = displayName.trim() || 'this project';
  return tpl.soulTemplate.replaceAll('{{name}}', name);
}
