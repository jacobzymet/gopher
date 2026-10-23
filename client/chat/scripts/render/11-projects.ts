function projectCardBlurb(project: Project) {
  const instructions = project.instructions.trim();
  if (instructions) return instructions;
  const memory = project.memory.trim();
  if (memory) return memory;
  return 'No instructions yet. Open the project to start chatting, or edit settings to add context.';
}

function showProjectsView() {
  if (typeof closeThreadFind === 'function') closeThreadFind({ restoreFocus: false });
  mainView = 'projects';
  cancelMessageEdit();
  closeConvoMenu();
  chatShell.classList.add('is-projects');
  chatShell.classList.remove('is-notifications');
  chatShell.classList.remove('is-in-project');
  projectsView.classList.remove('is-hidden');
  setNotificationsOpen(false);
  btnProjectsNav.classList.add('is-active');
  btnNotificationsNav.classList.remove('is-active');
  renderProjectsPage();
  renderSidebar();
  syncUrlFromState();
  closeMobileSidebar();
}

function showChatView() {
  mainView = 'chat';
  chatShell.classList.remove('is-projects', 'is-notifications');
  projectsView.classList.add('is-hidden');
  setNotificationsOpen(false);
  btnProjectsNav.classList.remove('is-active');
  btnNotificationsNav.classList.remove('is-active');
  syncProjectChrome();
  renderSidebar();
}

function renderProjectsPage() {
  const query = (projectsSearch.value || '').trim().toLowerCase();
  const sort = projectsSort.value || 'updated';
  let list = [...projects];
  if (query) {
    list = list.filter((project) => {
      const hay = (project.name + '\n' + project.instructions + '\n' + project.memory).toLowerCase();
      return hay.includes(query);
    });
  }
  if (sort === 'name') {
    list.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    list.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  projectsGrid.innerHTML = '';
  if (list.length === 0) {
    const empty = (document.createElement('div') as HTMLElement);
    empty.className = 'projects-empty';
    empty.innerHTML = query
      ? '<strong>No matches</strong>Try a different search.'
      : '<strong>No projects yet</strong>Create one to keep chats, instructions, and memory together.';
    projectsGrid.appendChild(empty);
    return;
  }

  for (const project of list) {
    const card = (document.createElement('div') as HTMLElement);
    card.className = 'project-card';
    const chatCount = conversationsForProject(project.id).length;

    const body = (document.createElement('button') as HTMLButtonElement);
    body.type = 'button';
    body.className = 'project-card-body';
    body.innerHTML =
      '<h2 class="project-card-title"></h2>' +
      '<p class="project-card-blurb"></p>' +
      '<div class="project-card-meta"><span></span><span></span></div>';
    (body.querySelector('.project-card-title') as HTMLElement).textContent = project.name;
    (body.querySelector('.project-card-blurb') as HTMLElement).textContent = projectCardBlurb(project);
    const meta = (body.querySelectorAll('.project-card-meta span') as NodeListOf<HTMLElement>);
    meta[0].textContent = formatProjectDate(project.updatedAt);
    meta[1].textContent = chatCount === 1 ? '1 chat' : chatCount + ' chats';
    body.addEventListener('click', () => openProject(project.id));

    const gear = (document.createElement('button') as HTMLButtonElement);
    gear.type = 'button';
    gear.className = 'project-card-gear';
    gear.setAttribute('aria-label', 'Project settings');
    gear.title = 'Settings';
    gear.textContent = '⚙';
    gear.addEventListener('click', (event) => {
      event.stopPropagation();
      openProjectSettings(project.id);
    });

    card.appendChild(body);
    card.appendChild(gear);
    projectsGrid.appendChild(card);
  }
}

function createProject() {
  if (!requireUnlockedData()) return;
  creatingProject = true;
  editingProjectId = null;
  (document.getElementById('projectModalTitle') as HTMLElement).textContent = 'New project';
  (document.getElementById('projectName') as HTMLInputElement).value = '';
  (document.getElementById('projectInstructions') as HTMLTextAreaElement).value = '';
  (document.getElementById('projectMemory') as HTMLTextAreaElement).value = '';
  syncProjectMemoryModeControls('default');
  (document.getElementById('btnProjectDelete') as HTMLButtonElement).classList.add('is-hidden');
  showProjectsView();
  openBackdrop(projectModal);
  (document.getElementById('projectName') as HTMLInputElement).focus();
}

function syncProjectMemoryModeControls(mode: string | null) {
  const value = PROJECT_MEMORY_MODES.includes(mode) ? mode : 'default';
  const toggle = (document.getElementById('projectMemoryModeToggle') as HTMLElement);
  if (toggle) {
    (toggle.querySelectorAll('[data-memory-mode]') as NodeListOf<HTMLButtonElement>).forEach((btn) => {
      const active: boolean = btn.getAttribute('data-memory-mode') === value;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }
  const hint = (document.getElementById('projectMemoryModeHint') as HTMLElement);
  if (hint) {
    hint.textContent = value === 'project_only'
      ? 'Project-only blocks shared memory. Past-chat retrieval, when enabled in Settings, stays inside this project.'
      : 'Default uses shared and project memory. Past-chat retrieval, when enabled in Settings, stays inside this project.';
  }
}

function selectedProjectMemoryMode() {
  const active: HTMLElement | null = (document.querySelector('#projectMemoryModeToggle [data-memory-mode].is-active') as HTMLElement);
  const mode = active && active.getAttribute('data-memory-mode');
  return PROJECT_MEMORY_MODES.includes(mode) ? mode : 'default';
}

function openProjectSettings(projectId: string | null | undefined) {
  const project = getProject(projectId);
  if (!project) return;
  creatingProject = false;
  editingProjectId = projectId!;
  (document.getElementById('projectModalTitle') as HTMLElement).textContent = 'Project';
  (document.getElementById('projectName') as HTMLInputElement).value = project.name;
  (document.getElementById('projectInstructions') as HTMLTextAreaElement).value = project.instructions;
  (document.getElementById('projectMemory') as HTMLTextAreaElement).value = project.memory;
  syncProjectMemoryModeControls(project.memoryMode || 'default');
  (document.getElementById('btnProjectDelete') as HTMLButtonElement).classList.remove('is-hidden');
  openBackdrop(projectModal);
  (document.getElementById('projectName') as HTMLInputElement).focus();
}

function closeProjectSettings() {
  closeBackdrop(projectModal);
  editingProjectId = null;
  creatingProject = false;
}

function commitProjectSettings() {
  if (!requireUnlockedData()) return;
  const name = (document.getElementById('projectName') as HTMLInputElement).value.trim() || 'Untitled project';
  const instructions = (document.getElementById('projectInstructions') as HTMLTextAreaElement).value;
  const memory = (document.getElementById('projectMemory') as HTMLTextAreaElement).value;
  const memoryMode = selectedProjectMemoryMode();
  const now = Date.now();

  if (creatingProject) {
    const project = normalizeProject({
      id: newId('p'),
      name,
      instructions,
      memory,
      memoryMode,
      createdAt: now,
      updatedAt: now,
    });
    projects.unshift(project);
    creatingProject = false;
    editingProjectId = project.id;
  } else {
    const project = getProject(editingProjectId);
    if (!project) return;
    project.name = name;
    project.instructions = instructions;
    project.memory = memory;
    project.memoryMode = memoryMode;
    project.updatedAt = now;
  }

  saveStore();
  closeProjectSettings();
  renderSidebar();
  if (mainView === 'projects') renderProjectsPage();
  updateGreeting();
}

function deleteProject(projectId: string | null | undefined) {
  if (!requireUnlockedData()) return;
  const project = getProject(projectId);
  if (!project) return;
  if (!confirm('Delete project "' + project.name + '"? Chats move back to Recents.')) return;
  if (typeof removeComposerDrafts === 'function') removeComposerDrafts({ projectIds: [projectId!] });
  conversations.forEach((convo) => {
    if (convo.projectId === projectId) convo.projectId = null;
  });
  projects = projects.filter((item) => item.id !== projectId);
  if (activeProjectId === projectId) activeProjectId = null;
  saveStore();
  closeProjectSettings();
  renderSidebar();
  if (mainView === 'projects') renderProjectsPage();
  else {
    showChatView();
    startDraft();
  }
  updateGreeting();
}

function openProject(projectId: string | null | undefined, { incognito = false } = {}) {
  const project = getProject(projectId);
  if (!project) return;
  if (typeof leaveComposerDraft === 'function') leaveComposerDraft();
  activeProjectId = projectId!;
  cancelMessageEdit();
  activeId = null;
  draftModelId = '';
  syncConversationModel();
  draftIncognito = !!incognito;
  if (latestState) updateInferenceState(latestState);
  showChatView();
  showEmptyState();
  renderSidebar();
  syncUrlFromState();
  closeMobileSidebar();
  if (typeof restoreComposerDraft === 'function') restoreComposerDraft();
  composerInput.focus();
}

