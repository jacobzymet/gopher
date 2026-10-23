/** Shared arrow/Enter/Escape handling for the trigger and the filter field. */
function handleModelMenuKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  const open = modelMenuIsOpen();
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!open) {
      openModelMenu();
      return;
    }
    const count = visibleModelMenuOptions().length;
    if (!count) return;
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const from = modelMenuActiveIndex < 0 ? (delta > 0 ? -1 : 0) : modelMenuActiveIndex;
    modelMenuActiveIndex = (from + delta + count) % count;
    paintModelMenuActive();
  } else if (event.key === 'Home' || event.key === 'End') {
    if (event.target === chatModelSearch) return;
    if (!open || !visibleModelMenuOptions().length) return;
    event.preventDefault();
    modelMenuActiveIndex = event.key === 'Home' ? 0 : visibleModelMenuOptions().length - 1;
    paintModelMenuActive();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (!open) {
      openModelMenu();
      return;
    }
    const choice = visibleModelMenuOptions()[modelMenuActiveIndex];
    if (choice) chooseModelOption(choice.value);
  } else if (event.key === ' ' && event.target === modelMenuTriggerEl()) {
    // Space only toggles from the button; inside the field it is a query character.
    event.preventDefault();
    if (!open) openModelMenu();
  } else if (event.key === 'Escape' && open) {
    event.preventDefault();
    event.stopPropagation();
    if (event.target === chatModelSearch && modelFilterTerms().length) {
      modelMenuFilter = '';
      chatModelSearch.value = '';
      applyModelFilter();
      return;
    }
    closeModelMenu({ restoreFocus: true });
  }
}

chatModelSelect.addEventListener('keydown', handleModelMenuKeydown);
chatModelSearch.addEventListener('keydown', handleModelMenuKeydown);
chatModelSearch.addEventListener('input', () => {
  modelMenuFilter = chatModelSearch.value;
  applyModelFilter();
});
// Clicking the field must not fall through to the wrap's toggle handler.
chatModelSearchWrap.addEventListener('click', (event) => {
  event.stopPropagation();
  chatModelSearch.focus();
});
chatModelBackdrop?.addEventListener('click', () => closeModelMenu({ restoreFocus: true }));
(document.getElementById('btnModelMenuClose') as HTMLButtonElement)?.addEventListener('click', () => closeModelMenu({ restoreFocus: true }));
(document.getElementById('btnModelUseDefault') as HTMLButtonElement)?.addEventListener('click', () => chooseModelOption('@default'));
(document.getElementById('btnModelClose') as HTMLButtonElement)?.addEventListener('click', () => closeModelMenu({ restoreFocus: true }));
(document.getElementById('btnModelProviders') as HTMLButtonElement)?.addEventListener('click', () => {
  closeModelMenu();
  openSettings('providers');
});
chatModelMenu.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const focusable = [...(chatModelMenu.querySelectorAll(
    'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"])'
  ) as NodeListOf<HTMLInputElement>)].filter((element) => element.getClientRects().length > 0);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

chatModelMenu.addEventListener('click', (event) => {
  const fold = ((event.target as Element).closest('[data-provider-fold]') as HTMLElement);
  if (fold) {
    event.preventDefault();
    event.stopPropagation();
    toggleProviderFold(fold.getAttribute('data-provider-fold') || '');
    return;
  }

  const pin = ((event.target as Element).closest('[data-model-pin]') as HTMLElement);
  if (pin) {
    event.preventDefault();
    event.stopPropagation();
    const value = pin.getAttribute('data-model-pin') || '';
    const before = [...(chatModelList.querySelectorAll('[data-model-pin]') as NodeListOf<HTMLElement>)];
    const index = before.indexOf(pin);
    togglePinnedModel(value);
    const after = [...(chatModelList.querySelectorAll('[data-model-pin]') as NodeListOf<HTMLElement>)];
    const same = after.find((item) => item.getAttribute('data-model-pin') === value);
        const fallback = chatModelSearch;
    (same || after[Math.min(Math.max(index, 0), after.length - 1)] || fallback)?.focus();
    return;
  }
  const pick = ((event.target as Element).closest('[data-model-pick]') as HTMLElement);
  const row = ((event.target as Element).closest('.chat-model-option') as HTMLElement);
  const value = pick?.getAttribute('data-model-pick')
    || row?.getAttribute('data-value')
    || '';
  if (!value) return;
  event.preventDefault();
  event.stopPropagation();
  chooseModelOption(value);
});
chatModelMenu.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  closeModelMenu({ restoreFocus: true });
});
document.addEventListener('click', (event) => {
  if (!modelMenuIsOpen()) return;
  if (chatModelSelectWrap.contains(event.target as Node | null)) return;
  if (modelMenuAnchorEl()?.contains(event.target as Node | null)) return;
  if (chatModelMenu.contains(event.target as Node | null)) return;
  // Confirmations raised from inside the menu sit above it.
  if (((event.target as Element).closest('#confirmModal') as HTMLElement)) return;
  closeModelMenu();
});
function repositionOpenModelMenu() {
  if (modelMenuIsOpen()) positionModelMenu();
}
window.addEventListener('resize', repositionOpenModelMenu);
document.addEventListener('scroll', repositionOpenModelMenu, true);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', repositionOpenModelMenu);
  window.visualViewport.addEventListener('scroll', repositionOpenModelMenu);
}
composerInput.addEventListener('input', () => {
  if (voiceListening) stopVoiceInput({ silent: true });
  mentionInput = composerInput;
  promoteTypedMentions();
  autoResize(composerInput);
  updateSendEnabled();
  updateMentionMenu(composerInput);
});
composerInput.addEventListener('click', () => updateMentionMenu(composerInput));
composerInput.addEventListener('keyup', (event) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    updateMentionMenu(composerInput);
  }
});
composerInput.addEventListener('blur', () => {
  // Delay so mousedown on a menu option can fire first.
  setTimeout(() => {
    if (document.activeElement !== composerInput) closeMentionMenu();
  }, 120);
});
composerInput.addEventListener('keydown', (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  mentionInput = composerInput;
  if (handleMentionKeydown(event)) return;

  if (event.key !== 'Enter') return;
  if (settings.enterSends) {
    if (!event.shiftKey) {
      event.preventDefault();
      if (!btnSend.disabled) sendMessage();
    }
  } else if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
    event.preventDefault();
    if (!btnSend.disabled) sendMessage();
  }
});

