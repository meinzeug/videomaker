'use client';
import { useEffect, useState, type RefObject } from 'react';
import { matchSpokenWords, type ScriptWord } from '@/lib/speech-follow';

type SpeechResultEvent={resultIndex:number;results:SpeechRecognitionResultList};
type SpeechErrorEvent={error:string};
type Recognition={lang:string;continuous:boolean;interimResults:boolean;maxAlternatives:number;start:(track?:MediaStreamTrack)=>void;abort:()=>void;onstart:(()=>void)|null;onend:(()=>void)|null;onresult:((event:SpeechResultEvent)=>void)|null;onerror:((event:SpeechErrorEvent)=>void)|null};
type RecognitionConstructor=new()=>Recognition;
type WindowWithSpeech=Window & {SpeechRecognition?:RecognitionConstructor;webkitSpeechRecognition?:RecognitionConstructor};
type Options={enabled:boolean;playing:boolean;words:ScriptWord[];scroll:RefObject<HTMLDivElement|null>;wordElements:RefObject<(HTMLSpanElement|null)[]>;audioTrack:MediaStreamTrack|null;onFailure:()=>void};

export function useSpeechFollow({enabled,playing,words,scroll,wordElements,audioTrack,onFailure}:Options){
 const [status,setStatus]=useState<'idle'|'starting'|'listening'|'paused'|'error'>('idle');
 const [message,setMessage]=useState('');
 useEffect(()=>{
  if(!enabled){setStatus('idle');setMessage('');return;}
  if(!playing){setStatus(value=>value==='error'?'error':'paused');return;}
  const Constructor=(window as WindowWithSpeech).SpeechRecognition||(window as WindowWithSpeech).webkitSpeechRecognition;
  if(!Constructor){setStatus('error');setMessage('Dieser Browser unterstützt keine Spracherkennung. Bitte den manuellen Modus oder einen unterstützten Browser verwenden.');onFailure();return;}
  const box=scroll.current;
  if(!box||!words.length){setStatus('error');setMessage('Der Skripttext enthält keine erkennbaren Wörter.');onFailure();return;}
  let active=true,fatal=false,timer:ReturnType<typeof setTimeout>|undefined,highlighted:HTMLSpanElement|null=null;
  let confirmed=0;
  const focusY=box.getBoundingClientRect().top+box.clientHeight/2;
  // Start at the first visible word on or below the focus line, including after manual scrolling.
  let low=0,high=words.length;
  while(low<high){const middle=(low+high)>>1;const rect=wordElements.current[middle]?.getBoundingClientRect();if(rect&&rect.bottom<focusY-6)low=middle+1;else high=middle;}
  confirmed=Math.min(low,Math.max(0,words.length-1));
  const states=new Map<number,{anchor:number;best:number;final:boolean}>();
  const recognition=new Constructor();recognition.lang='de-DE';recognition.continuous=true;recognition.interimResults=true;recognition.maxAlternatives=1;
  const recognitionTrack=audioTrack?.readyState==='live'?audioTrack.clone():null;
  function move(index:number){
   const target=wordElements.current[index];if(!target||!box)return;
   if(highlighted!==target){highlighted?.classList.remove('speech-current-word');highlighted=target;target.classList.add('speech-current-word');}
   const offset=target.getBoundingClientRect().top-(box.getBoundingClientRect().top+box.clientHeight/2);
   const top=Math.max(0,Math.min(box.scrollHeight-box.clientHeight,box.scrollTop+offset));
   if(Math.abs(top-box.scrollTop)>3)box.scrollTo({top,behavior:'smooth'});
  }
  recognition.onstart=()=>{if(active)setStatus('listening');};
  recognition.onresult=event=>{
   if(!active)return;
   for(let i=event.resultIndex;i<event.results.length;i++){
    const result=event.results[i];if(!result?.[0])continue;
    let state=states.get(i);if(!state){state={anchor:confirmed,best:confirmed,final:false};states.set(i,state);}if(state.final)continue;
    const match=matchSpokenWords(words,result[0].transcript,state.anchor);
    if(match!==null&&match>state.best){state.best=match;move(match-1);}
    if(result.isFinal){confirmed=Math.max(confirmed,state.best);state.final=true;}
   }
  };
  recognition.onerror=event=>{
   if(!active||event.error==='aborted'||event.error==='no-speech')return;
   fatal=true;setStatus('error');
   setMessage(event.error==='not-allowed'||event.error==='service-not-allowed'?'Spracherkennung wurde nicht freigegeben. Bitte Browserberechtigungen prüfen.':event.error==='audio-capture'?'Das Mikrofon ist für die Spracherkennung nicht verfügbar.':event.error==='network'?'Der Spracherkennungsdienst ist nicht erreichbar.':'Die Spracherkennung wurde unterbrochen.');
   onFailure();
  };
  function start(){
   if(!active||fatal)return;setStatus('starting');
   try{if(recognitionTrack?.readyState==='live'){try{recognition.start(recognitionTrack);}catch{recognition.start();}}else recognition.start();}
   catch{fatal=true;setStatus('error');setMessage('Spracherkennung konnte nicht gestartet werden. Bitte erneut versuchen oder manuell steuern.');onFailure();}
  }
  recognition.onend=()=>{if(active&&!fatal){states.clear();timer=setTimeout(start,500);}};
  setMessage('');start();
  return()=>{active=false;if(timer)clearTimeout(timer);recognition.onstart=null;recognition.onend=null;recognition.onresult=null;recognition.onerror=null;try{recognition.abort();}catch{}recognitionTrack?.stop();box.scrollTo({top:box.scrollTop,behavior:'instant'});highlighted?.classList.remove('speech-current-word');};
 },[enabled,playing,words,scroll,wordElements,audioTrack,onFailure]);
 return {status,message};
}
