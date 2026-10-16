import type { ToolCall, ToolOutcome } from './index.js';
export class ResearchProgress {
  readonly queries=new Set<string>();readonly pages=new Set<string>();rounds=0;calls=0;toolRounds=0;stalledRounds=0;
  ready():boolean{return this.queries.size>=6&&this.pages.size>=4&&this.rounds>=3;}
  exhausted():boolean{return this.calls>=64||this.toolRounds>=24||this.stalledRounds>=4;}
  nextTool():string{return this.queries.size>=3&&this.pages.size<4?'fetch_url':'web_search';}
  record(results:{call:ToolCall;outcome:ToolOutcome}[]):void{
    this.toolRounds++;this.calls+=results.length;const before=this.queries.size+this.pages.size;
    for(const{call,outcome}of results){if(!outcome.ok||!outcome.text.trim())continue;if(call.name==='web_search'){let hasResults=true;try{hasResults=Boolean(JSON.parse(outcome.text).results?.length);}catch{hasResults=!outcome.text.startsWith('No results found for ');}const query=String(call.arguments.query||'').trim().replace(/\s+/g,' ').toLowerCase();if(query&&hasResults)this.queries.add(query);}if(call.name==='fetch_url'){try{const url=new URL(call.arguments.url);url.hash='';const text=JSON.parse(outcome.text).text;if(typeof text==='string'&&text.trim().length)this.pages.add(url.toString());}catch{}}}
    if(this.queries.size+this.pages.size>before){this.rounds++;this.stalledRounds=0;}else this.stalledRounds++;
  }
  note():string{
    const status=`Research evidence so far: ${this.queries.size} distinct successful searches, ${this.pages.size} pages read, ${this.rounds} research rounds.`;
    return this.exhausted()?`${status} Research budget or progress limit reached. Stop tools and synthesize available evidence now. This does NOT establish that evidence is sufficient. Disclose access failures, unverified claims and unresolved gaps. Never invent sources.`:!this.ready()?`${status} Continue investigating before the final answer: at least 6 distinct successful searches and 4 pages across 3 rounds. Next call ${this.nextTool()}. Follow new leads, read primary sources and test the strongest counterargument. Concise output requires the same research depth.`:`${status} Minimum coverage reached. Audit evidence, resolve contradictions, and verify claims supported only by snippets before finishing.`;
  }
}
