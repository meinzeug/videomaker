export type NewsSource={title:string;url:string;source:string;date:string;description:string};
export type ResearchSource={title:string;url:string;publisher:string;date:string};
export type Finding={claim:string;assessment:'belegt'|'umstritten'|'offen';explanation:string;source_urls:string[]};
export type Hypothesis={question:string;indications:string;alternative:string;limitations:string;source_urls:string[]};
export type ResearchReport={search_requests:number;summary:string;sources:ResearchSource[];findings:Finding[];hypotheses:Hypothesis[];open_questions:string[];source_mode?:'selected'|'web';source_access?:Array<{url:string;status:'retrieved'|'unavailable';truncated:boolean}>};
const text=(value:unknown,max:number)=>typeof value==='string'?value.trim().slice(0,max):'';
/** Fragments are not sent in HTTP requests; query parameters remain intact. */
export function canonicalSourceUrl(value:unknown){try{if(typeof value!=='string'||value.length>2000)return '';const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||!u.hostname)return '';u.hash='';return u.href;}catch{return '';}}
function url(value:unknown){try{const valueUrl=canonicalSourceUrl(value);if(!valueUrl)return '';const u=new URL(valueUrl);return u.hostname.includes('.')&&u.pathname!=='/'?u.href:'';}catch{return '';}}
export function normalizeSources(value:unknown,minimum=2):NewsSource[]|null {
 if(!Array.isArray(value)||value.length<minimum||value.length>3)return null;
 const result:NewsSource[]=[];
 for(const s of value){if(!s || typeof s.title!=='string'||!s.title.trim()||s.title.length>500)return null;const link=url(s.url);if(!link||link.length>1000)return null;result.push({title:text(s.title,500),url:link,source:text(s.source,100),date:text(s.date,100),description:text(s.description,800)});}
 return result;
}
function canonical(value:string){try{const u=new URL(value);return `${u.origin}${u.pathname.replace(/\/$/,'')}${u.search}`;}catch{return '';}}
export function validateResearch(raw:unknown,citationUrls:string[],searchRequests:number):ResearchReport {
 const verified=new Set(citationUrls.map(canonical).filter(Boolean));
 if(!verified.size)throw new Error('Die Websuche hat keine überprüfbaren Quellenreferenzen zurückgegeben. Bitte erneut versuchen.');
 if(!raw||typeof raw!=='object')throw new Error('Die Recherche hat keinen auswertbaren Bericht geliefert.');
 const report=raw as Record<string,unknown>;const summary=text(report.summary,2500);
 if(!summary||!Array.isArray(report.sources)||!Array.isArray(report.findings)||!Array.isArray(report.hypotheses)||!Array.isArray(report.open_questions))throw new Error('Der Recherchebericht ist unvollständig.');
 const sources:ResearchSource[]=[];const seen=new Set<string>();
 for(const rawSource of report.sources.slice(0,12)){
  if(!rawSource||typeof rawSource!=='object')continue;
  const s=rawSource as Record<string,unknown>;const link=url(s.url),title=text(s.title,300),publisher=text(s.publisher,150);
  if(link&&title&&publisher&&verified.has(canonical(link))&&!seen.has(link)){sources.push({title,url:link,publisher,date:text(s.date,80)});seen.add(link);}
 }
 if(sources.length<3||new Set(sources.map(s=>new URL(s.url).hostname.replace(/^www\./,''))).size<2)throw new Error('Die Recherche lieferte zu wenige überprüfbare Quellen aus unterschiedlichen Angeboten. Bitte erneut versuchen.');
 function linked(value:unknown):string[]{if(!Array.isArray(value))return [];return [...new Set(value.map(url).filter((v):v is string=>!!v&&seen.has(v)))].slice(0,4);}
 const findings:Finding[]=[];
 for(const rawFinding of report.findings.slice(0,12)){
  if(!rawFinding||typeof rawFinding!=='object')continue;const f=rawFinding as Record<string,unknown>;
  const claim=text(f.claim,500),explanation=text(f.explanation,1000),refs=linked(f.source_urls);
  if(claim&&explanation&&refs.length&&['belegt','umstritten','offen'].includes(String(f.assessment)))findings.push({claim,explanation,assessment:f.assessment as Finding['assessment'],source_urls:refs});
 }
 if(findings.length<3)throw new Error('Die Recherche lieferte zu wenige Aussagen mit konkreten Quellen. Bitte erneut versuchen.');
 const hypotheses:Hypothesis[]=[];
 for(const rawHypothesis of report.hypotheses.slice(0,4)){
  if(!rawHypothesis||typeof rawHypothesis!=='object')continue;const h=rawHypothesis as Record<string,unknown>;
  const question=text(h.question,500),indications=text(h.indications,700),alternative=text(h.alternative,700),limitations=text(h.limitations,700),refs=linked(h.source_urls);
  if(question&&indications&&alternative&&limitations&&refs.length)hypotheses.push({question,indications,alternative,limitations,source_urls:refs});
 }
 const open_questions=report.open_questions.map(q=>text(q,500)).filter(Boolean).slice(0,8);
 return {search_requests:searchRequests,summary,sources,findings,hypotheses,open_questions};
}
