import type { ResearchReport } from '@/lib/research';
import { ExternalLink } from 'lucide-react';

export default function ResearchReportView({report}:{report:ResearchReport}) {
 const sources=new Map(report.sources.map((source,index)=>[source.url,index+1]));
 return <details className="research-panel">
  <summary><span><small>{report.source_mode==='selected'?'AUSGEWÄHLTE QUELLEN':'VERTIEFTE RECHERCHE'}</small><b>Quellen und Befunde ansehen</b></span><span>{report.search_requests} Suchanfragen · {report.sources.length} Quellen · {report.findings.length} Befunde</span></summary>
  <div className="research-content"><p className="research-intro">{report.summary}</p><p className="research-note">Quellen und Aussagen vor der Veröffentlichung prüfen.</p>
   {report.findings.length>0&&<h3>Was die Recherche ergeben hat</h3>}
   {report.findings.map((finding,index)=><article className="research-finding" key={index}><span className={`research-badge ${finding.assessment}`}>{finding.assessment}</span><div><b>{finding.claim}</b><p>{finding.explanation}</p><div className="research-refs">{finding.source_urls.map(link=><a href={link} target="_blank" rel="noopener noreferrer" key={link}>Quelle {sources.get(link) ?? '↗'} <ExternalLink size={12}/></a>)}</div></div></article>)}
   {report.hypotheses.length>0&&<><h3>Zu prüfende Hypothesen</h3>{report.hypotheses.map((hypothesis,index)=><article className="research-finding" key={index}><span className="research-badge offen">Hypothese</span><div><b>{hypothesis.question}</b><p><strong>Anhaltspunkte:</strong> {hypothesis.indications}</p><p><strong>Alternative:</strong> {hypothesis.alternative}</p><p><strong>Offen:</strong> {hypothesis.limitations}</p><div className="research-refs">{hypothesis.source_urls.map(link=><a href={link} target="_blank" rel="noopener noreferrer" key={link}>Quelle {sources.get(link) ?? '↗'} <ExternalLink size={12}/></a>)}</div></div></article>)}</>}
   {report.open_questions.length>0&&<><h3>Offene Fragen</h3><ul>{report.open_questions.map((question,index)=><li key={index}>{question}</li>)}</ul></>}
   <h3>Quellen</h3><ol className="research-sources">{report.sources.map((source,index)=>{const item=report.source_access?.[index],access=item?.url===source.url?item:undefined;return <li key={`${source.url}-${index}`}><a href={source.url} target="_blank" rel="noopener noreferrer"><b>{source.title}</b> <ExternalLink size={13}/></a><span>{source.publisher}{source.date?` · ${source.date}`:''}{access?(access.status==='unavailable'?' · Nur Kurzbeschreibung':access.truncated?' · Textauszug begrenzt':' · Text automatisch ausgelesen'):''}</span></li>})}</ol>
  </div>
 </details>;
}
