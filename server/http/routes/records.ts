import type { SkillUpsert, UserSkill } from '../../skills.js';
import type { DiagnosticInput } from '../../diagnostics.js';
import { HttpError, sendJson } from '../protocol.js';
import { objectBody, optionalText, text } from '../guards.js';
import { route, type Route, type RouteContext } from '../router.js';

/** Custom skills and the diagnostics log. */

const MAX_DIAGNOSTIC_BATCH = 64;

/** A skill as the client lists it, with its length in characters. */
const publicSkill = (skill: UserSkill) => ({ ...skill, content_chars: [...String(skill.content || '')].length });

async function skillList({ runtime, response }: RouteContext): Promise<void> {
  sendJson(response, { skills: (await runtime.storage.listSkills()).map(publicSkill) });
}

function postDiagnostics({ runtime, body: raw, response }: RouteContext): void {
  const body = objectBody(raw), diagnostics = runtime.storage.diagnostics;
  if (!Array.isArray(body.entries) || body.entries.length > MAX_DIAGNOSTIC_BATCH) {
    throw new HttpError(400, `At most ${MAX_DIAGNOSTIC_BATCH} diagnostic entries per batch.`);
  }
  if (body.generation !== diagnostics.generation) throw new HttpError(409, 'Diagnostics session changed.');
  for (const entry of body.entries as unknown[]) {
    const valid = entry && typeof entry === 'object' && !Array.isArray(entry);
    if (valid) diagnostics.push('browser', entry as DiagnosticInput);
  }
  sendJson(response, null, 204);
}

export const recordRoutes: Route[] = [
  route('GET', '/api/skills', skillList),
  route('POST', '/api/skills', async ({ runtime, body, response }) => {
    sendJson(response, publicSkill(await runtime.storage.createSkill(objectBody(body) as SkillUpsert)));
  }),
  route('POST', '/api/skills/import', async ({ runtime, body: raw, response }) => {
    const body = objectBody(raw);
    const skill = await runtime.storage.importSkill(optionalText(body, 'filename'), text(body, 'content'));
    sendJson(response, publicSkill(skill));
  }),
  route('PATCH', /^\/api\/skills\/([^/]+)$/, async ({ runtime, body, response }, match) => {
    sendJson(response, publicSkill(await runtime.storage.updateSkill(match![1]!, objectBody(body) as SkillUpsert)));
  }),
  route('DELETE', /^\/api\/skills\/([^/]+)$/, async (context, match) => {
    await context.runtime.storage.deleteSkill(match![1]!);
    await skillList(context);
  }),
  route('GET', '/api/diagnostics', ({ runtime, url, response }) => {
    const storage = runtime.storage;
    const view = storage.diagnostics.view(Number(url.searchParams.get('after')) || 0);
    sendJson(response, { ...view, persisted: storage.encrypted && storage.unlocked });
  }),
  route('POST', '/api/diagnostics', postDiagnostics),
  route('DELETE', '/api/diagnostics', async ({ runtime, response }) => {
    await runtime.storage.clearDiagnostics();
    sendJson(response, runtime.storage.diagnostics.view(0));
  }),
];
