function inProjectChat() {
  return mainView === 'chat' && !!getProject(activeProjectId);
}

function currentRoutePath() {
  if (mainView === 'projects') return '/projects';
  if (mainView === 'notifications') return '/notifications';
  if (appSurface === 'bots') {
    if (activeId) return '/loops/c/' + encodeURIComponent(activeId);
    return '/loops';
  }
  if (activeId) return '/c/' + encodeURIComponent(activeId);
  if (activeProjectId && getProject(activeProjectId)) {
    return draftIncognito
      ? '/p/' + encodeURIComponent(activeProjectId) + '/ghost'
      : '/p/' + encodeURIComponent(activeProjectId);
  }
  return draftIncognito ? '/ghost' : '/';
}

function syncUrlFromState({ replace = false } = {}) {
  if (suppressUrlSync) return;
  const path = currentRoutePath();
  if (window.location.pathname === path) return;
  if (replace) history.replaceState({ gopher: 1 }, '', path);
  else history.pushState({ gopher: 1 }, '', path);
}

function parseLocationRoute(): AppLocationRoute {
  const parts = (window.location.pathname || '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      try { return decodeURIComponent(part); }
      catch { return part; }
    });
  if (parts.length === 0) return { kind: 'draft', incognito: false, surface: 'chat' };
  if (parts[0] === 'loops' || parts[0] === 'bots') {
    if (parts[1] === 'c' && parts[2]) return { kind: 'convo', id: parts[2], surface: 'bots' };
    return { kind: 'draft', incognito: false, surface: 'bots' };
  }
  if (parts[0] === 'projects') return { kind: 'projects', surface: 'chat' };
  if (parts[0] === 'notifications') return { kind: 'notifications' };
  if (parts[0] === 'ghost') return { kind: 'draft', incognito: true, surface: 'chat' };
  if (parts[0] === 'c' && parts[1]) return { kind: 'convo', id: parts[1] };
  if (parts[0] === 'p' && parts[1]) {
    return {
      kind: 'project',
      id: parts[1],
      incognito: parts[2] === 'ghost',
    };
  }
  return { kind: 'draft', incognito: false };
}

function applyLocationRoute() {
  const route = parseLocationRoute();
  const locked = diskEncryptionLocked();
  suppressUrlSync = true;
  try {
    if (route.surface && typeof persistAppSurface === 'function' && appSurface !== route.surface) {
      persistAppSurface(route.surface);
    } else if (route.surface && typeof applyAppSurface !== 'function' && appSurface !== route.surface) {
      appSurface = route.surface;
      (document.getElementById('chatShell') as HTMLElement)?.setAttribute('data-surface', appSurface);
      if (typeof paintWordmarkSurface === 'function') paintWordmarkSurface(appSurface);
    }
    if (route.kind === 'projects') {
      showProjectsView();
    } else if (route.kind === 'notifications') {
      showNotificationsView();
    } else if (route.kind === 'convo') {
      const convo = conversations.find((item) => item.id === route.id);
      if (convo) {
        selectConversation(convo.id);
        const source = chatSourceTarget(window.location.href);
        if (source) scrollToChatSource(source.message);
      } else if (locked) {
        activeId = null;
        draftIncognito = false;
        showChatView();
        showEmptyState();
        renderSidebar();
      } else {
        startDraft({ incognito: false });
      }
    } else if (route.kind === 'project') {
      if (getProject(route.id)) {
        openProject(route.id, { incognito: !!route.incognito });
      } else if (locked) {
        activeId = null;
        activeProjectId = null;
        draftIncognito = !!route.incognito;
        showChatView();
        showEmptyState();
        renderSidebar();
      } else {
        activeProjectId = null;
        startDraft({ incognito: !!route.incognito });
      }
    } else {
      activeProjectId = null;
      startDraft({ incognito: !!route.incognito });
    }
  } finally {
    suppressUrlSync = false;
  }
  if (!locked) syncUrlFromState({ replace: true });
}

function leaveProject() {
  activeProjectId = null;
  activeId = null;
  showChatView();
  showEmptyState();
  syncProjectChrome();
  renderSidebar();
  syncUrlFromState();
  composerInput.focus();
}

/** Keep chrome (shell class, topbar, empty state, composer) in sync with project context. */
function syncProjectChrome() {
  const project = inProjectChat() ? getProject(activeProjectId) : null;
  const incognito = isIncognitoContext();
  chatShell.classList.toggle('is-in-project', !!project);
  chatShell.classList.toggle('is-incognito', incognito);
  if (topbarIncognito) {
    topbarIncognito.classList.toggle('is-hidden', !incognito);
  }
  const activeConvo = conversations.find((item) => item.id === activeId);
  const holder = activeConvo?.botsHeldBy && typeof getBot === 'function'
    ? getBot(activeConvo.botsHeldBy)
    : null;
  if (topbarBotsHold) {
    const held = !!(holder && typeof isBotGroup === 'function' && isBotGroup(activeConvo));
    topbarBotsHold.classList.toggle('is-hidden', !held);
    if (held) {
      topbarBotsHold.textContent = 'Held by @' + holder.handle;
      setIdentityTitle(
        topbarBotsHold,
        'Other agents wait until @' + holder.handle + ' resumes or you ping them'
      );
    }
  }

  // Label only — the leading plus icon is a sibling span and must survive.
  btnNewChatLabel.textContent = project ? 'New chat in project' : 'New chat';
  btnNewChat.title = project
    ? 'Start a new chat inside ' + project.name
    : 'Start a new chat';
  if (btnNewIncognitoChat) {
    btnNewIncognitoChat.title = project
      ? 'Ghost chat in ' + project.name + ' — temporary, not saved'
      : 'New ghost chat — temporary session, not saved';
  }

  if (incognito && !activeId) {
    emptyEyebrow.textContent = 'Temporary Session';
    emptyEyebrow.classList.remove('is-hidden');
    greetingEl.textContent = project ? project.name : 'Ghost Chat';
  } else if (project && !activeId) {
    emptyEyebrow.textContent = 'Project';
    emptyEyebrow.classList.remove('is-hidden');
    greetingEl.textContent = project.name;
  } else if (!activeId && typeof isBotsSurface === 'function' && isBotsSurface()) {
    emptyEyebrow.textContent = 'Loops';
    emptyEyebrow.classList.remove('is-hidden');
    greetingEl.textContent = 'Start a loop';
  } else if (!activeId) {
    emptyEyebrow.classList.add('is-hidden');
    const base = greetingForNow();
    const name = settings.name.trim();
    greetingEl.textContent = name ? base + ', ' + name : base;
  } else {
    emptyEyebrow.classList.add('is-hidden');
  }

  topbarProject.innerHTML = '';
  if (project) {
    topbarProject.classList.remove('is-hidden');
    const pill = (document.createElement('button') as HTMLButtonElement);
    pill.type = 'button';
    pill.className = 'topbar-project-pill';
    pill.textContent = project.name;
    pill.title = 'Project settings';
    pill.addEventListener('click', () => openProjectSettings(project.id));
    topbarProject.appendChild(pill);
    if (!activeId) {
      convoTitleEl.textContent = incognito ? '' : 'New chat';
    }
  } else {
    topbarProject.classList.add('is-hidden');
    if (!activeId) convoTitleEl.textContent = '';
  }
  if (incognito && activeId) convoTitleEl.textContent = '';

  if (incognito) {
    composerInput.placeholder = project
      ? 'Ghost chat in ' + project.name + ' — not saved. Type @ to mention'
      : 'Ghost chat — not saved. Type @ to mention';
  } else {
    composerInput.placeholder = project
      ? 'Message in ' + project.name + '… Type @ to mention'
      : (typeof isBotsSurface === 'function' && isBotsSurface()
        ? (activeId ? 'Give the room a hard problem… Type @ to ping' : 'Create a loop to start')
        : 'How can I help you today? Type @ to mention');
  }

  updateComposerHint();
  // Refresh model line without waiting for the next poll.
  if (serverReady) {
    modelHintEl.classList.remove('is-hidden');
    const suffix = project ? ' · Project: ' + project.name : '';
    const current = modelHintEl.textContent || '';
    const provider = (modelHintEl.querySelector('.model-hint-provider') as HTMLElement)?.textContent || '';
    if (incognito && !activeId) {
      modelHintEl.textContent = 'Temporary session — stays in memory only until you close the tab.'
        + (project ? ' · Project: ' + project.name : '');
    } else if (typeof paintLoopModelHint === 'function' && paintLoopModelHint()) {
      /* loop-specific model line */
    } else if (typeof paintReadyInferenceModelHint === 'function'
      && paintReadyInferenceModelHint(latestState)) {
      /* current Agent model line */
    } else if (current.startsWith('Chatting with ')) {
      const model = current.replace(/^Chatting with /, '').split(/ · | via /)[0];
      setModelHintWithProvider(
        project && !activeId
          ? 'Shared instructions & memory apply · ' + model
          : 'Chatting with ' + model + suffix,
        provider
      );
    } else if (project && !activeId) {
      modelHintEl.textContent = 'Shared instructions and memory apply to chats in this project.';
    }
  } else {
    modelHintEl.textContent = '';
    modelHintEl.classList.add('is-hidden');
  }
  if (typeof renderTraceMembers === 'function') renderTraceMembers();
  if (typeof renderWelcomeTools === 'function') renderWelcomeTools();
}

function isIncognitoContext() {
  if (activeId) {
    const convo = conversations.find((item) => item.id === activeId);
    return !!(convo && convo.incognito);
  }
  return draftIncognito;
}

function updateGreeting() {
  syncProjectChrome();
}

function updateComposerHint() {
  if (localDataLoadError) {
    showComposerHint('Saved settings could not be loaded. Retry loading above.', { warn: true });
    return;
  }
  if (diskEncryptionLocked()) {
    showComposerHint('Unlock local data to chat and save messages.', { warn: true });
    return;
  }
  if (!serverReady) {
    hideComposerHint();
    return;
  }
  if (voiceListening) {
    showComposerHint('Listening… click the mic or press Esc to stop');
    return;
  }
  // Keep recent attachment / voice warnings visible; pollState would otherwise wipe them.
  if (Date.now() < attachHintUntil && composerHint.classList.contains('is-warn')) {
    return;
  }
  if (Date.now() < voiceHintUntil && composerHint.classList.contains('is-warn')) {
    return;
  }
  attachHintUntil = 0;
  voiceHintUntil = 0;
  const queueLen = activeId ? getOutboundQueue(activeId).length : 0;
  if (queueLen > 0) {
    if (typeof isOutboundQueueStopped === 'function' && isOutboundQueueStopped(activeId)) {
      showComposerHint('Queue paused after Stop · send a new message or save an edit to resume');
      return;
    }
    if (isQueuePausedForEdit(activeId)) {
      showComposerHint('Queue paused · save or cancel the edit to continue');
      return;
    }
    const busy = isConvoBusy(activeId);
    const queueHint = queueLen === 1
      ? (busy
        ? (canSteerLiveStream()
          ? '1 message queued · Steer to guide live activity, or waits until this reply finishes'
          : '1 message queued · sends when this reply finishes')
        : '1 message queued')
      : (busy
        ? (canSteerLiveStream()
          ? queueLen + ' messages queued · Steer one to guide live activity, or they send in order'
          : queueLen + ' messages queued · sending in order')
        : queueLen + ' messages queued');
    showComposerHint(queueHint);
    return;
  }
  const heldConvo = conversations.find((item) => item.id === activeId);
  if (heldConvo && heldConvo.botsHeldBy && typeof getBot === 'function' && typeof isBotGroup === 'function' && isBotGroup(heldConvo)) {
    const holder = getBot(heldConvo.botsHeldBy);
    showComposerHint(
      holder
        ? 'Held by @' + holder.handle + ' — other agents wait until they resume, or you ping someone'
        : 'Room is held — other agents wait until resume'
    );
    return;
  }
  hideComposerHint();
}

