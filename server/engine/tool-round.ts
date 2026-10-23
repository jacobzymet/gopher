import { executeTool, needsApproval, risk, toolArguments, type ToolCall, type ToolContext,
  type ToolOutcome } from '../tools/index.js';
import type { LiveRun } from './live.js';

/**
 * Running one round of tool calls. Every call is announced first (so the client can show pending
 * approvals together); then calls run in batches where consecutive read-only calls share a batch
 * and anything that changes state runs alone, in order.
 */

export interface ToolResult { call: ToolCall; outcome: ToolOutcome }
export type AgentEmit = (data: Record<string, unknown>) => void;
export type Waiter = (run: LiveRun, id: string) => Promise<unknown>;
export type ToolExecutor = typeof executeTool;

const READ_ONLY = new Set([
  'read_file', 'list_dir', 'glob', 'grep', 'web_search', 'fetch_url', 'read_tool_history', 'list_chats',
    'search_chats', 'read_chat',
]);
const MAX_PARALLEL_READS = 8;
const PREVIEW_CHARS = 240;
const RESULT_CHARS = 32_000;

export function scheduleToolBatches(calls: ToolCall[]): ToolCall[][] {
  const groups: ToolCall[][] = [];
  for (const call of calls) {
    const last = groups.at(-1);
    const joinable = READ_ONLY.has(call.name) && last && last.length < MAX_PARALLEL_READS
      && last.every(item => READ_ONLY.has(item.name));
    if (joinable) last.push(call); else groups.push([call]);
  }
  return groups;
}

/** A one-line description of a call: its path, query, URL, command or name. */
export function callSummary(call: ToolCall): string {
  const args = toolArguments(call.arguments);
  return String(args.path || args.query || args.url || args.command || args.name || call.name).slice(0, PREVIEW_CHARS);
}

export function previewArguments(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return { preview: raw.slice(0, 1000) }; }
}

export function emitToolResult(agent: AgentEmit, call: ToolCall, outcome: ToolOutcome): void {
  if (call.name === 'run_terminal' || call.name === 'wait_terminal') {
    agent({
      phase: 'terminal', command: callSummary(call), output: outcome.text, ok: outcome.ok, running: outcome.running
        || false,
      session_id: outcome.command_session_id || null, source: 'agent',
    });
  }
  agent({
    phase: 'tool_result', id: call.id, name: call.name, ok: outcome.ok, running: outcome.running || false,
    command_session_id: outcome.command_session_id || null, preview: outcome.text.slice(0, PREVIEW_CHARS),
    result: outcome.text.slice(0, RESULT_CHARS), ...(outcome.note ? { note: outcome.note } : {}),
    ...(outcome.image ? { image: outcome.image } : {}), ...(outcome.image_id ? { image_id: outcome.image_id } : {}),
  });
}

const malformed = (value: unknown) =>
  !value || Array.isArray(value) || typeof value !== 'object' || '__invalid_json' in value;

interface RoundOptions {
  run: LiveRun; context: ToolContext; calls: ToolCall[]; enabled: Set<string>; agent: AgentEmit; wait: Waiter;
  execute: ToolExecutor;
}

/** Execute one call; failures become error outcomes the model can read, except cancellation. */
async function runCall({ run, context, enabled, agent, execute }: RoundOptions, call: ToolCall,
  approval: Promise<unknown> | undefined): Promise<ToolResult> {
  let outcome: ToolOutcome;
  try {
    context.signal.throwIfAborted();
    if (!enabled.has(call.name)) throw new Error(`Tool is unavailable or disabled: ${call.name}`);
    if (approval && !(await approval)) {
      throw new Error('The user denied this tool call. Continue without it; do not bypass this decision.');
    }
    if (malformed(call.arguments)) {
      throw new Error('The model returned malformed JSON arguments. Call the tool again with a JSON object.');
    }
    const summary = callSummary(call);
    agent({ phase: 'tool_executing', id: call.id, name: call.name, arguments: call.arguments, summary });
    outcome = await execute(context, call);
    context.signal.throwIfAborted();
    if (outcome.image) {
      outcome.image_id = `img_${++run.imageCount}`;
      outcome.text += `\nDisplay this image in the final reply using ![caption](${outcome.image_id}).`;
    }
  } catch (error) {
    if (context.signal.aborted) throw error;
    outcome = { ok: false, text: `Error: ${error instanceof Error ? error.message : String(error)}` };
  }
  emitToolResult(agent, call, outcome);
  return { call, outcome };
}

export async function executeCalls(options: RoundOptions): Promise<ToolResult[]> {
  const { run, context, calls, enabled, agent, wait } = options;
  const approvals = new Map<string, Promise<unknown>>();
  for (const call of calls) {
    const approval = enabled.has(call.name) && needsApproval(call.name, String(context.skills.approval_mode));
    if (approval) {
      const pending = wait(run, call.id);
      pending.catch(() => {});
      approvals.set(call.id, pending);
    }
    agent({
      phase: 'tool_call', id: call.id, name: call.name, arguments: call.arguments, needs_approval: approval,
      ...(approval ? { risk: risk(call.name), summary: callSummary(call) } : {}),
    });
  }
  const results: ToolResult[] = [];
  for (const group of scheduleToolBatches(calls)) {
    for (const call of group) {
      if (!approvals.has(call.id)) continue;
      agent({ phase: 'tool_approval', id: call.id, name: call.name, arguments: call.arguments, risk: risk(call.name),
        summary: callSummary(call) });
    }
    results.push(...await Promise.all(group.map(call => runCall(options, call, approvals.get(call.id)))));
  }
  return results;
}
