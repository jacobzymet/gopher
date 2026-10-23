import type { JsonObject, StoredConversation, StoredMessage } from '../storage.js';

/**
 * Reading the user's other chats: list_chats, search_chats and read_chat. Only chats in the same
 * profile and project scope as the current one are visible, never incognito chats, and only the
 * visible text of messages (no hidden thinking or memory blocks).
 */

/** The parts of the chat store that retrieval reads (a ChatStore satisfies it). */
export interface StoreView {
  conversations?: StoredConversation[];
  profiles?: Array<{ id?: unknown; conversations?: StoredConversation[] }>;
  activeProfileId?: unknown;
}
export interface RetrievalSource {
  conversationId?: string;
  profileId?: string | null;
  getStore?: () => Promise<Readonly<StoreView>>;
  getPreferences?: () => Promise<Readonly<JsonObject>>;
}
export interface RetrievalScope { chats: StoredConversation[]; scope: string; profileId: string | null }
interface Paging { cursor?: unknown; limit?: unknown; query?: unknown; chat_id?: unknown; char_offset?: unknown }

const SAFE_ID = /^[a-zA-Z0-9_.-]{1,128}$/;
const XML_TAGS = 'think|thinking|analysis|global_memory_update|memory_update|bot_memory_update|group_memory_update|'
  + 'bot_hold|bot_resume|bot_dm_user|bot_group_post';
const BRACKET_TAGS = 'think|thinking|analysis|global_memory_update|memory_update|bot_memory_update|group_memory_update|'
  + 'hold|resume|dm_user|group_post';
const HIDDEN_TAGS = new RegExp(`<\\s*(\\/?)(${XML_TAGS})\\b[^>]*>|\\[\\[\\s*(\\/?)(${BRACKET_TAGS})\\s*\\]\\]`, 'gi');
/** Markers that stand alone rather than opening a block. */
const SELF_CLOSING = ['bot_hold', 'bot_resume', 'hold', 'resume'];
const READ_PAGE_BYTES = 12_000;
const READ_CHUNK_CHARS = 1600;

/** The text a user saw in a message, without thinking and memory-update blocks. */
export function visibleText(message: StoredMessage | undefined): string {
  if (message?.role !== 'user' && message?.role !== 'assistant') return '';
  const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
    ? message.content.filter(part => ['text', 'input_text',
      'output_text'].includes(String(part?.type))).map(part => part.text).join('\n')
    : '';
  let output = '', cursor = 0;
  const stack: string[] = [];
  const tags = new RegExp(HIDDEN_TAGS.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = tags.exec(content))) {
    if (!stack.length) output += content.slice(cursor, match.index);
    const name = (match[2] || match[4])!.toLowerCase();
    if ((match[1] || match[3]) === '/') { if (stack.at(-1) === name) stack.pop(); }
    else if (!SELF_CLOSING.includes(name) && !match[0].endsWith('/>')) stack.push(name);
    cursor = tags.lastIndex;
  }
  if (!stack.length) output += content.slice(cursor);
  return output.trim();
}

/** The chats visible from this conversation, or null when retrieval is off or the chat is gone or incognito. */
export async function retrievalScope(context: RetrievalSource): Promise<RetrievalScope | null> {
  if (!context.conversationId || !context.getStore) return null;
  if ((await context.getPreferences?.())?.chatRetrieval === false) return null;
  const store = await context.getStore();
  const profileId = Array.isArray(store.profiles) ? String(store.activeProfileId ?? '') || null : null;
  if (context.profileId !== undefined && context.profileId !== profileId) return null;
  const profile: { conversations?: StoredConversation[] } | undefined = profileId === null ? store
    : store.profiles?.find(item => item.id === store.activeProfileId);
  if (!profile) return null;
  const source = profile.conversations?.find(chat => chat.id === context.conversationId && !chat.incognito);
  if (!source) return null;
  const project = source.projectId || null;
  const chats = (profile.conversations || [])
    .filter(chat => typeof chat.id === 'string' && SAFE_ID.test(chat.id) && chat.id !== source.id && !chat.incognito
      && (chat.projectId || null) === project)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  return { chats, scope: project ? 'current project' : 'non-project chats in current profile', profileId };
}

function metadata(chat: StoredConversation, index?: number) {
  const id = String(chat.id);
  return {
    chat_id: id, title: String(chat.title || 'Untitled chat').replace(/[\x00-\x1f]/g, '').slice(0, 60),
    updated_at: chat.updatedAt || 0, message_index: index,
    url: `/c/${encodeURIComponent(id)}${index !== undefined ? `?message=${index}` : ''}`,
  };
}

function search(scoped: RetrievalScope, args: Paging) {
  const query = String(args.query || '').trim().toLowerCase();
  if (!query || Buffer.byteLength(query) > 500) throw new Error('Query must contain 1–500 bytes');
  const terms = query.split(/\s+/);
  const hits: Array<ReturnType<typeof metadata> & { role: unknown; excerpt: string; score: number }> = [];
  for (const chat of scoped.chats) {
    for (const [index, message] of (chat.messages || []).entries()) {
      const text = visibleText(message), lower = text.toLowerCase(), title = String(chat.title || '').toLowerCase();
      if (!text || !terms.every(term => lower.includes(term) || title.includes(term))) continue;
      const positions = terms.map(term => lower.indexOf(term)).filter(position => position >= 0);
      const offset = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 80);
      const score = (lower.includes(query) ? 4 : 0) + terms.filter(term => lower.includes(term)).length;
      hits.push({ ...metadata(chat, index), role: message.role, excerpt: text.slice(offset, offset + 600), score });
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

/** Page through one chat's visible messages within a byte budget, resuming mid-message by character offset. */
function readChat(scoped: RetrievalScope, args: Paging, cursor: number, limit: number): string {
  const chat = scoped.chats.find(item => item.id === args.chat_id);
  if (!chat) throw new Error('Chat was not found within the current scope');
  const messages = chat.messages || [];
  let offset = Math.max(0, Number(args.char_offset) || 0);
  const results: unknown[] = [];
  const page: Record<string, unknown> = { scope: scoped.scope, results, next_cursor: null };
  for (let index = cursor; index < messages.length; index++) {
    const message = messages[index]!, text = visibleText(message);
    if (!text) { offset = 0; continue; }
    const characters = Array.from(text);
    if (offset >= characters.length) { offset = 0; continue; }
    const item = { ...metadata(chat, index), role: message.role, char_offset: offset, content: '', truncated: false };
    const used = Buffer.byteLength(JSON.stringify(page)) + Buffer.byteLength(JSON.stringify(item));
    const room = READ_PAGE_BYTES - used - 128;
    const capacity = Math.min(READ_CHUNK_CHARS, Math.max(0, Math.floor(room / 6)));
    if (!capacity) { page.next_cursor = index; page.next_char_offset = offset; return JSON.stringify(page); }
    item.content = characters.slice(offset, offset + capacity).join('');
    const end = offset + Array.from(item.content).length;
    item.truncated = end < characters.length;
    results.push(item);
    if (item.truncated) { page.next_cursor = index; page.next_char_offset = end; return JSON.stringify(page); }
    offset = 0;
    if (results.length >= limit) { if (index + 1 < messages.length) page.next_cursor = index + 1; break; }
  }
  return JSON.stringify(page);
}

export async function retrieve(context: RetrievalSource, name: string, args: Paging): Promise<string> {
  const scoped = await retrievalScope(context);
  if (!scoped) throw new Error('Chat retrieval is disabled or this conversation’s scope is no longer available');
  const cursor = Math.max(0, Number(args.cursor) || 0);
  const limit = Math.max(1, Math.min(20, Number(args.limit) || (name === 'list_chats' ? 10 : 5)));
  if (name === 'read_chat') return readChat(scoped, args, cursor, limit);
  let results: unknown[], total: number;
  if (name === 'list_chats') {
    total = scoped.chats.length;
    results = scoped.chats.slice(cursor, cursor + limit).map(chat => metadata(chat));
  } else {
    const hits = search(scoped, args);
    total = hits.length;
    results = hits.slice(cursor, cursor + limit).map(({ score: _score, ...hit }) => hit);
  }
  const next = cursor + results.length < total ? cursor + results.length : null;
  return JSON.stringify({ scope: scoped.scope, results, next_cursor: next, next_char_offset: null });
}
