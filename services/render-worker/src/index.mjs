import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const execFile = promisify(execFileCallback);
const API_URL = (process.env.HENDY_API_URL || "").trim().replace(/\/+$/, "");
const TOKEN = process.env.RENDER_SERVICE_TOKEN || "";
const WORKER_ID = (process.env.RENDER_WORKER_ID || "render-" + randomUUID()).slice(0, 80);
const POLL_MS = boundedInt("POLL_INTERVAL_MS", 2000, 250, 60000);
const JOB_TIMEOUT_MS = boundedInt("JOB_TIMEOUT_MS", 2700000, 60000, 7200000);
const MAX_INPUT_BYTES = boundedInt("MAX_INPUT_BYTES", 262144000, 20971520, 1073741824);
const MAX_OUTPUT_BYTES = boundedInt("MAX_OUTPUT_BYTES", 83886080, 10485760, 83886080);
const HEALTH_PORT = boundedInt("HEALTH_PORT", 8787, 1024, 65535);
const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";
const FFPROBE = process.env.FFPROBE_BIN || "ffprobe";
let stopping = false, activeJobId = "", activeProgress = 0, lastError = "";

function boundedInt(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
function log(event, fields = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, workerId: WORKER_ID, ...fields }));
}
function safeError(error, max = 250) {
  return String(error instanceof Error ? error.message : error).replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]").slice(0, max);
}
function seconds(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1800) throw new Error("Invalid " + name);
  return String(Number(value.toFixed(4)));
}
function fileExt(mime, name) {
  const known = { "video/mp4":".mp4","video/webm":".webm","video/quicktime":".mov","video/x-matroska":".mkv","audio/mpeg":".mp3","audio/mp4":".m4a","audio/wav":".wav","audio/x-wav":".wav","audio/ogg":".ogg","audio/flac":".flac","audio/aac":".aac","image/jpeg":".jpg","image/png":".png","image/webp":".webp" };
  return known[mime] || extname(name || "").toLowerCase() || ".bin";
}
async function api(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
  const headers = new Headers(options.headers || {});
  headers.set("authorization", "Bearer " + TOKEN);
  headers.set("x-render-worker-id", WORKER_ID);
  if (options.json !== undefined) headers.set("content-type", "application/json");
  try {
    const response = await fetch(API_URL + path, {
      method: options.method || "GET", headers,
      body: options.json === undefined ? options.body : JSON.stringify(options.json),
      signal: controller.signal, ...(options.duplex ? { duplex: options.duplex } : {}),
    });
    if (options.stream) {
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || "API HTTP " + response.status);
      }
      return response;
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message || "API HTTP " + response.status);
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("API request timed out.");
    throw error instanceof Error ? error : new Error("API request failed.");
  } finally { clearTimeout(timer); }
}
async function downloadAsset(assetId, jobId, folder) {
  const response = await api("/internal/render/assets/" + encodeURIComponent(assetId) + "?jobId=" + encodeURIComponent(jobId), { stream: true, timeoutMs: 60000 });
  const mime = String(response.headers.get("content-type") || "application/octet-stream").split(";")[0].trim().toLowerCase();
  const encodedName = response.headers.get("x-asset-name") || "";
  let name = ""; try { name = decodeURIComponent(encodedName); } catch {}
  const size = Number(response.headers.get("content-length") || "0");
  if (size > MAX_INPUT_BYTES) throw new Error("Source asset exceeds worker input limit.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_INPUT_BYTES) throw new Error("Source asset is empty or exceeds worker input limit.");
  const path = join(folder, "asset-" + randomUUID() + fileExt(mime, name));
  await writeFile(path, bytes, { mode: 0o600 });
  return { id: assetId, mime, path, size: bytes.length };
}
async function hasStream(path, selector) {
  try {
    const { stdout } = await execFile(FFPROBE, ["-v","error","-select_streams",selector,"-show_entries","stream=codec_type","-of","default=noprint_wrappers=1:nokey=1",path], { timeout: 15000, maxBuffer: 1048576 });
    return Boolean(stdout.trim());
  } catch { return false; }
}
function allClips(manifest) {
  return manifest.tracks.flatMap(track => track.clips.map(clip => ({ ...clip, kind: track.kind }))).sort((a,b) => a.start-b.start);
}
async function renderCommand(manifest, assets, outputPath) {
  const width = manifest.output.width, height = manifest.output.height, fps = manifest.output.fps;
  const clips = allClips(manifest);
  if (!clips.length || clips.length > 120) throw new Error("Clip count exceeds render limits.");
  const duration = Math.max(...clips.map(clip => Number(clip.start) + Number(clip.duration)));
  if (!Number.isFinite(duration) || duration <= 0 || duration > 1800) throw new Error("Timeline duration exceeds 30 minutes.");
  const args = ["-y","-hide_banner","-loglevel","error","-progress","pipe:1","-f","lavfi","-i","color=c=black:s="+width+"x"+height+":r="+fps+":d="+seconds(duration,"duration")];
  const filters = [], videos = [], audios = [];
  let input = 1;
  for (const clip of clips) {
    const asset = assets.get(clip.assetId);
    if (!asset) throw new Error("Asset missing from download cache.");
    const start = Number(clip.start), length = Number(clip.duration), inPoint = Number(clip.inPoint || 0);
    if (clip.kind === "video") {
      if (!asset.mime.startsWith("video/") && !asset.mime.startsWith("image/")) throw new Error("Video track source is not a video or image.");
      if (asset.mime.startsWith("image/")) args.push("-loop","1","-framerate",String(fps),"-t",seconds(length,"clip duration"),"-i",asset.path);
      else args.push("-i",asset.path);
      const idx = input++, label = "v" + videos.length;
      if (asset.mime.startsWith("video/") && !await hasStream(asset.path,"v:0")) throw new Error("Video file does not contain a video stream.");
      filters.push("["+idx+":v:0]trim=start="+seconds(inPoint,"inPoint")+":duration="+seconds(length,"clip duration")+
        ",setpts=PTS-STARTPTS+"+seconds(start,"start")+"/TB,scale="+width+":"+height+
        ":force_original_aspect_ratio=decrease,pad="+width+":"+height+":(ow-iw)/2:(oh-ih)/2,setsar=1["+label+"]");
      videos.push({ label, start, end: start + length });
    } else {
      if (!asset.mime.startsWith("audio/") && !asset.mime.startsWith("video/")) throw new Error("Audio track source is not an audio file.");
      if (!await hasStream(asset.path,"a:0")) throw new Error("Audio clip has no audio stream.");
      args.push("-i",asset.path);
      const idx = input++, label = "a" + audios.length;
      const delay = Math.max(0,Math.round(start*1000));
      filters.push("["+idx+":a:0]atrim=start="+seconds(inPoint,"inPoint")+":duration="+seconds(length,"duration")+",asetpts=PTS-STARTPTS,adelay="+delay+"|"+delay+"["+label+"]");
      audios.push(label);
    }
  }
  let base = "0:v";
  videos.forEach((clip,index) => {
    const next="base"+(index+1);
    filters.push("["+base+"]["+clip.label+"]overlay=0:0:eof_action=pass:shortest=0:enable='between(t,"+seconds(clip.start,"start")+","+seconds(clip.end,"end")+")'["+next+"]");
    base=next;
  });
  if (audios.length) {
    filters.push(audios.map(label=>"["+label+"]").join("")+"amix=inputs="+audios.length+":duration=longest:normalize=0,apad,atrim=duration="+seconds(duration,"duration")+"[aout]");
  } else {
    args.push("-f","lavfi","-t",seconds(duration,"duration"),"-i","anullsrc=channel_layout=stereo:sample_rate=48000");
    filters.push("["+input+":a:0]atrim=duration="+seconds(duration,"duration")+"[aout]");
  }
  args.push("-filter_complex",filters.join(";"),"-map","["+base+"]","-map","[aout]","-t",seconds(duration,"duration"),"-r",String(fps),
    "-c:v","libx264","-preset",process.env.FFMPEG_PRESET||"veryfast","-crf","23","-pix_fmt","yuv420p","-c:a","aac","-b:a","192k","-movflags","+faststart",outputPath);
  return { args, duration };
}
async function progress(jobId, value) {
  const pct=Math.min(98,Math.max(1,Math.floor(value)));
  activeProgress=Math.max(activeProgress,pct);
  await api("/internal/render/jobs/"+encodeURIComponent(jobId)+"/progress",{method:"POST",json:{progress:activeProgress},timeoutMs:15000});
}
async function runFfmpeg(args,duration,jobId) {
  await new Promise((resolve,reject)=>{
    const child=spawn(FFMPEG,args,{stdio:["ignore","pipe","pipe"]});
    let stderr="",pending="",timedOut=false;
    const timeout=setTimeout(()=>{timedOut=true;child.kill("SIGTERM");setTimeout(()=>child.kill("SIGKILL"),5000).unref();},JOB_TIMEOUT_MS);
    const heartbeat=setInterval(()=>{void progress(jobId,activeProgress).catch(e=>{lastError=safeError(e);});},45000);
    child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");
    child.stdout.on("data",chunk=>{
      pending+=chunk;const lines=pending.split(/\r?\n/);pending=lines.pop()||"";
      for(const line of lines){if(!line.startsWith("out_time_ms="))continue;const value=Number(line.slice(12));if(Number.isFinite(value)&&duration>0){const pct=Math.min(95,Math.max(2,Math.floor(value/1000000/duration*95)));if(pct>activeProgress)void progress(jobId,pct).catch(e=>{lastError=safeError(e);});}}
    });
    child.stderr.on("data",chunk=>{stderr=(stderr+chunk).slice(-6000);});
    child.on("error",error=>{clearTimeout(timeout);clearInterval(heartbeat);reject(error);});
    child.on("close",code=>{clearTimeout(timeout);clearInterval(heartbeat);if(timedOut)reject(new Error("FFmpeg timed out."));else if(code!==0)reject(new Error("FFmpeg exited "+code+": "+stderr.trim().slice(-1800)));else resolve();});
  });
}
async function render(job) {
  const folder=await mkdtemp(join(tmpdir(),"hendy-render-"));
  try {
    const clips=allClips(job.manifest), unique=[...new Set(clips.map(clip=>clip.assetId))], assets=new Map();
    let total=0;
    for(const assetId of unique){const asset=await downloadAsset(assetId,job.id,folder);total+=asset.size;if(total>MAX_INPUT_BYTES)throw new Error("Total media exceeds worker input limit.");assets.set(assetId,asset);await progress(job.id,2+Math.floor(8*assets.size/unique.length));}
    const outputPath=join(folder,"output.mp4");
    const command=await renderCommand(job.manifest,assets,outputPath);
    await progress(job.id,12);
    await runFfmpeg(command.args,command.duration,job.id);
    const output=await stat(outputPath);
    if(!output.isFile()||output.size<1024)throw new Error("MP4 output is missing or invalid.");
    if(output.size>MAX_OUTPUT_BYTES)throw new Error("MP4 output exceeds 80 MiB limit.");
    await progress(job.id,98);
    await api("/internal/render/jobs/"+encodeURIComponent(job.id)+"/output",{method:"PUT",headers:{"content-type":"video/mp4","content-length":String(output.size)},body:createReadStream(outputPath),duplex:"half",timeoutMs:120000});
    log("render_completed",{jobId:job.id,bytes:output.size});
  } finally { await rm(folder,{recursive:true,force:true}).catch(()=>undefined); }
}
async function reportFailure(jobId,error) {
  const message=safeError(error,280);
  const code=/timed out/i.test(message)?"RENDER_TIMEOUT":/limit|exceed/i.test(message)?"RENDER_LIMIT":/FFmpeg/i.test(message)?"FFMPEG_FAILED":"RENDER_FAILED";
  try { const result=await api("/internal/render/jobs/"+encodeURIComponent(jobId)+"/fail",{method:"POST",json:{code,message}});log("render_failed",{jobId,code,retrying:Boolean(result.retrying),message:message.slice(0,100)}); }
  catch(err){log("failure_report_failed",{jobId,message:safeError(err)});}
}
async function loop() {
  while(!stopping){
    try{
      const result=await api("/internal/render/jobs/next",{timeoutMs:15000});
      if(!result.job){await sleep(Math.max(POLL_MS,Number(result.pollAfterMs)||0));continue;}
      const job=result.job;activeJobId=job.id;activeProgress=1;log("render_started",{jobId:job.id,projectId:job.projectId,attempt:job.attempt});
      try{await render(job);}catch(error){lastError=safeError(error,400);await reportFailure(job.id,error);}finally{activeJobId="";activeProgress=0;}
      await sleep(200);
    }catch(error){lastError=safeError(error,250);log("poll_error",{message:lastError});await sleep(Math.max(POLL_MS,5000));}
  }
}
const server=createServer((request,response)=>{
  if(request.method==="GET"&&request.url==="/healthz"){
    const body=JSON.stringify({status:"ok",workerId:WORKER_ID,activeJobId:activeJobId||null,progress:activeProgress,lastError:lastError||null});
    response.writeHead(200,{"content-type":"application/json","content-length":Buffer.byteLength(body),"cache-control":"no-store"});response.end(body);
  }else{response.writeHead(404,{"content-type":"application/json"});response.end('{"error":"not_found"}');}
});
async function main(){
  if(!API_URL)throw new Error("HENDY_API_URL is required.");
  const parsed=new URL(API_URL);if(parsed.protocol!=="https:"&&!["localhost","127.0.0.1"].includes(parsed.hostname))throw new Error("HENDY_API_URL must use HTTPS.");
  if(TOKEN.length<32)throw new Error("RENDER_SERVICE_TOKEN is missing or too short.");
  await execFile(FFMPEG,["-version"],{timeout:10000});
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(HEALTH_PORT,"0.0.0.0",()=>{server.off("error",reject);resolve();});});
  log("worker_started",{apiUrl:API_URL,pollMs:POLL_MS,inputCapBytes:MAX_INPUT_BYTES,outputCapBytes:MAX_OUTPUT_BYTES});
  process.on("SIGTERM",()=>{stopping=true;log("shutdown_requested");});process.on("SIGINT",()=>{stopping=true;log("shutdown_requested");});
  await loop();server.close();log("worker_stopped");
}
main().catch(error=>{console.error("Render worker startup failed:",safeError(error,250));process.exitCode=1;});
