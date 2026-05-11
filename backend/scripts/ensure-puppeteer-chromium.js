/**
 * Render / CI: ensure Chromium is downloaded into .puppeteer_cache inside the
 * backend tree so it survives between builds and is found at runtime.
 *
 * Puppeteer v19+ exposes a programmatic download API via puppeteer.createBrowserFetcher
 * which respects PUPPETEER_CACHE_DIR. We use that instead of invoking install.js
 * directly (that path changed across versions).
 */
const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')

const backendRoot = path.join(__dirname, '..')
const cacheDir = path.join(backendRoot, '.puppeteer_cache')
fs.mkdirSync(cacheDir, { recursive: true })

console.log(`[ensure-puppeteer] cache dir: ${cacheDir}`)

// Strategy 1: use puppeteer's own programmatic downloader (v19+ API)
async function tryProgrammaticDownload() {
  const puppeteer = require('puppeteer')

  // puppeteer v19 exposes createBrowserFetcher
  if (typeof puppeteer.createBrowserFetcher !== 'function') {
    return false
  }

  const fetcher = puppeteer.createBrowserFetcher({ path: cacheDir, product: 'chrome' })

  // Get the revision puppeteer expects
  let revision
  try {
    // v19 stores it in its own package.json under `puppeteer.chromium_revision`
    const pkg = require('puppeteer/package.json')
    revision = pkg?.puppeteer?.chromium_revision
  } catch (_) {}

  if (!revision) {
    console.log('[ensure-puppeteer] could not determine chromium revision, skipping programmatic download')
    return false
  }

  const info = fetcher.revisionInfo(revision)
  if (info.local) {
    console.log(`[ensure-puppeteer] chrome r${revision} already at ${info.executablePath}`)
    return true
  }

  console.log(`[ensure-puppeteer] downloading chrome r${revision} …`)
  await fetcher.download(revision)
  console.log(`[ensure-puppeteer] done: ${info.executablePath}`)
  return true
}

// Strategy 2: fall back to running puppeteer's install.js directly
function tryInstallScript() {
  const candidates = [
    // puppeteer v14–19 package root
    path.join(backendRoot, 'node_modules', 'puppeteer', 'install.js'),
    // some intermediate versions
    path.join(backendRoot, 'node_modules', 'puppeteer', 'lib', 'cjs', 'puppeteer', 'node', 'install.js'),
  ]

  const installJs = candidates.find(p => fs.existsSync(p))
  if (!installJs) {
    console.log('[ensure-puppeteer] install.js not found in any known location')
    return false
  }

  console.log(`[ensure-puppeteer] running ${installJs}`)
  const res = spawnSync(process.execPath, [installJs], {
    cwd: backendRoot,
    env: { ...process.env, PUPPETEER_CACHE_DIR: cacheDir },
    stdio: 'inherit',
  })
  if (res.status !== 0) {
    throw new Error(`install.js exited with code ${res.status}`)
  }
  return true
}

;(async () => {
  try {
    const ok = await tryProgrammaticDownload()
    if (!ok) tryInstallScript()
  } catch (err) {
    console.error('[ensure-puppeteer] error:', err.message)
    // Exit 1 so npm ci fails loudly instead of silently deploying without chrome
    process.exit(1)
  }
})()
