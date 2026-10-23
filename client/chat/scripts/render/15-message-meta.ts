function formatTokPerSec(n: unknown) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 100) return Math.round(v) + ' tok/s';
  if (v >= 10) return v.toFixed(1) + ' tok/s';
  return v.toFixed(2) + ' tok/s';
}
function formatWorkDuration(ms: unknown) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '';
  const totalSeconds = Math.max(1, Math.round(value / 1000));
  if (totalSeconds < 60) return totalSeconds + 's';
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return totalMinutes + 'm' + (seconds ? ' ' + seconds + 's' : '');
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours + 'h' + (minutes ? ' ' + minutes + 'm' : '');
}

function workDurationMs(startedAt: unknown, endedAt: number) {
  const start = Number(startedAt);
  const end = Number(endedAt);
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(end) || end < start) return null;
  return Math.round(end - start);
}

function ingestStreamUsage(stats: StreamUsage | null | undefined, json: UsageFrame | null | undefined) {
  if (!stats || !json || typeof json !== 'object') return;
  const progress = json.prompt_progress;
  if (progress && typeof progress === 'object') {
    const total = progress.total;
    if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
      stats.contextPromptTokens = total;
      stats.contextCompletionTokens = null;
    }
  }
  const usage = json.usage;
  if (usage && typeof usage === 'object') {
    const completion = usage.completion_tokens;
    const hasCompletion = typeof completion === 'number' && Number.isFinite(completion) && completion >= 0;
    if (hasCompletion) {
      stats.completionTokens = (stats.completionTokens || 0) + completion;
    }
    const prompt = usage.prompt_tokens;
    const hasPrompt = typeof prompt === 'number' && Number.isFinite(prompt) && prompt >= 0;
    if (hasPrompt) {
      stats.promptTokens = (stats.promptTokens || 0) + prompt;
      stats.contextPromptTokens = prompt;
    }
    if (hasCompletion) {
      stats.contextCompletionTokens = completion;
    }
  }
  const timings = json.timings;
  if (timings && typeof timings === 'object') {
    const predicted = Number(timings.predicted_per_second);
    if (Number.isFinite(predicted) && predicted > 0) {
      stats.providerTokPerSec = predicted;
    } else {
      const n = Number(timings.predicted_n);
      const ms = Number(timings.predicted_ms);
      if (Number.isFinite(n) && n > 0 && Number.isFinite(ms) && ms > 0) {
        stats.providerTokPerSec = n / (ms / 1000);
      }
    }
  }
  if (typeof json.model === 'string' && json.model.trim() && !stats.upstreamModel) {
    stats.upstreamModel = json.model.trim();
  }
}

function finalizeTurnStats(stats: StreamUsage | null | undefined, firstTokenAt: number | null, endedAt: number) {
  if (!stats) return null;
  let tokensPerSec: number | null = null;
  if (Number.isFinite(stats.providerTokPerSec) && stats.providerTokPerSec! > 0) {
    tokensPerSec = stats.providerTokPerSec;
  } else if (
    Number.isFinite(stats.completionTokens)
    && stats.completionTokens > 0
    && firstTokenAt
  ) {
    const sec = (endedAt - firstTokenAt) / 1000;
    if (sec > 0.05) tokensPerSec = stats.completionTokens / sec;
  }
  return {
    completionTokens: Number.isFinite(stats.completionTokens) ? stats.completionTokens : null,
    promptTokens: Number.isFinite(stats.promptTokens) ? stats.promptTokens : null,
    contextPromptTokens: Number.isFinite(stats.contextPromptTokens) ? stats.contextPromptTokens : null,
    contextCompletionTokens: Number.isFinite(stats.contextCompletionTokens) ? stats.contextCompletionTokens : null,
    contextTokens: Number.isFinite(stats.contextPromptTokens)
      ? stats.contextPromptTokens! + (Number.isFinite(stats.contextCompletionTokens) ? stats.contextCompletionTokens! : 0)
      : null,
    tokensPerSec: tokensPerSec != null && Number.isFinite(tokensPerSec) ? tokensPerSec : null,
    upstreamModel: stats.upstreamModel || null,
  };
}

function ensureMsgFooter(row: HTMLElement) {
  let footer = (row.querySelector(':scope > .msg-footer') as HTMLElement);
  if (!footer) {
    footer = (document.createElement('div') as HTMLElement);
    footer.className = 'msg-footer';
    row.appendChild(footer);
  }
  return footer;
}

function syncMessageSpeaker(row: HTMLElement, message: RenderMessage | null | undefined) {
  if (!row) return;
  const convo = conversations.find((item) => item.id === activeId);
  const botsConvo = typeof isBotsConvo === 'function' && isBotsConvo(convo);
  row.classList.toggle('is-bot-chat', !!botsConvo);
  let label = '';
  let speakerBot: Bot | null = null;
  if (botsConvo) {
    if (row.classList.contains('msg-role-user')) {
      label = '@user';
    } else if (message?.speakerId && typeof getBot === 'function') {
      speakerBot = getBot(message.speakerId, convo);
      label = speakerBot ? ('@' + speakerBot.handle) : (message.speakerHandle ? '@' + message.speakerHandle : '');
    } else if (message?.speakerHandle) {
      label = '@' + message.speakerHandle;
      speakerBot = typeof botByHandle === 'function' ? botByHandle(message.speakerHandle, convo) : null;
    } else if (convo?.botKind === 'dm' && convo.botId && typeof getBot === 'function') {
      speakerBot = getBot(convo.botId, convo);
      if (speakerBot) label = '@' + speakerBot.handle;
    }
  }
  if (botsConvo && row.classList.contains('msg-role-assistant') && typeof hashAvatarSeed === 'function') {
    const seedBot = speakerBot || { handle: message?.speakerHandle || 'bot' };
    const hue = BOT_AVATAR_HUES[hashAvatarSeed(botAvatarSeed(seedBot)) % BOT_AVATAR_HUES.length];
    row.style.setProperty('--bot-bubble-hue', String(hue));
  } else {
    row.style.removeProperty('--bot-bubble-hue');
  }
  if (speakerBot) {
    row.dataset.speakerId = speakerBot.id;
    row.dataset.speakerHandle = speakerBot.handle || '';
  } else if (message?.speakerId) {
    row.dataset.speakerId = message.speakerId;
    row.dataset.speakerHandle = String(message.speakerHandle || '').replace(/^@/, '');
  } else {
    delete row.dataset.speakerId;
    delete row.dataset.speakerHandle;
  }
  let speaker = (row.querySelector(':scope > .msg-speaker') as HTMLElement);
  if (!label) {
    speaker?.remove();
    return;
  }
  if (!speaker) {
    speaker = (document.createElement('div') as HTMLElement);
    speaker.className = 'msg-speaker';
    const bubble = (row.querySelector(':scope > .msg-bubble') as HTMLElement);
    if (bubble) row.insertBefore(speaker, bubble);
    else row.prepend(speaker);
  } else {
    speaker.replaceChildren();
  }
  if (speakerBot && typeof createBotAvatarEl === 'function' && row.classList.contains('msg-role-assistant')) {
    const avatar = createBotAvatarEl(speakerBot, { className: 'msg-speaker-avatar' });
    applyPrivacyMosaic(avatar, 'speaker-avatar:' + speakerBot.id, { dense: true });
    speaker.appendChild(avatar);
  }
  const name = (document.createElement('span') as HTMLElement);
  name.className = 'msg-speaker-name';
  name.textContent = label;
  applyPrivacyMosaic(name, 'speaker:' + (speakerBot?.id || label));
  speaker.appendChild(name);
  if (message?.loopPhaseLabel && row.classList.contains('msg-role-assistant')) {
    const phase = (document.createElement('span') as HTMLElement);
    phase.className = 'msg-speaker-phase';
    const position = Number(message.loopPhaseIndex) && Number(message.loopPhaseTotal)
      ? (message.loopPhaseIndex + '/' + message.loopPhaseTotal + ' · ')
      : '';
    phase.textContent = position + message.loopPhaseLabel;
    phase.title = 'Loop stage: ' + message.loopPhaseLabel;
    speaker.appendChild(phase);
  }
}

function attachMessageMeta(row: HTMLElement, message: RenderMessage | null | undefined) {
  if (!row) return;
  const footer = ensureMsgFooter(row);
  let meta = (footer.querySelector(':scope > .msg-meta') as HTMLElement);
  const isAssistant = !!(
    message
    && (message.role === 'assistant' || row.classList.contains('msg-role-assistant'))
  );
  if (!isAssistant) {
    meta?.remove();
    return;
  }
  const model = String(message.model || '').trim()
    || (row.classList.contains('msg-role-assistant')
      ? String(
        (typeof selectedRemoteModel === 'function' && selectedRemoteModel(latestState)?.model)
        || selectedChatModel
        || ''
      ).trim()
      : '');
  const speed = formatTokPerSec(message.tokensPerSec);
  const workTime = formatWorkDuration(message.workDurationMs);
  if (!model && !speed && !workTime) {
    meta?.remove();
    return;
  }
  if (!meta) {
    meta = (document.createElement('div') as HTMLElement);
    meta.className = 'msg-meta';
    const actions = (footer.querySelector(':scope > .msg-actions') as HTMLElement);
    if (actions) footer.insertBefore(meta, actions);
    else footer.appendChild(meta);
  }
  const bits = [];
  if (model) {
    bits.push('<span class="msg-meta-model" title="' + escapeHtml(model) + '">' + escapeHtml(model) + '</span>');
  }
  if (speed) {
    if (bits.length) bits.push('<span class="msg-meta-sep" aria-hidden="true">·</span>');
    const tip = Number.isFinite(message.completionTokens)
      ? (message.completionTokens + ' completion tokens')
      : 'Generation speed';
    bits.push('<span class="msg-meta-speed" title="' + escapeHtml(tip) + '">' + escapeHtml(speed) + '</span>');
  }
  if (workTime) {
    if (bits.length) bits.push('<span class="msg-meta-sep" aria-hidden="true">·</span>');
    bits.push('<span class="msg-meta-duration" title="Total work time">' + escapeHtml(workTime) + '</span>');
  }
  meta.innerHTML = bits.join('');
}

function attachMessageActions(row: HTMLElement) {
  const footer = ensureMsgFooter(row);
  if ((footer.querySelector(':scope > .msg-actions') as HTMLElement)) return;
  const actions = (document.createElement('div') as HTMLElement);
  actions.className = 'msg-actions';

  const copyBtn = (document.createElement('button') as HTMLButtonElement);
  copyBtn.type = 'button';
  copyBtn.className = 'msg-action';
  copyBtn.setAttribute('aria-label', 'Copy message');
  copyBtn.title = 'Copy';
  copyBtn.innerHTML = COPY_ICON;
  copyBtn.addEventListener('click', () => {
    if (!navigator.clipboard) return;
    const raw = row.dataset.raw || '';
    const payload = row.classList.contains('msg-role-assistant') && settings.thinking !== 'visible'
      ? stripThinkingTags(raw)
      : raw;
    navigator.clipboard.writeText(payload).then(() => {
      copyBtn.classList.add('is-copied');
      copyBtn.innerHTML = CHECK_ICON;
      copyBtn.title = 'Copied';
      setTimeout(() => {
        copyBtn.classList.remove('is-copied');
        copyBtn.innerHTML = COPY_ICON;
        copyBtn.title = 'Copy';
      }, 1400);
    }).catch(() => {});
  });
  actions.appendChild(copyBtn);

  if (row.classList.contains('msg-role-assistant') && !row.classList.contains('msg-queued')) {
    const index = Number(row.dataset.msgIndex);
    const convo = conversations.find((item) => item.id === activeId);
    const message: ChatMessage | null | undefined = Number.isInteger(index) ? convo?.messages?.[index] : null;
    if (!message?.compact) {
      const replyBtn = (document.createElement('button') as HTMLButtonElement);
      replyBtn.type = 'button';
      replyBtn.className = 'msg-action';
      replyBtn.setAttribute('aria-label', 'Reply to this message');
      replyBtn.title = 'Reply';
      replyBtn.innerHTML = REPLY_ICON;
      replyBtn.addEventListener('click', () => {
        const quote = messageReplyExcerpt(row.dataset.raw || message?.content || '');
        if (!quote) return;
        setPendingReply(quote, resolveReplySpeaker(convo, row, message));
      });
      actions.appendChild(replyBtn);
    }
  }

  if (row.classList.contains('msg-role-user')) {
    const editBtn = (document.createElement('button') as HTMLButtonElement);
    editBtn.type = 'button';
    editBtn.className = 'msg-action';
    editBtn.setAttribute('aria-label', 'Edit message');
    editBtn.title = 'Edit';
    editBtn.innerHTML = EDIT_ICON;
    editBtn.addEventListener('click', () => beginMessageEdit(row));
    actions.appendChild(editBtn);
  }

  footer.appendChild(actions);
}

function buildBubble(role: string, content: string | undefined, index: number, message: ChatMessage, { animate = false } = {}) {
  const row = (document.createElement('div') as HTMLElement);
  row.className = 'msg msg-role-' + role;
  row.dataset.msgIndex = String(index);
  const bubble = (document.createElement('div') as HTMLElement);
  bubble.className = 'msg-bubble';
  row.appendChild(bubble);
  syncMessageSpeaker(row, message || { role, content });
  row.dataset.raw = typeof content === 'string' ? content : String(message?.content || '');
  if (role === 'assistant') {
    bubble.innerHTML = renderAssistantMessage(message || { content }, { streaming: false });
    enhanceCodeBlocks(bubble);
    (bubble.querySelectorAll('.think-body') as NodeListOf<HTMLElement>).forEach((el) => enhanceCodeBlocks(el));
  } else {
    bubble.innerHTML = formatUserMessageHtml(message || { content });
    if (message?.steered) {
      const meta = (document.createElement('div') as HTMLElement);
      meta.className = 'msg-queued-meta';
      meta.innerHTML = '<span class="msg-queued-label is-steered">Steered</span>';
      row.appendChild(meta);
    }
  }
  attachMessageActions(row);
  if (role === 'assistant') {
    attachMessageMeta(row, message || { role: 'assistant', content });
  }
  if (animate) queueMicrotask(() => motionEnter(row, { y: role === 'user' ? 10 : 14 }));
  return row;
}

function reattachLiveStream(convo: Conversation) {
  if (!convo || activeId !== convo.id) return null;
  const stream = activeStreams.get(convo.id);
  if (!stream || stream.hardStopped) return null;
  stream.dom = null;
  paintStreamIntoView(convo, stream, stream.partial || '', true);
  if ((stream.dom as StreamDom | null)?.row) {
    stream.dom!.row.dataset.msgIndex = String(liveTurnSlices(convo).followUpStart);
    selectTraceMessage(Number(stream.dom!.row.dataset.msgIndex), {
      animate: false,
      ensureOpen: false,
    });
  }
  return stream;
}

