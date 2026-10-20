(() => {
  "use strict";
  const apiBase = String((window.HENDY_CONFIG || {}).apiBaseUrl || "").replace(/\/+$/, "");
  const tokenKey = "hendy-session-token";
  const $ = (s) => document.querySelector(s);
  const state = { token: sessionStorage.getItem(tokenKey) || "", projects: [], assets: [], jobs: [] };
  let noticeTimer;
  function el(tag, text, cls) { const n = document.createElement(tag); if(text!==undefined)n.textContent=text; if(cls)n.className=cls; return n; }
  function notice(text,kind) { const n=$("#notice"); n.textContent=text; n.className="notice "+(kind||"info"); n.classList.remove("hidden"); clearTimeout(noticeTimer); noticeTimer=setTimeout(()=>n.classList.add("hidden"),6000); }
  async function request(path,options) {
    if(!apiBase)throw new Error("Thiếu API URL. Đặt VITE_API_BASE_URL trong GitHub Actions Variables rồi deploy lại.");
    const init=options||{}, headers=new Headers(init.headers||{}); headers.set("accept","application/json");
    if(state.token)headers.set("authorization","Bearer "+state.token);
    if(init.body&&!headers.has("content-type"))headers.set("content-type","application/json");
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),12000);
    try {
      const response=await fetch(apiBase+path,Object.assign({},init,{headers,signal:ctl.signal}));
      const data=await response.json().catch(()=>null);
      if(!response.ok)throw new Error(data&&data.error?data.error.message+" (request "+(data.error.requestId||response.headers.get("x-request-id")||"unknown")+")":"API HTTP "+response.status);
      return data;
    } catch(e) { if(e.name==="AbortError")throw new Error("API quá thời gian phản hồi."); if(e instanceof TypeError)throw new Error("Không kết nối được API; kiểm tra URL và CORS."); throw e; }
    finally {clearTimeout(timer);}
  }
  function date(value){const d=new Date(value);return Number.isNaN(d.getTime())?"—":d.toLocaleString();}
  function setStatus(text,good){const n=$("#api-state");n.textContent=text;n.className="status "+(good?"good":"bad");}
  function drawProjects(){
    const body=$("#projects-body");body.replaceChildren();
    if(!state.projects.length){const row=el("tr"),cell=el("td","Chưa có dự án.");cell.colSpan=3;row.append(cell);body.append(row);return;}
    state.projects.forEach(p=>{const row=el("tr");row.append(el("td",p.name),el("td",date(p.updatedAt)),el("td",p.id,"mono"));body.append(row);});
  }
  function drawAssets(){
    const list=$("#assets-list");list.replaceChildren();
    if(!state.assets.length){list.append(el("p","Chưa upload tài nguyên.","muted"));return;}
    state.assets.forEach(a=>{const row=el("article",undefined,"asset-row"),left=el("div");left.append(el("strong",a.name),el("small",a.mime_type+" · "+(a.size_bytes/1048576).toFixed(2)+" MiB"));row.append(left,el("span",date(a.created_at),"muted"));list.append(row);});
  }
  async function refresh(){
    setStatus("Đang kiểm tra…",false);
    try{
      const health=await request("/healthz");setStatus("API trực tuyến",true);$("#metric-api").textContent="Online";$("#metric-version").textContent="Phiên bản "+health.version+" · "+health.environment;
      if(state.token){
        const values=await Promise.all([request("/api/v1/auth/me"),request("/api/v1/projects"),request("/api/v1/assets"),request("/api/v1/render/jobs")]);
        state.projects=values[1].projects||[];state.assets=values[2].assets||[];state.jobs=values[3].jobs||[];
        $("#metric-projects").textContent=String(state.projects.length);$("#metric-assets").textContent=String(state.assets.length);$("#metric-jobs").textContent=String(state.jobs.length);
        $("#metric-jobs-note").textContent=state.jobs.filter(j=>["queued","processing"].includes(j.status)).length+" đang chờ/chạy";
        drawProjects();drawAssets();$("#login-panel").classList.add("hidden");$("#dashboard").classList.remove("hidden");$("#logout").classList.remove("hidden");
      }else{$("#login-panel").classList.remove("hidden");$("#dashboard").classList.add("hidden");$("#logout").classList.add("hidden");}
    }catch(e){
      if(state.token&&/UNAUTHENTICATED|Session is invalid|expired/i.test(e.message)){state.token="";sessionStorage.removeItem(tokenKey);}
      setStatus(apiBase?"API lỗi":"Chưa cấu hình API",false);$("#metric-api").textContent="Offline";$("#login-error").textContent=e.message;notice(e.message,"error");
    }
  }
  $("#login-form").addEventListener("submit",async ev=>{
    ev.preventDefault();const button=ev.currentTarget.querySelector("button");button.disabled=true;button.textContent="Đang đăng nhập…";$("#login-error").textContent="";
    try{const s=await request("/api/v1/auth/login",{method:"POST",body:JSON.stringify({email:$("#email").value.trim(),password:$("#password").value})});state.token=s.token;sessionStorage.setItem(tokenKey,s.token);$("#password").value="";await refresh();notice("Đăng nhập thành công.","success");}
    catch(e){$("#login-error").textContent=e.message;}finally{button.disabled=false;button.textContent="Đăng nhập";}
  });
  $("#refresh").addEventListener("click",()=>void refresh());
  $("#logout").addEventListener("click",()=>{state.token="";sessionStorage.removeItem(tokenKey);$("#password").value="";void refresh();notice("Đã đăng xuất.","info");});
  void refresh();setInterval(()=>void refresh(),60000);
})();
