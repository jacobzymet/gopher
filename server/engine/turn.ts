import { randomUUID } from 'node:crypto';
import type { StoreView } from '../tools/retrieval.js';
import type { ChatMessage, CompletionPayload, ModelOption, Provider, ProviderEvent, Providers,
  ToolDefinition } from '../providers.js';
import { skillsCatalog, type UserSkill } from '../skills.js';
import { canonicalToolName, retrievalScope, toolDefinitions, type ToolCall, type ToolContext,
  type ToolOutcome } from '../tools/index.js';
import { agentPrompt, applyToolDescriptions } from '../tools/prompts.js';
import { ResearchProgress } from '../tools/research.js';
import { applyThinkingControl } from '../tools/capabilities.js';
import { PageCache } from '../tools/web.js';
import type { JsonObject } from '../storage.js';
import { record } from '../diagnostics.js';
import { archiveRecord, compactChatMessages, compactMessages, contextWindow, messageBudget } from './context.js';
import { TextRouter } from './text-router.js';
import { normalizeUsage } from '../providers/usage.js';
import { delta, sse, type LiveRun } from './live.js';
import { emitToolResult, executeCalls, previewArguments, type AgentEmit, type ToolExecutor, type ToolResult,
  type Waiter } from './tool-round.js';
import type { AgentSkills, ChatRequest } from './request.js';

/** One agent or chat turn: prompt assembly, the model/tool loop, steering, research and retries. */

export interface TurnDependencies {
  providers: Providers;
  getStore?: () => Promise<Readonly<StoreView>>;
  getPreferences?: () => Promise<Readonly<JsonObject>>;
  getSkills?: () => Promise<UserSkill[]>;
  execute: ToolExecutor;
  agent: AgentEmit;
  emit: (frame: string) => void;
  waitApproval: Waiter;
  waitClarification: Waiter;
  /** Make the turn steerable through its steer id. */
  registerSteer: () => void;
}

const TURN_TIMEOUT_MS = 3600_000;
const MAX_RAW_TEXT = 16 * 1024 * 1024;
const MAX_TOOL_ARGUMENTS = 2 * 1024 * 1024;
const MAX_TOOL_INDEX = 128;
const MAX_CALLS_PER_ROUND = 128;
const MANY_TOOLS_NOTICE = 25;
const MAX_BLANK_RETRIES = 2;
const MAX_FINAL_TOOL_RETRIES = 4;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface PendingCall { id: string; wire_id: string; name: string; raw: string }
interface RoundOutput { visible: string; reasoning: string; rawText: string; calls: ToolCall[] }

export class AgentTurn {
  private readonly signal: AbortSignal;
  private skills: AgentSkills = {};
  private userSkills: UserSkill[] = [];
  private context!: ToolContext;
  private useTools = false;
  private definitions: ToolDefinition[] = [];
  private enabled = new Set<string>();
  private messages: ChatMessage[] = [];
  private catalogModel: ModelOption | undefined;
  private windowTokens = 0;
  private force = new Set<string>();
  private clarifyPending = false;
  private blankRetries = 0;
  private stallRetries = 0;
  private finalToolRetries = 0;
  private toolCount = 0;
  private noticeSent = false;
  private finalNotice = false;
  private firstContent = true;
  private firstReasoning = true;
  private rounds = 0;
  private readonly research = new ResearchProgress();

  constructor(private readonly run: LiveRun, private readonly request: ChatRequest,
    private readonly provider: Provider, private readonly deps: TurnDependencies) {
    this.signal = run.signal;
  }

  private get deepResearch(): boolean { return Boolean(this.request.deep_research); }

  async execute(): Promise<void> {
    await this.prepare();
    while (true) {
      const finished = await this.round();
      if (finished) return;
    }
  }

  // ------------------------------------------------------------------ preparation

  private configureSkills(): void {
    this.skills = { chat_retrieval: true, approval_mode: 'auto_safe', ...this.request.skills };
    if (!this.deepResearch) return;
    Object.assign(this.skills, { web_search: true, fetch_url: true, web_search_depth: 'deep' });
    this.skills.web_search_max_results = Math.max(10, Number(this.skills.web_search_max_results) || 0);
  }

  private async clarify(questions: unknown[]): Promise<unknown> {
    const id = `clarify_${randomUUID()}`;
    const answer = this.deps.waitClarification(this.run, id);
    this.deps.agent({ phase: 'clarify', id, questions });
    this.deps.agent({ phase: 'status', message: 'Waiting for your answers…' });
    const answers = await answer;
    this.deps.agent({ phase: 'clarify_done', id, answers, summary: JSON.stringify(answers) });
    return answers;
  }

  private async prepare(): Promise<void> {
    const { request, deps, run } = this;
    this.configureSkills();
    this.userSkills = (await deps.getSkills?.() || []).filter(skill => skill.enabled);
    this.signal.throwIfAborted();
    this.context = {
      id: run.info.conversation_id, conversationId: request.conversation_id, skills: this.skills,
        userSkills: this.userSkills,
      signal: this.signal, history: run.history, pages: new PageCache(), getStore: deps.getStore,
        getPreferences: deps.getPreferences,
      clarify: questions => this.clarify(questions),
    };
    const retrieval = this.skills.chat_retrieval !== false
      ? await retrievalScope(this.context).catch(() => null) : null;
    if (retrieval) this.context.profileId = retrieval.profileId;
    const skills = this.skills;
    this.useTools = Boolean(request.agent || request.deep_research || skills.web_search || skills.fetch_url
      || skills.filesystem || skills.terminal || skills.browser || retrieval || this.userSkills.length);
    this.definitions = this.useTools
      ? toolDefinitions(skills, this.userSkills, this.deepResearch, Boolean(retrieval)) : [];
    await applyToolDescriptions(this.definitions, skills, this.deepResearch);
    this.enabled = new Set(this.definitions.map(tool => tool.function.name));
    this.messages = structuredClone(request.messages);
    await this.addSystemPrompt(Boolean(retrieval));
    if (this.useTools) {
      deps.agent({ phase: 'status', message: this.deepResearch ? 'Deep research' : 'Agent mode' });
      deps.registerSteer();
      deps.agent({ phase: 'steer_ready', id: run.steerId });
    }
    const catalog = await deps.providers.catalog().catch((): ModelOption[] => []);
    this.catalogModel = catalog.find(model => model.provider_id === this.provider.id && model.model === request.model);
    this.windowTokens = contextWindow(request, this.provider, this.catalogModel);
    applyThinkingControl(request, this.catalogModel);
    this.force = new Set((request.force_tools || []).filter(name => this.enabled.has(name)));
    this.clarifyPending = this.deepResearch;
  }

  /** The agent prompt (or just the skill catalog) is appended to the first system message. */
  private async addSystemPrompt(retrieval: boolean): Promise<void> {
    const { request } = this;
    let system = skillsCatalog(this.userSkills);
    if (this.useTools) {
      system = await agentPrompt(this.skills, this.userSkills, this.deepResearch,
        request.deep_research_output === 'brief', request.force_tools || [], retrieval);
    }
    if (!system) return;
    const first = this.messages[0];
    if (first?.role === 'system' && typeof first.content === 'string') first.content += `\n\n${system}`;
    else this.messages.unshift({ role: 'system', content: system });
  }

  // ------------------------------------------------------------------ one round

  private applySteers(): void {
    for (const steer of this.run.steers.splice(0)) {
      this.messages.push({ role: 'user', content: `[USER STEER]\n${steer.text}` });
      this.deps.agent({ phase: 'steer', content: steer.text,
        ...(steer.client_id ? { client_id: steer.client_id } : {}) });
    }
  }

  private compact(): void {
    const { request } = this;
    const compacted = this.useTools
      ? compactMessages(this.messages, this.windowTokens, this.run.history, this.definitions)
      : this.catalogModel?.context_length || request.context_window_tokens
        ? compactChatMessages(this.messages, this.windowTokens)
        : { messages: this.messages, compacted: false };
    this.messages = compacted.messages;
    if (!compacted.compacted) return;
    const message = this.useTools
      ? 'Older tool activity was archived to stay within the context budget. Instructions were preserved.'
      : 'Earlier conversation was compacted. The complete transcript remains saved in the chat.';
    this.deps.agent({ phase: 'notice', message });
  }

  private statusMessage(): string {
    if (this.clarifyPending) return 'Refining research goal…';
    if (this.deepResearch) return 'Researching and verifying sources…';
    return this.rounds === 1 ? 'Waiting for model…' : 'Continuing…';
  }

  /** The payload for this round, with the tool it must call (if any). Deep research enforces its plan here. */
  private buildPayload(): { payload: CompletionPayload; forceFinal: boolean } {
    let forced = this.clarifyPending ? 'ask_user' : [...this.force][0];
    const forceFinal = this.deepResearch && !this.clarifyPending && this.research.exhausted();
    if (this.deepResearch && !this.clarifyPending && !forced && !forceFinal
      && !this.research.ready()) forced = this.research.nextTool();
    if (forceFinal && !this.finalNotice) {
      this.messages.push({ role: 'user', content: this.research.note() });
      this.finalNotice = true;
    }
    const payload: CompletionPayload = { ...this.request, messages: this.messages, stream: true };
    if (this.definitions.length) {
      payload.tools = this.definitions;
      payload.tool_choice = forced ? { type: 'function', function: { name: forced } } : 'auto';
    }
    // The final research answer is written without any tools.
    if (forceFinal) { delete payload.tools; delete payload.tool_choice; }
    return { payload, forceFinal };
  }

  private textRouter(output: RoundOutput): TextRouter {
    return new TextRouter((text, isReasoning) => {
      if (!text) return;
      if (isReasoning) {
        output.reasoning += text;
        if (this.firstReasoning) { record('server.first_reasoning_token', {}); this.firstReasoning = false; }
      } else {
        output.visible += text;
        if (this.firstContent) { record('server.first_content_token', {}); this.firstContent = false; }
      }
      this.deps.emit(delta(text, isReasoning));
    });
  }

  private collectToolDelta(pending: Map<number, PendingCall>, event: Extract<ProviderEvent, { type: 'tool' }>): void {
    const index = event.index || 0;
    if (index < 0 || index > MAX_TOOL_INDEX) throw new Error('Invalid tool call index');
    const entry = pending.get(index) || { id: `tool_${randomUUID()}`, wire_id: event.id || `call_${randomUUID()}`,
      name: '', raw: '' };
    if (event.id) entry.wire_id = event.id;
    if (event.name) entry.name += event.name;
    if (event.arguments) entry.raw += event.arguments;
    if (entry.raw.length > MAX_TOOL_ARGUMENTS) throw new Error('Tool arguments exceed 2 MB');
    pending.set(index, entry);
    if (entry.name) this.deps.agent({ phase: 'tool_prepare', id: entry.id, name: entry.name,
      arguments: previewArguments(entry.raw) });
  }

  private emitUsage(usage: Extract<ProviderEvent, { type: 'usage' }>['usage']): void {
    this.deps.emit(sse(null, { choices: [], usage: normalizeUsage(usage) }));
  }

  /** Stream one model reply. Returns null when a stalled stream should be retried. */
  private async streamReply(payload: CompletionPayload): Promise<RoundOutput | null> {
    const output: RoundOutput = { visible: '', reasoning: '', rawText: '', calls: [] };
    const pending = new Map<number, PendingCall>();
    const router = this.textRouter(output);
    let native = false;
    try {
      const signal = AbortSignal.any([this.signal, AbortSignal.timeout(TURN_TIMEOUT_MS)]);
      for await (const event of this.deps.providers.complete(this.provider, payload, signal)) {
        this.signal.throwIfAborted();
        if (event.type === 'text') {
          output.rawText += event.text || '';
          if (Buffer.byteLength(output.rawText) > MAX_RAW_TEXT) throw new Error('Model response exceeds 16 MB');
          router.push(event.text || '');
        } else if (event.type === 'reasoning') {
          output.reasoning += event.text || '';
          if (event.text
            && this.firstReasoning) { record('server.first_reasoning_token', {}); this.firstReasoning = false; }
          this.deps.emit(delta(event.text || '', true));
        } else if (event.type === 'tool') { native = true; this.collectToolDelta(pending, event); }
        else if (event.type === 'usage') this.emitUsage(event.usage || {});
        else if (event.type === 'progress') this.deps.agent({ phase: 'prompt_progress', ...event.data });
      }
    } catch (error) {
      const stalled = (error as { code?: unknown })?.code === 'provider_stalled';
      if (!this.signal.aborted && stalled && this.stallRetries++ < 1) {
        this.deps.agent({ phase: 'content_clear', ...(output.reasoning ? { reasoning: output.reasoning } : {}) });
        this.deps.agent({ phase: 'notice', message: 'The model stalled; retrying that step.' });
        return null;
      }
      throw error;
    }
    this.stallRetries = 0;
    router.push('', true);
    output.calls = native ? this.nativeCalls(pending) : this.useTools ? this.inlineCalls(output.rawText) : [];
    return output;
  }

  private nativeCalls(pending: Map<number, PendingCall>): ToolCall[] {
    return [...pending.values()].map(entry => {
      let args: unknown;
      try { args = JSON.parse(entry.raw || '{}'); } catch { args = { __invalid_json: entry.raw }; }
      return { id: entry.id, wire_id: entry.wire_id, name: canonicalToolName(entry.name), arguments: args };
    });
  }

  /** Models without native tool calling write <tool_call>{json}</tool_call> in their text. */
  private inlineCalls(rawText: string): ToolCall[] {
    const calls: ToolCall[] = [];
    for (const match of rawText.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
      try {
        type InlineCall = { name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } };
        const value = JSON.parse(match[1]!) as InlineCall;
        const name = value.name || value.function?.name;
        const args = value.arguments || value.function?.arguments || {};
        if (name) calls.push({ id: `tool_${randomUUID()}`, name: canonicalToolName(name),
          arguments: typeof args === 'string' ? JSON.parse(args) : args });
      } catch { /* Not a tool call; it stays hidden like any other tool-call markup. */ }
    }
    return calls;
  }

  /** A reply without tool calls: finish, or push the model to continue. Returns true when the turn is done. */
  private finishOrNudge(output: RoundOutput, forceFinal: boolean): boolean {
    const { visible, reasoning } = output;
    if (this.run.steers.length) {
      if (visible) this.messages.push({ role: 'assistant', content: visible });
      return false;
    }
    const researchIncomplete = this.deepResearch && !forceFinal && !this.research.ready();
    const required = [...this.force].join(', ');
    if (this.force.size || this.clarifyPending || researchIncomplete || (!visible.trim() && this.useTools)) {
      if (this.blankRetries++ >= MAX_BLANK_RETRIES) {
        throw new Error(this.clarifyPending ? 'Deep research did not ask clarifying questions before answering.'
          : researchIncomplete ? 'Research model did not complete the required searches and source reading.'
            : this.force.size
              ? `Agent did not use required tools: ${required}.` : 'Agent produced no user-visible answer.');
      }
      this.deps.agent({ phase: 'content_clear' });
      const nudge = this.clarifyPending ? 'Use ask_user now to clarify the research goal.'
        : this.force.size ? `Use the required tool now: ${required}.`
          : researchIncomplete
            ? this.research.note() : 'Please provide a visible answer or continue using tools to finish the task.';
      this.messages.push({ role: 'assistant', content: visible || reasoning || '' }, { role: 'user', content: nudge });
      return false;
    }
    if (!visible.trim() && reasoning.trim() && this.useTools) {
      throw new Error('The model returned reasoning without a visible answer. Try again or choose another model.');
    }
    this.deps.emit(sse(null, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
    return true;
  }

  private refuseAll(calls: ToolCall[], text: string): ToolResult[] {
    const results = calls.map(call => ({ call, outcome: { ok: false, text } as ToolOutcome }));
    for (const { call, outcome } of results) emitToolResult(this.deps.agent, call, outcome);
    return results;
  }

  /** Deep research clarifies first: only ask_user runs in a round that calls it. */
  private async askUser(ask: ToolCall, calls: ToolCall[]): Promise<ToolResult[]> {
    let outcome: ToolOutcome;
    try { outcome = await this.deps.execute(this.context, ask); }
    catch (error) {
      if (this.signal.aborted) throw error;
      outcome = { ok: false, text: errorText(error) };
    }
    if (outcome.ok) { this.clarifyPending = false; this.force.add('web_search'); }
    const later: ToolOutcome = { ok: false,
      text: 'Clarifying questions were asked this turn. Call this tool again after the user answers.' };
    const results = calls.map(call => ({ call, outcome: call === ask ? outcome : later }));
    for (const result of results) emitToolResult(this.deps.agent, result.call, result.outcome);
    return results;
  }

  private async runTools(output: RoundOutput, forceFinal: boolean): Promise<void> {
    const { calls, visible, reasoning } = output;
    this.blankRetries = 0;
    if (calls.length > MAX_CALLS_PER_ROUND) throw new Error('Model returned too many tool calls in one round');
    this.toolCount += calls.length;
    this.deps.agent({ phase: 'content_clear', ...(visible.trim() ? { text: visible } : {}),
      ...(reasoning.trim() ? { reasoning } : {}) });
    if (this.toolCount >= MANY_TOOLS_NOTICE && !this.noticeSent) {
      this.noticeSent = true;
      this.deps.agent({ phase: 'notice',
        message: 'The agent has used many tools. You can steer it or stop this response at any time.' });
    }
    const toolCalls = calls.map(call => ({ id: call.wire_id || call.id, type: 'function' as const,
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
    this.messages.push({ role: 'assistant', content: visible || null,
      ...(reasoning ? { reasoning_content: reasoning } : {}), tool_calls: toolCalls });
    const ask = this.enabled.has('ask_user') ? calls.find(call => call.name === 'ask_user') : undefined;
    let results: ToolResult[];
    if (ask) results = await this.askUser(ask, calls);
    else if (this.clarifyPending || forceFinal) {
      const reason = this.clarifyPending ? 'Deep research requires ask_user first before searching or fetching.'
        : 'The research budget has been reached. Stop calling tools and write the final answer using '
          + 'collected evidence.';
      results = this.refuseAll(calls, reason);
      if (forceFinal && this.finalToolRetries++ >= MAX_FINAL_TOOL_RETRIES) {
        throw new Error('Research model kept calling tools instead of writing its final answer.');
      }
    } else {
      results = await executeCalls({
        run: this.run, context: this.context, calls, enabled: this.enabled, agent: this.deps.agent,
        wait: this.deps.waitApproval, execute: this.deps.execute,
      });
    }
    this.recordResults(results);
    if (this.deepResearch && !ask) {
      this.research.record(results);
      this.deps.agent({ phase: 'status',
        message: `Researching · ${this.research.queries.size} searches · ${this.research.pages.size} pages read` });
    }
  }

  /** Results go back to the model, long ones truncated with a pointer to the full archived text. */
  private recordResults(results: ToolResult[]): void {
    for (const { call, outcome } of results) {
      if (outcome.ok) this.force.delete(call.name);
      const historyId = archiveRecord(this.run.history,
        { name: call.name, arguments: call.arguments, text: outcome.text });
      const max = Math.max(1024, Math.min(32_000, Math.floor(messageBudget(this.windowTokens, this.definitions) / 3)));
      const text = outcome.text.length > max
        ? `${outcome.text.slice(0,
          max)}\n[Output truncated; full output archived as ${historyId}. Use read_tool_history to continue.]`
        : outcome.text;
      this.messages.push({ role: 'tool', tool_call_id: call.wire_id || call.id, name: call.name, content: text });
    }
    for (const { call, outcome } of results) {
      if (!outcome.image) continue;
      this.messages.push({
        role: 'user',
        content: [{ type: 'text', text: `Image returned by ${call.name} (${outcome.image_id})` }, { type: 'image_url',
          image_url: { url: outcome.image } }],
      });
    }
  }

  /** One model call and whatever it asks for. Returns true when the turn has finished. */
  private async round(): Promise<boolean> {
    this.signal.throwIfAborted();
    this.rounds++;
    this.applySteers();
    this.compact();
    if (this.useTools) this.deps.agent({ phase: 'status', message: this.statusMessage() });
    const { payload, forceFinal } = this.buildPayload();
    const output = await this.streamReply(payload);
    if (!output) return false;
    if (!this.useTools || !output.calls.length) return this.finishOrNudge(output, forceFinal);
    await this.runTools(output, forceFinal);
    return false;
  }
}
