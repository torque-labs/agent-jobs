/**
 * @mention gating for group/channel turns. In a GROUP the agent should only
 * respond when the bot is @mentioned or replied to (like TEA); in a 1:1 DM it
 * always responds (you don't @ a bot in a DM). Bot identity is fetched once per
 * token and cached. Fails OPEN (respond) if identity can't be resolved, so a
 * transient lookup error never silently kills the bot.
 */

// ---- Telegram ----
const tgIdentity = new Map<string, { id: number; username: string }>();

async function telegramBotIdentity(token: string): Promise<{ id: number; username: string } | null> {
  const cached = tgIdentity.get(token);
  if (cached) return cached;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const d = (await res.json()) as { ok?: boolean; result?: { id: number; username?: string } };
    if (d.ok && d.result?.username) {
      const v = { id: d.result.id, username: d.result.username };
      tgIdentity.set(token, v);
      return v;
    }
  } catch {
    // fall through to fail-open
  }
  return null;
}

export type TelegramGateMsg = {
  text?: string;
  chat?: { id: number; type?: string };
  reply_to_message?: { from?: { id?: number } };
};

/**
 * Decide whether to respond to a Telegram message + return the text with the
 * bot mention stripped. Private chats always respond; groups require an
 * @mention of the bot or a reply to the bot.
 */
export async function gateTelegram(
  msg: TelegramGateMsg,
  botToken: string,
  text: string,
): Promise<{ respond: boolean; text: string }> {
  const type = msg.chat?.type;
  if (!type || type === 'private') return { respond: true, text };

  const bot = await telegramBotIdentity(botToken);
  if (!bot) return { respond: true, text }; // fail-open: don't break the bot

  const mentioned = text.toLowerCase().includes('@' + bot.username.toLowerCase());
  const repliedToBot = msg.reply_to_message?.from?.id === bot.id;
  if (!mentioned && !repliedToBot) return { respond: false, text };

  const stripped = text.replace(new RegExp('@' + bot.username, 'ig'), '').trim();
  return { respond: true, text: stripped || text };
}

// ---- Slack ----
const slackUserId = new Map<string, string>();

async function slackBotUserId(token: string): Promise<string | null> {
  const cached = slackUserId.get(token);
  if (cached) return cached;
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    const d = (await res.json()) as { ok?: boolean; user_id?: string };
    if (d.ok && d.user_id) {
      slackUserId.set(token, d.user_id);
      return d.user_id;
    }
  } catch {
    // fail-open
  }
  return null;
}

export type SlackGateEvent = { text?: string; channel_type?: string };

/**
 * Decide whether to respond to a Slack message + strip the bot mention. IMs
 * always respond; channels require an `<@BOTUSERID>` mention.
 */
export async function gateSlack(
  event: SlackGateEvent,
  botToken: string,
): Promise<{ respond: boolean; text: string }> {
  const text = event.text ?? '';
  if (event.channel_type === 'im') return { respond: true, text };

  const uid = await slackBotUserId(botToken);
  if (!uid) return { respond: true, text }; // fail-open

  if (!text.includes(`<@${uid}>`)) return { respond: false, text };
  const stripped = text.replace(new RegExp(`<@${uid}>`, 'g'), '').trim();
  return { respond: true, text: stripped || text };
}
