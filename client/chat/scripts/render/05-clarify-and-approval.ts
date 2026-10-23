function findClarifyPart(stream: ActiveStream | null | undefined, id: string) {
  return (stream?.timeline || []).find((part) => part.type === 'clarify' && part.id === id) || null;
}

function buildClarifyFormHtml(part: TimelinePart) {
  const done = !part.live || !!part.answers;
  const questions = Array.isArray(part.questions) ? part.questions : [];
  if (done && part.summary) {
    return (
      '<div class="clarify-card is-done" data-clarify-id="' + escapeHtml(part.id) + '">' +
        '<div class="clarify-card-head">' +
          '<span class="clarify-card-kicker">Deep research</span>' +
          '<span class="clarify-card-title">Goal refined</span>' +
        '</div>' +
        '<div class="clarify-summary">' + escapeHtml(part.summary).replace(/\n/g, '<br>') + '</div>' +
      '</div>'
    );
  }
  let body = '';
  questions.forEach((q, qi) => {
    const multi = !!q.multiSelect;
    const inputType = multi ? 'checkbox' : 'radio';
    const group = 'clarify-' + part.id + '-' + qi;
    const selected = part.draft?.[qi] || { labels: [], custom: '', useCustom: false };
    const options = Array.isArray(q.options) ? q.options : [];
    let opts = '';
    options.forEach((opt, oi) => {
      const label = String(opt.label || '');
      const checked = !selected.useCustom && selected.labels.includes(label);
      opts +=
        '<label class="clarify-option' + (checked ? ' is-selected' : '') + '">' +
          '<input type="' + inputType + '" name="' + escapeHtml(group) + '" value="' + escapeHtml(label) + '"' +
            (checked ? ' checked' : '') + (done ? ' disabled' : '') +
            ' data-clarify-q="' + qi + '" data-clarify-opt="' + oi + '">' +
          '<span>' +
            '<div class="clarify-option-label">' + escapeHtml(label) + '</div>' +
            (opt.description
              ? '<div class="clarify-option-desc">' + escapeHtml(String(opt.description)) + '</div>'
              : '') +
          '</span>' +
        '</label>';
    });
    opts +=
      '<div class="clarify-other">' +
        '<label class="clarify-other-toggle' + (selected.useCustom ? ' is-selected' : '') + '">' +
          '<input type="' + inputType + '" name="' + escapeHtml(group) + '" value="__other__"' +
            (selected.useCustom ? ' checked' : '') + (done ? ' disabled' : '') +
            ' data-clarify-q="' + qi + '" data-clarify-other="1">' +
          '<span class="clarify-option-label">Other</span>' +
        '</label>' +
        '<textarea class="clarify-other-input" rows="2" placeholder="Describe what you want instead…"' +
          ' data-clarify-q="' + qi + '" data-clarify-custom="1"' +
          (selected.useCustom ? '' : ' hidden') +
          (done ? ' disabled' : '') + '>' +
          escapeHtml(selected.custom || '') +
        '</textarea>' +
      '</div>';
    body +=
      '<div class="clarify-q" data-clarify-q="' + qi + '">' +
        (q.header ? '<span class="clarify-q-chip">' + escapeHtml(String(q.header)) + '</span>' : '') +
        '<div class="clarify-q-text">' + escapeHtml(String(q.question || '')) + '</div>' +
        '<div class="clarify-options">' + opts + '</div>' +
      '</div>';
  });
  return (
    '<div class="clarify-card' + (done ? ' is-done' : '') + '" data-clarify-id="' + escapeHtml(part.id) + '">' +
      '<div class="clarify-card-head">' +
        '<span class="clarify-card-kicker">Deep research</span>' +
        '<span class="clarify-card-title">A couple of quick questions before searching</span>' +
      '</div>' +
      body +
      (done
        ? ''
        : '<div class="clarify-actions">' +
            '<button type="button" class="clarify-submit" data-clarify-submit="' + escapeHtml(part.id) + '">Continue research</button>' +
          '</div>') +
    '</div>'
  );
}

function mountClarifyForm(stream: ActiveStream, part: TimelinePart) {
  if (!stream.dom?.answerEl) return;
  let host = stream.dom.clarifyHost;
  if (!host) {
    host = (document.createElement('div') as HTMLElement);
    host.className = 'clarify-host';
    stream.dom.clarifyHost = host;
  }
  host.innerHTML = buildClarifyFormHtml(part);
  const answerEl = stream.dom.answerEl;
  if (host.parentElement !== answerEl) {
    answerEl.insertBefore(host, answerEl.firstChild);
  }
  syncClarifySubmitEnabled(host);
}

function preserveClarifyHost(answerEl: HTMLElement | null | undefined) {
  const host = (answerEl?.querySelector?.(':scope > .clarify-host') as HTMLElement);
  if (host) host.remove();
  return host || null;
}

function restoreClarifyHost(answerEl: HTMLElement | null | undefined, host: HTMLElement | null | undefined) {
  if (!answerEl || !host) return;
  answerEl.insertBefore(host, answerEl.firstChild);
}

function syncClarifySubmitEnabled(host: HTMLElement) {
  if (!host) return;
  const card = (host.querySelector('.clarify-card') as HTMLElement);
  if (!card || card.classList.contains('is-done')) return;
  const submit = (card.querySelector('[data-clarify-submit]') as HTMLButtonElement);
  if (!submit) return;
  const questions = (card.querySelectorAll('.clarify-q') as NodeListOf<HTMLElement>);
  let ok = questions.length > 0;
  questions.forEach((qEl) => {
    const qi = Number(qEl.dataset.clarifyQ);
    const otherOn = !!(qEl.querySelector('input[data-clarify-other]:checked') as HTMLInputElement);
    if (otherOn) {
      const custom = (qEl.querySelector('[data-clarify-custom]') as HTMLTextAreaElement);
      if (!String(custom?.value || '').trim()) ok = false;
    } else if (!(qEl.querySelector('input[data-clarify-opt]:checked') as HTMLInputElement)) {
      ok = false;
    }
  });
  submit.disabled = !ok;
}

function collectClarifyAnswers(part: TimelinePart, host: HTMLElement) {
  const answers: Record<string, string | string[]> = {};
  const questions = Array.isArray(part.questions) ? part.questions : [];
  questions.forEach((q, qi) => {
    const qEl = (host.querySelector('.clarify-q[data-clarify-q="' + qi + '"]') as HTMLElement);
    const key = String(q.question || ('q' + qi));
    const otherOn = !!(qEl?.querySelector('input[data-clarify-other]:checked') as HTMLInputElement);
    if (otherOn) {
      answers[key] = String((qEl.querySelector('[data-clarify-custom]') as HTMLTextAreaElement)?.value || '').trim();
      return;
    }
    const selected = [...((qEl?.querySelectorAll('input[data-clarify-opt]:checked') as NodeListOf<HTMLInputElement>) || [])]
      .map((el) => el.value);
    answers[key] = q.multiSelect ? selected : (selected[0] || '');
  });
  return answers;
}

async function submitClarifyForm(stream: ActiveStream, clarifyId: string) {
  const part = findClarifyPart(stream, clarifyId);
  const host = stream.dom?.clarifyHost;
  if (!part || !host || part.submitting) return;
  const answers = collectClarifyAnswers(part, host);
  part.submitting = true;
  syncClarifySubmitEnabled(host);
  const btn = (host.querySelector('[data-clarify-submit]') as HTMLButtonElement);
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Submitting…';
  }
  try {
    const response = await fetch('/api/chat/clarify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: clarifyId, answers }),
    });
    if (!response.ok) {
      const problem: RenderApiProblem | null = await response.json().catch(() => null);
      throw new Error((problem && problem.error) || 'Could not submit answers');
    }
  } catch (error) {
    part.submitting = false;
    if (btn) btn.textContent = 'Continue research';
    syncClarifySubmitEnabled(host);
    showAttachHint((error as Error | undefined)?.message || 'Could not submit answers');
  }
}

const approvalInFlight: Set<string> = new Set();

async function submitToolApproval(id: string, allow: boolean) {
  const key = String(id || '').trim();
  if (!key || approvalInFlight.has(key)) return;
  const stream = typeof activeStream === 'function' ? activeStream() : null;
  const part = stream?.timeline?.find((item) => item.type === 'tool' && item.id === key);
  if (!stream || stream.cancelled || stream.serverFinished || stream.settled
    || stream.controller?.signal.aborted || !part?.live) return;
  if (part && ['allowed', 'denied', 'expired'].includes(part.approval)) return;
  approvalInFlight.add(key);
  if (typeof diagnosticStreamMark === 'function' && stream) {
    const convo = conversations.find((item) => item.id === activeId);
    if (convo) diagnosticStreamMark(stream, convo, 'approval.decision', { id: key, allow: !!allow });
  }
  if (part) {
    part.approval = allow ? 'allowed' : 'denied';
  }
  refreshNotificationsUi();
  (document.querySelectorAll('[data-tool-allow="' + CSS.escape(key) + '"], [data-tool-deny="' + CSS.escape(key) + '"]') as NodeListOf<HTMLButtonElement>).forEach((btn) => {
    btn.disabled = true;
  });
  if (typeof refreshTraceSidebar === 'function') refreshTraceSidebar({ animate: false });
  try {
    const response = await fetch('/api/chat/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: key, allow: !!allow }),
    });
    if (!response.ok) {
      const problem: RenderApiProblem | null = await response.json().catch(() => null);
      throw new Error((problem && problem.error) || 'Could not submit approval');
    }
    const result: RenderApprovalResult = await response.json();
    if (result.expired) {
      if (part) part.approval = 'expired';
      refreshNotificationsUi();
      if (typeof refreshTraceSidebar === 'function') refreshTraceSidebar({ animate: false });
    }
  } catch (error) {
    const expired = /no pending tool approval|no longer waiting for approval/i.test(String((error as Error | undefined)?.message || ''));
    if (expired) {
      if (part) part.approval = 'expired';
      refreshNotificationsUi();
      if (typeof refreshTraceSidebar === 'function') refreshTraceSidebar({ animate: false });
      return;
    }
    if (part) part.approval = 'pending';
    refreshNotificationsUi();
    (document.querySelectorAll('[data-tool-allow="' + CSS.escape(key) + '"], [data-tool-deny="' + CSS.escape(key) + '"]') as NodeListOf<HTMLButtonElement>).forEach((btn) => {
      btn.disabled = false;
    });
    if (typeof showAttachHint === 'function') {
      showAttachHint((error as Error | undefined)?.message || 'Could not submit approval');
    }
    if (typeof refreshTraceSidebar === 'function') refreshTraceSidebar({ animate: false });
  } finally {
    approvalInFlight.delete(key);
  }
}

function skillDetailLabel(name: string | undefined) {
  if (name === 'read_chat') return 'Chat';
  if (name === 'list_chats') return 'Scope';
  if (name === 'fetch_url' || name === 'browser_navigate') return 'URL';
  if (name === 'activate_skill' || name === 'read_skill') return 'Skill';
  if (name === 'run_terminal') return 'Command';
  if (name === 'wait_terminal') return 'Session';
  if (name === 'apply_patch') return 'Files';
  if (name === 'read_tool_history') return 'Record';
  if (name === 'browser_click' || name === 'browser_type' || name === 'browser_press' || name === 'browser_wait') {
    return 'Target';
  }
  if (name === 'browser_evaluate') return 'Expression';
  if (name === 'browser_screenshot' || name === 'show_image') return 'Path';
  if (name === 'glob') return 'Pattern';
  if (name === 'grep') return 'Query';
  if (name === 'read_file' || name === 'write_file' || name === 'str_replace' || name === 'delete_file' || name === 'list_dir') {
    return 'Path';
  }
  return 'Query';
}

