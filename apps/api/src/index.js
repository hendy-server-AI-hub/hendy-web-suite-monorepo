import { allowedMediaType, isRecord, MAX_JSON_BYTES, MAX_UPLOAD_BYTES, MAX_OUTPUT_BYTES, MAX_CLIPS, MAX_DURATION, parseOrigins, safeFilename, validUuid, validateManifest } from "./validation.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const TOKEN_TTL = 8 * 60 * 60;
const PBKDF2_ITERATIONS = 210000;
const MAX_ATTEMPTS = 3;
const LEASE_SECONDS = 600;
const enc = new TextEncoder();
const dec = new TextDecoder();
const uid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

function b64(bytes) { let raw = ""; for (const b of bytes) raw += String.fromCharCode(b); return btoa(raw).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_"); }
function unb64(s) { const normalized = s.replace(/-/g,"+").replace(/_/g,"/"); const raw = atob(normalized + "=".repeat((4-normalized.length%4)%4)); return Uint8Array.from(raw, c => c.charCodeAt(0)); }
function buf(bytes) { const out = new Uint8Array(bytes.byteLength); out.set(bytes); return out.buffer; }
function json(data, status = 200, headers = {}) { return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } }); }
function fail(code, message, requestId, status, headers) { return json({ error: { code, message, requestId } }, status, headers); }
function equal(a,b) { const x=enc.encode(String(a)), y=enc.encode(String(b)); let diff=x.length^y.length; for(let i=0;i<Math.max(x.length,y.length);i++) diff|=(x[i]||0)^(y[i]||0); return diff===0; }
function corsAllowed(origin, env) { return !origin || parseOrigins(env.CORS_ORIGINS || "http://localhost:5173,http://localhost:5174,http://localhost:5175").includes(origin); }
function cors(request, env, requestId) {
  const origin = request.headers.get("origin") || "";
  return {
    "x-request-id": requestId,
    "access-control-allow-origin": corsAllowed(origin, env) ? origin : "",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-request-id,x-bootstrap-key,x-render-worker-id",
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
}
async function readJson(request) {
  if (Number(request.headers.get("content-length") || "0") > MAX_JSON_BYTES) return { error: "JSON body exceeds 1 MiB.", status: 413 };
  try {
    const raw = await request.text();
    if (enc.encode(raw).byteLength > MAX_JSON_BYTES) return { error: "JSON body exceeds 1 MiB.", status: 413 };
    return { value: JSON.parse(raw) };
  } catch { return { error: "Body must be valid JSON.", status: 400 }; }
}
async function hashPassword(password, salt) {
  const material = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name:"PBKDF2", hash:"SHA-256", salt:buf(salt), iterations:PBKDF2_ITERATIONS }, material, 256));
}
async function signKey(secret) { return crypto.subtle.importKey("raw", enc.encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["sign","verify"]); }
async function createToken(user, secret) {
  const now = Math.floor(Date.now()/1000);
  const claims = { sub:user.id, email:user.email, role:user.role, iat:now, exp:now+TOKEN_TTL };
  const head=b64(enc.encode(JSON.stringify({alg:"HS256",typ:"JWT"})));
  const body=b64(enc.encode(JSON.stringify(claims)));
  const input=head+"."+body;
  const sig=new Uint8Array(await crypto.subtle.sign("HMAC",await signKey(secret),enc.encode(input)));
  return { token:input+"."+b64(sig), tokenType:"Bearer", expiresAt:new Date(claims.exp*1000).toISOString() };
}
async function verifyToken(token, secret) {
  const parts=String(token).split(".");
  if(parts.length!==3 || parts.some(s=>s.length>8192)) return null;
  try {
    const header=JSON.parse(dec.decode(unb64(parts[0])));
    if(header.alg!=="HS256"||header.typ!=="JWT") return null;
    if(!await crypto.subtle.verify("HMAC",await signKey(secret),buf(unb64(parts[2])),enc.encode(parts[0]+"."+parts[1]))) return null;
    const c=JSON.parse(dec.decode(unb64(parts[1])));
    if(typeof c.sub!=="string"||typeof c.email!=="string"||typeof c.exp!=="number"||c.exp<=Math.floor(Date.now()/1000)||!["owner","admin","editor","viewer"].includes(c.role)) return null;
    return c;
  } catch { return null; }
}
async function auth(request, env) {
  if(!env.DB||!env.AUTH_JWT_SECRET) return null;
  const match=(request.headers.get("authorization")||"").match(/^Bearer\s+(.+)$/i);
  if(!match) return null;
  const claims=await verifyToken(match[1],env.AUTH_JWT_SECRET);
  if(!claims) return null;
  const user=await env.DB.prepare("SELECT id,email,role,status FROM users WHERE id=? LIMIT 1").bind(claims.sub).first();
  return user&&user.status==="active"&&user.email===claims.email&&user.role===claims.role?claims:null;
}
function emailOk(email) { return typeof email==="string"&&email.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function writable(user) { return user.role!=="viewer"; }
function pubUser(u) { return {id:u.id,email:u.email,role:u.role}; }
function pubJob(j) {
  return {id:j.id,projectId:j.project_id,projectName:j.project_name||undefined,status:j.status,progress:j.progress,attempts:j.attempts,outputSizeBytes:j.output_size_bytes||null,errorCode:j.error_code||null,errorMessage:j.error_message||null,createdAt:j.created_at,updatedAt:j.updated_at,finishedAt:j.finished_at||null,downloadAvailable:j.status==="completed"&&Boolean(j.output_key)};
}
async function ownedAssets(env, ownerId, manifest) {
  const ids=[...new Set(manifest.tracks.flatMap(t=>t.clips.map(c=>c.assetId)))];
  if(!ids.length) return {ok:false,message:"Manifest must reference uploaded assets."};
  const placeholders=ids.map(()=>"?").join(",");
  const result=await env.DB.prepare("SELECT id FROM assets WHERE owner_id=? AND id IN ("+placeholders+")").bind(ownerId,...ids).all();
  const found=new Set((result.results||[]).map(row=>row.id));
  return ids.every(x=>found.has(x))?{ok:true,ids}:{ok:false,message:"Every clip must reference an asset owned by this account."};
}
async function route(request, env, requestId, headers) {
  const url=new URL(request.url);
  const path=url.pathname.replace(/\/+$/,"")||"/";
  const method=request.method.toUpperCase();

  if(method==="GET"&&(path==="/healthz"||path==="/api/v1/health")) {
    return json({status:"ok",service:env.APP_NAME||"Hendy Control API",version:env.APP_VERSION||"2.0.0",environment:env.APP_ENV||"development",capabilities:{database:Boolean(env.DB),storage:Boolean(env.ASSETS),auth:Boolean(env.AUTH_JWT_SECRET),rendering:Boolean(env.RENDER_SERVICE_TOKEN)},timestamp:nowIso(),requestId},200,headers);
  }
  if(method==="GET"&&path==="/api/v1/meta") return json({name:env.APP_NAME||"Hendy Control API",version:env.APP_VERSION||"2.0.0",features:["health","auth","projects","private-assets","render-queue"]},200,headers);

  if(path==="/api/v1/auth/bootstrap"&&method==="POST") {
    if(!env.DB||!env.AUTH_JWT_SECRET||!env.BOOTSTRAP_ADMIN_KEY) return fail("AUTH_NOT_CONFIGURED","Database/auth secrets are missing.",requestId,503,headers);
    if(!equal(request.headers.get("x-bootstrap-key")||"",env.BOOTSTRAP_ADMIN_KEY)) return fail("BOOTSTRAP_FORBIDDEN","Bootstrap key is invalid.",requestId,403,headers);
    const count=await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first();
    if(Number(count?.count||0)>0) return fail("BOOTSTRAP_CLOSED","Initial owner already exists.",requestId,409,headers);
    const parsed=await readJson(request); if(parsed.error) return fail("INVALID_JSON",parsed.error,requestId,parsed.status,headers);
    const email=typeof parsed.value?.email==="string"?parsed.value.email.trim().toLowerCase():"";
    const password=typeof parsed.value?.password==="string"?parsed.value.password:"";
    if(!emailOk(email)) return fail("INVALID_EMAIL","Enter a valid email.",requestId,422,headers);
    if(password.length<12||password.length>128) return fail("WEAK_PASSWORD","Password must be 12-128 characters.",requestId,422,headers);
    const userId=uid(), salt=crypto.getRandomValues(new Uint8Array(16));
    const hash=await hashPassword(password,salt);
    const inserted=await env.DB.prepare("INSERT INTO users (id,email,salt,password_hash,role,status) SELECT ?,?,?,?,'owner','active' WHERE NOT EXISTS (SELECT 1 FROM users)").bind(userId,email,b64(salt),b64(hash)).run();
    if(Number(inserted.meta?.changes||0)!==1) return fail("BOOTSTRAP_CLOSED","Initial owner already exists.",requestId,409,headers);
    const session=await createToken({id:userId,email,role:"owner"},env.AUTH_JWT_SECRET);
    return json({...session,user:{id:userId,email,role:"owner"}},201,headers);
  }
  if(path==="/api/v1/auth/login"&&method==="POST") {
    if(!env.DB||!env.AUTH_JWT_SECRET) return fail("AUTH_NOT_CONFIGURED","Database/auth secrets are missing.",requestId,503,headers);
    const parsed=await readJson(request); if(parsed.error) return fail("INVALID_JSON",parsed.error,requestId,parsed.status,headers);
    const email=typeof parsed.value?.email==="string"?parsed.value.email.trim().toLowerCase():"";
    const password=typeof parsed.value?.password==="string"?parsed.value.password:"";
    if(!emailOk(email)||!password||password.length>128) return fail("INVALID_CREDENTIALS","Email or password is incorrect.",requestId,401,headers);
    const user=await env.DB.prepare("SELECT id,email,role,status,salt,password_hash FROM users WHERE email=? LIMIT 1").bind(email).first();
    if(!user||user.status!=="active") {
      await hashPassword(password,crypto.getRandomValues(new Uint8Array(16)));
      return fail("INVALID_CREDENTIALS","Email or password is incorrect.",requestId,401,headers);
    }
    const check=await hashPassword(password,unb64(user.salt));
    if(!equal(b64(check),user.password_hash)) return fail("INVALID_CREDENTIALS","Email or password is incorrect.",requestId,401,headers);
    return json({...await createToken(user,env.AUTH_JWT_SECRET),user:pubUser(user)},200,headers);
  }
  if(path==="/api/v1/render/validate"&&method==="POST") {
    const parsed=await readJson(request); if(parsed.error) return fail("INVALID_JSON",parsed.error,requestId,parsed.status,headers);
    const checked=validateManifest(parsed.value); if(!checked.valid) return fail("INVALID_MANIFEST",checked.reason,requestId,422,headers);
    return json({valid:true,projectId:checked.manifest.projectId,clipCount:checked.clipCount,trackCount:checked.trackCount,duration:checked.duration},200,headers);
  }

  if(path.startsWith("/internal/render/")) {
    if(!env.DB||!env.RENDER_SERVICE_TOKEN) return fail("RENDER_NOT_CONFIGURED","Render service is not configured.",requestId,503,headers);
    const bearer=(request.headers.get("authorization")||"").match(/^Bearer\s+(.+)$/i);
    if(!bearer||!equal(bearer[1],env.RENDER_SERVICE_TOKEN)) return fail("RENDER_UNAUTHORIZED","Render worker token is invalid.",requestId,401,headers);
    const workerId=request.headers.get("x-render-worker-id")||"";
    if(!/^[A-Za-z0-9._-]{1,80}$/.test(workerId)) return fail("INVALID_WORKER_ID","Valid x-render-worker-id is required.",requestId,400,headers);
    if(method==="GET"&&path==="/internal/render/jobs/next") {
      if(!env.ASSETS) return fail("STORAGE_NOT_CONFIGURED","R2 binding is missing.",requestId,503,headers);
      const now=Math.floor(Date.now()/1000), timestamp=nowIso();
      await env.DB.prepare("UPDATE render_jobs SET status='failed',error_code='WORKER_TIMEOUT',error_message='Lease expired after maximum attempts.',lease_until=NULL,worker_id=NULL,finished_at=?,updated_at=? WHERE status='processing' AND lease_until<=? AND attempts>=?")
        .bind(timestamp,timestamp,now,MAX_ATTEMPTS).run();
      const candidate=await env.DB.prepare("SELECT j.id,j.owner_id,j.project_id,j.attempts,p.name AS project_name,p.manifest_json FROM render_jobs j JOIN projects p ON p.id=j.project_id WHERE p.manifest_json IS NOT NULL AND j.attempts<? AND (j.status='queued' OR (j.status='processing' AND j.lease_until<=?)) ORDER BY j.created_at ASC LIMIT 1").bind(MAX_ATTEMPTS,now).first();
      if(!candidate) return json({job:null,pollAfterMs:2500},200,headers);
      const claim=await env.DB.prepare("UPDATE render_jobs SET status='processing',progress=1,attempts=attempts+1,worker_id=?,lease_until=?,updated_at=?,finished_at=NULL WHERE id=? AND attempts<? AND (status='queued' OR (status='processing' AND lease_until<=?))").bind(workerId,now+LEASE_SECONDS,timestamp,candidate.id,MAX_ATTEMPTS,now).run();
      if(Number(claim.meta?.changes||0)!==1) return json({job:null,pollAfterMs:500},200,headers);
      let manifest; try { manifest=JSON.parse(candidate.manifest_json); } catch {
        await env.DB.prepare("UPDATE render_jobs SET status='failed',error_code='INVALID_MANIFEST_JSON',error_message='Stored manifest is invalid JSON.',lease_until=NULL,worker_id=NULL,finished_at=?,updated_at=? WHERE id=? AND worker_id=?").bind(timestamp,timestamp,candidate.id,workerId).run();
        return json({job:null,pollAfterMs:250},200,headers);
      }
      const checked=validateManifest(manifest); if(!checked.valid) {
        await env.DB.prepare("UPDATE render_jobs SET status='failed',error_code='INVALID_MANIFEST',error_message=?,lease_until=NULL,worker_id=NULL,finished_at=?,updated_at=? WHERE id=? AND worker_id=?").bind(checked.reason.slice(0,280),timestamp,timestamp,candidate.id,workerId).run();
        return json({job:null,pollAfterMs:250},200,headers);
      }
      return json({job:{id:candidate.id,ownerId:candidate.owner_id,projectId:candidate.project_id,projectName:candidate.project_name,attempt:Number(candidate.attempts||0)+1,manifest}},200,headers);
    }
    const assetMatch=path.match(/^\/internal\/render\/assets\/([0-9a-f-]{36})$/i);
    if(assetMatch&&method==="GET") {
      const jobId=url.searchParams.get("jobId")||"";
      const job=await env.DB.prepare("SELECT owner_id,status,worker_id FROM render_jobs WHERE id=? LIMIT 1").bind(jobId).first();
      if(!job||job.status!=="processing"||job.worker_id!==workerId) return fail("INVALID_JOB_LEASE","Render lease is invalid.",requestId,409,headers);
      const asset=await env.DB.prepare("SELECT id,owner_id,name,mime_type,r2_key FROM assets WHERE id=? AND owner_id=? LIMIT 1").bind(assetMatch[1],job.owner_id).first();
      if(!asset||!env.ASSETS) return fail("ASSET_NOT_FOUND","Source asset was not found.",requestId,404,headers);
      const object=await env.ASSETS.get(asset.r2_key); if(!object) return fail("ASSET_OBJECT_MISSING","Source object is missing.",requestId,404,headers);
      const h=new Headers(headers); object.writeHttpMetadata(h); h.set("content-type",asset.mime_type); h.set("x-asset-name",encodeURIComponent(asset.name)); h.set("cache-control","private, no-store");
      return new Response(object.body,{status:200,headers:h});
    }
    const internalJob=path.match(/^\/internal\/render\/jobs\/([0-9a-f-]{36})(?:\/(progress|fail|output))?$/i);
    if(internalJob) {
      const jobId=internalJob[1], action=internalJob[2]||"";
      const job=await env.DB.prepare("SELECT id,owner_id,project_id,status,attempts,worker_id FROM render_jobs WHERE id=? LIMIT 1").bind(jobId).first();
      if(!job||job.status!=="processing"||job.worker_id!==workerId) return fail("INVALID_JOB_LEASE","Render lease is invalid.",requestId,409,headers);
      if(action==="progress"&&method==="POST") {
        const parsed=await readJson(request); if(parsed.error) return fail("INVALID_JSON",parsed.error,requestId,parsed.status,headers);
        const progress=parsed.value?.progress; if(!Number.isInteger(progress)||progress<1||progress>99) return fail("INVALID_PROGRESS","Progress must be an integer from 1 to 99.",requestId,422,headers);
        const updated=await env.DB.prepare("UPDATE render_jobs SET progress=?,lease_until=?,updated_at=? WHERE id=? AND status='processing' AND worker_id=?").bind(progress,Math.floor(Date.now()/1000)+LEASE_SECONDS,nowIso(),jobId,workerId).run();
        if(Number(updated.meta?.changes||0)!==1) return fail("INVALID_JOB_LEASE","Render lease expired.",requestId,409,headers);
        return json({updated:true,progress},200,headers);
      }
      if(action==="fail"&&method==="POST") {
        const parsed=await readJson(request); if(parsed.error) return fail("INVALID_JSON",parsed.error,requestId,parsed.status,headers);
        const code=typeof parsed.value?.code==="string"&&/^[A-Z0-9_]{1,64}$/.test(parsed.value.code)?parsed.value.code:"RENDER_FAILED";
        const message=typeof parsed.value?.message==="string"?parsed.value.message.trim().slice(0,280):"Render worker failed.";
        const retry=Number(job.attempts||0)<MAX_ATTEMPTS, timestamp=nowIso();
        const updated=await env.DB.prepare("UPDATE render_jobs SET status=?,progress=CASE WHEN ?='queued' THEN 0 ELSE progress END,error_code=?,error_message=?,lease_until=NULL,worker_id=NULL,finished_at=CASE WHEN ?='failed' THEN ? ELSE NULL END,updated_at=? WHERE id=? AND status='processing' AND worker_id=?").bind(retry?"queued":"failed",retry?"queued":"failed",code,message||"Render worker failed.",retry?"queued":"failed",timestamp,timestamp,jobId,workerId).run();
        return json({accepted:Number(updated.meta?.changes||0)===1,retrying:retry},200,headers);
      }
      if(action==="output"&&(method==="PUT"||method==="POST")) {
        if(!env.ASSETS) return fail("STORAGE_NOT_CONFIGURED","R2 binding is missing.",requestId,503,headers);
        const size=Number(request.headers.get("content-length")||"0");
        if(!Number.isSafeInteger(size)||size<=0) return fail("CONTENT_LENGTH_REQUIRED","Render worker must send Content-Length.",requestId,411,headers);
        if(size>MAX_OUTPUT_BYTES) return fail("OUTPUT_TOO_LARGE","MP4 output is limited to 80 MiB.",requestId,413,headers);
        if(!request.body||!(request.headers.get("content-type")||"").toLowerCase().startsWith("video/mp4")) return fail("INVALID_OUTPUT","Output must be video/mp4.",requestId,415,headers);
        const key="renders/"+job.owner_id+"/"+jobId+".mp4";
        try {
          await env.ASSETS.put(key,request.body,{httpMetadata:{contentType:"video/mp4"},customMetadata:{ownerId:job.owner_id,jobId}});
          const timestamp=nowIso();
          const updated=await env.DB.prepare("UPDATE render_jobs SET status='completed',progress=100,output_key=?,output_size_bytes=?,error_code=NULL,error_message=NULL,lease_until=NULL,worker_id=NULL,finished_at=?,updated_at=? WHERE id=? AND status='processing' AND worker_id=?").bind(key,size,timestamp,timestamp,jobId,workerId).run();
          if(Number(updated.meta?.changes||0)!==1) { await env.ASSETS.delete(key).catch(()=>undefined); return fail("INVALID_JOB_LEASE","Lease expired before upload completed.",requestId,409,headers); }
          return json({completed:true,jobId,outputSizeBytes:size},200,headers);
        } catch(error) {
          await env.ASSETS.delete(key).catch(()=>undefined);
          console.error(JSON.stringify({event:"render_output_failed",requestId,jobId,message:error instanceof Error?error.message:"unknown"}));
          return fail("OUTPUT_UPLOAD_FAILED","Could not save output to storage.",requestId,500,headers);
        }
      }
      return fail("METHOD_NOT_ALLOWED","Unsupported internal render method.",requestId,405,headers);
    }
    return fail("NOT_FOUND","Internal render route not found.",requestId,404,headers);
  }

  const protectedPath=path==="/api/v1/auth/me"||path.startsWith("/api/v1/projects")||path.startsWith("/api/v1/assets")||path.startsWith("/api/v1/render/jobs");
  if(protectedPath) {
    if(!env.DB) return fail("DATABASE_NOT_CONFIGURED","D1 binding is missing.",requestId,503,headers);
    if(!env.AUTH_JWT_SECRET) return fail("AUTH_NOT_CONFIGURED","JWT secret is missing.",requestId,503,headers);
    const user=await auth(request,env); if(!user) return fail("UNAUTHENTICATED","Session is invalid or expired.",requestId,401,headers);
    if(path==="/api/v1/auth/me"&&method==="GET") return json({user:pubUser(user),expiresAt:new Date(user.exp*1000).toISOString()},200,headers);

    if(path==="/api/v1/projects"&&method==="GET") {
      const rows=await env.DB.prepare("SELECT id,name,manifest_json,created_at,updated_at FROM projects WHERE owner_id=? ORDER BY updated_at DESC LIMIT 200").bind(user.sub).all();
      return json({projects:(rows.results||[]).map(p=>({id:p.id,name:p.name,manifest:p.manifest_json?JSON.parse(p.manifest_json):null,createdAt:p.created_at,updatedAt:p.updated_at}))},200,headers);
    }
    if(path==="/api/v1/projects"&&method==="POST") {
      if(!writable(user)) return fail("ROLE_FORBIDDEN","Viewer accounts are read-only.",requestId,403,headers);
      const parsed=await readJson(request); if(parsed.error) return fail("INVALID_JSON",parsed.error,requestId,parsed.status,headers);
      const name=typeof parsed.value?.name==="string"?parsed.value.name.trim():"";
      if(!name||name.length>200) return fail("INVALID_PROJECT_NAME","Project name must be 1-200 characters.",requestId,422,headers);
      const projectId=uid(); await env.DB.prepare("INSERT INTO projects (id,owner_id,name) VALUES (?,?,?)").bind(projectId,user.sub,name).run();
      return json({project:{id:projectId,name,manifest:null,createdAt:nowIso(),updatedAt:nowIso()}},201,headers);
    }
    const projectMatch=path.match(/^\/api\/v1\/projects\/([0-9a-f-]{36})$/i);
    if(projectMatch&&["GET","PUT","DELETE"].includes(method)) {
      const projectId=projectMatch[1];
      const project=await env.DB.prepare("SELECT id,owner_id,name,manifest_json,created_at,updated_at FROM projects WHERE id=? AND owner_id=? LIMIT 1").bind(projectId,user.sub).first();
      if(!project) return fail("PROJECT_NOT_FOUND","Project was not found.",requestId,404,headers);
      if(method==="GET") return json({project:{id:project.id,name:project.name,manifest:project.manifest_json?JSON.parse(project.manifest_json):null,createdAt:project.created_at,updatedAt:project.updated_at}},200,headers);
      if(!writable(user)) return fail("ROLE_FORBIDDEN","Viewer accounts are read-only.",requestId,403,headers);
      if(method==="DELETE") { await env.DB.prepare("DELETE FROM projects WHERE id=? AND owner_id=?").bind(projectId,user.sub).run(); return json({deleted:true,id:projectId},200,headers); }
      const parsed=await readJson(request); if(parsed.error) return fail("INVALID_JSON",parsed.error,requestId,parsed.status,headers);
      const name=parsed.value?.name===undefined?project.name:(typeof parsed.value.name==="string"?parsed.value.name.trim():"");
      if(!name||name.length>200) return fail("INVALID_PROJECT_NAME","Project name must be 1-200 characters.",requestId,422,headers);
      let manifestJson=project.manifest_json;
      if(Object.hasOwn(parsed.value||{},"manifest")) {
        if(parsed.value.manifest===null) manifestJson=null;
        else {
          const checked=validateManifest(parsed.value.manifest);
          if(!checked.valid) return fail("INVALID_MANIFEST",checked.reason,requestId,422,headers);
          if(checked.manifest.projectId!==projectId) return fail("PROJECT_ID_MISMATCH","Manifest projectId must equal cloud project ID.",requestId,422,headers);
          const media=await ownedAssets(env,user.sub,checked.manifest); if(!media.ok) return fail("ASSET_ACCESS_DENIED",media.message,requestId,422,headers);
          manifestJson=JSON.stringify(checked.manifest);
        }
      }
      const timestamp=nowIso(); await env.DB.prepare("UPDATE projects SET name=?,manifest_json=?,updated_at=? WHERE id=? AND owner_id=?").bind(name,manifestJson,timestamp,projectId,user.sub).run();
      return json({project:{id:projectId,name,manifest:manifestJson?JSON.parse(manifestJson):null,updatedAt:timestamp}},200,headers);
    }

    if(path==="/api/v1/assets"&&method==="GET") {
      const rows=await env.DB.prepare("SELECT id,name,mime_type,size_bytes,created_at FROM assets WHERE owner_id=? ORDER BY created_at DESC LIMIT 500").bind(user.sub).all();
      return json({assets:rows.results||[]},200,headers);
    }
    if(path==="/api/v1/assets"&&method==="POST") {
      if(!writable(user)) return fail("ROLE_FORBIDDEN","Viewer accounts cannot upload.",requestId,403,headers);
      if(!env.ASSETS) return fail("STORAGE_NOT_CONFIGURED","R2 binding is missing.",requestId,503,headers);
      if(!(request.headers.get("content-type")||"").toLowerCase().startsWith("multipart/form-data")) return fail("UNSUPPORTED_UPLOAD","Upload multipart/form-data with field file.",requestId,415,headers);
      if(Number(request.headers.get("content-length")||"0")>MAX_UPLOAD_BYTES+100000) return fail("FILE_TOO_LARGE","Upload is limited to 20 MiB.",requestId,413,headers);
      let form; try{form=await request.formData();}catch{return fail("INVALID_UPLOAD","Invalid multipart upload.",requestId,400,headers);}
      const file=form.get("file");
      if(!(file instanceof File)||file.size<=0) return fail("INVALID_UPLOAD","A non-empty file is required.",requestId,422,headers);
      if(file.size>MAX_UPLOAD_BYTES) return fail("FILE_TOO_LARGE","Upload is limited to 20 MiB.",requestId,413,headers);
      const mime=(file.type||"").split(";")[0].trim().toLowerCase();
      if(!allowedMediaType(mime)) return fail("UNSUPPORTED_MEDIA_TYPE","Allowed media: common video, audio, JPEG, PNG and WebP.",requestId,415,headers);
      const assetId=uid(), name=safeFilename(file.name), key="assets/"+user.sub+"/"+assetId;
      try {
        await env.ASSETS.put(key,await file.arrayBuffer(),{httpMetadata:{contentType:mime},customMetadata:{ownerId:user.sub,assetId}});
        await env.DB.prepare("INSERT INTO assets (id,owner_id,name,mime_type,size_bytes,r2_key) VALUES (?,?,?,?,?,?)").bind(assetId,user.sub,name,mime,file.size,key).run();
      } catch(error) {
        await env.ASSETS.delete(key).catch(()=>undefined);
        console.error(JSON.stringify({event:"asset_upload_failed",requestId,assetId,message:error instanceof Error?error.message:"unknown"}));
        return fail("ASSET_UPLOAD_FAILED","Could not save uploaded media.",requestId,500,headers);
      }
      return json({asset:{id:assetId,name,mime_type:mime,size_bytes:file.size,created_at:nowIso()}},201,headers);
    }
    const assetMatch=path.match(/^\/api\/v1\/assets\/([0-9a-f-]{36})$/i);
    if(assetMatch&&["GET","DELETE"].includes(method)) {
      const asset=await env.DB.prepare("SELECT id,owner_id,name,mime_type,size_bytes,r2_key,created_at FROM assets WHERE id=? AND owner_id=? LIMIT 1").bind(assetMatch[1],user.sub).first();
      if(!asset) return fail("ASSET_NOT_FOUND","Asset was not found.",requestId,404,headers);
      if(method==="DELETE") {
        if(!writable(user)) return fail("ROLE_FORBIDDEN","Viewer accounts cannot delete assets.",requestId,403,headers);
        if(env.ASSETS) await env.ASSETS.delete(asset.r2_key);
        await env.DB.prepare("DELETE FROM assets WHERE id=? AND owner_id=?").bind(asset.id,user.sub).run();
        return json({deleted:true,id:asset.id},200,headers);
      }
      if(!env.ASSETS) return fail("STORAGE_NOT_CONFIGURED","R2 binding is missing.",requestId,503,headers);
      const object=await env.ASSETS.get(asset.r2_key); if(!object) return fail("ASSET_OBJECT_MISSING","Asset object is missing from R2.",requestId,404,headers);
      const h=new Headers(headers); object.writeHttpMetadata(h); h.set("content-type",asset.mime_type); h.set("content-disposition","attachment; filename*=UTF-8''"+encodeURIComponent(asset.name)); h.set("cache-control","private, no-store");
      return new Response(object.body,{status:200,headers:h});
    }
    if(path==="/api/v1/render/jobs"&&method==="POST") {
      if(!writable(user)) return fail("ROLE_FORBIDDEN","Viewer accounts cannot render.",requestId,403,headers);
      if(!env.ASSETS||!env.RENDER_SERVICE_TOKEN) return fail("RENDER_NOT_CONFIGURED","Storage or render worker token is missing.",requestId,503,headers);
      const parsed=await readJson(request); if(parsed.error) return fail("INVALID_JSON",parsed.error,requestId,parsed.status,headers);
      const projectId=parsed.value?.projectId; if(!validUuid(projectId)) return fail("INVALID_PROJECT_ID","projectId must be a UUID.",requestId,422,headers);
      const project=await env.DB.prepare("SELECT id,name,manifest_json FROM projects WHERE id=? AND owner_id=? LIMIT 1").bind(projectId,user.sub).first();
      if(!project||!project.manifest_json) return fail("MANIFEST_REQUIRED","Save the project manifest before rendering.",requestId,422,headers);
      let manifest; try{manifest=JSON.parse(project.manifest_json);}catch{return fail("INVALID_MANIFEST_JSON","Saved manifest is invalid JSON.",requestId,422,headers);}
      const checked=validateManifest(manifest); if(!checked.valid) return fail("INVALID_MANIFEST",checked.reason,requestId,422,headers);
      const media=await ownedAssets(env,user.sub,checked.manifest); if(!media.ok) return fail("ASSET_ACCESS_DENIED",media.message,requestId,422,headers);
      const active=await env.DB.prepare("SELECT COUNT(*) AS count FROM render_jobs WHERE owner_id=? AND status IN ('queued','processing')").bind(user.sub).first();
      if(Number(active?.count||0)>=2) return fail("RENDER_QUEUE_LIMIT","Two active render jobs are allowed per account.",requestId,429,headers);
      const jobId=uid(); await env.DB.prepare("INSERT INTO render_jobs (id,owner_id,project_id,status,progress,attempts) VALUES (?,?,?,'queued',0,0)").bind(jobId,user.sub,projectId).run();
      return json({job:{id:jobId,projectId,projectName:project.name,status:"queued",progress:0,attempts:0,createdAt:nowIso(),updatedAt:nowIso(),downloadAvailable:false}},202,headers);
    }
    if(path==="/api/v1/render/jobs"&&method==="GET") {
      const rows=await env.DB.prepare("SELECT j.*,p.name AS project_name FROM render_jobs j JOIN projects p ON p.id=j.project_id WHERE j.owner_id=? ORDER BY j.created_at DESC LIMIT 100").bind(user.sub).all();
      return json({jobs:(rows.results||[]).map(pubJob)},200,headers);
    }
    const jobMatch=path.match(/^\/api\/v1\/render\/jobs\/([0-9a-f-]{36})(?:\/(download|cancel))?$/i);
    if(jobMatch) {
      const jobId=jobMatch[1], action=jobMatch[2]||"";
      const job=await env.DB.prepare("SELECT j.*,p.name AS project_name FROM render_jobs j JOIN projects p ON p.id=j.project_id WHERE j.id=? AND j.owner_id=? LIMIT 1").bind(jobId,user.sub).first();
      if(!job) return fail("JOB_NOT_FOUND","Render job was not found.",requestId,404,headers);
      if(action==="download"&&method==="GET") {
        if(job.status!=="completed"||!job.output_key) return fail("OUTPUT_NOT_READY","MP4 output is not ready.",requestId,409,headers);
        if(!env.ASSETS) return fail("STORAGE_NOT_CONFIGURED","R2 binding is missing.",requestId,503,headers);
        const object=await env.ASSETS.get(job.output_key); if(!object) return fail("OUTPUT_MISSING","MP4 file is missing from R2.",requestId,404,headers);
        const h=new Headers(headers); object.writeHttpMetadata(h); h.set("content-type","video/mp4"); h.set("content-disposition",'attachment; filename="hendy-render-'+job.id+'.mp4"'); h.set("cache-control","private, no-store");
        return new Response(object.body,{status:200,headers:h});
      }
      if(action==="cancel"&&method==="POST") {
        if(!writable(user)) return fail("ROLE_FORBIDDEN","Viewer accounts cannot cancel jobs.",requestId,403,headers);
        if(job.status!=="queued") return fail("JOB_ALREADY_STARTED","Only queued jobs can be cancelled.",requestId,409,headers);
        await env.DB.prepare("UPDATE render_jobs SET status='cancelled',updated_at=?,finished_at=? WHERE id=? AND owner_id=? AND status='queued'").bind(nowIso(),nowIso(),jobId,user.sub).run();
        return json({cancelled:true,id:jobId},200,headers);
      }
      if(action||method!=="GET") return fail("METHOD_NOT_ALLOWED","Method is not supported.",requestId,405,headers);
      return json({job:pubJob(job)},200,headers);
    }
    return fail("NOT_FOUND","API route not found.",requestId,404,headers);
  }
  if(path.startsWith("/api/")) return fail("NOT_FOUND","API route not found.",requestId,404,headers);
  return json({service:env.APP_NAME||"Hendy Control API",health:"/healthz",metadata:"/api/v1/meta"},200,headers);
}

export default {
  async fetch(request, env) {
    const requestId=request.headers.get("x-request-id")?.slice(0,128)||uid();
    const headers=cors(request,env,requestId);
    const origin=request.headers.get("origin")||"";
    if(request.method==="OPTIONS") return origin&&!corsAllowed(origin,env)?new Response(null,{status:403,headers:{"x-request-id":requestId,vary:"Origin"}}):new Response(null,{status:204,headers});
    if(origin&&!corsAllowed(origin,env)) return fail("ORIGIN_NOT_ALLOWED","Origin is not on the CORS allowlist.",requestId,403,{"x-request-id":requestId,vary:"Origin"});
    try { return await route(request,env,requestId,headers); }
    catch(error) {
      console.error(JSON.stringify({event:"unhandled_api_error",requestId,message:error instanceof Error?error.message:"unknown"}));
      return fail("INTERNAL_ERROR","Unexpected server error.",requestId,500,headers);
    }
  },
};
