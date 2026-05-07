# Pre-Deployment Checklist

## Code Ready?
- [x] Backend CORS configured for env vars
- [x] Frontend build scripts in place  
- [x] `.env.example` files created
- [x] Vercel config (`vercel.json`) created
- [x] Render config (`render.yaml`) created
- [ ] All secrets added to `.env` files (DO NOT COMMIT)

## Repository Clean?
- [ ] Run `git status` — should show no uncommitted changes
- [ ] `.env` and `.env.local` files in `.gitignore`
- [ ] All test files removed

## Local Testing
- [ ] `npm run build` succeeds in `/frontend`
- [ ] Backend starts with `uvicorn main:app --reload`
- [ ] Can generate a video end-to-end locally
- [ ] Preview link is clickable and renders

## Secrets Gathered
- [ ] Supabase URL
- [ ] Supabase service role key
- [ ] ElevenLabs API key (if using voice cloning)
- [ ] Frontend domain for Vercel
- [ ] Backend domain for Render

## Ready to Deploy?
- [ ] Push to GitHub
- [ ] Create Vercel project
- [ ] Create Render service  
- [ ] Add environment variables to both platforms
- [ ] Test the deployed URLs

---

For step-by-step instructions, see [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md)
