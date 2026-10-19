# Hendy Web Suite — Monorepo Starter

Bộ khung làm việc cho **admin-web**, **studio-web**, **site**, **Cloudflare Worker API** và các package dùng chung.

> **Lưu ý về source gốc:** gói `hendy-web-interfaces-source` cùng các thư mục Flutter/Python/installer gốc chưa có trong lượt làm việc này. Những giao diện trong gói này là bản khởi tạo hoạt động để làm nền tích hợp, không phải bản sao các file gốc. Hãy chép mã Flutter hiện có vào `mobile_app/`, script thật vào `scripts/`, `installer/HendyTools.iss`, `hendy_tools_pro.py` và `requirements.txt` trước khi thay thế các bản placeholder.

## Yêu cầu

- Node.js `>=20.19` và npm `>=10.8`
- Wrangler/Cloudflare account chỉ cần khi triển khai Worker
- Python 3.10+ chỉ dùng nếu bạn phát triển công cụ Python

## Cài và chạy

```bash
npm install
npm run dev:admin   # http://localhost:5173
npm run dev:studio  # http://localhost:5174
npm run dev:site    # http://localhost:5175
npm run dev:api     # Cloudflare Worker local, thường ở http://localhost:8787
```

Mỗi lệnh dev chạy trong terminal riêng. Kiểm tra và build toàn monorepo:

```bash
npm run check:structure
npm run typecheck
npm run build
```

## Cấu trúc chính

```text
.github/workflows/
  deploy-cloudflare.yml
  build-and-publish-release.yml
apps/
  admin-web/       React + Vite, dashboard quản trị
  studio-web/      React + Vite, giao diện studio biên tập
  site/            React + Vite, trang giới thiệu
  api/             Cloudflare Workers + Wrangler
packages/
  core-utils/      tiện ích dùng chung
  shared-types/    kiểu dữ liệu chung
mobile_app/        vị trí source Flutter hiện có
scripts/           script vận hành và kiểm tra repo
installer/         script đóng gói Windows Inno Setup
```

## Cấu hình GitHub → Cloudflare

Trong **GitHub → Settings → Secrets and variables → Actions**, tạo secrets:

- `CLOUDFLARE_API_TOKEN`: token giới hạn quyền triển khai Workers cần thiết.
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare Account ID.

Không commit token hoặc file `.env` lên Git.

Workflow `deploy-cloudflare.yml` triển khai Worker từ **`apps/api/wrangler.toml`**. Khi push lên `main`, pipeline cài dependencies, typecheck, build và deploy API. Có thể chạy thủ công ở tab Actions.

Nếu muốn xuất bản `admin-web`, `studio-web`, `site` lên Cloudflare Pages, hãy tạo ba Pages project trong Cloudflare trước; workflow release hiện đóng gói artifact tĩnh, không tự xuất bản Pages. Cấu hình pipeline Pages sau khi biết chính xác project name và domain của tài khoản.

## D1 (tùy chọn)

API starter chỉ cần Worker để chạy `/healthz` và `/api/v1/meta`. Migration mẫu nằm ở `apps/api/migrations/0001_init.sql`. Khi muốn lưu dự án, tạo D1 database, thay `database_id` placeholder trong `apps/api/wrangler.toml` và bỏ comment cho binding `DB`; sau đó mới triển khai các endpoint phụ thuộc DB.

## Tạo release

Đẩy tag có dạng `v1.0.0` (hoặc `v*`) để workflow build ba web app, đóng gói output và tạo GitHub Release. Cần bật GitHub Actions và quyền `contents: write` (đã khai báo trong workflow).

## Trạng thái chức năng

- ✅ Workspace npm, các app Vite, package types/utilities.
- ✅ API Worker có health check, metadata, CORS, request ID, xử lý lỗi và xác thực manifest cơ bản.
- ✅ CI typecheck/build; deploy Worker qua GitHub Actions; release ZIP khi tag.
- ⚠️ Chưa cấu hình R2, D1, queue render, xác thực người dùng, thanh toán hoặc pipeline render FFmpeg. Đây cần tài nguyên và secrets thật; không được coi phần scaffold là hệ thống backend production hoàn chỉnh.


## Studio — trạng thái sau đợt chỉnh sửa

Các thay đổi trong `apps/studio-web/src/App.tsx` và `src/api.ts` giữ lại bố cục hiện tại, nhưng sửa hành vi timeline và bổ sung kết nối API cơ bản:

- Tách riêng `selectedClipId`, `selectedAssetName` và `playheadSeconds`; chọn clip không tự ý kéo dài clip.
- Có seek timeline, mô phỏng play/pause theo timecode, cắt clip tại playhead và Undo/Redo bằng nút hoặc `Ctrl+Z`, `Ctrl+Y`, `Ctrl+Shift+Z`.
- Zoom timeline thay đổi tỷ lệ nội dung và đồng bộ vị trí cuộn với thước thời gian.
- Tìm kiếm/lọc asset; các điều khiển phụ đề (hiện/ẩn, màu, viền, bóng) cập nhật preview và được lưu trong bản nháp.
- Bản nháp tự lưu trong `localStorage` (trình duyệt hiện tại), bao gồm tên dự án, timeline, playhead, zoom và các tùy chọn phụ đề. Đây **không phải** lưu cloud; dữ liệu không tự đồng bộ sang máy/người dùng khác.
- Studio đọc `GET /api/v1/meta` để hiện trạng thái Worker và gửi manifest đến `POST /api/v1/render/validate`. API chỉ kiểm tra cấu trúc manifest, không lưu dự án hoặc render video.

### Chạy Studio cùng API local

1. Sao chép `apps/studio-web/.env.example` thành `apps/studio-web/.env.local` (không commit file `.env.local`).
2. Trong terminal riêng, chạy `npm run dev:api` và `npm run dev:studio`.
3. Mở `http://localhost:5174`. Nhãn API trên thanh công cụ sẽ báo trạng thái kết nối; nút **Kiểm tra API** sẽ gửi manifest hiện tại đến Worker.

Nếu API chưa chạy hoặc CORS không cho phép `http://localhost:5174`, Studio vẫn lưu bản nháp cục bộ nhưng không thể kiểm tra manifest từ Worker.

### Giới hạn còn lại

Media đang là dữ liệu mẫu; preview chưa phát file thật, upload/R2 chưa được nối, các thuộc tính transform/volume chưa ghi vào manifest, và chưa có D1 project API hay auth. Nên triển khai xác thực/phân quyền và kho lưu trữ trước khi thêm API đọc/ghi dự án; không mở endpoint ghi dữ liệu cho người dùng ẩn danh. Render MP4 cần render worker/FFmpeg riêng và cơ chế theo dõi tác vụ.


## Provision production resources and secrets (one-time)

The production bootstrap script provisions the minimum Cloudflare data/storage resources and configures deployment secrets without committing credentials:

- Creates the D1 database `hendy-suite-db` and R2 bucket `hendy-suite-assets` if they do not already exist.
- Writes the real D1 database ID and R2 binding into `apps/api/wrangler.toml`; configures a strict HTTPS CORS allowlist.
- Generates `AUTH_JWT_SECRET` and a one-time `BOOTSTRAP_ADMIN_KEY` with cryptographic randomness.
- Writes GitHub Actions repository secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `AUTH_JWT_SECRET` and `BOOTSTRAP_ADMIN_KEY` using GitHub CLI input, not command-line arguments.
- Applies remote D1 migrations. The local secret file `.env.production.local` is ignored by Git and written with restrictive permissions.

### One-time prerequisites

1. Install Node.js 22+, Git and GitHub CLI (`gh`), then clone this repository and run `npm install`.
2. Authenticate GitHub CLI with an account that can write repository Actions secrets: `gh auth login`.
3. In the Cloudflare dashboard, create an API token scoped to this account with only the permissions needed for **Workers Scripts: Edit**, **D1: Edit** and **R2 Storage: Edit**. The script cannot mint an initial Cloudflare credential out of nothing; enter this token into the hidden prompt. Never paste it into chat or commit it to Git.
4. Obtain the Cloudflare Account ID from the account dashboard.

Run:

```bash
npm run bootstrap:production:push
```

The script prompts for the repository, Account ID, Cloudflare token (hidden input) and the real HTTPS origins used by your Admin/Studio/site. It creates resources, writes the Actions secrets, runs migrations and commits/pushes only `apps/api/wrangler.toml` to `main`. GitHub Actions then runs typecheck/build and attempts Worker deployment. The workflow keeps the credentials scoped to the deployment steps.

If you prefer reviewing the config before pushing, run `npm run bootstrap:production` and inspect `apps/api/wrangler.toml` before committing it yourself.

When the Worker deployment has completed, bootstrap the first owner account:

```bash
npm run bootstrap:admin
```

Enter the deployed Worker URL, owner email, and a password of at least 12 characters when prompted. The password is hidden during input. The endpoint is one-time only and refuses further bootstrap attempts after the first user exists. Sign in to Studio with this account; its login dialog stores a short-lived Bearer token in the current browser profile. Do not share `.env.production.local`.

### API capabilities added

- `POST /api/v1/auth/bootstrap`: creates only the first owner, guarded by `BOOTSTRAP_ADMIN_KEY`.
- `POST /api/v1/auth/login`, `GET /api/v1/auth/me`: PBKDF2 password hashes and expiring HS256 bearer tokens.
- `GET/POST /api/v1/projects`, `GET/PUT/DELETE /api/v1/projects/:uuid`: per-user project CRUD in D1.
- `GET/POST /api/v1/assets`, `GET/DELETE /api/v1/assets/:uuid`: private R2-backed file management, with a 20 MB upload cap and MIME allowlist.
- Studio login, R2 upload, cloud project metadata/manifest save and API diagnostics.

### Production boundaries that remain

This is a production-oriented foundation, not a claim that the complete product has finished. Do not expose publicly until you configure Cloudflare rate limiting/WAF, alerts and backups, and decide on password recovery/MFA/account administration. Uploads currently cap at 20 MB and the UI still contains sample timeline content. **MP4 export is not implemented**: the render-jobs table is a schema placeholder, not a working FFmpeg queue/worker. A separately deployed render service and job lifecycle are still required; the UI reports that instead of pretending a render succeeded. The Flutter app, full Python utility and Windows installer originals are also not part of the starter archive and must be restored from their source packages before those deliverables can be production releases.
