function cancelMessageEdit({ resumeQueue = true }: { resumeQueue?: boolean; type?: string } = {}) {
  if (!editingRow) return;
  const row = editingRow;
  const wasQueued = row.classList.contains('msg-queued');
  const queueId = row.dataset.queueId || '';
  const raw = row.dataset.raw || '';
  const bubble = (row.querySelector('.msg-bubble, .msg-edit') as HTMLElement);
  closeMentionMenu();
  mentionInput = composerInput;
  if (bubble) {
    const next = (document.createElement('div') as HTMLElement);
    next.className = 'msg-bubble';
    if (wasQueued && activeId) {
      const item = findQueuedItem(activeId, queueId);
      next.innerHTML = formatUserMessageHtml({
        content: item?.displayText || raw,
        attachments: item?.attachments || [],
      });
    } else {
      next.innerHTML = formatUserHtml(raw);
    }
    bubble.replaceWith(next);
  }
  row.classList.remove('is-editing');
  editingRow = null;
  if (typeof updateSendEnabled === 'function') updateSendEnabled();
  if (wasQueued) {
    editingQueueId = null;
    if (activeId && queueId) {
      const item = findQueuedItem(activeId, queueId);
      if (item) refreshQueuedBubble(row, item, { paused: false });
    }
    updateComposerHint();
    if (resumeQueue) maybeSendNextQueued(activeId);
  }
}

function resolveUserMessageIndex(row: HTMLElement, convo: Conversation) {
  const messages = convo?.messages || [];
  const hinted = Number(row?.dataset.msgIndex);
  if (Number.isInteger(hinted) && hinted >= 0 && messages[hinted]?.role === 'user') {
    return hinted;
  }
  if (!row || !chatThread) return -1;
  const userRows = [...(chatThread.querySelectorAll('.msg.msg-role-user:not(.msg-queued)') as NodeListOf<HTMLElement>)];
  const pos = userRows.indexOf(row);
  if (pos < 0) return -1;
  let seen = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role !== 'user') continue;
    seen += 1;
    if (seen === pos) return i;
  }
  return -1;
}

function beginMessageEdit(row: HTMLElement) {
  if (row.classList.contains('is-editing') || row.classList.contains('msg-queued')) return;
  if (editingRow && editingRow !== row) cancelMessageEdit();

  const raw = row.dataset.raw || '';
  const bubble = (row.querySelector('.msg-bubble') as HTMLElement);
  if (!bubble) return;

  const editor = (document.createElement('div') as HTMLElement);
  editor.className = 'msg-edit';
  const input = (document.createElement('textarea') as HTMLTextAreaElement);
  input.className = 'msg-edit-input';
  input.value = raw;
  input.setAttribute('aria-label', 'Edit message');
  input.placeholder = 'Edit message… Type @ to mention';
  const bar = (document.createElement('div') as HTMLElement);
  bar.className = 'msg-edit-bar';
  const btnCancel = (document.createElement('button') as HTMLButtonElement);
  btnCancel.type = 'button';
  btnCancel.className = 'btn btn-ghost';
  btnCancel.textContent = 'Cancel';
  const btnSave = (document.createElement('button') as HTMLButtonElement);
  btnSave.type = 'button';
  btnSave.className = 'btn btn-primary';
  btnSave.textContent = 'Send & restart';
  const status = (document.createElement('div') as HTMLElement);
  status.className = 'msg-edit-status';
  status.setAttribute('role', 'status');
  status.textContent = 'Sending replaces this message and all later replies.';
  bar.appendChild(btnCancel);
  bar.appendChild(btnSave);
  editor.appendChild(input);
  editor.appendChild(status);
  editor.appendChild(bar);

  bubble.replaceWith(editor);
  row.classList.add('is-editing');
  editingRow = row;
  mentionInput = input;
  if (typeof updateSendEnabled === 'function') updateSendEnabled();

  const commit = () => {
    const next = input.value.trim();
    if (!next) return;
    closeMentionMenu();
    mentionInput = composerInput;
    void submitEditedMessage(row, next);
  };
  btnCancel.addEventListener('click', cancelMessageEdit);
  btnSave.addEventListener('click', commit);
  input.addEventListener('input', () => {
    autoResize(input);
    updateMentionMenu(input);
  });
  input.addEventListener('click', () => updateMentionMenu(input));
  input.addEventListener('keyup', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      updateMentionMenu(input);
    }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement !== input) closeMentionMenu();
    }, 120);
  });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (handleMentionKeydown(event)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelMessageEdit();
      return;
    }
    if (event.key !== 'Enter') return;
    if (settings.enterSends) {
      if (!event.shiftKey) {
        event.preventDefault();
        commit();
      }
    } else if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      commit();
    }
  });
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  autoResize(input);
}

async function submitEditedMessage(row: HTMLElement, rawText: string) {
  if (row.dataset.editSubmitting === 'true' || !String(rawText || '').trim()) return;
  const convo = conversations.find((item) => item.id === activeId);
  if (!convo) return;
  const index = resolveUserMessageIndex(row, convo);
  if (index < 0) {
    showComposerHint('Could not find that message. Try Send again.');
    return;
  }
  if (!serverReady) {
    showComposerHint('Model is not ready yet. Try Send again.');
    return;
  }
  row.dataset.editSubmitting = 'true';
  const editControls = (row.querySelectorAll('.msg-edit button, .msg-edit textarea') as NodeListOf<HTMLTextAreaElement>);
  const editStatus = (row.querySelector('.msg-edit-status') as HTMLElement);
  const editSend = (row.querySelector('.msg-edit .btn-primary') as HTMLElement);
  editControls.forEach((control) => { control.disabled = true; });
  if (editSend) editSend.textContent = 'Restarting…';
  if (editStatus) editStatus.textContent = 'Stopping the current response before sending your edit…';
  updateSendEnabled();
  let editStartEpoch: ReturnType<typeof markOutboundStarting> | null = null;
  try {
  const live = typeof activeStreams !== 'undefined' ? activeStreams.get(convo.id) : null;
  if (live) {
    live.replaced = true;
    live.skipQueue = true;
  }
  // Invalidate requests still starting as well as requests already streaming.
  if (live || outboundStarting.has(convo.id)) abortStream(convo.id, { cancelServer: true });
  editStartEpoch = markOutboundStarting(convo.id);
  await waitForCancel(convo.id);
  if (!outboundStartIsCurrent(convo.id, editStartEpoch)) return;

  const mentioned = parseCapabilityMentions(rawText);
  const text = mentioned.text;
  const mentionIds = new Set<string>([
    ...composerMentionIds,
    ...mentioned.mentions,
  ]);
  mentionIds.delete('agent');
  const turn = resolveTurnSkills(mentionIds);
  const displayText = displayTextWithMentions(text, mentioned.mentions);

  if (editingRow === row) editingRow = null;
  row.classList.remove('is-editing');
  if (activeId === convo.id) {
    mentionInput = composerInput;
    closeMentionMenu();
  }
  updateSendEnabled();

  const priorMessage = convo.messages[index];
  const priorAttachments = Array.isArray(priorMessage.attachments)
    ? priorMessage.attachments
    : [];
  convo.messages = convo.messages.slice(0, index + 1);
  const editedMessage: ChatMessage = { role: 'user', content: displayText };
  if (priorAttachments.length) editedMessage.attachments = priorAttachments;
  copyReplyFields(priorMessage, editedMessage);
  convo.messages[index] = editedMessage;
  if (index === 0 && !convo.titleEdited) {
    convo.title = provisionalTitle(text || displayText);
    convo.titleStatus = 'pending';
    convo.titleAttempts = 0;
    convo._titleReq = (convo._titleReq || 0) + 1;
    convo._titleBusy = false;
    if (typeof clearConversationTitleTimer === 'function') {
      clearConversationTitleTimer(convo.id);
    }
  }
  convo.updatedAt = Date.now();
  saveConversations();
  renderSidebar();
  if (activeId === convo.id) renderThread(convo, { drainQueue: false });
  const mappedAttachments = priorAttachments.map((att) => ({
    ...att,
    sendMode: att.sendMode || (att.kind === 'image' && att.dataUrl && !att.extractedText ? 'native' : 'text'),
    apiPart: att.kind === 'image' && att.dataUrl && !att.extractedText
      ? { type: 'image_url', image_url: { url: att.dataUrl } }
      : null,
    apiText: att.extractedText
      ? ('Attachment: ' + (att.name || 'file') + '\n\n' + att.extractedText)
      : '',
  }));
  const apiText = buildUserApiContent(
    text,
    mappedAttachments,
    editedMessage.replyQuote,
    editedMessage.replyToSpeakerHandle
  );
  const editedUser = convo.messages[index];
  if (typeof isBotsConvo === 'function' && isBotsConvo(convo) && typeof runBotsOutbound === 'function') {
    await runBotsOutbound(convo, {
      id: newId('q'),
      editText: rawText,
      displayText,
      apiText,
      attachments: priorAttachments,
      replyQuote: editedMessage.replyQuote || '',
      replyToSpeakerId: editedMessage.replyToSpeakerId || '',
      replyToSpeakerHandle: editedMessage.replyToSpeakerHandle || '',
      turn: {
        useAgent: turn.useAgent,
        skills: turn.skills,
        deepResearch: turn.deepResearch,
        deepResearchOutput: turn.deepResearchOutput,
        forceTools: turn.forceTools,
      },
    }, editedUser, convo.title);
    return;
  }
  const started = await runAssistantTurn(convo, {
    useAgent: turn.useAgent,
    text: apiText,
    skills: turn.skills,
    deepResearch: turn.deepResearch,
    deepResearchOutput: turn.deepResearchOutput,
    forceTools: turn.forceTools,
    replaceLive: true,
  });
  if (started === false) {
    if (activeId === convo.id && !isConvoBusy(convo.id)) {
      showComposerHint('Response was not restarted. Your edited message is saved; edit it to retry.');
    }
  }
  } catch (error) {
    if (activeId === convo.id) showComposerHint('Could not restart the response. Your edit is kept; try again.');
  } finally {
    if (editStartEpoch != null) clearOutboundStarting(convo.id, editStartEpoch);
    delete row.dataset.editSubmitting;
    editControls.forEach((control) => { control.disabled = false; });
    if (editSend) editSend.textContent = 'Send & restart';
    if (editStatus) editStatus.textContent = 'Sending replaces this message and all later replies.';
    updateSendEnabled();
  }
}

