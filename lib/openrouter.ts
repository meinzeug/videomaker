export const SYSTEM_PROMPT = `Du bist strategischer YouTube-Producer und Scriptwriter für den politischen Commentary-Kanal 'Kontrakurs' (YouTube-Handle: @Kontra-Kurs). Tonalität: Kompromisslose Kritik am politischen Establishment aus Sicht der bürgerlichen Mitte ('wir hier unten' vs. 'die da oben'). Sprache: Direkt, bildhaft, umgangssprachlich. Nutze scharfe Umschreibungen statt direkter Beleidigungen (Monetarisierungs-Schutz). Erstelle aus den übergebenen News-Themen:\x20
1. Drei klickstarke Titel (Skandal-Begriff: Konkreter Anlass).\x20
2. Ein Thumbnail-Konzept (Schwarz/Rot/Weiß).\x20
3. Bildgenerierungs-Prompts für 2 B-Roll-Overlays.\x20
4. Ein komplettes 10-12 Minuten Skript nach der 5-Schritt-Formel: 1. Empörungs-Hook, 2. Quellen-Zerlegung, 3. Gesunder Menschenverstand-Kontrast, 4. Persönliches Rechenbeispiel, 5. Community-Aktivierung.`;
export async function complete(system: string, prompt: string, maxTokens=10000, tool?: "search" | "fetch") {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OpenRouter-API-Schlüssel fehlt.');
  const response=await fetch('https://openrouter.ai/api/v1/chat/completions', {method:'POST',headers:{Authorization:`Bearer ${process.env.OPENROUTER_API_KEY}`,'Content-Type':'application/json','HTTP-Referer':'https://videomaker.dorfspy.de','X-Title':'Kontrakurs Videomaker'},body:JSON.stringify({model:process.env.OPENROUTER_MODEL || 'openai/gpt-6.1-terra',reasoning:{effort:'xhigh'},provider:{require_parameters:true},max_tokens:maxTokens,...(tool === 'search' ? {tools:[{type:'openrouter:web_search',parameters:{engine:'exa',max_results:5,max_total_results:20}}],max_tool_calls:6} : tool === 'fetch' ? {tools:[{type:'openrouter:web_fetch',parameters:{engine:'openrouter',max_content_tokens:12000}}],max_tool_calls:4} : {}),messages:[{role:'system',content:system},{role:'user',content:prompt}]}),signal:AbortSignal.timeout(240000)});
  const result=await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(`OpenRouter (${response.status}): ${String(result?.error?.message || 'Anfrage fehlgeschlagen').slice(0,400)}`);
  if (tool === 'search' && !(result.usage?.server_tool_use_details?.web_search_requests > 0)) throw new Error('Die Websuche wurde nicht ausgeführt. Bitte erneut versuchen.');
  const choice=result.choices?.[0];
  if (choice?.finish_reason==='length') throw new Error('Die KI-Antwort wurde abgeschnitten. Bitte erneut versuchen.');
  if (typeof choice?.message?.content !== 'string' || !choice.message.content.trim()) throw new Error('OpenRouter lieferte keine Textantwort.');
  return choice.message.content as string;
}
export function parseJson(text:string) { const cleaned=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''); return JSON.parse(cleaned); }
