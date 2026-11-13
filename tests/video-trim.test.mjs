import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseTrimRange,parseTrimProbe,isTrimComplete} from '../lib/video-trim.ts';
test('trim validates finite, ordered and bounded timestamps',()=>{
 assert.deepEqual(parseTrimRange({start:1.25,end:3.5}),{start:1.25,end:3.5});
 assert.deepEqual(parseTrimRange({start:1.0004,end:1.1004}),{start:1,end:1.1});
 for(const value of [{start:-1,end:1},{start:1,end:1},{start:0,end:.099},{start:0,end:601},{start:'1',end:2},{start:0,end:Infinity},{start:0,end:Number.MAX_VALUE},null])assert.throws(()=>parseTrimRange(value));
});
test('durationless WebM may be processed but a durationless output or MP4 may not',()=>{
 const source=JSON.stringify({format:{},streams:[{codec_type:'video',width:320,height:240,avg_frame_rate:'15/1'},{codec_type:'audio'}]});
 assert.throws(()=>parseTrimProbe(source));
 const probe=parseTrimProbe(source,true);assert.equal(probe.duration,null);assert.equal(probe.audio,true);
 const makeOutput=(videoDuration,audioDuration)=>parseTrimProbe(JSON.stringify({format:{duration:'2'},streams:[{codec_type:'video',width:320,height:240,avg_frame_rate:'15/1',duration:String(videoDuration)},{codec_type:'audio',duration:String(audioDuration)}]}));
 assert.equal(isTrimComplete(probe,makeOutput(2,2),2),true);
 assert.equal(isTrimComplete(probe,makeOutput(1.8,2),2),false);
 assert.equal(isTrimComplete(probe,makeOutput(2,1.7),2),false);
 assert.equal(isTrimComplete(probe,makeOutput(.1,.1),.3-.2),true);
 assert.equal(isTrimComplete(probe,{...makeOutput(2,2),audio:false},2),false);
});
test('probe rejects missing video, oversized video and excessive frame rate',()=>{
 const json=(video)=>JSON.stringify({format:{duration:'2'},streams:video?[video]:[]});
 assert.throws(()=>parseTrimProbe(json(null)));
 assert.throws(()=>parseTrimProbe(json({codec_type:'video',width:8000,height:4000})));
 assert.throws(()=>parseTrimProbe(json({codec_type:'video',width:320,height:240,avg_frame_rate:'121/1'})));
});
