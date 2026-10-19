import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  AudioLines, Check, ChevronDown, CircleHelp, Clapperboard, CloudUpload, FileVideo2,
  Film, FolderOpen, Grid2X2, Layers, Maximize2, Mic2, MoreHorizontal, Music2,
  Pause, Play, Plus, Redo2, Scissors, Settings2, ShieldCheck, Sparkles, Subtitles, Undo2,
  Volume2, WandSparkles, ZoomIn, ZoomOut,
} from "lucide-react";
import type { RenderManifest } from "@hendy/shared-types";
import { clearAccessToken, createProject, getAccessToken, getApiMeta, getCurrentUser, isApiConfigured, listAssets, login, saveProject, uploadAsset, validateRenderManifest } from "./api";

type Clip = {
  id: number;
  name: string;
  start: number;
  duration: number;
  color: "violet" | "blue" | "green" | "orange";
  track: number;
  assetId?: string;
};
type AssetKind = "video" | "audio" | "subtitle" | "image" | "effect";
type Asset = { icon: typeof FileVideo2; name: string; detail: string; kind: AssetKind; cloudId?: string; mimeType?: string };
type SavedProject = {
  version: 1;
  projectId: string;
  timelineName: string;
  clips: Clip[];
  playheadSeconds: number;
  zoom: number;
  selectedClipId: number | null;
  selectedAssetName: string;
  showSubtitles?: boolean;
  strokeEnabled?: boolean;
  shadowEnabled?: boolean;
  duckEnabled?: boolean;
  subtitleColor?: string;
};
type ApiState = "checking" | "online" | "offline" | "unconfigured";
type NoticeKind = "success" | "warning" | "error" | "info";

const PROJECT_DURATION = 84;
const FRAME_RATE = 24;
const STORAGE_KEY = "hendy-studio-project-v1";
const originalClips: Clip[] = [
  { id: 1, name: "intro_scene.mp4", start: 0, duration: 23, color: "violet", track: 0 },
  { id: 2, name: "main_footage.mp4", start: 23, duration: 39, color: "blue", track: 0 },
  { id: 3, name: "outro_scene.mp4", start: 62, duration: 22, color: "violet", track: 0 },
  { id: 4, name: "vietsub_vi.srt", start: 7, duration: 73, color: "green", track: 1 },
  { id: 5, name: "background_music.wav", start: 0, duration: 84, color: "orange", track: 2 },
];
const sourceAssets: Asset[] = [
  { icon: FileVideo2, name: "intro_scene.mp4", detail: "1920 × 1080 · 00:12", kind: "video" },
  { icon: FileVideo2, name: "main_footage.mp4", detail: "1920 × 1080 · 00:34", kind: "video" },
  { icon: Subtitles, name: "vietsub_vi.srt", detail: "48 dòng phụ đề", kind: "subtitle" },
  { icon: Music2, name: "background_music.wav", detail: "WAV · 48 kHz", kind: "audio" },
];

function makeProjectId(): string {
  try { return `local-${crypto.randomUUID()}`; }
  catch { return `local-${Date.now()}`; }
}

function isClip(value: unknown): value is Clip {
  if (!value || typeof value !== "object") return false;
  const clip = value as Record<string, unknown>;
  return Number.isInteger(clip.id)
    && typeof clip.name === "string"
    && typeof clip.start === "number" && Number.isFinite(clip.start) && clip.start >= 0
    && typeof clip.duration === "number" && Number.isFinite(clip.duration) && clip.duration > 0
    && ["violet", "blue", "green", "orange"].includes(String(clip.color))
    && typeof clip.track === "number" && Number.isInteger(clip.track) && clip.track >= 0 && clip.track <= 3;
}

function readSavedProject(): SavedProject | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const project = value as Partial<SavedProject>;
    if (project.version !== 1 || !Array.isArray(project.clips) || !project.clips.every(isClip)) return null;
    return {
      version: 1,
      projectId: typeof project.projectId === "string" ? project.projectId : makeProjectId(),
      timelineName: typeof project.timelineName === "string" && project.timelineName.trim() ? project.timelineName : "Video giới thiệu — Vietsub Pro",
      clips: project.clips,
      playheadSeconds: typeof project.playheadSeconds === "number" && Number.isFinite(project.playheadSeconds)
        ? Math.min(PROJECT_DURATION, Math.max(0, project.playheadSeconds)) : 0,
      zoom: typeof project.zoom === "number" && Number.isFinite(project.zoom) ? Math.min(1.5, Math.max(0.7, project.zoom)) : 1,
      selectedClipId: typeof project.selectedClipId === "number" ? project.selectedClipId : null,
      selectedAssetName: typeof project.selectedAssetName === "string" ? project.selectedAssetName : sourceAssets[0].name,
      showSubtitles: typeof project.showSubtitles === "boolean" ? project.showSubtitles : true,
      strokeEnabled: typeof project.strokeEnabled === "boolean" ? project.strokeEnabled : true,
      shadowEnabled: typeof project.shadowEnabled === "boolean" ? project.shadowEnabled : false,
      duckEnabled: typeof project.duckEnabled === "boolean" ? project.duckEnabled : true,
      subtitleColor: typeof project.subtitleColor === "string" && /^#[0-9a-f]{6}$/i.test(project.subtitleColor) ? project.subtitleColor : "#ffffff",
    };
  } catch {
    return null;
  }
}

function formatTimecode(seconds: number): string {
  const totalFrames = Math.max(0, Math.round(seconds * FRAME_RATE));
  const frames = totalFrames % FRAME_RATE;
  const totalSeconds = Math.floor(totalFrames / FRAME_RATE);
  const secs = totalSeconds % 60;
  const mins = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return [hours, mins, secs, frames].map((part) => String(part).padStart(2, "0")).join(":");
}

function toManifest(projectId: string, clips: Clip[]): RenderManifest {
  const trackKinds: Array<RenderManifest["tracks"][number]["kind"]> = ["video", "subtitle", "audio", "audio"];
  return {
    version: 1,
    projectId,
    output: { width: 1920, height: 1080, fps: FRAME_RATE, format: "mp4" },
    tracks: trackKinds.map((kind, trackIndex) => ({
      id: `track-${trackIndex + 1}`,
      kind,
      clips: clips.filter((clip) => clip.track === trackIndex).map((clip) => ({
        id: `clip-${clip.id}`,
        assetId: clip.assetId || clip.name,
        start: clip.start,
        duration: clip.duration,
      })),
    })),
  };
}

export default function App() {
  const [loadedProject] = useState(readSavedProject);
  const [tab, setTab] = useState("Media");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [assetSearch, setAssetSearch] = useState("");
  const [assets, setAssets] = useState<Asset[]>(sourceAssets);
  const [apiToken, setApiToken] = useState(getAccessToken);
  const [userEmail, setUserEmail] = useState("");
  const [showAuth, setShowAuth] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [cloudProjectId, setCloudProjectId] = useState("");
  const [selectedAssetName, setSelectedAssetName] = useState(loadedProject?.selectedAssetName ?? sourceAssets[0].name);
  const [selectedClipId, setSelectedClipId] = useState<number | null>(loadedProject ? loadedProject.selectedClipId : 2);
  const [playing, setPlaying] = useState(false);
  const [playheadSeconds, setPlayheadSeconds] = useState(loadedProject?.playheadSeconds ?? 2);
  const [zoom, setZoom] = useState(loadedProject?.zoom ?? 1);
  const [clips, setClips] = useState<Clip[]>(loadedProject?.clips ?? originalClips);
  const [timelineName, setTimelineName] = useState(loadedProject?.timelineName ?? "Video giới thiệu — Vietsub Pro");
  const [showSubtitles, setShowSubtitles] = useState(loadedProject?.showSubtitles ?? true);
  const [strokeEnabled, setStrokeEnabled] = useState(loadedProject?.strokeEnabled ?? true);
  const [shadowEnabled, setShadowEnabled] = useState(loadedProject?.shadowEnabled ?? false);
  const [duckEnabled, setDuckEnabled] = useState(loadedProject?.duckEnabled ?? true);
  const [subtitleColor, setSubtitleColor] = useState(loadedProject?.subtitleColor ?? "#ffffff");
  const [projectId] = useState(loadedProject?.projectId ?? makeProjectId());
  const [undoStack, setUndoStack] = useState<Clip[][]>([]);
  const [redoStack, setRedoStack] = useState<Clip[][]>([]);
  const [saveStatus, setSaveStatus] = useState("Đã lưu cục bộ");
  const [apiStatus, setApiStatus] = useState<ApiState>(isApiConfigured ? "checking" : "unconfigured");
  const [apiVersion, setApiVersion] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeKind, setNoticeKind] = useState<NoticeKind>("info");
  const [noticeId, setNoticeId] = useState(0);
  const rulerViewportRef = useRef<HTMLDivElement | null>(null);
  const timelineContentRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const selectedClip = clips.find((clip) => clip.id === selectedClipId) ?? null;
  const time = useMemo(() => formatTimecode(playheadSeconds), [playheadSeconds]);
  const visibleAssets = assets.filter((asset) => {
    const matchesTab = tab === "Media"
      || (tab === "Audio" && asset.kind === "audio")
      || (tab === "Text" && asset.kind === "subtitle")
      || (tab === "Effects" && asset.kind === "effect");
    const matchesCategory = categoryFilter === "All"
      || (categoryFilter === "Video" && asset.kind === "video")
      || (categoryFilter === "Audio" && asset.kind === "audio")
      || (categoryFilter === "Text" && asset.kind === "subtitle");
    return matchesTab && matchesCategory && asset.name.toLowerCase().includes(assetSearch.trim().toLowerCase());
  });

  function showNotice(message: string, kind: NoticeKind = "info") {
    setNotice(message);
    setNoticeKind(kind);
    setNoticeId((current) => current + 1);
  }

  function commitClips(nextClips: Clip[]) {
    setUndoStack((current) => [...current.slice(-49), clips.map((clip) => ({ ...clip }))]);
    setRedoStack([]);
    setClips(nextClips);
  }

  function undo() {
    if (!undoStack.length) return;
    setRedoStack((current) => [...current, clips.map((clip) => ({ ...clip }))]);
    setClips(undoStack[undoStack.length - 1]);
    setUndoStack((current) => current.slice(0, -1));
    showNotice("Đã hoàn tác thay đổi timeline.", "success");
  }

  function redo() {
    if (!redoStack.length) return;
    setUndoStack((current) => [...current, clips.map((clip) => ({ ...clip }))]);
    setClips(redoStack[redoStack.length - 1]);
    setRedoStack((current) => current.slice(0, -1));
    showNotice("Đã khôi phục thay đổi timeline.", "success");
  }

  function resetTimeline() {
    commitClips(originalClips.map((clip) => ({ ...clip })));
    setSelectedClipId(2);
    setPlayheadSeconds(2);
    setShowSubtitles(true);
    setStrokeEnabled(true);
    setShadowEnabled(false);
    setDuckEnabled(true);
    setSubtitleColor("#ffffff");
    showNotice("Timeline đã được đặt về mẫu ban đầu.", "success");
  }

  function seekFromPointer(clientX: number) {
    const rect = timelineContentRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const position = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setPlayheadSeconds(position * PROJECT_DURATION);
  }

  function splitSelectedClip() {
    if (!selectedClip) {
      showNotice("Hãy chọn một clip trên timeline trước khi cắt.", "warning");
      return;
    }
    const splitAt = playheadSeconds;
    const clipEnd = selectedClip.start + selectedClip.duration;
    if (splitAt <= selectedClip.start + 0.05 || splitAt >= clipEnd - 0.05) {
      showNotice("Đưa playhead vào bên trong clip đang chọn rồi thử cắt lại.", "warning");
      return;
    }
    const nextId = Math.max(0, ...clips.map((clip) => clip.id)) + 1;
    const leftDuration = splitAt - selectedClip.start;
    const rightClip: Clip = { ...selectedClip, id: nextId, start: splitAt, duration: clipEnd - splitAt };
    const nextClips = clips.flatMap((clip) => clip.id === selectedClip.id
      ? [{ ...clip, duration: leftDuration }, rightClip]
      : [clip]);
    commitClips(nextClips);
    setSelectedClipId(nextId);
    showNotice(`Đã cắt “${selectedClip.name}” tại ${formatTimecode(splitAt)}.`, "success");
  }

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isApiConfigured) {
      showNotice("Chưa cấu hình VITE_API_BASE_URL. Sao chép apps/studio-web/.env.example thành .env.local và đặt URL Worker.", "warning");
      return;
    }
    setAuthBusy(true);
    try {
      const session = await login(authEmail.trim(), authPassword);
      setApiToken(session.token);
      setUserEmail(session.user.email);
      setAuthPassword("");
      setShowAuth(false);
      showNotice("Đăng nhập thành công: " + session.user.email, "success");
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Đăng nhập thất bại.", "error");
    } finally {
      setAuthBusy(false);
    }
  }

  function signOut() {
    clearAccessToken();
    setApiToken("");
    setUserEmail("");
    setAssets(sourceAssets);
    setCloudProjectId("");
    showNotice("Đã đăng xuất API.", "info");
  }

  async function handleFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = "";
    if (!files.length) return;
    if (!apiToken) {
      setShowAuth(true);
      showNotice("Đăng nhập trước khi upload tài nguyên lên cloud.", "warning");
      return;
    }
    setUploadBusy(true);
    let uploadedCount = 0;
    try {
      for (const file of files) {
        const result = await uploadAsset(file);
        const mime = result.asset.mime_type.toLowerCase();
        const kind: AssetKind = mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : (mime.startsWith("text/") || mime.includes("subrip")) ? "subtitle" : "image";
        const Icon = kind === "audio" ? Music2 : kind === "subtitle" ? Subtitles : FileVideo2;
        const size = result.asset.size_bytes >= 1024 * 1024 ? (result.asset.size_bytes / (1024 * 1024)).toFixed(1) + " MB" : Math.max(1, Math.round(result.asset.size_bytes / 1024)) + " KB";
        const asset: Asset = { icon: Icon, name: result.asset.name, detail: size + " · cloud", kind, cloudId: result.asset.id, mimeType: mime };
        setAssets((current) => [asset, ...current.filter((item) => item.cloudId !== asset.cloudId)]);
        setSelectedAssetName(asset.name);
        uploadedCount++;
      }
      showNotice("Đã upload " + uploadedCount + " tài nguyên lên R2.", "success");
    } catch (error) {
      showNotice((error instanceof Error ? error.message : "Upload thất bại.") + (uploadedCount ? " Đã upload thành công " + uploadedCount + " file trước đó." : ""), "error");
    } finally {
      setUploadBusy(false);
    }
  }

  function addSelectedAssetToTimeline() {
    const asset = assets.find((item) => item.name === selectedAssetName);
    if (!asset) {
      showNotice("Chọn một tài nguyên trước.", "warning");
      return;
    }
    if (!asset.cloudId) {
      showNotice("Đây là tài nguyên minh họa. Upload file thật lên R2 rồi chọn tài nguyên cloud để dùng trong timeline.", "warning");
      return;
    }
    const track = asset.kind === "audio" ? 2 : asset.kind === "subtitle" ? 1 : selectedClip?.track ?? 0;
    const color: Clip["color"] = asset.kind === "audio" ? "orange" : asset.kind === "subtitle" ? "green" : "blue";
    if (selectedClip) {
      commitClips(clips.map((clip) => clip.id === selectedClip.id ? { ...clip, name: asset.name, assetId: asset.cloudId, color, track } : clip));
      showNotice("Đã thay media clip đang chọn bằng tài nguyên cloud.", "success");
      return;
    }
    const nextId = Math.max(0, ...clips.map((clip) => clip.id)) + 1;
    const duration = asset.kind === "subtitle" || asset.kind === "audio" ? Math.max(1, PROJECT_DURATION - playheadSeconds) : Math.min(10, Math.max(1, PROJECT_DURATION - playheadSeconds));
    commitClips([...clips, { id: nextId, name: asset.name, assetId: asset.cloudId, start: playheadSeconds, duration, color, track }]);
    setSelectedClipId(nextId);
    showNotice("Đã thêm tài nguyên cloud vào timeline.", "success");
  }

  async function saveTimelineToCloud() {
    if (!isApiConfigured) {
      showNotice("Chưa cấu hình API URL.", "warning");
      return;
    }
    if (!apiToken) {
      setShowAuth(true);
      showNotice("Đăng nhập để lưu dự án lên cloud.", "warning");
      return;
    }
    setSaveStatus("Đang đồng bộ…");
    try {
      let targetId = cloudProjectId;
      if (!targetId) {
        const created = await createProject(timelineName);
        targetId = created.project.id;
        setCloudProjectId(targetId);
      }
      const missingMedia = clips.filter((clip) => !clip.assetId);
      if (missingMedia.length) {
        await saveProject(targetId, { name: timelineName });
        setSaveStatus("Đã lưu tên dự án cloud");
        showNotice("Đã lưu tên dự án lên cloud. Timeline chưa đồng bộ vì còn " + missingMedia.length + " clip minh họa chưa gắn file R2; chọn từng clip, chọn file cloud và bấm + để thay media.", "warning");
        return;
      }
      const manifest = toManifest(targetId, clips);
      await validateRenderManifest(manifest);
      await saveProject(targetId, { name: timelineName, manifest });
      setSaveStatus("Đã đồng bộ cloud");
      showNotice("Đã lưu dự án và manifest lên D1.", "success");
    } catch (error) {
      setSaveStatus("Lỗi đồng bộ");
      showNotice(error instanceof Error ? error.message : "Không thể đồng bộ dự án lên cloud.", "error");
    }
  }

  async function checkManifestWithApi() {
    if (!isApiConfigured) {
      showNotice("API chưa được cấu hình. Bản nháp vẫn tự lưu trong trình duyệt; hãy đặt VITE_API_BASE_URL để kiểm tra manifest qua Worker.", "warning");
      return;
    }
    setApiStatus("checking");
    try {
      const result = await validateRenderManifest(toManifest(projectId, clips));
      setApiStatus("online");
      showNotice(`Manifest hợp lệ: ${result.clipCount} clip, ${result.trackCount} track. API hiện chỉ xác thực cấu trúc, chưa lưu cloud hoặc render video.`, "success");
    } catch (error) {
      setApiStatus("offline");
      showNotice(error instanceof Error ? error.message : "Không thể kiểm tra manifest qua API.", "error");
    }
  }

  useEffect(() => {
    if (!isApiConfigured || !apiToken) return;
    let active = true;
    Promise.all([getCurrentUser(), listAssets()]).then(([session, response]) => {
      if (!active) return;
      setUserEmail(session.user.email);
      const cloudAssets: Asset[] = response.assets.map((asset) => {
        const mime = asset.mime_type.toLowerCase();
        const kind: AssetKind = mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : (mime.startsWith("text/") || mime.includes("subrip")) ? "subtitle" : "image";
        const Icon = kind === "audio" ? Music2 : kind === "subtitle" ? Subtitles : FileVideo2;
        const size = asset.size_bytes >= 1024 * 1024 ? (asset.size_bytes / (1024 * 1024)).toFixed(1) + " MB" : Math.max(1, Math.round(asset.size_bytes / 1024)) + " KB";
        return { icon: Icon, name: asset.name, detail: size + " · cloud", kind, cloudId: asset.id, mimeType: mime };
      });
      setAssets((current) => [...cloudAssets, ...sourceAssets.filter((sample) => !cloudAssets.some((remote) => remote.name === sample.name))]);
    }).catch(() => {
      if (!active) return;
      clearAccessToken();
      setApiToken("");
      setUserEmail("");
      showNotice("Phiên API đã hết hạn. Hãy đăng nhập lại.", "warning");
    });
    return () => { active = false; };
  }, [apiToken]);

  useEffect(() => {
    if (!isApiConfigured) {
      setApiStatus("unconfigured");
      return;
    }
    let active = true;
    getApiMeta().then((meta) => {
      if (!active) return;
      setApiStatus("online");
      setApiVersion(meta.version);
    }).catch(() => {
      if (active) setApiStatus("offline");
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setPlayheadSeconds((current) => Math.min(PROJECT_DURATION, current + 0.25));
    }, 250);
    return () => window.clearInterval(timer);
  }, [playing]);

  useEffect(() => {
    if (playing && playheadSeconds >= PROJECT_DURATION) setPlaying(false);
  }, [playing, playheadSeconds]);

  useEffect(() => {
    if (playing) return;
    setSaveStatus("Đang lưu…");
    const timer = window.setTimeout(() => {
      try {
        const project: SavedProject = {
          version: 1,
          projectId,
          timelineName,
          clips,
          playheadSeconds,
          zoom,
          selectedClipId,
          selectedAssetName,
          showSubtitles,
          strokeEnabled,
          shadowEnabled,
          duckEnabled,
          subtitleColor,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
        setSaveStatus("Đã lưu cục bộ");
      } catch {
        setSaveStatus("Không lưu được");
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [projectId, timelineName, clips, playheadSeconds, zoom, selectedClipId, selectedAssetName, showSubtitles, strokeEnabled, shadowEnabled, duckEnabled, subtitleColor, playing]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const key = event.key.toLowerCase();
      if (key === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      else if (key === "y") { event.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undoStack, redoStack, clips]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => {
      setNotice("");
    }, 5200);
    return () => window.clearTimeout(timer);
  }, [noticeId, notice]);

  function renameProject() {
    const nextName = window.prompt("Tên dự án", timelineName);
    if (nextName?.trim()) setTimelineName(nextName.trim().slice(0, 200));
  }

  return <div className="studio-shell">
    <header className="studio-top">
      <a className="studio-logo" href="#"><span><Clapperboard size={18}/></span>hendy<span className="logo-pro">PRO</span></a>
      <div className="top-divider"/>
      <button className="project-title" onClick={renameProject}>{timelineName}<ChevronDown size={14}/></button>
      <span className={`saved-state ${saveStatus === "Không lưu được" ? "save-error" : ""}`} title="Dữ liệu bản nháp được lưu trong localStorage của trình duyệt"><i/> {saveStatus}</span>
      <span className={`api-state api-${apiStatus}`} title={apiVersion ? `API version ${apiVersion}` : "Trạng thái API"}>API: {apiStatus === "checking" ? "đang kiểm tra" : apiStatus === "online" ? "kết nối" : apiStatus === "offline" ? "ngoại tuyến" : "chưa cấu hình"}</span>
      <div className="top-spacer"/>
      <button className="tool-btn" title="Undo" onClick={undo} disabled={!undoStack.length}><Undo2 size={16}/></button>
      <button className="tool-btn" title="Redo" onClick={redo} disabled={!redoStack.length}><Redo2 size={16}/></button>
      <button className="tool-btn help-btn" title="Trợ giúp" onClick={() => showNotice("Mẹo: chọn clip, đặt playhead bên trong clip rồi dùng nút kéo để tách. Dùng Ctrl+Z để hoàn tác, Ctrl+Y hoặc Ctrl+Shift+Z để làm lại.", "info")}><CircleHelp size={16}/></button>
      <button className="cloud-btn" onClick={apiToken ? saveTimelineToCloud : checkManifestWithApi}><CloudUpload size={15}/> {apiToken ? "Lưu cloud" : "Kiểm tra API"}</button>
      <button className="export-btn" onClick={() => showNotice("Xuất MP4 chưa khả dụng: cần tích hợp render worker/FFmpeg và kho lưu trữ. Chưa có video nào được tạo.", "warning")}><Sparkles size={15}/> Xuất video</button>
      <button className="user-puck user-puck-button" title={apiToken ? "Đã đăng nhập: " + userEmail : "Đăng nhập API"} onClick={() => setShowAuth(true)}>{apiToken ? "✓" : "GD"}</button>
    </header>

    <div className="studio-workspace">
      <aside className="asset-sidebar">
        <div className="side-tabs">{[{label:"Media",icon:Film},{label:"Audio",icon:AudioLines},{label:"Text",icon:Subtitles},{label:"Effects",icon:WandSparkles}].map(({label,icon:Icon})=><button key={label} className={tab===label?"current":""} onClick={()=>{setTab(label);setCategoryFilter("All");}}><Icon size={17}/><span>{label}</span></button>)}</div>
        <div className="asset-head"><div><b>{tab === "Media"?"Thư viện media":tab === "Audio"?"Thư viện âm thanh":tab === "Text"?"Phụ đề & văn bản":"Hiệu ứng"}</b><small>{apiToken ? "Cloud assets · " + userEmail : "Project assets"}</small></div><button title="Thêm tài nguyên đã chọn vào timeline (hoặc thay clip đang chọn)" onClick={addSelectedAssetToTimeline}><Plus size={16}/></button></div>
        <button className="import-drop" onClick={() => { if (!apiToken) { setShowAuth(true); return; } fileInputRef.current?.click(); }} disabled={uploadBusy}><CloudUpload size={20}/><b>{uploadBusy ? "Đang upload…" : "Nhập tài nguyên"}</b><span>{apiToken ? "Tải file lên R2 · tối đa 20 MB/file" : "Đăng nhập để upload lên cloud"}</span></button>
        <input ref={fileInputRef} className="file-picker-hidden" type="file" multiple accept="video/mp4,video/webm,video/quicktime,audio/mpeg,audio/mp4,audio/wav,audio/ogg,text/vtt,.srt,.vtt,image/jpeg,image/png,image/webp" onChange={handleFilesSelected} />
        <div className="asset-search"><span>⌕</span><input aria-label="Tìm trong thư viện" value={assetSearch} onChange={(event)=>setAssetSearch(event.target.value)} placeholder="Tìm trong thư viện"/></div>
        <div className="asset-categories">
          <button className={categoryFilter==="All"?"chosen":""} onClick={()=>setCategoryFilter("All")}><FolderOpen size={13}/> Tất cả <span>{assets.length}</span></button>
          <button className={categoryFilter==="Video"?"chosen":""} onClick={()=>setCategoryFilter("Video")}><Film size={13}/> Video <span>{assets.filter((asset)=>asset.kind==="video").length}</span></button>
          <button className={categoryFilter==="Audio"?"chosen":""} onClick={()=>setCategoryFilter("Audio")}><Music2 size={13}/> Âm thanh <span>{assets.filter((asset)=>asset.kind==="audio").length}</span></button>
          <button className={categoryFilter==="Text"?"chosen":""} onClick={()=>setCategoryFilter("Text")}><Subtitles size={13}/> Phụ đề <span>{assets.filter((asset)=>asset.kind==="subtitle").length}</span></button>
        </div>
        <div className="asset-list">
          {visibleAssets.map(({icon:Icon,name,detail},i)=><button key={name} className={`asset-item ${selectedAssetName===name?"asset-selected":""}`} onClick={()=>setSelectedAssetName(name)}><div className={`asset-thumb thumb-${i}`}><Icon size={19}/>{name.endsWith(".mp4")&&<span className="thumb-play"><Play size={9} fill="currentColor"/></span>}</div><span className="asset-description"><b>{name}</b><small>{detail}</small></span><MoreHorizontal size={15}/></button>)}
          {visibleAssets.length === 0 && <div className="asset-empty">Không tìm thấy tài nguyên phù hợp.</div>}
        </div>
        <div className="storage-footer"><span>Không gian làm việc</span><div className="storage-track"><i/></div><small>1,8 GB <b>/ 10 GB · số liệu mẫu</b></small></div>
      </aside>

      <main className="editor-main">
        <div className="canvas-header"><div><span className="section-kicker">CANVAS PREVIEW</span><b>Khung xem trước</b></div><div className="canvas-modes"><button className="mode-on"><Grid2X2 size={13}/> Preview</button><button onClick={()=>showNotice("Fit là chế độ bố cục mẫu; preview hiện chưa phát file media thật.","info")}><Maximize2 size={13}/> Fit</button><button title="Tùy chọn khung" onClick={()=>showNotice("Độ phân giải mục tiêu hiện là 1920 × 1080, 24 FPS.","info")}><Settings2 size={14}/></button></div></div>
        <div className="preview-stage"><div className="video-frame"><div className="frame-background"><div className="frame-glow"/><div className="frame-orb orb-one"/><div className="frame-orb orb-two"/><div className="frame-grid"/><div className="frame-copy"><span>HENDY CREATIVE LAB</span><strong>MAKE<br/><em>IT</em> <b>MATTER.</b></strong><small>CREATE · EDIT · TELL YOUR STORY</small></div><div className="frame-tag">VST / 024</div><div className="frame-watermark">H</div>{showSubtitles && <div className="subtitle-preview" style={{color:subtitleColor,textShadow:strokeEnabled?"0 2px 3px #000, 1px 0 2px #000, -1px 0 2px #000":shadowEnabled?"0 2px 4px #0009":"none"}}>Biến ý tưởng của bạn thành câu chuyện.</div>}</div><div className="frame-time">{time}</div></div><div className="preview-side-label">16:9 <span>·</span> 1080p</div></div>
        <div className="player-controls"><div className="play-controls"><button title="Về đầu" onClick={()=>{setPlayheadSeconds(0);setPlaying(false);}}>↤</button><button className="play-main" title={playing?"Tạm dừng":"Phát timeline"} onClick={()=>{if(playheadSeconds>=PROJECT_DURATION)setPlayheadSeconds(0);setPlaying((value)=>!value);}}>{playing?<Pause size={15} fill="currentColor"/>:<Play size={16} fill="currentColor"/>}</button><button title="Tiến 5 giây" onClick={()=>setPlayheadSeconds((value)=>Math.min(PROJECT_DURATION,value+5))}>↦</button></div><div className="time-display"><b>{time}</b><span> / {formatTimecode(PROJECT_DURATION)}</span></div><div className="control-spacer"/><button className="tool-btn" title="Âm lượng" onClick={()=>showNotice("Điều khiển âm lượng sẽ có hiệu lực khi media player được tích hợp.","info")}><Volume2 size={15}/></button><button className="tool-btn" title="Toàn màn hình" onClick={()=>showNotice("Chế độ toàn màn hình chưa được nối với player.","info")}><Maximize2 size={15}/></button></div>

        <div className="timeline-toolbar"><div className="timeline-title"><Layers size={15}/><b>Timeline</b><span className="timeline-badge">4 tracks</span></div><div className="timeline-actions"><button title="Split clip tại playhead" onClick={splitSelectedClip}><Scissors size={14}/></button><button title="Dạng sóng âm thanh (minh họa)" onClick={()=>showNotice("Waveform hiện được minh họa bằng đồ họa, chưa phân tích từ file WAV.","info")}><AudioLines size={14}/></button><span className="toolbar-separator"/><button title="Zoom out" onClick={()=>setZoom((value)=>Math.max(.7,Math.round((value-.1)*10)/10))}><ZoomOut size={14}/></button><div className="zoom-bar"><i style={{width:`${((zoom-.7)/.8)*100}%`}}/></div><button title="Zoom in" onClick={()=>setZoom((value)=>Math.min(1.5,Math.round((value+.1)*10)/10))}><ZoomIn size={14}/></button><span className="zoom-value">{Math.round(zoom*100)}%</span></div></div>
        <div className="timeline-ruler"><div className="ruler-spacer"/><div className="ruler-viewport" ref={rulerViewportRef}><div className="ruler-scale" style={{width:`${zoom*100}%`}}>{Array.from({length:9},(_,i)=><span key={i} style={{left:`${(i*10/PROJECT_DURATION)*100}%`}}>{`00:${String(i*10).padStart(2,"0")}`}</span>)}</div></div></div>
        <div className="timeline-area"><div className="track-labels"><div className="track-label video-track"><Film size={14}/><span>Video 1</span><button title="Track controls" onClick={()=>showNotice("Track controls chưa được triển khai.","info")}>⌁</button></div><div className="track-label text-track"><Subtitles size={14}/><span>Vietsub</span><button title="Track controls" onClick={()=>showNotice("Track controls chưa được triển khai.","info")}>⌁</button></div><div className="track-label audio-track"><Music2 size={14}/><span>Audio 1</span><button title="Track controls" onClick={()=>showNotice("Track controls chưa được triển khai.","info")}>⌁</button></div><div className="track-label voice-track"><Mic2 size={14}/><span>Voiceover</span><button title="Track controls" onClick={()=>showNotice("Track controls chưa được triển khai.","info")}>⌁</button></div></div>
          <div className="tracks-canvas" onScroll={(event)=>{if(rulerViewportRef.current)rulerViewportRef.current.scrollLeft=event.currentTarget.scrollLeft;}} onClick={(event)=>seekFromPointer(event.clientX)}>
            <div className="timeline-content" ref={timelineContentRef} style={{width:`${zoom*100}%`}}>
              <div className="ruler-lines">{Array.from({length:9},(_,i)=><i key={i} style={{left:`${i*10/PROJECT_DURATION*100}%`}}/>)}</div>
              {[0,1,2,3].map((track)=><div className="track-lane" key={track}/>)}
              {clips.map((clip)=><button key={clip.id} title={`${clip.name} — chọn để chỉnh sửa`} className={`clip clip-${clip.color} ${clip.id===selectedClipId?"clip-selected":""}`} style={{left:`${clip.start/PROJECT_DURATION*100}%`,width:`${clip.duration/PROJECT_DURATION*100}%`,top:`${clip.track*25+2}%`}} onClick={(event)=>{event.stopPropagation();setSelectedClipId(clip.id);seekFromPointer(event.clientX);}}><span className="clip-name">{clip.name}</span>{clip.id===4&&<span className="subtitle-blocks">{Array.from({length:14},(_,i)=><i key={i}/>)}</span>}{clip.id===5&&<span className="waveform">{Array.from({length:55},(_,i)=><i key={i} style={{height:`${14+Math.abs(Math.sin(i*1.7))*65+Math.abs(Math.cos(i*.3))*18}%`}}/>)}</span>}</button>)}
              <div className="playhead" style={{left:`${Math.min(100,playheadSeconds/PROJECT_DURATION*100)}%`}}><i/><span/></div>
            </div>
          </div>
        </div>
        <div className="timeline-footer"><span><i/> Snap</span><span>{FRAME_RATE} FPS</span><span>1920 × 1080</span><div/><span>{formatTimecode(PROJECT_DURATION)}</span></div>
      </main>

      <aside className="inspector"><div className="inspector-head"><div><span className="section-kicker">PROPERTIES</span><b>Trình kiểm tra</b></div><button title="Tùy chọn" onClick={()=>showNotice("Bảng tùy chọn đang ở mức giao diện; chưa ghi thuộc tính clip ra manifest.","info")}><MoreHorizontal size={17}/></button></div><div className="inspector-tabs"><button className="active">Video</button><button onClick={()=>showNotice("Thuộc tính âm thanh chưa được kết nối với media engine.","info")}>Âm thanh</button><button onClick={()=>showNotice("Chuyển cảnh chưa được triển khai.","info")}>Chuyển cảnh</button></div><div className="inspector-scroll">
        <section className="property-section"><div className="property-title"><FileVideo2 size={15}/><b>Transform</b><ChevronDown size={14}/></div><div className="selected-clip-summary">{selectedClip ? <>Clip đang chọn: <b>{selectedClip.name}</b><small>Bắt đầu {formatTimecode(selectedClip.start)} · dài {selectedClip.duration.toFixed(2)} giây</small></> : "Chọn clip trên timeline để xem thông tin."}</div><div className="property-row"><label>Vị trí X</label><span className="number-input">0 <small>px</small></span><label>Y</label><span className="number-input">0 <small>px</small></span></div><div className="property-row"><label>Tỷ lệ</label><span className="number-input wide">100 <small>%</small></span><button className="keyframe" onClick={()=>showNotice("Keyframe chưa được hỗ trợ.","info")}>◇</button></div><div className="property-row"><label>Góc xoay</label><span className="number-input wide">0 <small>°</small></span><button className="keyframe" onClick={()=>showNotice("Keyframe chưa được hỗ trợ.","info")}>◇</button></div><div className="slider-label"><span>Độ mờ</span><b>100%</b></div><div className="property-slider"><i/></div></section>
        <section className="property-section"><div className="property-title"><Subtitles size={15}/><b>Vietsub & phụ đề</b><ChevronDown size={14}/></div><div className="toggle-row"><div><b>Hiển thị phụ đề</b><small>vietsub_vi.srt · asset mẫu</small></div><button className={`switch ${showSubtitles?"on":""}`} aria-label="Bật hoặc tắt phụ đề" aria-pressed={showSubtitles} onClick={()=>setShowSubtitles((value)=>!value)}><i/></button></div><label className="field-label">Kiểu chữ</label><button className="select-field" onClick={()=>showNotice("Font subtitle sẽ được tùy chỉnh khi nối renderer.","info")}>Inter SemiBold <ChevronDown size={14}/></button><div className="property-row field-pair"><div><label>Kích thước</label><span className="number-input wide">42 <small>px</small></span></div><div><label>Vị trí Y</label><span className="number-input wide">86 <small>%</small></span></div></div><label className="field-label">Màu chữ & viền</label><div className="color-options"><button className={`color-chip ${subtitleColor==="#ffffff"?"selected":""}`} style={{background:"#ffffff"}} title="Trắng" onClick={()=>setSubtitleColor("#ffffff")}/><button className={`color-chip ${subtitleColor==="#b9a8ff"?"selected":""}`} style={{background:"#b9a8ff"}} title="Tím" onClick={()=>setSubtitleColor("#b9a8ff")}/><button className={`color-chip ${subtitleColor==="#ffe279"?"selected":""}`} style={{background:"#ffe279"}} title="Vàng" onClick={()=>setSubtitleColor("#ffe279")}/><button className="color-custom" onClick={()=>{const value=window.prompt("Mã màu HEX (ví dụ #FFFFFF)",subtitleColor);if(value&&/^#[0-9a-f]{6}$/i.test(value.trim()))setSubtitleColor(value.trim().toLowerCase());else if(value)showNotice("Mã màu không hợp lệ. Hãy dùng định dạng #RRGGBB.","warning");}}>+</button><span>{subtitleColor.toUpperCase()}</span></div><div className="toggle-row"><div><b>Viền chữ</b><small>Độ dày 2px · màu đen</small></div><button className={`switch ${strokeEnabled?"on":""}`} aria-label="Bật hoặc tắt viền phụ đề" aria-pressed={strokeEnabled} onClick={()=>setStrokeEnabled((value)=>!value)}><i/></button></div><div className="toggle-row"><div><b>Đổ bóng</b><small>Tăng tương phản</small></div><button className={`switch ${shadowEnabled?"on":""}`} aria-label="Bật hoặc tắt bóng phụ đề" aria-pressed={shadowEnabled} onClick={()=>setShadowEnabled((value)=>!value)}><i/></button></div><button className="advanced-btn" onClick={()=>showNotice("Xuất ASS cần được nối với renderer/backend.","warning")}>Cài đặt phụ đề ASS <span>↗</span></button></section>
        <section className="property-section"><div className="property-title"><AudioLines size={15}/><b>Âm thanh</b><ChevronDown size={14}/></div><div className="slider-label"><span>Âm lượng clip</span><b>100%</b></div><div className="property-slider"><i/></div><div className="toggle-row"><div><b>Duck nhạc nền</b><small>Giảm nhạc khi có giọng nói</small></div><button className={`switch ${duckEnabled?"on":""}`} aria-label="Bật hoặc tắt duck nhạc nền" aria-pressed={duckEnabled} onClick={()=>setDuckEnabled((value)=>!value)}><i/></button></div></section>
      </div><div className="inspector-bottom"><button onClick={resetTimeline}>Đặt lại timeline</button><button className="apply-btn" onClick={()=>showNotice("Thay đổi timeline được tự lưu cục bộ. Các thông số Inspector hiện vẫn là UI mẫu, chưa ghi vào manifest.","info")}>Áp dụng</button></div></aside>
    </div>
    {showAuth && <div className="auth-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowAuth(false); }}>
      <form className="auth-dialog" onSubmit={submitLogin}>
        <div className="auth-dialog-head"><div><span className="auth-icon"><ShieldCheck size={18}/></span><div><b>Đăng nhập Hendy API</b><small>Phiên đăng nhập dùng Bearer token</small></div></div><button type="button" aria-label="Đóng" onClick={() => setShowAuth(false)}>×</button></div>
        {apiToken ? <div className="auth-active"><Check size={17}/><div><b>Đã đăng nhập</b><small>{userEmail || "Tài khoản API"}</small></div></div> : <>
          <label>Email<input type="email" autoComplete="username" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} required placeholder="admin@example.com"/></label>
          <label>Mật khẩu<input type="password" autoComplete="current-password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} required minLength={12} maxLength={128} placeholder="Ít nhất 12 ký tự"/></label>
          <p className="auth-help">Tạo tài khoản owner một lần bằng lệnh <code>npm run bootstrap:admin</code>. Mật khẩu không được lưu trong trình duyệt; token lưu cục bộ để gọi API.</p>
          <button className="auth-submit" type="submit" disabled={authBusy || !isApiConfigured}>{authBusy ? "Đang đăng nhập…" : "Đăng nhập"}</button>
        </>}
        {apiToken && <button className="auth-submit auth-logout" type="button" onClick={() => { signOut(); setShowAuth(false); }}>Đăng xuất</button>}
      </form>
    </div>}
    {notice && <div className={`studio-toast toast-${noticeKind}`} role="status" aria-live="polite"><span>{notice}</span><button aria-label="Đóng thông báo" onClick={()=>setNotice("")}>×</button></div>}
  </div>;
}
