# Deployment Prep Complete ✅

## What's Ready

### Files Created
1. **`DEPLOYMENT_GUIDE.md`** — Step-by-step deployment instructions
2. **`DEPLOYMENT_CHECKLIST.md`** — Pre-flight checklist before going live
3. **`frontend/.env.example`** — Frontend env vars template
4. **`backend/.env.example`** — Backend env vars template (updated)
5. **`frontend/vercel.json`** — Vercel deployment config
6. **`backend/render.yaml`** — Render deployment config

### Code Changes
1. **`backend/main.py`** — Updated CORS to use `ALLOWED_ORIGINS` env var
   - Now reads from environment instead of hardcoded localhost
   - Supports dynamic frontend URLs for staging/production

## Quick Summary

### Frontend → Vercel
```
Root: voice/frontend
Build: npm run build
Start: npm run start
Env: NEXT_PUBLIC_API_URL, NEXT_PUBLIC_APP_URL
```

### Backend → Render
```
Root: voice/backend
Build: pip install -r requirements.txt
Start: uvicorn main:app --host 0.0.0.0 --port 8000
Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ELEVENLABS_API_KEY, etc.
```

## Next Steps

1. **Copy `.env.example` to `.env` and `.env.local`** (both frontend & backend)
   - Fill in your actual secrets
   - NEVER commit these files

2. **Commit & push** to GitHub
   ```bash
   git add .
   git commit -m "deployment: add vercel and render configs"
   git push origin main
   ```

3. **Follow `DEPLOYMENT_GUIDE.md`** step-by-step
   - Create Vercel project first
   - Create Render service second
   - Connect them with env vars

4. **Test end-to-end**
   - Generate a video on your deployed frontend
   - Verify it calls your deployed backend
   - Check that preview links work

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    Your Browser                         │
└────────────────────┬────────────────────────────────────┘
                     │
        ┌────────────┴──────────────┐
        │                           │
        v                           v
   VERCEL                       RENDER
   (Frontend)                  (Backend)
   Next.js 15                  FastAPI
   Tailwind CSS                Python 3.11
   Hosted on CDN               Hosted on Cloud
        │                           │
        │       ┌──────────────────┘
        │       │ API Calls
        │       │ (/composite, etc)
        │       v
        └──────► Cloud Storage
                (Supabase)
                Videos & Thumbnails
```

---

**You're ready to deploy!** 🚀

See [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) for detailed instructions.
