function syncEncryptionPassphraseWarning() {
  const passphraseInput = (document.getElementById('encryptionPassphrase') as HTMLInputElement);
  const confirmInput = (document.getElementById('encryptionPassphraseConfirm') as HTMLInputElement);
  const warning = (document.getElementById('encryptionPassphraseWarning') as HTMLElement);
  if (!passphraseInput || !confirmInput || !warning) return;

  const passphrase = passphraseInput.value;
  const confirm = confirmInput.value;
  const length = Array.from(passphrase).length;
  const messages = [];
  if (length > 0 && length < 16) {
    messages.push('This passphrase has ' + length + ' characters. Use at least 16 characters. You can continue with the current passphrase.');
  } else if (length > 1024) {
    messages.push('This passphrase has ' + length + ' characters. You can use it, but a shorter passphrase can be easier to enter correctly.');
  }
  if (confirm && passphrase !== confirm) {
    messages.push('The confirmation does not match.');
  }

  warning.textContent = messages.join(' ');
  warning.classList.toggle('is-hidden', messages.length === 0);
}

['encryptionPassphrase', 'encryptionPassphraseConfirm'].forEach((id) => {
  (document.getElementById(id) as HTMLElement)?.addEventListener('input', syncEncryptionPassphraseWarning);
});
(document.getElementById('btnEnableEncryption') as HTMLButtonElement)?.addEventListener('click', async () => {
  const passphrase = (document.getElementById('encryptionPassphrase') as HTMLInputElement)?.value || '';
  const confirm = (document.getElementById('encryptionPassphraseConfirm') as HTMLInputElement)?.value || '';
  const btn = (document.getElementById('btnEnableEncryption') as HTMLButtonElement);
  if (btn) btn.disabled = true;
  try {
    await postEncryption('/api/data/encryption/enable', {
      passphrase,
      passphrase_confirm: confirm,
    });
    (document.getElementById('encryptionPassphrase') as HTMLInputElement).value = '';
    (document.getElementById('encryptionPassphraseConfirm') as HTMLInputElement).value = '';
    syncEncryptionPassphraseWarning();
  } catch (error) {
    alert((error as Error).message || 'Could not enable encryption');
  } finally {
    if (btn) btn.disabled = false;
  }
});
(document.getElementById('btnUnlockEncryption') as HTMLButtonElement)?.addEventListener('click', async () => {
  const passphrase = (document.getElementById('encryptionUnlockPassphrase') as HTMLInputElement)?.value || '';
  const btn = (document.getElementById('btnUnlockEncryption') as HTMLButtonElement);
  try {
    await unlockDiskEncryption(passphrase, btn);
  } catch (error) {
    alert((error as Error).message || 'Could not unlock');
  }
});
(document.getElementById('encryptionUnlockPassphrase') as HTMLInputElement)?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    (document.getElementById('btnUnlockEncryption') as HTMLButtonElement)?.click();
  }
});
let unlockModalBusy = false;

function unlockModalIsBusy() {
  return unlockModalBusy;
}

function setUnlockPassphraseRevealed(revealed: boolean) {
  const input = (document.getElementById('unlockModalPassphrase') as HTMLInputElement);
  const btn = (document.getElementById('btnUnlockModalReveal') as HTMLButtonElement);
  if (!input || !btn) return;
  const show = !!revealed;
  input.type = show ? 'text' : 'password';
  btn.classList.toggle('is-revealed', show);
  btn.setAttribute('aria-pressed', show ? 'true' : 'false');
  btn.setAttribute('aria-label', show ? 'Hide passphrase' : 'Show passphrase');
}

function setUnlockModalLoading(loading: boolean) {
  unlockModalBusy = loading;
  const btn = (document.getElementById('btnUnlockModalSubmit') as HTMLButtonElement);
  const label = (btn?.querySelector('.unlock-button-label') as HTMLElement);
  if (label) label.textContent = loading ? 'Unlocking' : 'Unlock';
  if (btn) {
    btn.disabled = loading;
    btn.classList.toggle('is-loading', loading);
    (btn.querySelector('.button-loading-spinner') as HTMLElement)?.classList.toggle('is-hidden', !loading);
    btn.toggleAttribute('aria-busy', loading);
    btn.setAttribute('aria-label', loading ? 'Unlocking' : 'Unlock');
  }
  const input = (document.getElementById('unlockModalPassphrase') as HTMLInputElement);
  const shell = (document.getElementById('unlockPassphraseShell') as HTMLElement);
  if (input) {
    input.readOnly = loading;
    input.classList.toggle('is-sealed', loading);
  }
  shell?.classList.toggle('is-sealed', loading);
  const reveal = (document.getElementById('btnUnlockModalReveal') as HTMLButtonElement);
  if (reveal) reveal.disabled = loading;
  const dismiss = (document.getElementById('btnUnlockModalDismiss') as HTMLButtonElement);
  if (dismiss) dismiss.disabled = loading;
  const status = (document.getElementById('unlockModalStatus') as HTMLElement);
  if (status) {
    status.textContent = loading ? 'Decrypting chats and settings.' : '';
    status.classList.toggle('is-hidden', !loading);
  }
  if (loading) setUnlockModalError('');
}
(document.getElementById('btnUnlockModalSubmit') as HTMLButtonElement)?.addEventListener('click', async () => {
  const input = (document.getElementById('unlockModalPassphrase') as HTMLInputElement);
  const passphrase = input?.value || '';
  if (unlockModalBusy) return;
  setUnlockModalLoading(true);
  try {
    await unlockDiskEncryption(passphrase, null);
  } catch (error) {
    setUnlockModalError((error as Error).message || 'Could not unlock');
    setUnlockModalLoading(false);
    input?.focus();
  }
});
(document.getElementById('unlockModalPassphrase') as HTMLInputElement)?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (unlockModalBusy) return;
    (document.getElementById('btnUnlockModalSubmit') as HTMLButtonElement)?.click();
  }
});
(document.getElementById('btnUnlockModalReveal') as HTMLButtonElement)?.addEventListener('click', () => {
  if (unlockModalBusy) return;
  const input = (document.getElementById('unlockModalPassphrase') as HTMLInputElement);
  const revealed = input?.type !== 'text';
  setUnlockPassphraseRevealed(revealed);
  input?.focus();
});
(document.getElementById('btnUnlockModalDismiss') as HTMLButtonElement)?.addEventListener('click', () => {
  if (unlockModalBusy) return;
  hideUnlockSession();
});
(document.getElementById('btnLockEncryption') as HTMLButtonElement)?.addEventListener('click', async () => {
  try {
    captureComposerDraft();
    saveStore({ immediate: true });
    await storeWriteChain;
    await postEncryption('/api/data/encryption/lock', {});
    clearMemoryAfterLock();
  } catch (error) {
    alert((error as Error).message || 'Could not lock');
  }
});
(document.getElementById('btnDisableEncryption') as HTMLButtonElement)?.addEventListener('click', () => {
  (document.getElementById('settingsEncryptionDisable') as HTMLElement)?.classList.remove('is-hidden');
});
(document.getElementById('btnConfirmDisableEncryption') as HTMLButtonElement)?.addEventListener('click', async () => {
  const passphrase = (document.getElementById('encryptionDisablePassphrase') as HTMLInputElement)?.value || '';
  const btn = (document.getElementById('btnConfirmDisableEncryption') as HTMLButtonElement);
  if (btn) btn.disabled = true;
  try {
    await postEncryption('/api/data/encryption/disable', { passphrase });
    (document.getElementById('encryptionDisablePassphrase') as HTMLInputElement).value = '';
    (document.getElementById('settingsEncryptionDisable') as HTMLElement)?.classList.add('is-hidden');
  } catch (error) {
    alert((error as Error).message || 'Could not disable encryption');
  } finally {
    if (btn) btn.disabled = false;
  }
});
(document.querySelectorAll('#themeToggle [data-theme-choice]') as NodeListOf<HTMLElement>).forEach((btn) => {
  btn.addEventListener('click', () => setTheme(btn.dataset.themeChoice));
});
(document.querySelectorAll('#fontScaleToggle [data-font-scale]') as NodeListOf<HTMLElement>).forEach((btn) => {
  btn.addEventListener('click', () => patchAppearance({ font_scale: btn.dataset.fontScale }));
});
['settingFontBody', 'settingFontDisplay'].forEach((id) => {
  const el = (document.getElementById(id) as HTMLSelectElement);
  if (!el) return;
  el.addEventListener('change', () => {
    const key = id === 'settingFontBody' ? 'font_body' : 'font_display';
    patchAppearance({ [key]: el.value });
  });
});
(document.getElementById('btnAppearanceReset') as HTMLButtonElement).addEventListener('click', resetAppearance);
settingsModal.addEventListener('click', (event) => {
  if (event.target === settingsModal) closeSettings();
});
projectModal.addEventListener('click', (event) => {
  if (event.target === projectModal) closeProjectSettings();
});
document.addEventListener('click', (event) => {
  if (notificationsPopoverIsOpen()
      && !notificationsView.contains(event.target as Node | null)
      && !btnNotificationsNav.contains(event.target as Node | null)) {
    setNotificationsOpen(false);
  }
  if (profileMenuIsOpen() && !sidebarProfileMenu.contains(event.target as Node | null) && !btnProfileMenu.contains(event.target as Node | null)) {
    setProfileMenuOpen(false);
  }
  if (openConvoMenu && !openConvoMenu.contains(event.target as Node | null) && !((event.target as Element).closest('.convo-more') as HTMLElement)) {
    closeConvoMenu();
  }
});
(document.getElementById('btnConfirmModalCancel') as HTMLButtonElement)?.addEventListener('click', () => settleConfirmDanger(false));
(document.getElementById('btnConfirmModalOk') as HTMLButtonElement)?.addEventListener('click', () => settleConfirmDanger(true));
(document.getElementById('confirmModal') as HTMLElement)?.addEventListener('click', (event) => {
  if (event.target === event.currentTarget) settleConfirmDanger(false);
});
convoTitleEl.addEventListener('click', beginTopbarTitleEdit);
convoTitleEl.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && !(convoTitleEl.querySelector('input') as HTMLInputElement)) {
    event.preventDefault();
    beginTopbarTitleEdit();
  }
});
document.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === 'k') {
    event.preventDefault();
    if (searchModal && !searchModal.classList.contains('is-hidden')) closeSearchModal();
    else openSearchModal();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
    const field = event.target;
    const textField = field instanceof HTMLTextAreaElement
      || (field instanceof HTMLInputElement
        && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes((field.type || 'text').toLowerCase()));
    if (textField && (key === 'a' || key === 'c' || key === 'x')) {
      if (key === 'a') {
        event.preventDefault();
        field.select();
        return;
      }
      const start = field.selectionStart ?? 0;
      const end = field.selectionEnd ?? 0;
      if (end > start && navigator.clipboard?.writeText) {
        const selected = field.value.slice(start, end);
        event.preventDefault();
        void navigator.clipboard.writeText(selected).then(() => {
          if (key !== 'x') return;
          field.setRangeText('', start, end, 'start');
          field.dispatchEvent(new Event('input', { bubbles: true }));
        });
        return;
      }
    }
  }
  if (event.key === 'Escape') {
    if (notificationsPopoverIsOpen()) {
      setNotificationsOpen(false, { restoreFocus: true });
      return;
    }
    if (profileMenuIsOpen()) {
      setProfileMenuOpen(false, { restoreFocus: true });
      return;
    }
    const profileModal = (document.getElementById('profileModal') as HTMLElement);
    if (profileModal && !profileModal.classList.contains('is-hidden')) {
      closeProfileModal();
      return;
    }
    if (voiceListening) {
      stopVoiceInput();
      return;
    }
    if (searchModal && !searchModal.classList.contains('is-hidden')) {
      closeSearchModal();
      return;
    }
    const confirmModal = (document.getElementById('confirmModal') as HTMLElement);
    if (confirmModal && !confirmModal.classList.contains('is-hidden')) {
      settleConfirmDanger(false);
      return;
    }
    const unlockModal = (document.getElementById('unlockModal') as HTMLElement);
    if (unlockModal && !unlockModal.classList.contains('is-hidden')) {
      if (unlockModalBusy) return;
      hideUnlockSession();
      return;
    }
    if (!projectModal.classList.contains('is-hidden')) {
      closeProjectSettings();
      return;
    }
    if (!settingsModal.classList.contains('is-hidden')) {
      closeSettings();
      return;
    }
    if (!chatModelMenu.classList.contains('is-hidden')) {
      closeModelMenu({ restoreFocus: true });
      return;
    }
    if (wordmarkMenuIsOpen()) {
      setWordmarkMenuOpen(false);
      (document.getElementById('btnWordmarkSurface') as HTMLButtonElement)?.focus();
      return;
    }
    closeConvoMenu();
  }
});

chatModelSelectWrap.addEventListener('click', (event) => {
  if (((event.target as Element).closest('.chat-model-menu') as HTMLElement)) return;
  event.preventDefault();
  event.stopPropagation();
  if (modelMenuIsOpen()) {
    closeModelMenu({ restoreFocus: true });
    return;
  }
  openModelMenu();
  // openModelMenu() puts focus in the filter field when it is shown;
  // don't yank it back to the trigger.
  if (!modelSearchEnabled()) chatModelSelect.focus();
});

