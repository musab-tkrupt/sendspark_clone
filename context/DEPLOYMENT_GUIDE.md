# Deployment Guide: Vercel + Render

## Overview
- **Frontend** (Next.js): Deploys to Vercel  
- **Backend** (FastAPI): Deploys to Render  
- **Storage**: Supabase (stays the same)

---

## Part 1: Frontend Deployment (Vercel)

### 1. Prepare frontend
```bash
cd frontend
npm install
npm run build  # Test build locally
```

### 2. Push to GitHub
```bash
git add .
git commit -m "prep: deployment ready"
git push origin main
```

### 3. Connect Vercel
1. Go to [vercel.com](https://vercel.com)
2. Sign in with GitHub
3. Click **"Add New..."** → **"Project"**
4. Select the repository (`SS_Clone_2.0`)
5. Configure:
   - **Root Directory**: `voice/frontend`
   - **Build Command**: `npm run build`
   - **Start Command**: `npm run start`

### 4. Set environment variables in Vercel
- Go to **Settings** → **Environment Variables**
- Add:
  ```
  NEXT_PUBLIC_API_URL=https://your-render-backend-url
  NEXT_PUBLIC_APP_URL=https://your-vercel-frontend-url
  ```

### 5. Deploy
Click **"Deploy"** — Vercel will build and go live.

---

## Part 2: Backend Deployment (Render)

### 1. Prepare backend
- Ensure `backend/requirements.txt` is up-to-date
- Ensure `backend/.env` variables are documented (but NOT committed)

### 2. Create Render service
1. Go to [render.com](https://render.com)
2. Sign in or create account
3. Click **"New"** → **"Web Service"**
4. Choose **"GitHub"** and connect
5. Select the repository and branch

### 3. Configure the service
- **Name**: `voice-backend` (or your choice)
- **Root Directory**: `voice/backend`
- **Build Command**: `pip install -r requirements.txt`
- **Start Command**: `uvicorn main:app --host 0.0.0.0 --port 8000`
- **Plan**: Choose Free or Paid (Free tier sleeps after 15 min inactivity)

### 4. Set environment variables in Render
- Go to **Environment** tab
- Add all vars from your `backend/.env`:
  ```
  SUPABASE_URL=your_supabase_url
  SUPABASE_SERVICE_ROLE_KEY=your_key
  SUPABASE_STORAGE_BUCKET=Videos
  SUPABASE_PATH_PREFIX=sendspark
  ELEVENLABS_API_KEY=your_key
  ELEVENLABS_MODEL_ID=eleven_multilingual_v2
  ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128
  ENABLE_CHATTERBOX=true
  ```

### 5. Deploy
Click **"Create Web Service"** — Render builds and deploys.

---

## Part 3: Connect frontend to backend

Once backend is live on Render:

### 1. Get your Render backend URL
- It will look like: `https://voice-backend.onrender.com`

### 2. Update Vercel environment variables
- Go back to Vercel → **Settings** → **Environment Variables**
- Update `NEXT_PUBLIC_API_URL` to your Render URL
- Redeploy (Vercel auto-redeploys on env change)

### 3. Update your CLAUDE_CONTEXT.md
- Document the live URLs for future reference

---

## Part 4: Test everything

### Frontend
1. Visit your Vercel URL
2. Check network requests go to Render backend
3. Generate a composite video
4. Verify the preview link works

### Backend
1. Visit `https://your-render-backend/health`
2. Should return `{"status": "ok", "model_loaded": true}`

### Sharing
- The preview link format: `https://your-vercel-url/preview/[lead]/[id]`
- Social media will now be able to scrape this URL and show preview cards

---

## Troubleshooting

### Backend not loading model
- Render free tier may timeout during model init
- Upgrade to paid tier or use pre-built model cache

### CORS errors
- Ensure `frontend\` URL is in Render's CORS allowed list
- In `backend/main.py`, update:
  ```python
  allow_origins=["https://your-vercel-url", "http://localhost:3001"]
  ```

### Preview not showing on social
- Backend must be publicly accessible (already is on Render)
- Frontend preview route must set Open Graph meta tags (already implemented)
- Wait a few minutes for social cache to refresh

---

## Quick Deploy Checklist

- [ ] `npm run build` succeeds locally (frontend)
- [ ] Backend `.env` file exists with all required vars
- [ ] GitHub repo is up-to-date
- [ ] Vercel project created and linked
- [ ] Render service created and linked
- [ ] Supabase credentials copied to both platforms
- [ ] ElevenLabs key (if used) added to Render
- [ ] Backend health check returns 200
- [ ] Frontend can talk to backend (check network tab)
- [ ] Preview link generates and is shareable

---

## Notes

- **Render free tier sleeps** — wake it up by visiting the backend URL
- **Supabase free tier** should be sufficient for testing
- **FFmpeg** is pre-installed on Render
- For higher load, upgrade Render plan or use Railway.app

Good to go! 🚀
