# Voice Pipeline (Frontend + Backend)

This project has two apps:

- `frontend` (Next.js) for UI and workflow orchestration
- `backend` (FastAPI) for voice cloning, video compositing, and job APIs

It also depends on a recorder script outside this folder:

- `../scripts/record.js` (Node + Puppeteer website scroll recorder)

## Architecture At A Glance

1. User fills contacts and input files in frontend (`/sendspark`)
2. Frontend calls backend APIs:
   - `POST /scroll` -> generate website scroll videos
   - `GET /scroll-status/{id}` -> poll status
   - `POST /composite` -> compose final personalized videos
   - `GET /composite-status/{id}` -> poll status
3. Backend spawns `node scripts/record.js ...` from the parent repo root.
4. Output media files are written to disk and served through download endpoints.

## Prerequisites

Install these on your machine:

- Node.js 18+ and npm
- Python 3.11+ (3.10+ is usually fine)
- `ffmpeg` and `ffprobe` available on PATH

Also install Chromium dependencies for Puppeteer on your OS if needed.

## Install

### 1) Install recorder/root dependencies

From repo root (`SS_Clone_2.0`):

```bash
npm install
```

This is required for `scripts/record.js` and Puppeteer packages.

### 2) Install frontend dependencies

From `voice/frontend`:

```bash
npm install
```

### 3) Install backend dependencies

From `voice/backend`:

```bash
python -m venv .venv
# Windows PowerShell
.venv\Scripts\Activate.ps1
# macOS/Linux
# source .venv/bin/activate

pip install -r requirements.txt
```

## Run In Development

### Start backend (port 8000)

From `voice/backend`:

```bash
uvicorn main:app --reload --port 8000
```

Health check:

- `GET http://localhost:8000/health`

### Start frontend (port 3001)

From `voice/frontend`:

```bash
npm run dev
```

Open:

- `http://localhost:3001`
- `http://localhost:3001/sendspark`

## Production Build / Start

### Frontend

From `voice/frontend`:

```bash
npm run build
npm run start
```

### Backend

From `voice/backend`:

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

For real production, run behind a process manager/reverse proxy (systemd, Docker, PM2/supervisor, Nginx, etc).

## Docker Compose (Minimal)

From `voice/`:

```bash
docker compose up --build
```

This starts:

- frontend on `http://localhost:3001`
- backend on `http://localhost:8000`

Stop with:

```bash
docker compose down
```

Notes:

- Compose file: `voice/docker-compose.yml`
- It mounts the parent repo so backend can access `../scripts/record.js`.
- First startup can be slow because it installs apt/npm/pip dependencies inside containers.

## Current Workflow Notes

- CSV upload format is `name,website`
- Sample file is available at:
  - `frontend/sample-contacts.csv`
- In SendSpark recording step:
  - You can download the recorded bubble video before processing.
- Composite controls:
  - `skip_seconds` controls where bubble audio starts after cloned greeting.
  - `scroll_start_seconds` controls where the background website video starts.

## API Summary (Backend)

- `POST /generate` - voice cloner flow
- `GET /status/{job_id}`
- `POST /scroll`
- `GET /scroll-status/{job_id}`
- `GET /scroll-video/{filename}`
- `POST /composite`
- `GET /composite-status/{job_id}`
- `GET /download/{filename}`
- `GET /download-all/{job_id}`
- `GET /composite-download-all/{job_id}`

## Production Readiness Checklist

Status today: **Not fully production-ready yet** (works well for local/staging).

Main gaps to address before production:

1. Persistence
   - Jobs are stored in-memory (`jobs`, `composite_jobs`) and lost on restart.
   - Move job state to Redis/Postgres.

2. Security/Auth
   - No authentication/authorization on APIs.
   - Add auth and basic abuse protection (rate limiting, request limits).

3. File lifecycle
   - `temp/` and `outputs/` are not auto-cleaned.
   - Add retention policy and cleanup workers.

4. Validation
   - Minimal validation for uploaded files and `contacts` payload.
   - Add strict schema validation and file type checks.

5. Observability
   - Limited structured logging and no metrics/tracing.
   - Add centralized logs, error tracking, and alerting.

6. Operational hardening
   - Add timeout/retry policy standards and worker isolation for heavy media jobs.
   - Consider queue-based execution (Celery/RQ/Arq/BullMQ equivalent).

7. Config management
   - Localhost values are hardcoded in frontend (`API = "http://localhost:8000"`).
   - Move to environment-based config for staging/production.

## Quick Troubleshooting

- Stuck on "Generating..." in scroll step:
  - Check `.jobs/<jobId>.json` under repo root.
  - Confirm root `npm install` was run (for Puppeteer dependencies).
  - Confirm Chromium launch works on your machine.

- `ffmpeg` errors:
  - Verify both `ffmpeg` and `ffprobe` are installed and available on PATH.

- Backend health returns model not loaded:
  - Wait until startup model loading finishes before running jobs.

