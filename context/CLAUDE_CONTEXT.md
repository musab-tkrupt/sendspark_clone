# Project Context for AI Agents

## Overview
This repository is a full-stack voice outreach platform. It includes:
- `backend/`: FastAPI Python service for voice cloning, video compositing, and Supabase storage.
- `frontend/`: Next.js app for UI, recording, job control, and sharing.
- `docker-compose.yml`: local dev orchestration.

## Key Concepts
- Voice cloning uses Chatterbox TTS locally and ElevenLabs via API.
- Generated media is stored in Supabase storage.
- The app supports personalized videos per lead, with shareable links.
- A preview link requires a public HTML-accessible route with Open Graph metadata.

## Backend
### Main file
- `backend/main.py`
- Loads environment variables from `backend/.env`.
- Uses CORS for `http://localhost:3000` and `http://localhost:3001`.
- Uses in-memory job state for `jobs` and `composite_jobs`.

### Important routes
- `POST /generate` - generate cloned audio/video from reference audio and names.
- `GET /status/{job_id}` - check generation progress.
- `POST /scroll` - create website scroll videos using `node scripts/record-paged.js`.
- `GET /scroll-status/{job_id}` - poll scroll jobs.
- `POST /composite` - composite face + scroll + cloned voice into outbound videos.
- `POST /composite-elevenlabs` - same composite flow using ElevenLabs voice cloning.
- `GET /composite-status/{job_id}` - poll composite progress.
- `GET /download/{filename}` - download local output file.
- `GET /download-all/{job_id}` - zip and download all generated files.
- `GET /composite-download-all/{job_id}` - zip and download all composite videos.
- `GET /dependency-check` - validate Supabase and ElevenLabs configuration.
- `GET /preview/metadata/{lead}/{preview_id}` - preview metadata for share link generation.

### Storage and preview schema
- Supabase storage bucket configured with:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `SUPABASE_STORAGE_BUCKET`
  - `SUPABASE_PATH_PREFIX`
- Preview assets are uploaded under `previews/<lead-slug>/<preview_id>/`.
- Each preview includes:
  - `video.mp4`
  - `thumbnail.png`
- The backend generates thumbnails using FFmpeg from the completed video.
- Preview metadata response includes:
  - `lead`
  - `preview_id`
  - `preview_path`
  - `video_url`
  - `thumbnail_url`
  - `title`
  - `description`

## Frontend
### Important files
- `frontend/app/page.tsx` - core voice cloner UI.
- `frontend/app/sendspark/page.tsx` - SendSpark workflow with contacts, scrolling, recording, composite and results.
- `frontend/app/preview/[lead]/[id]/page.tsx` - preview route that renders OG metadata for sharing.

### Preview behavior
- The preview route fetches metadata from the backend endpoint.
- It sets Open Graph and Twitter meta tags for social preview.
- It is designed to be a minimal sharable URL, not a full application page.
- The shared URL format is:
  - `/preview/<lead-slug>/<preview_id>`

## Environment and deployment
- Frontend uses `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_APP_URL` for the preview route and backend API.
- The app is intended to run locally on `localhost:3001` for frontend and `localhost:8000` for backend.
- For global link previews, the app must be deployed to a public domain.

## Agent guidance
When a new AI agent is spawned for this repo, it should keep in mind:
- The repository contains both backend and frontend pieces.
- Preview sharing is implemented via a backend metadata endpoint and dynamic frontend route.
- Supabase storage is the canonical asset store.
- `preview_path` is the shareable URL path used for social link preview.
- The thumbnail image is generated from the video and used as `og:image`.
- Lead names are slug-normalized for storage and route generation.
