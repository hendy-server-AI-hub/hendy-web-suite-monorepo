# Hendy Web Suite

Monorepo chứa Admin Web, Studio Web, public site, Cloudflare Worker API và worker FFmpeg chạy trong container riêng.

> **Phạm vi source:** archive đầu vào không chứa source ứng dụng Flutter gốc, công cụ Python production và installer Windows hoàn chỉnh. Các vị trí tương ứng hiện là placeholder; hãy restore source gốc trước khi phát hành các sản phẩm đó.

## Yêu cầu

- Node.js 22+, npm 10.8+
- GitHub CLI (gh) để tự khai báo GitHub Actions secrets
- Cloudflare API token có quyền Pages Write, Workers Scripts Edit, D1 Edit và R2 Storage Edit
- Docker + Docker Compose trên máy chủ render FFmpeg

## Chạy giao diện/API local

```bash
npm install
npm run dev:admin   # http://localhost:5173
npm run dev:studio  # http://localhost:5174
npm run dev:site    # http://localhost:5175
npm run dev:api     # thường ở http://localhost:8787
```

Kiểm tra repository, types, API và build:

```bash
npm run check:structure
npm run typecheck
npm run test:api
npm run render:check
npm run build
```

## Cấu trúc

- apps/admin-web: dashboard có trạng thái API thật, đăng nhập và hiển thị dự án/tài nguyên theo tài khoản.
- apps/studio-web: timeline, upload media R2, lưu manifest D1, trạng thái render và tải MP4.
- apps/site: public landing page responsive.
- apps/api: Cloudflare Worker, xác thực, API dự án/tài nguyên và render job.
- apps/api/migrations: schema D1 cho projects, users, assets, render_jobs và lease/attempt.
- services/render-worker: Node.js 22 + FFmpeg container; lấy job qua internal API, render MP4 và lưu kết quả R2.
- packages: TypeScript types và utilities dùng chung.
- scripts: kiểm tra cấu trúc, API smoke tests và bootstrap secrets/resources.
- .github/workflows: CI, Cloudflare Worker deploy, GHCR render image và release ZIP.

## Tự động khai báo secrets và tài nguyên production

Trước hết cần một Cloudflare API token do account admin tạo trong Cloudflare và một phiên GitHub CLI có quyền ghi secrets. Script không thể phát sinh credential Cloudflare ban đầu nếu chưa có quyền được cấp.

```bash
gh auth login
npm install
npm run bootstrap:production:push
```

Script sẽ nhập Cloudflare token trong terminal (input ẩn), Account ID, production HTTPS origins và public Worker API URL. Sau đó nó:
- Tạo D1 database hendy-suite-db và R2 bucket hendy-suite-assets nếu chưa có.
- Sinh AUTH_JWT_SECRET, BOOTSTRAP_ADMIN_KEY và RENDER_SERVICE_TOKEN bằng crypto.
- Cấu hình D1/R2/CORS trong apps/api/wrangler.toml.
- Ghi GitHub Actions secrets CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, AUTH_JWT_SECRET, BOOTSTRAP_ADMIN_KEY, RENDER_SERVICE_TOKEN qua GitHub CLI stdin.
- Chạy các D1 migrations, tạo .env.production.local và .env.render.local local-only, rồi push cấu hình Worker lên main.

**Không commit hoặc chia sẻ** .env.production.local và .env.render.local. Cloudflare API token không được ghi xuống disk.

Sau khi GitHub Actions deploy Worker thành công:

```bash
npm run bootstrap:admin
```

Lệnh này tạo tài khoản owner đầu tiên bằng email/password nhập trong terminal. Endpoint bootstrap bị khóa sau khi người dùng đầu tiên được tạo.

## Chạy FFmpeg render worker

Trên máy chủ có Docker, dùng file .env.render.local được tạo từ bootstrap:

```bash
npm run render:up
npm run render:logs
```

CI cũng có workflow build/publish image lên GitHub Container Registry khi source render-worker thay đổi. Render worker là service riêng, không chạy bên trong Cloudflare Worker. Mỗi container xử lý một job, hỗ trợ tối đa 120 clip, 30 phút, 4K/60 FPS, 20 MiB cho mỗi input upload, tổng input 250 MiB và output 80 MiB qua API Worker.

## API production

- POST /api/v1/auth/bootstrap; POST /api/v1/auth/login; GET /api/v1/auth/me.
- GET/POST /api/v1/projects và GET/PUT/DELETE /api/v1/projects/:uuid.
- GET/POST /api/v1/assets và GET/DELETE /api/v1/assets/:uuid.
- POST /api/v1/render/validate; POST/GET /api/v1/render/jobs; GET /api/v1/render/jobs/:uuid; POST /api/v1/render/jobs/:uuid/cancel; GET /api/v1/render/jobs/:uuid/download.
- Internal worker routes yêu cầu RENDER_SERVICE_TOKEN riêng.

Auth sử dụng PBKDF2-HMAC-SHA256 với salt ngẫu nhiên, Bearer JWT HS256 hết hạn sau 8 giờ và truy vấn dữ liệu có owner scope. File R2 là private; viewer chỉ đọc. Upload hiện giới hạn 20 MiB và output render qua Worker giới hạn 80 MiB.

## Trước khi mở public

Cấu hình Cloudflare WAF/rate limits, alert/monitoring, backup/restore, account recovery/MFA, quota/billing và review bảo mật. Dashboard activity vẫn là demo; analytics/finance/user management chưa được tích hợp đầy đủ. Kiểm thử luồng end-to-end với Cloudflare account thật và Docker host trước khi tuyên bố hệ thống production-ready. Xem docs/PRODUCTION_BOOTSTRAP.md để biết các bước chi tiết.


## Frontend production hosting

The production bootstrap also creates the Cloudflare Pages projects `hendy-admin-web`, `hendy-studio-web`, and `hendy-public-site`. After `npm run bootstrap:production:push`, the `.github/workflows/deploy-cloudflare-pages.yml` workflow builds and publishes all three apps from `main`. It stores their `*.pages.dev` URLs and the Worker API URL in GitHub Actions Variables. Optional custom domains can be attached later in Cloudflare Pages and require updating those variables and Worker CORS origins.
