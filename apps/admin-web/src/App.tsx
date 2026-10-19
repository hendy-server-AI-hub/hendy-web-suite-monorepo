import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Activity, ArrowDownRight, ArrowUpRight, Bell, Bot, Boxes, CheckCircle2, ChevronDown, CircleHelp, Cloud, CreditCard, Gauge, LayoutDashboard, LifeBuoy, Search, Settings, ShieldCheck, Users, Video, Wallet, Workflow, Zap } from "lucide-react";
import type { ProjectSummary } from "@hendy/shared-types";
import { formatDate } from "@hendy/core-utils";
import { clearStoredToken, getApiMeta, getCurrentUser, getHealth, getStoredToken, listAssets, listProjects, login } from "./api";

const projects: ProjectSummary[] = [
  { id: "PRJ-1042", name: "Tài liệu hướng dẫn sản phẩm", status: "processing", updatedAt: new Date(Date.now() - 4 * 60_000).toISOString(), durationSeconds: 328 },
  { id: "PRJ-1041", name: "Video giới thiệu Vietsub Pro", status: "completed", updatedAt: new Date(Date.now() - 35 * 60_000).toISOString(), durationSeconds: 912 },
  { id: "PRJ-1040", name: "Bản tin tuần — tập 08", status: "completed", updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), durationSeconds: 1450 },
  { id: "PRJ-1039", name: "Khóa học dựng video", status: "failed", updatedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(), durationSeconds: 654 },
];
const nav = [
  { title: "TỔNG QUAN", items: [{ label: "Dashboard", icon: LayoutDashboard }, { label: "Người dùng", icon: Users }, { label: "Dự án video", icon: Video }, { label: "Hàng đợi AI", icon: Workflow }] },
  { title: "VẬN HÀNH", items: [{ label: "Dịch vụ & API", icon: Boxes }, { label: "Thanh toán", icon: CreditCard }, { label: "Ví & giao dịch", icon: Wallet }, { label: "Hạ tầng Cloud", icon: Cloud }] },
  { title: "HỆ THỐNG", items: [{ label: "Phân quyền", icon: ShieldCheck }, { label: "Cấu hình", icon: Settings }, { label: "Trợ giúp", icon: LifeBuoy }] },
];

export default function App() {
  const [active, setActive] = useState("Dashboard");
  const [query, setQuery] = useState("");
  const [cloudProjects, setCloudProjects] = useState<ProjectSummary[] | null>(null);
  const [assetCount, setAssetCount] = useState<number | null>(null);
  const [apiStatus, setApiStatus] = useState<"checking" | "online" | "offline" | "unconfigured">(import.meta.env.VITE_API_BASE_URL ? "checking" : "unconfigured");
  const [apiVersion, setApiVersion] = useState("");
  const [healthCapabilities, setHealthCapabilities] = useState<{databaseConfigured:boolean;objectStorageConfigured:boolean;authenticationConfigured:boolean} | null>(null);
  const [sessionToken, setSessionToken] = useState(getStoredToken);
  const [userEmail, setUserEmail] = useState("");
  const [showAuth, setShowAuth] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const studioUrl = import.meta.env.VITE_STUDIO_URL || "http://localhost:5174";
  const activeProjects = cloudProjects ?? projects;
  const filtered = activeProjects.filter((project) => `${project.id} ${project.name}`.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    let alive = true;
    getApiMeta().then((meta) => {
      if (!alive) return;
      setApiStatus("online");
      setApiVersion(meta.version);
    }).catch(() => {
      if (alive) setApiStatus(import.meta.env.VITE_API_BASE_URL ? "offline" : "unconfigured");
    });
    getHealth().then((health) => {
      if (alive) setHealthCapabilities(health.capabilities);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!sessionToken) { setCloudProjects(null); setAssetCount(null); return; }
    let alive = true;
    Promise.all([getCurrentUser(), listProjects(), listAssets()]).then(([session, projectResponse, assetResponse]) => {
      if (!alive) return;
      setUserEmail(session.user.email);
      setCloudProjects(projectResponse.projects);
      setAssetCount(assetResponse.assets.length);
      setAuthError("");
    }).catch((error) => {
      if (!alive) return;
      clearStoredToken();
      setSessionToken("");
      setUserEmail("");
      setCloudProjects(null);
      setAssetCount(null);
      setAuthError(error instanceof Error ? error.message : "Phiên đăng nhập không hợp lệ.");
    });
    return () => { alive = false; };
  }, [sessionToken]);

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError("");
    try {
      const session = await login(authEmail.trim(), authPassword);
      setSessionToken(session.token);
      setUserEmail(session.user.email);
      setAuthPassword("");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Đăng nhập thất bại.");
    } finally {
      setAuthBusy(false);
    }
  }

  function signOut() {
    clearStoredToken();
    setSessionToken("");
    setUserEmail("");
    setShowAuth(false);
  }
  return <div className="admin-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-icon"><Zap size={19} fill="currentColor" /></div><div><b>hendy<span>.</span></b><small>CONTROL CENTER</small></div><button className="collapse" aria-label="Thu gọn menu">‹</button></div>
      <div className="workspace"><div className="workspace-mark">H</div><div><b>Hendy Studio</b><small>Production workspace</small></div><ChevronDown size={15} /></div>
      {nav.map((section) => <div className="nav-group" key={section.title}><div className="nav-title">{section.title}</div>{section.items.map(({ label, icon: Icon }) => <button key={label} className={`nav-item ${active === label ? "active" : ""}`} onClick={() => setActive(label)}><Icon size={17} strokeWidth={1.8}/><span>{label}</span>{label === "Hàng đợi AI" && <i className="nav-count">8</i>}</button>)}</div>)}
      <div className="sidebar-bottom"><div className="plan-card"><div className="plan-top"><span className="plan-icon"><Zap size={15}/></span><span>WORKSPACE</span><span className="live-dot"/></div><strong>Hendy workspace</strong><div className="meter"><span style={{width:"0%"}}/></div><small>Quota chưa cấu hình</small><button onClick={() => setActive("Thanh toán")}>Quản lý gói <ArrowUpRight size={13}/></button></div><div className="user-row"><button className="avatar account-avatar" onClick={() => setShowAuth(true)} title="Tài khoản API">{sessionToken ? "✓" : "GD"}</button><div className="user-meta"><b>{userEmail || "Studio Admin"}</b><small>{sessionToken ? "Đã xác thực" : "Demo — chưa đăng nhập"}</small></div><button aria-label="Tùy chọn tài khoản" onClick={() => setShowAuth(true)}><ChevronDown size={16}/></button></div></div>
    </aside>
    <main className="main-area"><header className="topbar"><div className="breadcrumbs">Hendy Studio <span>/</span> <b>{active}</b></div><div className="top-actions"><div className={`environment env-${apiStatus}`}><span/> {apiStatus === "online" ? "API online" : apiStatus === "checking" ? "Đang kiểm tra" : apiStatus === "offline" ? "API lỗi" : "API chưa cấu hình"}</div><button className="icon-btn" aria-label="Trợ giúp" onClick={() => setActive("Trợ giúp")}><CircleHelp size={18}/></button><button className="icon-btn notification" aria-label="Thông báo"><Bell size={18}/><i/></button><button className="top-avatar top-avatar-button" title={userEmail || "Đăng nhập API"} onClick={() => setShowAuth(true)}>{sessionToken ? "✓" : "GD"}</button></div></header>
      <div className="page-content"><div className="page-heading"><div><div className="eyebrow"><span/> TRUNG TÂM ĐIỀU HÀNH</div><h1>{active === "Dashboard" ? "Tổng quan hệ thống" : active}</h1><p>Theo dõi hệ thống; đăng nhập để xem dự án và tài nguyên thực được lưu trong D1/R2.</p></div><div className="heading-actions"><button className="btn-secondary" onClick={() => window.location.reload()}><Activity size={15}/> Làm mới</button><button className="btn-primary" onClick={() => window.open(studioUrl, "_blank", "noopener,noreferrer")}><Video size={16}/> Mở Studio</button></div></div>
      <div className="stat-grid"><Stat icon={<Video/>} label="Dự án đã lưu" value={cloudProjects === null ? "—" : String(cloudProjects.length)} change={cloudProjects === null ? "Đăng nhập" : "D1"} positive={cloudProjects !== null} hint={cloudProjects === null ? "Đăng nhập để xem dữ liệu thật" : "Từ cơ sở dữ liệu của bạn"}/><Stat icon={<Boxes/>} label="Tài nguyên cloud" value={assetCount === null ? "—" : String(assetCount)} change={assetCount === null ? "Đăng nhập" : "R2"} positive={assetCount !== null} hint={assetCount === null ? "Cần phiên đăng nhập" : "Tài nguyên thuộc tài khoản"}/><Stat icon={<Gauge/>} label="API Worker" value={apiStatus === "online" ? "Online" : apiStatus === "checking" ? "..." : apiStatus === "offline" ? "Offline" : "Chưa cấu hình"} change={apiVersion || "API"} positive={apiStatus === "online"} hint={apiStatus === "online" ? "Health endpoint phản hồi" : "Kiểm tra URL và Worker"}/><Stat icon={<ShieldCheck/>} label="Xác thực" value={sessionToken && userEmail ? "Đã đăng nhập" : "Chưa đăng nhập"} change={sessionToken ? "JWT" : "API"} positive={Boolean(sessionToken && userEmail)} hint={userEmail || "Đăng nhập để quản lý dữ liệu"}/></div>
      <div className="section-grid"><section className="panel usage-panel"><div className="panel-heading"><div><h2>Sức khỏe hệ thống</h2><p>Trạng thái dịch vụ theo thời gian thực</p></div><span className={`status-pill ${apiStatus === "online" ? "" : "status-alert"}`}><i/> {apiStatus === "online" ? "API hoạt động" : apiStatus === "checking" ? "Đang kiểm tra" : apiStatus === "offline" ? "API không phản hồi" : "Chưa cấu hình API"}</span></div><div className="health-list"><Health icon={<Cloud/>} name="Cloudflare Worker" detail={apiVersion ? "API version " + apiVersion : "Health endpoint"} online={apiStatus === "online"} status={apiStatus === "online" ? "Online" : apiStatus === "checking" ? "Checking" : "Unavailable"}/><Health icon={<Bot/>} name="D1 Database" detail="Project and user data binding" online={Boolean(healthCapabilities?.databaseConfigured)} status={healthCapabilities?.databaseConfigured ? "Configured" : "Not configured"}/><Health icon={<Workflow/>} name="R2 Asset Storage" detail="Private uploaded assets" online={Boolean(healthCapabilities?.objectStorageConfigured)} status={healthCapabilities?.objectStorageConfigured ? "Configured" : "Not configured"}/><Health icon={<ShieldCheck/>} name="JWT authentication" detail="Bearer session validation" online={Boolean(healthCapabilities?.authenticationConfigured)} status={healthCapabilities?.authenticationConfigured ? "Configured" : "Not configured"}/></div><div className="uptime"><div><span>Metrics 30 ngày</span><b>Chưa có nguồn dữ liệu</b></div><div className="uptime-note">Kết nối Cloudflare Analytics hoặc hệ thống giám sát để hiển thị uptime thực. Không hiển thị số liệu giả.</div></div></section>
        <section className="panel activity-panel"><div className="panel-heading"><div><h2>Hoạt động gần đây</h2><p>Log sự kiện chưa được nối; các mục dưới là dữ liệu minh họa</p></div><button className="link-button" onClick={() => setActive("Dịch vụ & API")}>Xem nhật ký <ArrowUpRight size={14}/></button></div><div className="activity-list"><ActivityItem icon={<CheckCircle2/>} color="green" title="Worker API hoạt động bình thường" detail="Kiểm tra sức khỏe hoàn tất" time="2 phút trước"/><ActivityItem icon={<Users/>} color="blue" title="24 người dùng mới" detail="Đăng ký qua Web Studio" time="18 phút trước"/><ActivityItem icon={<Zap/>} color="purple" title="Đã hoàn thành 18 lượt render" detail="Render Queue · Batch #221" time="36 phút trước"/><ActivityItem icon={<ShieldCheck/>} color="orange" title="Đã cập nhật chính sách bảo mật" detail="Quyền truy cập quản trị" time="1 giờ trước"/></div></section></div>
      <section className="panel projects-panel"><div className="panel-heading project-heading"><div><h2>Dự án gần đây</h2><p>Trạng thái xử lý và hoạt động biên tập mới nhất</p></div><div className="table-actions"><label className="search-box"><Search size={15}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm dự án..."/></label><button className="btn-secondary small" onClick={() => setActive("Dự án video")}>Tất cả dự án <ArrowUpRight size={14}/></button></div></div><div className="table-wrap"><table><thead><tr><th>TÊN DỰ ÁN</th><th>MÃ DỰ ÁN</th><th>TRẠNG THÁI</th><th>CẬP NHẬT</th><th>THỜI LƯỢNG</th><th/></tr></thead><tbody>{filtered.map((project) => <tr key={project.id}><td><div className="project-name"><div className="project-thumb"><Video size={16}/></div><b>{project.name}</b></div></td><td><code>{project.id}</code></td><td><span className={`project-status ${project.status}`}><i/>{project.status === "processing" ? "Đang xử lý" : project.status === "completed" ? "Hoàn tất" : project.status === "draft" ? "Bản nháp" : "Thất bại"}</span></td><td>{formatDate(project.updatedAt)}</td><td>{project.durationSeconds ? Math.floor(project.durationSeconds/60) + ":" + String(project.durationSeconds%60).padStart(2,"0") : "—"}</td><td><button className="dots" aria-label={`Tùy chọn ${project.name}`}>···</button></td></tr>)}</tbody></table>{filtered.length===0 && <div className="empty-state">Không tìm thấy dự án phù hợp.</div>}</div><div className="table-footer"><span>Hiển thị <b>{filtered.length}</b> trên <b>{activeProjects.length}</b> {cloudProjects === null ? "dự án minh họa — đăng nhập để tải D1" : "dự án trong tài khoản"}</span><div className="pagination"><button disabled>Trước</button><button className="selected">1</button><button disabled>Tiếp</button></div></div></section>
      <footer className="page-footer"><span>© 2026 Hendy Studio. All rights reserved.</span><span><i className={apiStatus === "online" ? "footer-dot-online" : "footer-dot-offline"}/> API status: {apiStatus} <b>·</b> Version {apiVersion || "—"}</span></footer>
      </div>
    </main>
      {showAuth && <div className="admin-auth-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowAuth(false); }}>
        <form className="admin-auth-dialog" onSubmit={submitLogin}>
          <div className="admin-auth-head"><div><span><ShieldCheck size={18}/></span><div><b>Đăng nhập quản trị</b><small>Bearer token · Hạn 8 giờ</small></div></div><button type="button" onClick={() => setShowAuth(false)} aria-label="Đóng">×</button></div>
          {sessionToken && userEmail ? <div className="admin-auth-user"><b>{userEmail}</b><small>Đã đăng nhập vào Hendy API</small><button type="button" onClick={signOut}>Đăng xuất</button></div> : <>
            <label>Email<input type="email" autoComplete="username" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} required placeholder="owner@example.com"/></label>
            <label>Mật khẩu<input type="password" autoComplete="current-password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} required minLength={12} maxLength={128} placeholder="Ít nhất 12 ký tự"/></label>
            {authError && <p className="admin-auth-error">{authError}</p>}
            <p className="admin-auth-help">Tạo tài khoản đầu tiên từ terminal bằng <code>npm run bootstrap:admin</code>.</p>
            <button className="admin-auth-submit" type="submit" disabled={authBusy || apiStatus === "unconfigured"}>{authBusy ? "Đang xác thực…" : "Đăng nhập"}</button>
          </>}
        </form>
      </div>}
  </div>;
}
function Stat({icon,label,value,change,positive,hint}:{icon:ReactNode;label:string;value:string;change:string;positive:boolean;hint:string}){return <article className="stat-card"><div className="stat-top"><span className="stat-icon">{icon}</span><span className={`trend ${positive?"up":"down"}`}>{positive?<ArrowUpRight size={13}/>:<ArrowDownRight size={13}/>} {change}</span></div><div className="stat-label">{label}</div><div className="stat-value">{value}</div><div className="stat-hint">{hint}</div><div className="sparkline">{[20,31,26,40,35,58,49,64,52,78,68,88].map((v,i)=><i key={i} style={{height:`${v}%`}}/>)}</div></article>}
function Health({icon,name,detail,online,status}:{icon:ReactNode;name:string;detail:string;online:boolean;status:string}){return <div className="health-row"><span className="health-icon">{icon}</span><div className="health-copy"><b>{name}</b><small>{detail}</small></div><span className={`health-ok ${online?"":"health-offline"}`}><i/> {status}</span></div>}
function ActivityItem({icon,color,title,detail,time}:{icon:ReactNode;color:string;title:string;detail:string;time:string}){return <div className="activity-row"><span className={`activity-icon ${color}`}>{icon}</span><div className="activity-copy"><b>{title}</b><small>{detail}</small></div><time>{time}</time></div>}
