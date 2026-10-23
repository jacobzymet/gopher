function botSystemPromptParts(convo: Conversation, speakerBot: Bot | null | undefined) {
  const P = window.GOPHER_PROMPTS || {};
  const fill = window.fillPrompt || ((t) => t);
  if (!speakerBot) return [];
  const description = String(speakerBot.description || '').trim() || '(No description provided.)';
  const parts = [
    fill(P['chat.botIdentity'] || 'You are @{{handle}}. Purpose:\n{{description}}', {
      handle: speakerBot.handle,
      description,
    }),
    fill(P['chat.botMemory'] || 'Private memory:\n{{memory}}', {
      memory: String(speakerBot.memory || '').trim() || '(empty)',
    }),
  ];
  if (isBotGroup(convo)) {
    const names = ['@user'].concat(participantBots(convo).map(botDisplayHandle));
    parts.push(fill(P['chat.botGroup'] || 'Group chat with {{participants}}. Speak only as @{{handle}}.', {
      participants: names.join(', '),
      handle: speakerBot.handle,
    }));
    parts.push(fill(P['chat.botGroupMemory'] || 'Shared group notes:\n{{memory}}', {
      memory: String(convo.groupMemory || '').trim() || '(empty)',
    }));
    if (convo.botsHeldBy) {
      const holder = getBot(convo.botsHeldBy);
      parts.push(fill(P['chat.botHold'] || 'Room is held by @{{handle}}. Specialists: NO_REPLY unless @user pings you.', {
        handle: holder ? holder.handle : 'holder',
      }));
    }
  } else if (convo.botKind === 'dm') {
    const group = findLinkedGroup(convo);
    const groupNote = group
      ? ('Linked group: ' + (group.title || 'group') + ' (' + participantBots(group).map(botDisplayHandle).join(', ') + '). You can <bot_group_post> back there.')
      : 'No linked group. <bot_group_post> is unavailable unless you opened this DM from a group.';
    parts.push(fill(P['chat.botDm'] || 'Private DM with @user. {{group_note}} Speak as @{{handle}}.', {
      handle: speakerBot.handle,
      group_note: groupNote,
    }));
  }
  return parts;
}

function labeledBotContent(message: ChatMessage, speakerBot: Bot | null | undefined) {
  const text = typeof message.content === 'string' ? message.content : '';
  if (message.compact) return '[Compacted earlier conversation]\n' + text;
  if (message.role === 'user') return isBotGroup(conversations.find((c) => (c.messages || []).includes(message))) ? ('@user: ' + text) : text;
  if (speakerBot && message.speakerId === speakerBot.id) return text;
  const handle = message.speakerHandle || getBot(message.speakerId)?.handle || 'bot';
  return '@' + handle + ': ' + text;
}

function botApiMessages(convo: Conversation, speakerBot: Bot | null | undefined, fallbackUserText: string | ApiContentPart[] | null, { messageLimit = null }: {messageLimit?: number | null} = {}): BotApiMessage[] {
  const group = isBotGroup(convo);
  const rows: BotApiMessage[] = [];
  const allMessages = convo.messages || [];
  const sourceMessages = Number.isFinite(messageLimit)
    ? allMessages.slice(0, Math.max(0, Number(messageLimit)))
    : allMessages;
  sourceMessages.forEach((message) => {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) return;
    let content = String(message.content || '');
    if (message.compact) content = '[Compacted earlier conversation]\n' + content;
    else if (group) {
      if (message.role === 'user') content = '@user: ' + content;
      else if (!(speakerBot && message.speakerId === speakerBot.id)) {
        content = '@' + (message.speakerHandle || getBot(message.speakerId, convo)?.handle || 'bot') + ': ' + content;
      }
    }
    if (!content.trim()) return;
    const mine = message.role === 'assistant' && speakerBot && message.speakerId === speakerBot.id;
    rows.push({ role: mine ? 'assistant' : 'user', content });
  });
  const lastStored = sourceMessages.filter((message) => (
    message && (message.role === 'user' || message.role === 'assistant')
  )).pop();
  if (fallbackUserText && lastStored && lastStored.role === 'user' && rows.length && rows[rows.length - 1].role === 'user') {
    rows[rows.length - 1].content = group ? ('@user: ' + fallbackUserText) : fallbackUserText;
  }
  return rows;
}

function estimateConvoChars(convo: Conversation) {
  return (convo.messages || []).reduce((sum, message) => sum + String(message.content || '').length, 0);
}

async function collectCompletionText(messages: BotApiMessage[], modelId: string) {
  const remote = selectedRemoteModel(latestState, modelId);
  if (!remote?.ready || !remote.model || (!remote.provider_id && !remote.base)) {
    throw new Error('The selected Loop model is unavailable for compaction');
  }
  const body: Record<string, unknown> = { messages, agent: false, skills: {}, force_tools: [] };
  body.remote_base = remote.base;
  if (remote.provider_id) body.provider_id = remote.provider_id;
  body.model = remote.model;
  const response = await fetch('/api/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Compact request failed');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() ?? '';
    for (const raw of chunks) {
      const parsed = parseSseEvent(raw);
      if (!parsed || parsed.data === '' || parsed.data === '[DONE]') continue;
      if (parsed.event === 'error') throw new Error(parsed.data);
      try {
        const json: { choices?: Array<{ delta?: { content?: unknown } }> } = JSON.parse(parsed.data);
        const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
        if (typeof delta === 'string') text += delta;
      } catch { /* ignore */ }
    }
  }
  return text.trim();
}

function parseCompactJson(raw: string) {
  const source = String(raw || '').trim();
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: { summary?: unknown; memory?: unknown } = JSON.parse(source.slice(start, end + 1));
    return {
      summary: String(parsed.summary || '').trim(),
      memory: String(parsed.memory || '').trim(),
    };
  } catch {
    return null;
  }
}

async function maybeCompactBotsConvo(convo: Conversation | null | undefined, speakerBot: Bot | null | undefined) {
  if (!convo || convo.incognito || estimateConvoChars(convo) < BOT_COMPACT_CHARS) return;
  if ((convo.messages || []).length <= BOT_COMPACT_KEEP + 2) return;
  const writeEpoch = storageWriteEpoch;
  const runEpoch = botsOutboundEpochOf(convo.id);
  const snapshot = convo.messages.slice();
  const dropCount = convo.messages.length - BOT_COMPACT_KEEP;
  const dropped = convo.messages.slice(0, dropCount);
  const kept = convo.messages.slice(dropCount);
  const transcript = dropped.map((message) => {
    const who = message.role === 'user'
      ? '@user'
      : ('@' + (message.speakerHandle || getBot(message.speakerId)?.handle || 'bot'));
    return who + ': ' + String(message.content || '');
  }).join('\n\n');
  const P = window.GOPHER_PROMPTS || {};
  const fill = window.fillPrompt || ((t) => t);
  const group = isBotGroup(convo);
  const template = group
    ? (P['chat.botCompactGroup'] || 'Return JSON {"summary","memory"}. Current notes:\n{{memory}}')
    : (P['chat.botCompact'] || 'Return JSON {"summary","memory"}. Current memory:\n{{memory}}');
  try {
    const raw = await collectCompletionText([
      { role: 'system', content: fill(template, {
        memory: group
          ? (String(convo.groupMemory || '').trim() || '(empty)')
          : (String(speakerBot?.memory || '').trim() || '(empty)'),
      }) },
      { role: 'user', content: transcript.slice(0, 24000) },
    ], speakerBot?.model || conversationModelId(convo));
    if (writeEpoch !== storageWriteEpoch || diskEncryptionLocked()
      || runEpoch !== botsOutboundEpochOf(convo.id)
      || !conversations.includes(convo)
      || convo.messages.length !== snapshot.length
      || snapshot.some((message, index) => convo.messages[index] !== message)) return;
    const parsed = parseCompactJson(raw);
    if (!parsed || !parsed.summary) return;
    convo.messages = ([{
      role: 'assistant',
      content: parsed.summary,
      compact: true,
      speakerId: speakerBot ? speakerBot.id : null,
      speakerHandle: speakerBot ? speakerBot.handle : null,
    }] as ChatMessage[]).concat(kept);
    if (group) persistGroupMemory(convo, parsed.memory || convo.groupMemory || '');
    else if (speakerBot) persistBotMemory(speakerBot.id, parsed.memory || speakerBot.memory || '');
    convo.updatedAt = Date.now();
    saveStore({ immediate: true });
  } catch (error) {
    console.warn('Bot compact failed:', (error as Error | null)?.message || error);
  }
}

function botsToPing(convo: Conversation, userText: string, { fromBotId = null, replyToSpeakerId = null }: BotPingOptions = {}) {
  const members = participantBots(convo);
  if (!members.length) return [];
  const pings = parseBotMentions(userText, convo);
  if (!isBotGroup(convo)) return members.slice(0, 1);
  if (replyToSpeakerId && !fromBotId && members.some((bot) => bot.id === replyToSpeakerId)) {
    const target = getBot(replyToSpeakerId, convo);
    return target ? [target] : [];
  }
  const heldBy = convo.botsHeldBy || null;
  if (heldBy && fromBotId) return [];
  let ids: string[];
  if (heldBy && !fromBotId) {
    if (pings.everyone) ids = members.map((bot) => bot.id);
    else if (pings.botIds.length) {
      ids = pings.botIds.filter((id) => members.some((bot) => bot.id === id));
    } else {
      ids = [heldBy];
    }
  } else if (pings.everyone || (!pings.botIds.length && !fromBotId)) {
    ids = members.map((bot) => bot.id);
  } else {
    ids = pings.botIds.filter((id) => members.some((bot) => bot.id === id));
  }
  if (fromBotId) ids = ids.filter((id) => id !== fromBotId);
  return ids.map((id) => getBot(id, convo)).filter(Boolean);
}

