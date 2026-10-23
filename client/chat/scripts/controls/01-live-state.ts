function showSettingsPane(pane: string | undefined) {
  (document.querySelectorAll('.settings-nav-btn') as NodeListOf<HTMLElement>).forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.settingsPane === pane);
  });
  (document.querySelectorAll('.settings-pane') as NodeListOf<HTMLElement>).forEach((el) => {
    el.classList.toggle('is-active', el.dataset.settingsPane === pane);
  });
  const scroll = (document.getElementById('settingsScroll') as HTMLElement);
  (document.querySelector('.settings-main') as HTMLElement)?.classList.toggle('is-provider-pane', pane === 'providers');
  if (scroll) scroll.scrollTop = 0;
  if (typeof setProviderSettingsActive === 'function') {
    setProviderSettingsActive(pane === 'providers');
  }
  if (pane === 'data') {
    refreshLocalDataPane();
    refreshSettingsDataSummary();
  } else if (pane === 'profiles') {
    renderProfilesSettingsList();
  } else if (pane === 'app' && typeof refreshAppUpdatePane === 'function') {
    refreshAppUpdatePane();
  } else if (pane === 'logs' && typeof refreshDiagnostics === 'function') {
    if (typeof renderDiagnostics === 'function') renderDiagnostics();
    refreshDiagnostics();
  }
}

function refreshSettingsDataSummary() {
  const el = (document.getElementById('settingsDataSummary') as HTMLElement);
  if (!el) return;
  const chatCount = conversations.filter((convo) => !(typeof isBotsConvo === 'function' && isBotsConvo(convo))).length;
  const loopCount = conversations.filter((convo) => typeof isBotsConvo === 'function' && isBotsConvo(convo)).length;
  const projectCount = projects.length;
  const chatLabel = chatCount === 1 ? '1 chat' : chatCount + ' chats';
  const projectLabel = projectCount === 1 ? '1 project' : projectCount + ' projects';
  const loopLabel = loopCount === 1 ? '1 loop' : loopCount + ' loops';
  const profileLabel = activeProfile()?.name || 'Personal';
  el.textContent = profileLabel + ' profile. Stored on disk: '
    + chatLabel + ', ' + loopLabel + ', and ' + projectLabel + '.';
  const clearChats = (document.getElementById('btnClearChats') as HTMLButtonElement);
  const clearLoops = (document.getElementById('btnClearLoops') as HTMLButtonElement);
  const clearProjects = (document.getElementById('btnClearProjects') as HTMLButtonElement);
  const clearAll = (document.getElementById('btnClearAllData') as HTMLButtonElement);
  if (clearChats) clearChats.disabled = chatCount === 0;
  if (clearLoops) clearLoops.disabled = loopCount === 0;
  if (clearProjects) clearProjects.disabled = projectCount === 0;
  const hasDrafts = typeof hasComposerDrafts === 'function' && hasComposerDrafts();
  if (clearAll) clearAll.disabled = chatCount === 0 && loopCount === 0 && projectCount === 0 && !hasDrafts;
}

const outboundStarting = new Set<string>();
const outboundStartEpochs = new Map<string, number>();
const stoppedOutboundQueues = new Set<string>();

function isConvoBusy(convoId: string | null | undefined) {
  const botsRunning = typeof isBotsOutboundActive === 'function'
    && isBotsOutboundActive(convoId)
    && !(typeof isBotsOutboundStopped === 'function' && isBotsOutboundStopped(convoId));
  return !!convoId && (
    activeStreams.has(convoId!)
    || outboundStarting.has(convoId)
    || botsRunning
  );
}

function activeStream() {
  return activeId ? activeStreams.get(activeId) || null : null;
}

/** Hard stop for bot group hop loops — lives here so Stop works even before bots.js loads. */
const botsOutboundStopFlags = new Set<string>();
/** Turns this page already started or stopped — do not resume from linger. */
const handledLiveTurnIds = new Set<string>();
/** Conversations the user Stopped before a turn id arrived. */
const cancelledLiveConvoIds = new Set<string>();

function rememberHandledLiveTurn(turnId: string | null | undefined) {
  const id = String(turnId || '').trim();
  if (id) handledLiveTurnIds.add(id);
}

function shouldSkipLiveTurnResume(info: { conversation_id?: string; turn_id?: string }) {
  const convoId = String(info?.conversation_id || '').trim();
  const turnId = String(info?.turn_id || '').trim();
  if (turnId && handledLiveTurnIds.has(turnId)) return true;
  if (convoId && cancelledLiveConvoIds.has(convoId)) return true;
  return false;
}

function noteLiveTurnUserCancel(convoId: string | null | undefined, turnId: string | null | undefined) {
  if (convoId) cancelledLiveConvoIds.add(convoId);
  rememberHandledLiveTurn(turnId);
}

function clearLiveTurnUserCancel(convoId: string | null | undefined) {
  if (convoId) cancelledLiveConvoIds.delete(convoId);
}

function markBotsOutboundStopped(convoId: string | null | undefined) {
  if (convoId) botsOutboundStopFlags.add(convoId);
  if (typeof clearBotsInjects === 'function') clearBotsInjects(convoId);
}

function clearBotsOutboundStopped(convoId: string | null | undefined) {
  if (convoId) botsOutboundStopFlags.delete(convoId);
}

function isBotsOutboundStopped(convoId: string | null | undefined) {
  return !!convoId && botsOutboundStopFlags.has(convoId);
}

const cancelInFlight = new Map<string, Promise<boolean>>();

function markOutboundStarting(convoId: string | null | undefined) {
  if (!convoId) return 0;
  const epoch = (outboundStartEpochs.get(convoId) || 0) + 1;
  outboundStartEpochs.set(convoId, epoch);
  outboundStarting.add(convoId);
  if (typeof syncComposerStreamUi === 'function') syncComposerStreamUi();
  return epoch;
}

function outboundStartIsCurrent(convoId: string, epoch: number) {
  return !!convoId && !!epoch && outboundStartEpochs.get(convoId) === epoch;
}

function clearOutboundStarting(convoId: string | null | undefined, epoch: number | null = null) {
  if (!convoId) return;
  if (epoch != null && !outboundStartIsCurrent(convoId, epoch)) return;
  outboundStarting.delete(convoId);
  if (typeof syncComposerStreamUi === 'function') syncComposerStreamUi();
}

function invalidateOutboundStart(convoId: string | null | undefined) {
  if (!convoId) return;
  outboundStartEpochs.set(convoId, (outboundStartEpochs.get(convoId) || 0) + 1);
  outboundStarting.delete(convoId);
  if (typeof syncComposerStreamUi === 'function') syncComposerStreamUi();
}

function scheduleCancel(convoId: string, turnId: string | null | undefined) {
  if (!convoId) return Promise.resolve(true);
  const prev = cancelInFlight.get(convoId) || Promise.resolve(true);
  const next = prev.catch(() => false).then(async () => {
    const controller = new AbortController();
    let timeout: number | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, 6000);
    });
    try {
      const response = await Promise.race([
        fetch('/api/chat/cancel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            conversation_id: convoId,
            ...(turnId ? { turn_id: turnId } : {}),
          }),
          signal: controller.signal,
        }),
        timedOut,
      ]);
      if (!response) return false;
      if (!response.ok) return false;
      const result: { settled?: boolean } | null = await response.json().catch(() => null);
      return result?.settled === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  });
  cancelInFlight.set(convoId, next);
  next.finally(() => {
    if (cancelInFlight.get(convoId) === next) cancelInFlight.delete(convoId);
  });
  return next;
}

function waitForCancel(convoId: string) {
  const pending = convoId ? cancelInFlight.get(convoId) : null;
  if (!pending) return Promise.resolve();
  // Always continue after the cancel HTTP finishes. A failed/unsettled
  // cancel must not freeze every later prompt on Processing.
  return pending.then(() => {}).catch(() => {});
}

function cancelLiveBodyReader(stream: ActiveStream) {
  const reader = stream?.bodyReader;
  if (!reader || typeof reader.cancel !== 'function') return;
  stream.bodyReader = null;
  try {
    const pending = reader.cancel();
    // cancel() returns a promise. AbortError from an already-aborted
    // BodyStreamBuffer is expected and must not become uncaught.
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch { /* ignore */ }
}

function abortStream(convoId: string | null | undefined, {
  cancelServer = true,
  soft = false,
  preservePartial = false,
} = {}) {
  if (!soft) invalidateOutboundStart(convoId);
  if (cancelServer && !soft) markBotsOutboundStopped(convoId);
  if (cancelServer && !soft && typeof bumpBotsOutboundEpoch === 'function') {
    bumpBotsOutboundEpoch(convoId!);
  }
  const stream = activeStreams.get(convoId!);
  if (stream) {
    if (cancelServer) stream.cancelled = true;
    if (cancelServer && !soft && !preservePartial) stream.hardStopped = true;
    rememberHandledLiveTurn(stream.turnId);
    if (cancelServer && !soft) noteLiveTurnUserCancel(convoId, stream.turnId);
    cancelLiveBodyReader(stream);
    try { stream.controller.abort(); } catch { /* ignore */ }
    if (cancelServer && !soft && !preservePartial) {
      if (typeof discardLiveStreamRow === 'function') discardLiveStreamRow(stream);
      else {
        try { stream.dom?.thinkingOrb?.stop(); } catch { /* ignore */ }
        stream.dom?.row?.remove();
        stream.dom = null;
      }
      if (activeStreams.get(convoId!) === stream) activeStreams.delete(convoId!);
    }
  } else if (cancelServer && !soft) {
    noteLiveTurnUserCancel(convoId, null);
  }
  const cancelDone = cancelServer && convoId
    ? scheduleCancel(convoId!, stream?.turnId || null)
    : Promise.resolve();
  if (typeof refreshNotificationsUi === 'function') refreshNotificationsUi();
  syncComposerStreamUi();
  return cancelDone;
}

/** Abort the live hop without ending the bots outbound loop. */
function softAbortStream(convoId: string | null | undefined) {
  abortStream(convoId, { cancelServer: true, soft: true });
}

function abortAllStreams({ cancelServer = true } = {}) {
  const ids = new Set([...activeStreams.keys(), ...outboundStarting]);
  for (const id of ids) abortStream(id, { cancelServer });
  if (typeof stopAllBotsOutbound === 'function') stopAllBotsOutbound();
}

function syncComposerStreamUi() {
  const busy = isConvoBusy(activeId);
  // Keep Send visible while streaming so the next message can be queued.
  btnSend.classList.remove('is-hidden');
  btnSend.classList.toggle('is-queueing', busy);
  btnStop.classList.toggle('is-hidden', !busy);
  const botsBusy = busy
    && typeof isBotsConvo === 'function'
    && isBotsConvo(conversations.find((item) => item.id === activeId));
  btnSend.title = busy
    ? (botsBusy ? 'Queue for after this agent turn' : 'Queue message')
    : 'Send message';
  btnSend.setAttribute(
    'aria-label',
    busy
      ? (botsBusy ? 'Queue for after this agent turn' : 'Queue message')
      : 'Send message'
  );
  updateSendEnabled();
  updateComposerHint();
  // Steer appears only while an agent reply can accept mid-turn guidance.
  if (activeId) {
    const convo = conversations.find((c) => c.id === activeId);
    if (convo && getOutboundQueue(activeId).length) renderOutboundQueue(convo);
  }
  if (typeof syncSidebarBusyUi === 'function') syncSidebarBusyUi();
}

