function mountStarfield(canvas: HTMLCanvasElement) {
  if (!canvas) return;
  const host = canvas.parentElement!;
  if (!host) return;

  function rand(seed: number) {
    let t = seed + 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function paint() {
    const width = host.clientWidth || 1;
    const height = host.clientHeight || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Dense field of tiny dim dots; seeded so resize doesn't reshuffle wildly.
    // Light mode keeps the field but uses dark ink so it reads on pale paper.
    const light = document.documentElement.dataset.theme === 'light';
    const ink = light ? '18, 22, 32' : '245, 248, 255';
    // Keep stars clear of the model selector so they don't look like UI glitches.
    const clearZones: { left: number; top: number; right: number; bottom: number; }[] = [];
    const modelWrap = (document.getElementById('chatModelSelectWrap') as HTMLElement);
    if (modelWrap && !modelWrap.classList.contains('is-hidden')) {
      const hostRect = host.getBoundingClientRect();
      const rect = modelWrap.getBoundingClientRect();
      const pad = 16;
      clearZones.push({
        left: rect.left - hostRect.left - pad,
        top: rect.top - hostRect.top - pad,
        right: rect.right - hostRect.left + pad,
        bottom: rect.bottom - hostRect.top + pad,
      });
    }
    const inClearZone = (x: number, y: number) => clearZones.some((zone) =>
      x >= zone.left && x <= zone.right && y >= zone.top && y <= zone.bottom
    );
    // Sparser and dimmer than a real starfield — this is texture on the
    // canvas, not a subject. The host's CSS mask fades it out before the
    // thread column, so density only has to read in the upper area.
    const count = Math.round((width * height) / 4200);
    for (let i = 0; i < count; i++) {
      const x = rand(i * 1289 + 17) * width;
      const y = rand(i * 2657 + 91) * height;
      if (inClearZone(x, y)) continue;
      const size = rand(i * 409 + 3) < 0.86 ? 0.5 : 0.85;
      const alpha = light
        ? 0.11 + rand(i * 733 + 11) * 0.18
        : 0.09 + rand(i * 733 + 11) * 0.2;
      ctx.beginPath();
      ctx.fillStyle = 'rgba(' + ink + ', ' + alpha.toFixed(3) + ')';
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  repaintStarfield = paint;
  paint();
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(paint);
    observer.observe(host);
  } else {
    window.addEventListener('resize', paint);
  }
}

const emptyStateOrb = mountOrb(document.getElementById('orbMark') as HTMLCanvasElement, 64, {
  ink: () => {
    const tone = chatMain.dataset.backgroundTone;
    if (tone === 'dark') return 'bright';
    if (tone === 'light') return 'dark';
    return 'auto';
  },
});
repaintEmptyOrb = () => emptyStateOrb.paint();
mountStarfield((document.getElementById('starfieldCanvas') as HTMLCanvasElement));

const updateToast = (document.getElementById('updateToast') as HTMLElement);
const updateToastTitle = (document.getElementById('updateToastTitle') as HTMLElement);
const updateToastBody = (document.getElementById('updateToastBody') as HTMLElement);
const btnUpdateView = (document.getElementById('btnUpdateView') as HTMLAnchorElement);
const btnUpdateLater = (document.getElementById('btnUpdateLater') as HTMLButtonElement);
const btnUpdateDismiss = (document.getElementById('btnUpdateDismiss') as HTMLButtonElement);
const btnUpdateInstall = (document.getElementById('btnUpdateInstall') as HTMLButtonElement);
const appUpdateCurrent = (document.getElementById('appUpdateCurrent') as HTMLElement);
const appUpdateStatus = (document.getElementById('appUpdateStatus') as HTMLElement);
const btnAppUpdateCheck = (document.getElementById('btnAppUpdateCheck') as HTMLButtonElement);
const btnAppUpdateInstall = (document.getElementById('btnAppUpdateInstall') as HTMLButtonElement);
const btnAppUpdateNotes = (document.getElementById('btnAppUpdateNotes') as HTMLAnchorElement);
let updateInstallInFlight = false;
let lastAppUpdateStatus: AppUpdateStatus | null = null;

function dismissedUpdateCommit() {
  return String(settings.updateDismissed || '');
}

function dismissUpdateNotice(commit: string | undefined) {
  if (updateInstallInFlight) return;
  const tag = String(commit || '').trim();
  if (tag && settings.updateDismissed !== tag) {
    saveSettings({ ...settings, updateDismissed: tag });
  }
  hideUpdateToast();
}

function hideUpdateToast() {
  if (!updateToast) return;
  updateToast.classList.remove('is-visible', 'is-busy');
  updateToast.removeAttribute('aria-busy');
  window.setTimeout(() => {
    if (!updateToast.classList.contains('is-visible')) {
      updateToast.classList.add('is-hidden');
      updateToast.hidden = true;
    }
  }, prefersReducedMotion() ? 0 : 220);
}

function commitLabel(value: unknown) {
  const text = String(value || '');
  return /^[0-9a-f]{40}$/i.test(text) ? ('master@' + text.slice(0, 12)) : (text || 'this source build');
}

function setUpdateInstallButtons(disabled: boolean, label: string | null) {
  [btnUpdateInstall, btnAppUpdateInstall].forEach((btn) => {
    if (!btn) return;
    btn.disabled = disabled;
    if (label) btn.textContent = label;
  });
  if (btnAppUpdateCheck) btnAppUpdateCheck.disabled = disabled;
  if (btnUpdateLater) btnUpdateLater.disabled = disabled;
  if (btnUpdateDismiss) btnUpdateDismiss.disabled = disabled;
}

function renderAppUpdatePane(status: AppUpdateStatus | null | undefined) {
  const currentRaw = String(status?.current || latestState?.version || '');
  const currentLabel = commitLabel(currentRaw);
  if (appUpdateCurrent) {
    appUpdateCurrent.textContent = currentRaw ? ('Gopher ' + currentLabel) : 'Gopher';
  }
  if (btnAppUpdateNotes) {
    btnAppUpdateNotes.href = status?.commit_url || 'https://github.com/jacobzymet/gopher/commits/master';
  }
  const canInstall = Boolean(status?.can_install && status?.update_available);
  if (btnAppUpdateInstall) {
    btnAppUpdateInstall.hidden = !canInstall;
    if (!updateInstallInFlight) {
      btnAppUpdateInstall.disabled = false;
      btnAppUpdateInstall.textContent = 'Build and restart';
    }
  }
  if (!appUpdateStatus) return;
  if (updateInstallInFlight) return;
  if (!status) {
    appUpdateStatus.textContent = 'Could not check master on GitHub.';
    return;
  }
  if (status.error) {
    appUpdateStatus.textContent = String(status.error);
    return;
  }
  const latestLabel = commitLabel(status.latest);
  if (status.update_available) {
    if (canInstall) {
      appUpdateStatus.textContent = 'You’re on ' + currentLabel + '. Build ' + latestLabel + ' locally with Node.js and restart Gopher.';
    } else if (status.install_blocked) {
      appUpdateStatus.textContent = 'You’re on ' + currentLabel + '. ' + latestLabel + ' is available. ' + String(status.install_blocked);
    } else {
      appUpdateStatus.textContent = 'You’re on ' + currentLabel + '. ' + latestLabel + ' is available on GitHub.';
    }
    return;
  }
  if (status.latest) {
    appUpdateStatus.textContent = 'You’re on the current master commit (' + latestLabel + ').';
    return;
  }
  appUpdateStatus.textContent = 'The master commit could not be determined.';
}

function showUpdateToast(status: AppUpdateStatus | null | undefined) {
  if (!updateToast || !status || !status.update_available || !status.latest) return;
  if (updateInstallInFlight) return;
  if (dismissedUpdateCommit() === String(status.latest)) return;
  const latestLabel = commitLabel(status.latest);
  const currentLabel = commitLabel(status.current);
  const canInstall = Boolean(status.can_install);
  if (updateToastTitle) {
    updateToastTitle.textContent = 'Gopher ' + latestLabel;
  }
  if (updateToastBody) {
    if (canInstall) {
      updateToastBody.textContent =
        'You’re on ' + currentLabel + '. Build ' + latestLabel + ' locally with Node.js and restart Gopher.';
    } else if (status.install_blocked) {
      updateToastBody.textContent =
        'You’re on ' + currentLabel + '. ' + latestLabel + ' is available. ' + String(status.install_blocked);
    } else {
      updateToastBody.textContent =
        'You’re on ' + currentLabel + '. ' + latestLabel + ' is available on GitHub.';
    }
  }
  if (btnUpdateView && status.commit_url) {
    btnUpdateView.href = status.commit_url;
    btnUpdateView.textContent = 'View commit';
    btnUpdateView.className = canInstall ? 'btn btn-ghost' : 'btn btn-primary';
    btnUpdateView.hidden = false;
  }
  if (btnUpdateInstall) {
    btnUpdateInstall.hidden = !canInstall;
    btnUpdateInstall.disabled = false;
    btnUpdateInstall.textContent = 'Build and restart';
  }
  if (btnUpdateLater) btnUpdateLater.disabled = false;
  if (btnUpdateDismiss) btnUpdateDismiss.disabled = false;
  updateToast.dataset.latest = String(status.latest);
  updateToast.hidden = false;
  updateToast.classList.remove('is-hidden', 'is-busy');
  updateToast.removeAttribute('aria-busy');
  void updateToast.offsetWidth;
  afterNextPaint(() => updateToast.classList.add('is-visible'));
}

async function checkForAppUpdate({ force = false } = {}) {
  if (updateInstallInFlight) return lastAppUpdateStatus;
  try {
    const response = await fetch('/api/updates/check' + (force ? '?force=1' : ''));
    if (!response.ok) {
      renderAppUpdatePane(null);
      return null;
    }
    const status: AppUpdateStatus = await response.json();
    lastAppUpdateStatus = status;
    renderAppUpdatePane(status);
    if (status && status.update_available) showUpdateToast(status);
    else if (updateToast) {
      updateToast.hidden = true;
      updateToast.classList.remove('is-visible');
    }
    return status;
  } catch {
    renderAppUpdatePane(null);
    return null;
  }
}

function refreshAppUpdatePane() {
  if (lastAppUpdateStatus) renderAppUpdatePane(lastAppUpdateStatus);
  checkForAppUpdate();
}

async function installAppUpdate() {
  if (updateInstallInFlight) return;
  const canInstall = Boolean(
    (btnUpdateInstall && !btnUpdateInstall.hidden)
    || (btnAppUpdateInstall && !btnAppUpdateInstall.hidden)
  );
  if (!canInstall) return;
  updateInstallInFlight = true;
  if (updateToast) {
    updateToast.classList.add('is-busy');
    updateToast.setAttribute('aria-busy', 'true');
  }
  const installingLabel = 'Building ' + commitLabel(lastAppUpdateStatus?.latest || updateToast?.dataset?.latest) + ' locally. This may take several minutes. Gopher will restart after a successful build.';
  if (updateToastBody) updateToastBody.textContent = installingLabel;
  if (appUpdateStatus) appUpdateStatus.textContent = installingLabel;
  setUpdateInstallButtons(true, 'Building…');
  try {
    const response = await fetch('/api/updates/apply', { method: 'POST' });
    const body: RuntimeApiProblem = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || 'Could not build the update');
    }
    if (updateToastBody) updateToastBody.textContent = 'Restarting Gopher…';
    if (appUpdateStatus) appUpdateStatus.textContent = 'Restarting Gopher…';
    setUpdateInstallButtons(true, 'Restarting…');
  } catch (error) {
    updateInstallInFlight = false;
    if (updateToast) {
      updateToast.classList.remove('is-busy');
      updateToast.removeAttribute('aria-busy');
    }
    const message = (error as Error | undefined)?.message || 'Could not build the update.';
    if (updateToastBody) updateToastBody.textContent = message;
    if (appUpdateStatus) appUpdateStatus.textContent = message;
    setUpdateInstallButtons(false, 'Build and restart');
  }
}

btnUpdateLater?.addEventListener('click', () => {
  dismissUpdateNotice(updateToast?.dataset?.latest);
});
btnUpdateDismiss?.addEventListener('click', () => {
  dismissUpdateNotice(updateToast?.dataset?.latest);
});
btnUpdateInstall?.addEventListener('click', () => {
  installAppUpdate();
});
btnAppUpdateInstall?.addEventListener('click', () => {
  installAppUpdate();
});
btnAppUpdateCheck?.addEventListener('click', () => {
  if (updateInstallInFlight) return;
  if (appUpdateStatus) appUpdateStatus.textContent = 'Checking master on GitHub…';
  checkForAppUpdate({ force: true });
});

(async () => {
  await initLocalData();
  applyStoredSidebarCollapsed();
  document.documentElement.classList.add('ui-ready');
  applyStoredPrivacyMode();
  applyChatBackground(settings);
  updateGreeting();
  syncAgentButton();
  syncResearchControls();
  renderSidebar();
  await pollState();
  applyLocationRoute();
  const startupUrl = new URL(window.location.href);
  if (startupUrl.searchParams.get('settings') === 'providers' && !diskEncryptionLocked()) {
    openSettings('providers');
    startupUrl.searchParams.delete('settings');
    history.replaceState(
      { gopher: 1 },
      '',
      startupUrl.pathname + startupUrl.search + startupUrl.hash
    );
  }
  // Route rendering focuses the composer. When encrypted data is locked, put
  // focus back in the blocking unlock field after that startup work completes.
  if (diskEncryptionLocked()) focusUnlockPassphrase();
  window.addEventListener('popstate', () => {
    applyLocationRoute();
  });
  setInterval(pollState, 2000);
  loadUserSkills();
  // Soft update check after the UI settles; GitHub answers are cached server-side.
  window.setTimeout(() => { checkForAppUpdate(); }, 2500);
  setInterval(() => { checkForAppUpdate(); }, 12 * 60 * 60 * 1000);
})();
