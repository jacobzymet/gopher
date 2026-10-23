function chatSourceTarget(href: string | null) {
  try {
    const url = new URL(String(href || ''), window.location.origin);
    if (url.origin !== window.location.origin || !/^\/c\/[^/]+$/.test(url.pathname)) return null;
    const id = decodeURIComponent(url.pathname.slice(3));
    const raw = url.searchParams.get('message');
    const message: number | null = raw != null && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))
      ? Number(raw) : null;
    return { id, message };
  } catch { return null; }
}

function scrollToChatSource(index: number | null) {
  if (!Number.isSafeInteger(index) || index! < 0) return;
  stickToBottom = false;
  userScrollOverride = true;
  requestAnimationFrame(() => {
    const row = (chatThread.querySelector('.msg[data-msg-index="' + index + '"]') as HTMLElement);
    if (!row) return;
    row.scrollIntoView({ behavior: 'instant', block: 'center' });
    row.classList.add('is-chat-source');
    row.setAttribute('tabindex', '-1');
    row.focus({ preventScroll: true });
    window.setTimeout(() => row.classList.remove('is-chat-source'), 2400);
  });
}

function chatRetrievalResultHtml(result: unknown) {
  let data: ChatRetrievalResult | undefined;
  try { data = JSON.parse(String(result || '')); } catch { return ''; }
  if (!Array.isArray(data?.results)) return '';
  const sources = data.results.map((item) => {
    const target = chatSourceTarget(item.url);
    if (!target || target.id !== item.chat_id) return '';
    const excerpt = String(item.excerpt ?? item.content ?? '');
    const role = item.role === 'user' ? 'User' : item.role === 'assistant' ? 'Assistant' : '';
    const label = String(item.title || 'Untitled chat');
    const date = Number(item.updated_at);
    const when = Number.isFinite(date) && date > 0 ? new Date(date).toLocaleDateString() : '';
    return '<div class="chat-source">' +
      '<a class="chat-source-link" href="' + escapeHtml(item.url) + '">' + escapeHtml(label) + '</a>' +
      (role || when ? '<span class="chat-source-meta">' + escapeHtml([role, when].filter(Boolean).join(' · ')) + '</span>' : '') +
      (excerpt ? '<details class="chat-source-excerpt"><summary>View retrieved text</summary><pre>' + escapeHtml(excerpt) + '</pre></details>' : '') +
      (item.truncated ? '<span class="chat-source-meta">Partial message</span>' : '') + '</div>';
  }).filter(Boolean);
  return '<div class="agent-step-result chat-retrieval-result">' +
    '<div>' + escapeHtml(data.scope || 'Past chats') + ' · ' + (sources.length ? sources.length + (sources.length === 1 ? ' source' : ' sources') : 'No matching messages') + '</div>' +
    sources.join('') +
    (data.next_cursor != null ? '<div class="chat-source-meta">More results available</div>' : '') + '</div>';
}

function agentStepResultHtml(result: unknown, name: string | undefined) {
  if (name === 'list_chats' || name === 'search_chats' || name === 'read_chat') {
    const html = chatRetrievalResultHtml(result);
    if (html) return html;
  }
  const text = String(result || '').trim();
  if (!text) return '';
  const expandable = text.length > 180 || (text.match(/\n/g) || []).length >= 3;
  if (!expandable) {
    return '<div class="agent-step-result is-short">' + escapeHtml(text) + '</div>';
  }
  return (
    '<details class="agent-step-result">' +
      '<summary>' +
        '<span class="agent-step-result-text">' + escapeHtml(text) + '</span>' +
        THINK_CHEVRON +
      '</summary>' +
    '</details>'
  );
}

function agentStepHtml({
  name,
  detail,
  result,
  note,
  ok,
  running,
  live,
  kind,
  startedAt,
  durationMs,
  endedAt,
  justSettled,
  approval,
  approvalRisk,
  id,
  executing: executingFlag,
  args,
  body,
  image,
}: TimelinePart) {
  let kindLabel = skillLabel(name, { kind });
  const resultText = String(result || '');
  if (name === 'ask_user' && !live && /ask_user\b/i.test(resultText)) {
    kindLabel = 'Clarifying questions · rejected';
  }
  const elapsedMs = toolDurationMs({ live, startedAt, durationMs, endedAt });
  const elapsed = elapsedMs > 0 || live ? formatToolElapsed(elapsedMs) : '';
  const waitingApproval = !!live && approval === 'pending';
  const executing = !!executingFlag;
  const failed = !live && ok === false;
  const liveStatus = waitingApproval ? 'Needs approval'
    : approval === 'expired' ? 'No longer pending' : skillLiveVerb(name, { kind, approval, executing });
  const status = live
    ? '<span class="agent-step-status">' + escapeHtml(liveStatus) + '</span>'
    : failed ? '<span class="agent-step-status">' + (approval === 'denied' ? 'Denied' : 'Failed') + '</span>'
    : running ? '<span class="agent-step-status">Running</span>' : '';
  const meta = (status || elapsed)
    ? '<span class="agent-step-meta">' + status +
      (elapsed ? '<span class="agent-step-elapsed">' + escapeHtml(elapsed) + '</span>' : '') +
      '</span>'
    : '';
  const risk = String(approvalRisk || '');
  const riskLabel = risk === 'terminal'
    ? 'Runs a command'
    : risk === 'browser'
      ? 'Controls a browser'
    : risk === 'write'
      ? 'Modifies files'
      : risk === 'safe'
        ? 'Read-only'
        : '';
  const riskHtml = waitingApproval && riskLabel
    ? '<div class="agent-step-risk' + (risk === 'safe' ? ' is-safe' : (risk === 'terminal' || risk === 'browser') ? ' is-terminal' : '') + '">' + escapeHtml(riskLabel) + '</div>'
    : '';
  const approveHtml = waitingApproval
    ? '<div class="agent-step-approve">' +
        '<button type="button" class="btn btn-primary" data-tool-allow="' + escapeHtml(id || '') + '">Allow</button>' +
        '<button type="button" class="btn btn-outline" data-tool-deny="' + escapeHtml(id || '') + '">Deny</button>' +
      '</div>'
    : '';
  const fullBody = String(body || toolBodyFromArgs(name, args) || '');
  const bodyText = waitingApproval ? fullBody : fullBody.length > 20000 ? fullBody.slice(0, 20000) + '\n[Preview truncated]' : fullBody;
  const bodyHtml = bodyText
    ? '<div class="agent-step-body' + (live ? ' is-live' : '') + '"><pre class="agent-step-body-stream">' + escapeHtml(bodyText) + '</pre></div>'
    : '';
  const shot = String(image || '');
  const shotHtml = /^data:image\//i.test(shot)
    ? '<div class="agent-step-shot"><img src="' + escapeHtml(shot) + '" alt="Browser screenshot"></div>'
    : '';
  return wrapTimelineStep(
    '<div class="agent-step-card"' + (live ? ' aria-busy="true"' : '') + '>' +
      (live && executing ? '<span class="agent-step-scan" aria-hidden="true"></span>' : '') +
      '<div class="agent-step-head">' +
        '<span class="agent-step-icon" aria-hidden="true">' + skillToolIcon(name, { kind }) + '</span>' +
        '<div class="agent-step-kind">' + escapeHtml(kindLabel) + '</div>' +
        meta +
      '</div>' +
      riskHtml +
      approveHtml +
      (note
        ? '<div class="agent-step-note">' + escapeHtml(note) + '</div>'
        : '') +
      (detail
        ? '<div class="agent-step-detail"><em>' + escapeHtml(skillDetailLabel(name)) + '</em>'
          + '<span class="agent-step-detail-value">' + escapeHtml(detail) + '</span></div>'
        : '') +
      bodyHtml +
      shotHtml +
      (live && !resultText && executing
        ? '<div class="agent-step-await" aria-hidden="true"><span class="agent-step-await-bar"></span></div>'
        : '') +
      agentStepResultHtml(result, name) +
    '</div>',
    {
      live: !!live,
      done: !live && !failed && !running,
      failed,
      running: !live && !!running,
      justSettled: !!justSettled && !failed && !running,
      startedAt: live ? Number(startedAt) || 0 : 0,
      toolName: name || '',
      toolId: id || '',
    }
  );
}

