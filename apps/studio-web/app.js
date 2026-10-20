(() => {
  "use strict";
  const apiBase=String((window.HENDY_CONFIG||{}).apiBaseUrl||"").replace(/\/+$/,"");
  const tokenKey="hendy-session-token", $=s=>document.querySelector(s);
  const state={token:sessionStorage.getItem(tokenKey)||"",projects:[],assets:[],jobs:[],projectId:"",clips:[],pollTimer:null};
  let noticeTimer;
  function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
  function notice(text,kind){const n=$("#notice");n.textContent=text;n.className="notice "+(kind||"info");n.classList.remove("hidden");clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>n.classList.add("hidden"),7000);}
  function setApi(text,good){$("#api-status").textContent=text;$("#api-status").className="badge "+(good?"good":"bad");}
  async function request(path,options){
    if(!apiBase)throw new Error("Chưa cấu hình API URL. Thiết lập VITE_API_BASE_URL rồi deploy lại Pages.");
    const init=options||{},headers=new Headers(init.headers||{});headers.set("accept","application/json");if(state.token)headers.set("authorization","Bearer "+state.token);
    if(init.body&&!(init.body instanceof FormData)&&!headers.has("content-type"))headers.set("content-type","application/json");
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),path.endsWith("/download")?120000:15000);
    try{const response=await fetch(apiBase+path,Object.assign({},init,{headers,signal:ctl.signal}));if(path.endsWith("/download")&&response.ok)return await response.blob();const data=await response.json().catch(()=>null);if(!response.ok)throw new Error(data&&data.error?data.error.message+" (request "+(data.error.requestId||response.headers.get("x-request-id")||"unknown")+")":"API HTTP "+response.status);return data;}
    catch(e){if(e.name==="AbortError")throw new Error("Yêu cầu API quá thời gian chờ.");if(e instanceof TypeError)throw new Error("Không kết nối được API; kiểm tra URL và CORS.");throw e;}finally{clearTimeout(timer);}
  }
  function fmt(sec){const s=Math.max(0,Math.floor(Number(sec)||0));return String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");}
  function assetById(id){return state.assets.find(a=>a.id===id);}
  function makeManifest(){return{version:1,projectId:state.projectId,output:{width:1920,height:1080,fps:30,format:"mp4"},tracks:[
    {id:"video-main",kind:"video",clips:state.clips.filter(c=>c.kind==="video").map(c=>({id:c.id,assetId:c.assetId,start:c.start,duration:c.duration,inPoint:c.inPoint||0}))},
    {id:"audio-main",kind:"audio",clips:state.clips.filter(c=>c.kind==="audio").map(c=>({id:c.id,assetId:c.assetId,start:c.start,duration:c.duration,inPoint:c.inPoint||0}))}
  ]};}
  function drawProjects(){const s=$("#project-select"),chosen=state.projectId;s.replaceChildren();const empty=el("option","Chọn dự án cloud");empty.value="";s.append(empty);state.projects.forEach(p=>{const o=el("option",p.name);o.value=p.id;s.append(o);});s.value=chosen;}
  function drawAssets(){
    const list=$("#asset-list");list.replaceChildren();if(!state.assets.length){list.append(el("p","Chưa có media. Upload video, ảnh hoặc audio để bắt đầu.","muted"));return;}
    state.assets.forEach(a=>{const card=el("article",undefined,"asset-card"),mark=el("span",a.mime_type.startsWith("audio/")?"♫":a.mime_type.startsWith("image/")?"▧":"▶","asset-mark"),details=el("div",undefined,"asset-details");
      details.append(el("strong",a.name),el("small",a.mime_type+" · "+(a.size_bytes/1048576).toFixed(2)+" MiB"));
      const add=el("button","Thêm","button small ghost");add.addEventListener("click",()=>addAsset(a));card.append(mark,details,add);list.append(card);
    });
  }
  function drawTimeline(){
    const video=$("#video-track"),audio=$("#audio-track");video.replaceChildren();audio.replaceChildren();
    function draw(target,clips,empty){if(!clips.length){target.append(el("p",empty,"empty-track"));return;}
      clips.slice().sort((a,b)=>a.start-b.start).forEach((clip,index)=>{const card=el("div",undefined,"clip "+clip.kind);card.append(el("span",String(index+1).padStart(2,"0"),"clip-index"));const info=el("div",undefined,"clip-info");info.append(el("strong",clip.name),el("small",fmt(clip.start)+" · "+clip.duration+"s"));
        const remove=el("button","×","remove-clip");remove.title="Xóa clip";remove.addEventListener("click",()=>{state.clips=state.clips.filter(c=>c.id!==clip.id);drawTimeline();});card.append(info,remove);target.append(card);});
    }
    draw(video,state.clips.filter(c=>c.kind==="video"),"Thêm video hoặc ảnh từ Media Library.");draw(audio,state.clips.filter(c=>c.kind==="audio"),"Thêm nhạc hoặc âm thanh nếu cần.");
    const duration=state.clips.reduce((max,c)=>Math.max(max,c.start+c.duration),0);$("#duration-label").textContent=fmt(duration);$("#clip-total").textContent=state.clips.length+" clips";
    $("#preview-title").textContent=state.clips.length?($("#project-name").value||"Dự án mới"):"Chưa có clip";$("#project-state").textContent=state.projectId?"Dự án cloud: "+state.projectId.slice(0,8):"Chưa chọn dự án cloud";
  }
  function addAsset(asset){
    if(!state.projectId){notice("Tạo hoặc chọn dự án cloud trước khi thêm clip.","warning");return;}
    const duration=Math.max(1,Math.min(600,Number($("#clip-duration").value)||5)),kind=asset.mime_type.startsWith("audio/")?"audio":"video";
    const start=state.clips.reduce((max,c)=>Math.max(max,c.start+c.duration),0);
    state.clips.push({id:crypto.randomUUID(),assetId:asset.id,name:asset.name,kind,start,duration,inPoint:0});drawTimeline();notice("Đã thêm "+asset.name+" vào timeline.","success");
  }
  async function loadProject(projectId){
    state.projectId=projectId;state.clips=[];const p=state.projects.find(x=>x.id===projectId);$("#project-name").value=p?p.name:"Dự án mới";
    if(p&&p.manifest)state.clips=p.manifest.tracks.flatMap(t=>t.clips.map(c=>{const a=assetById(c.assetId);return{id:c.id,assetId:c.assetId,name:a?a.name:c.assetId,kind:t.kind,start:c.start,duration:c.duration,inPoint:c.inPoint||0};}));
    drawTimeline();drawProjects();
  }
  async function reload(){
    const values=await Promise.all([request("/api/v1/auth/me"),request("/api/v1/projects"),request("/api/v1/assets"),request("/api/v1/render/jobs"),request("/healthz")]);
    state.projects=values[1].projects||[];state.assets=values[2].assets||[];state.jobs=values[3].jobs||[];
    setApi("API online · "+values[4].version,true);$("#worker-state").textContent=values[4].capabilities.rendering?"Render API sẵn sàng":"Thiếu render token";$("#worker-state").className="badge "+(values[4].capabilities.rendering?"good":"bad");
    drawAssets();drawProjects();if(state.projectId&&!state.projects.some(p=>p.id===state.projectId))state.projectId="";
    if(state.projectId)await loadProject(state.projectId);else if(state.projects.length)await loadProject(state.projects[0].id);else drawTimeline();
    drawJobs();$("#login-panel").classList.add("hidden");$("#studio").classList.remove("hidden");$("#logout").classList.remove("hidden");
  }
  async function saveProject(){
    if(!state.projectId){const created=await request("/api/v1/projects",{method:"POST",body:JSON.stringify({name:$("#project-name").value.trim()||"Video mới"})});state.projectId=created.project.id;state.projects.unshift(created.project);}
    const data=makeManifest();const checked=await request("/api/v1/render/validate",{method:"POST",body:JSON.stringify(data)});if(!checked.valid)throw new Error("Manifest không hợp lệ.");
    const saved=await request("/api/v1/projects/"+encodeURIComponent(state.projectId),{method:"PUT",body:JSON.stringify({name:$("#project-name").value.trim()||"Video mới",manifest:data})});
    state.projects=state.projects.filter(p=>p.id!==state.projectId);state.projects.unshift(saved.project);drawProjects();$("#save-note").textContent="Đã đồng bộ lúc "+new Date().toLocaleTimeString();notice("Đã lưu manifest lên cloud.","success");
  }
  function drawJobs(){
    const list=$("#job-list");list.replaceChildren();if(!state.jobs.length){list.append(el("p","Chưa có render job.","muted"));return;}
    state.jobs.forEach(job=>{const row=el("article",undefined,"job-row"),left=el("div");left.append(el("strong",job.projectName||job.projectId),el("small",job.status.toUpperCase()+" · "+job.progress+"% · "+new Date(job.updatedAt).toLocaleString()));const actions=el("div",undefined,"job-actions");
      if(job.status==="completed"&&job.downloadAvailable){const b=el("button","Tải MP4","button small secondary");b.addEventListener("click",async()=>{try{const blob=await request("/api/v1/render/jobs/"+encodeURIComponent(job.id)+"/download"),u=URL.createObjectURL(blob),a=document.createElement("a");a.href=u;a.download="hendy-render-"+job.id+".mp4";a.click();setTimeout(()=>URL.revokeObjectURL(u),60000);}catch(e){notice(e.message,"error");}});actions.append(b);}
      if(job.status==="queued"){const b=el("button","Hủy","button small ghost");b.addEventListener("click",async()=>{try{await request("/api/v1/render/jobs/"+encodeURIComponent(job.id)+"/cancel",{method:"POST"});await pollJobs();}catch(e){notice(e.message,"error");}});actions.append(b);}
      row.append(left,actions);if(job.status==="failed")row.append(el("p",job.errorMessage||job.errorCode||"Render failed","error"));list.append(row);
    });
  }
  async function pollJobs(){if(!state.token)return;try{state.jobs=(await request("/api/v1/render/jobs")).jobs||[];drawJobs();if(!state.jobs.some(j=>["queued","processing"].includes(j.status))&&state.pollTimer){clearInterval(state.pollTimer);state.pollTimer=null;}}catch(e){notice(e.message,"error");}}
  $("#login-form").addEventListener("submit",async ev=>{ev.preventDefault();const b=ev.currentTarget.querySelector("button");b.disabled=true;b.textContent="Đang đăng nhập…";try{const s=await request("/api/v1/auth/login",{method:"POST",body:JSON.stringify({email:$("#email").value.trim(),password:$("#password").value})});state.token=s.token;sessionStorage.setItem(tokenKey,s.token);$("#password").value="";await reload();notice("Đăng nhập thành công.","success");}catch(e){$("#auth-error").textContent=e.message;}finally{b.disabled=false;b.textContent="Đăng nhập";}});
  $("#logout").addEventListener("click",()=>{state.token="";state.projectId="";state.clips=[];sessionStorage.removeItem(tokenKey);$("#login-panel").classList.remove("hidden");$("#studio").classList.add("hidden");$("#logout").classList.add("hidden");setApi("Đã đăng xuất",false);});
  $("#new-project").addEventListener("click",async()=>{try{const r=await request("/api/v1/projects",{method:"POST",body:JSON.stringify({name:$("#project-name").value.trim()||"Video mới"})});state.projects.unshift(r.project);await loadProject(r.project.id);notice("Đã tạo dự án cloud.","success");}catch(e){notice(e.message,"error");}});
  $("#project-select").addEventListener("change",async e=>{try{await loadProject(e.target.value);}catch(err){notice(err.message,"error");}});
  $("#save-project").addEventListener("click",async()=>{try{await saveProject();}catch(e){$("#save-note").textContent="Lỗi đồng bộ";notice(e.message,"error");}});
  $("#render-project").addEventListener("click",async()=>{const b=$("#render-project");b.disabled=true;try{await saveProject();const r=await request("/api/v1/render/jobs",{method:"POST",body:JSON.stringify({projectId:state.projectId})});state.jobs.unshift(r.job);drawJobs();notice("Đã gửi render job vào hàng đợi.","success");if(!state.pollTimer)state.pollTimer=setInterval(()=>void pollJobs(),3000);}catch(e){notice(e.message,"error");}finally{b.disabled=false;}});
  $("#upload-input").addEventListener("change",async e=>{const files=Array.from(e.target.files||[]);e.target.value="";if(!files.length)return;$("#upload-status").textContent="Đang upload "+files.length+" file…";try{for(const file of files){const form=new FormData();form.append("file",file,file.name);const r=await request("/api/v1/assets",{method:"POST",body:form});state.assets.unshift(r.asset);}drawAssets();$("#upload-status").textContent="Đã upload "+files.length+" file.";notice("Media đã được lưu trong storage riêng tư.","success");}catch(err){$("#upload-status").textContent="Upload thất bại.";notice(err.message,"error");}});
  $("#clear-timeline").addEventListener("click",()=>{if(confirm("Xóa toàn bộ clip khỏi timeline?")){state.clips=[];drawTimeline();}});
  $("#project-name").addEventListener("input",()=>{if(!state.projectId)$("#preview-title").textContent=$("#project-name").value||"Video mới";});
  if(state.token)void reload().then(()=>{if(state.jobs.some(j=>["queued","processing"].includes(j.status)))state.pollTimer=setInterval(()=>void pollJobs(),3000);}).catch(e=>{state.token="";sessionStorage.removeItem(tokenKey);setApi("Phiên hết hạn",false);$("#auth-error").textContent=e.message;$("#login-panel").classList.remove("hidden");$("#studio").classList.add("hidden");});
  else setApi(apiBase?"Đang chờ đăng nhập":"Thiếu API URL",false);
})();
