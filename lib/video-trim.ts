export const MAX_TRIM_SECONDS=600;
export const MIN_TRIM_SECONDS=0.1;
export function parseTrimRange(input:unknown){
 if(!input || typeof input!=='object')throw new Error('Ungültiger Schnittbereich.');
 const {start,end}=input as Record<string,unknown>;
 if(typeof start!=='number'||typeof end!=='number'||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>Number.MAX_SAFE_INTEGER/1000)throw new Error('Bitte einen gültigen Schnittbereich wählen.');
 // FFmpeg receives millisecond precision; validate the values it will actually use.
 const startMs=Math.round(start*1000),endMs=Math.round(end*1000);
 if(endMs-startMs<MIN_TRIM_SECONDS*1000||endMs-startMs>MAX_TRIM_SECONDS*1000)throw new Error('Bitte einen Bereich zwischen 0,1 Sekunden und zehn Minuten wählen.');
 return {start:startMs/1000,end:endMs/1000};
}

export type TrimMediaInfo={duration:number|null;videoDuration:number|null;audioDuration:number|null;audio:boolean;frameRate:number|null};
/** Parse ffprobe's bounded JSON. Only streaming WebM may omit a source duration. */
export function parseTrimProbe(output:string,allowUnknownDuration=false):TrimMediaInfo {
 const info=JSON.parse(output) as {format?:{duration?:string};streams?:Array<{codec_type?:string;width?:number;height?:number;avg_frame_rate?:string;duration?:string}>};
 const positive=(value:string|undefined)=>{const number=Number(value);return Number.isFinite(number)&&number>0?number:null;};
 const duration=positive(info.format?.duration),streams=info.streams||[],video=streams.find(stream=>stream.codec_type==='video'),audio=streams.find(stream=>stream.codec_type==='audio');
 if((duration===null&&!allowUnknownDuration)||!video||!Number.isInteger(video.width)||!Number.isInteger(video.height))throw new Error('Ungültige Videodaten.');
 const width=video.width!,height=video.height!;
 if(width<1||height<1||width>3840||height>3840||width*height>3840*2160)throw new Error('Nicht unterstützte Videoabmessungen.');
 const [n,d]=(video.avg_frame_rate||'0/0').split('/').map(Number);
 if(Number.isFinite(n)&&Number.isFinite(d)&&d>0&&n/d>120)throw new Error('Nicht unterstützte Bildrate.');
 const frameRate=Number.isFinite(n)&&Number.isFinite(d)&&d>0&&n>0?n/d:null;
 return {duration,videoDuration:positive(video.duration),audioDuration:positive(audio?.duration),audio:!!audio,frameRate};
}

/** Reject incomplete output and missing/short audio; allow only frame-rounding tolerance. */
export function isTrimComplete(source:TrimMediaInfo,output:TrimMediaInfo,seconds:number):boolean {
 if(!Number.isFinite(seconds))return false;
 const milliseconds=Math.round(seconds*1000);
 if(milliseconds<MIN_TRIM_SECONDS*1000||milliseconds>MAX_TRIM_SECONDS*1000)return false;
 const requested=milliseconds/1000;
 const fps=source.frameRate||output.frameRate;
 const tolerance=Math.min(0.2,Math.max(0.05,(fps?1/fps:0.05)+0.03));
 return output.duration!==null&&output.videoDuration!==null&&output.videoDuration+tolerance>=requested&&
  (!source.audio||(output.audio&&output.audioDuration!==null&&output.audioDuration+0.12>=requested));
}
