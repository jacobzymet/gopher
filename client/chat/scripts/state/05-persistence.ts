function reportPersistenceFailure(path: string, error: unknown) {
  console.warn('Could not persist ' + path, error);
  const now = Date.now();
  if (now - persistenceWarningAt < 5000 || typeof showComposerHint !== 'function') return;
  persistenceWarningAt = now;
  showComposerHint('Could not save local changes. Check the server and retry.', { warn: true });
}

/**
 * Never set `keepalive` here: chats and the background image push these payloads
 * far past the browser's 64 KiB keepalive quota, and over-quota requests are
 * rejected before they ever reach the server.
 */
async function putJsonWithRetry(path: string, payload: unknown, { attempts = 3, valid = () => true, timeoutMs = 15000, body = JSON.stringify(payload) }: PersistenceOptions = {}) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!valid()) return false;
    if (attempt) await new Promise<unknown>((resolve) => setTimeout(resolve, 200 * attempt));
    if (!valid()) return false;
    const controller = new AbortController();
    let timer: number | undefined;
    try {
      const response = await Promise.race([fetch(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      }), new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Saving local changes timed out'));
        }, timeoutMs);
      })]);
      // Older servers echo the archive. Release it before the next request.
      if (response.body) void response.body.cancel().catch(() => {});
      if (response.ok) return true;
      // Most client errors are deterministic; only timeout and throttling merit a retry.
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408 &&
        response.status !== 429
      ) {
        lastError = new Error(path + ' rejected the write (' + response.status + ')');
        break;
      }
      lastError = new Error(path + ' responded ' + response.status);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  reportPersistenceFailure(path, lastError);
  return false;
}

function outboundQueueForStore(convo: Conversation) {
  const convoId = convo?.id;
  const queue = outboundQueues.has(convoId) && Array.isArray(outboundQueues.get(convoId))
    ? outboundQueues.get(convoId)!.slice()
    : (Array.isArray(convo?.outboundQueue) ? convo.outboundQueue.slice() : []);
  const stream = typeof activeStreams !== 'undefined' ? activeStreams.get(convoId) : null;
  const pending = (stream?.pendingSteers || [])
    .filter((entry) => entry?.item && !entry.applied)
    .map((entry) => entry.item);
  if (!pending.length) return queue;
  const seen = new Set(pending.map((item) => item.id));
  return pending.concat(queue.filter((item) => !seen.has(item.id)));
}

function conversationStoreRecord(convo: Conversation) {
  const record = { ...convo };
  delete record.outboundQueue;
  const queue = outboundQueueForStore(convo);
  if (queue.length) record.outboundQueue = queue;
  return record;
}

function restoreOutboundQueues(list: Conversation[], { clear = true } = {}) {
  if (clear) outboundQueues.clear();
  for (const convo of list || []) {
    const items = Array.isArray(convo.outboundQueue)
      ? convo.outboundQueue.map(normalizeOutboundItem).filter(Boolean)
      : [];
    if (items.length) outboundQueues.set(convo.id, items);
    if (convo && Object.prototype.hasOwnProperty.call(convo, 'outboundQueue')) {
      delete convo.outboundQueue;
    }
  }
}

function adoptPersistedOutboundQueue(convo: Conversation | null | undefined) {
  if (!convo?.id) return;
  const persisted = Array.isArray(convo.outboundQueue)
    ? convo.outboundQueue.map(normalizeOutboundItem).filter(Boolean)
    : [];
  if (Object.prototype.hasOwnProperty.call(convo, 'outboundQueue')) {
    delete convo.outboundQueue;
  }
  if (outboundQueues.has(convo.id)) return;
  if (persisted.length) outboundQueues.set(convo.id, persisted);
}

function persistOutboundQueues() {
  saveConversations({ immediate: true });
}

function storePayload() {
  if (typeof captureComposerDraft === 'function') captureComposerDraft();
  syncActiveProfileFromMemory();
  return {
    version: 3,
    activeProfileId,
    profiles: profiles.map(profileStoreRecord),
  };
}

function diskEncryptionLocked() {
  return !!(
    dataInfo
    && dataInfo.encryption_enabled
    && !dataInfo.encryption_unlocked
  );
}

function requireUnlockedData() {
  if (localDataLoadError) {
    showLocalDataLoadError(localDataLoadError);
    return false;
  }
  if (!diskEncryptionLocked()) return true;
  promptUnlockSession();
  return false;
}

function enqueueStoreWrite(snapshot: unknown) {
  const epoch = storageWriteEpoch;
  // Capture immutable bytes now: queued snapshots otherwise share live messages.
  const body = JSON.stringify(snapshot);
  storeWriteChain = new Promise<boolean>((resolve) => {
    if (!pendingStoreWrite && activeStoreWrite?.epoch === epoch && activeStoreWrite.body === body) {
      // Dispatch and retrieval setup often save the exact same chat snapshot.
      activeStoreWrite.waiters.push(resolve);
    } else if (pendingStoreWrite?.epoch === epoch) {
      // Only the latest complete snapshot matters. Resolve superseded callers
      // when that replacement is durable, including the pre-send retrieval wait.
      pendingStoreWrite.body = body;
      pendingStoreWrite.waiters.push(resolve);
    } else {
      pendingStoreWrite?.waiters.forEach((done) => done(false));
      pendingStoreWrite = { body, epoch, waiters: [resolve] };
    }
  });
  if (!storeWriteRunning) {
    storeWriteRunning = true;
    // Queue insertion, removal, and message dispatch share one synchronous turn.
    // Persist its final snapshot instead of starting an obsolete write midway.
    queueMicrotask(() => { void drainStoreWrites(); });
  }
  return storeWriteChain;
}

async function drainStoreWrites() {
  storeWriteRunning = true;
  try {
    while (pendingStoreWrite) {
      const write = pendingStoreWrite;
      pendingStoreWrite = null;
      activeStoreWrite = write;
      let saved = false;
      try {
        saved = await putJsonWithRetry('/api/data/store', null, {
          body: write.body,
          valid: () => write.epoch === storageWriteEpoch && !diskEncryptionLocked(),
        });
      } catch (error) {
        reportPersistenceFailure('/api/data/store', error);
      }
      activeStoreWrite = null;
      write.waiters.forEach((done) => done(saved));
    }
  } finally {
    activeStoreWrite = null;
    storeWriteRunning = false;
  }
}

function saveStore({ immediate = true } = {}) {
  if (!storageReady || diskEncryptionLocked()) return;
  const put = () => {
    if (diskEncryptionLocked()) return;
    enqueueStoreWrite(storePayload());
  };
  clearTimeout(saveStoreTimer);
  saveStoreTimer = null;
  if (immediate) {
    put();
    return;
  }
  saveStoreTimer = setTimeout(() => {
    saveStoreTimer = null;
    put();
  }, 120);
}

function saveConversations({ immediate = true } = {}) {
  saveStore({ immediate });
}

