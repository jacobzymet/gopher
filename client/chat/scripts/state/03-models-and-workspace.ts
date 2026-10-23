function setModelHintWithProvider(prefix: string, providerLabel: string) {
  if (!modelHintEl) return;
  modelHintEl.replaceChildren(document.createTextNode(String(prefix || '')));
  const provider = String(providerLabel || '').trim();
  if (!provider) return;
  modelHintEl.appendChild(document.createTextNode(' via '));
  const protectedProvider = (document.createElement('span') as HTMLElement);
  protectedProvider.className = 'model-hint-provider';
  protectedProvider.textContent = provider;
  applyPrivacyMosaic(protectedProvider, 'model-hint-provider:' + provider);
  modelHintEl.appendChild(protectedProvider);
}
const chatModelSelect = (document.getElementById('chatModelSelect') as HTMLButtonElement);
const chatModelSelectWrap = (document.getElementById('chatModelSelectWrap') as HTMLElement);
const chatModelOriginPill = (document.getElementById('chatModelOriginPill') as HTMLElement);
const chatModelMenu = (document.getElementById('chatModelMenu') as HTMLElement);
const chatModelBackdrop = (document.getElementById('chatModelBackdrop') as HTMLButtonElement);
const chatModelCatalogMeta = (document.getElementById('chatModelCatalogMeta') as HTMLElement);
const chatModelList = (document.getElementById('chatModelList') as HTMLElement);
const chatModelSearchWrap = (document.getElementById('chatModelSearchWrap') as HTMLElement);
const chatModelSearch = (document.getElementById('chatModelSearch') as HTMLInputElement);
const chatModelSearchCount = (document.getElementById('chatModelSearchCount') as HTMLElement);
const chatModelSummary = (document.getElementById('chatModelSummary') as HTMLElement);
const chatModelEmpty = (document.getElementById('chatModelEmpty') as HTMLElement);
const RECENT_MODELS_MAX = 12;
const PINNED_MODELS_MAX = 48;
const MODEL_PIN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1z"/></svg>';
const MODEL_MARK_ICON = '<svg class="chat-model-option-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>';
let selectedRemoteModelId = '';
let selectedChatModel = ''; // Effective model for the visible chat or draft.
let draftModelId = '';
let selectedModelMissingPolls = 0;
let recentModelIds: string[] = [];
let pinnedModelIds: string[] = [];
let modelMenuOptions: ModelMenuOption[] = [];
/** Options passing the current filter — what the arrow keys actually walk. */
let modelMenuMatches: ModelMenuOption[] = [];
let modelMenuFilter = '';
let modelMenuActiveIndex = -1;

let latestState: AppState | null = null;

function normalizeModelIds(ids: unknown, limit: number): string[] {
  return [...new Set(((Array.isArray(ids) ? ids : []) as unknown[])
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => (id as string).trim()))].slice(0, limit);
}

function normalizeWorkspaceRoot(value: unknown) {
  return String(value || '').trim().slice(0, 512);
}

function sessionWorkspaceRoot() {
  const convo = conversations.find((item) => item.id === activeId);
  if (convo) return normalizeWorkspaceRoot(convo.workspaceRoot);
  return normalizeWorkspaceRoot(draftWorkspaceRoot);
}

function workspaceFolderName(root: string) {
  const path = normalizeWorkspaceRoot(root);
  if (!path) return '';
  const trimmed = path.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function setSessionWorkspaceRoot(value: string) {
  const next = normalizeWorkspaceRoot(value);
  const convo = conversations.find((item) => item.id === activeId);
  let changed = false;
  if (convo) {
    if (normalizeWorkspaceRoot(convo.workspaceRoot) !== next) {
      convo.workspaceRoot = next;
      changed = true;
      if (!convo.incognito) saveStore({ immediate: true });
    }
  } else if (normalizeWorkspaceRoot(draftWorkspaceRoot) !== next) {
    draftWorkspaceRoot = next;
    changed = true;
  }
  if (typeof renderComposerModes === 'function') renderComposerModes();
  if (typeof renderPlusMenu === 'function') renderPlusMenu();
  if (typeof onSessionWorkspaceChanged === 'function') onSessionWorkspaceChanged(changed);
  return changed;
}

function resetDraftWorkspace() {
  draftWorkspaceRoot = '';
}

function conversationModelId(convo: Conversation | null) {
  return (typeof convo?.modelId === 'string' ? convo.modelId.trim() : '')
    || (typeof settings.selectedChatModel === 'string' ? settings.selectedChatModel.trim() : '');
}

function syncConversationModel() {
  const convo = conversations.find((item) => item.id === activeId);
  const value = convo ? conversationModelId(convo) : (draftModelId || conversationModelId(null));
  selectedChatModel = typeof resolveSavedModelId === 'function' && typeof modelMenuOptions !== 'undefined'
    ? resolveSavedModelId(value, modelMenuOptions,
      typeof modelCatalogIsComplete === 'function' && modelCatalogIsComplete(latestState?.network, modelMenuOptions))
    : value;
  selectedRemoteModelId = selectedChatModel;
}

function setChatModelSelection(value: string) {
  const modelId = String(value || '').trim();
  const convo = conversations.find((item) => item.id === activeId);
  if (convo) {
    if (modelId) convo.modelId = modelId;
    else delete convo.modelId;
    convo.updatedAt = Date.now();
    saveConversations({ immediate: true });
  } else {
    draftModelId = modelId;
  }
  syncConversationModel();
}

function persistModelPickerState() {
  saveSettings({
    ...settings,
    recentModelIds: recentModelIds.slice(),
    pinnedModelIds: pinnedModelIds.slice(),
  }, { immediate: true });
}

function saveRecentModelIds(ids: unknown) {
  recentModelIds = normalizeModelIds(ids, RECENT_MODELS_MAX);
  persistModelPickerState();
}

function rememberRecentModel(value: string) {
  if (!value) return;
  saveRecentModelIds([value, ...recentModelIds.filter((id) => id !== value)]);
}

function savePinnedModelIds(ids: unknown) {
  pinnedModelIds = normalizeModelIds(ids, PINNED_MODELS_MAX);
  persistModelPickerState();
}

function isModelPinned(value: string) {
  return !!value && pinnedModelIds.includes(value);
}

function togglePinnedModel(value: string) {
  if (!value) return;
  if (isModelPinned(value)) {
    savePinnedModelIds(pinnedModelIds.filter((id) => id !== value));
  } else {
    savePinnedModelIds([value, ...pinnedModelIds.filter((id) => id !== value)]);
  }
  if (modelMenuIsOpen()) applyModelFilter({ keepActive: true });
}

function hydrateModelPickerState() {
  syncConversationModel();
  if (selectedChatModel && chatModelSelect) {
    const parts = selectedChatModel.split('|').filter(Boolean);
    chatModelSelect.textContent = parts[parts.length - 1] || 'Model';
    chatModelSelect.title = 'Restoring saved model…';
  }
  recentModelIds = normalizeModelIds(settings.recentModelIds, RECENT_MODELS_MAX);
  pinnedModelIds = normalizeModelIds(settings.pinnedModelIds, PINNED_MODELS_MAX);
}

