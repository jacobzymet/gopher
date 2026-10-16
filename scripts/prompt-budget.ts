import { agentPrompt, applyToolDescriptions } from '../server/tools/prompts.js';
import { toolDefinitions, type AgentSkills } from '../server/tools/index.js';
import { estimateTokens } from '../server/engine.js';

const profiles: Record<string, AgentSkills> = {
  coding: { filesystem: true, terminal: true, workspace_root: '/workspace', approval_mode: 'manual' },
  research: { web_search: true, fetch_url: true, web_search_depth: 'deep' },
  all: { filesystem: true, terminal: true, browser: true, workspace_root: '/workspace', web_search: true, fetch_url: true, web_search_depth: 'deep' },
};
for (const [name, skills] of Object.entries(profiles)) {
  const deep = name === 'research';
  const system = await agentPrompt(skills, [], deep, false, [], false);
  const tools = toolDefinitions(skills, [], deep, false);
  await applyToolDescriptions(tools, skills, deep);
  console.log(JSON.stringify({ profile: name, system_tokens: estimateTokens(system), tool_schema_tokens: estimateTokens(tools), total_tokens: estimateTokens(system) + estimateTokens(tools), tools: tools.length }));
}
