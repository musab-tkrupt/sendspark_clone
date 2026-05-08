const puppeteer = require('puppeteer')
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const VIEWPORT_WIDTH = 1600
const VIEWPORT_HEIGHT = 900
const PAGE_ZOOM = 0.9
const NAV_TIMEOUT_MS = 20000
const INITIAL_HOLD_MS = 800
const FINAL_HOLD_MS = 1000
const BETWEEN_SCROLL_WAIT_MS = 2200
const MAX_SCROLL_STEPS = 10
const MAX_JOB_MS = 90000
const FALLBACK_URL = 'https://www.tkrupt.com/'

const jobId = process.argv[3]
function updateJob(data) {
  if (!jobId) return
  const dir = path.join(process.cwd(), '.jobs')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${jobId}.json`), JSON.stringify(data))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function gotoWithFallback(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
    return url
  } catch (err) {
    console.warn(`Primary URL failed (${url}): ${err.message}. Falling back to ${FALLBACK_URL}`)
    await page.goto(FALLBACK_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
    return FALLBACK_URL
  }
}

async function recordPagedVideo(url) {
  fs.mkdirSync('./outputs', { recursive: true })

  const baseFilename = url
    .replace(/https?:\/\//, '')
    .replace(/[^a-z0-9]/gi, '-')
    .toLowerCase()
  const uniqueSuffix = jobId ? `-${jobId}` : ''
  const filename = `${baseFilename}${uniqueSuffix}`
  const outputPath = `./outputs/${filename}-paged.mp4`

  updateJob({ status: 'recording', started_at: Date.now() })
  console.log(`Recording (paged): ${url}`)
  console.log(`Output: ${outputPath}`)

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const page = await browser.newPage()
  await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT })

  const recorder = new PuppeteerScreenRecorder(page, {
    fps: 30,
    videoFrame: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    videoCodec: 'libx264',
    videoCrf: 18,
    videoPreset: 'ultrafast',
  })

  console.log('Loading page...')
  const finalUrl = await gotoWithFallback(page, url)
  await page.evaluate((zoom) => {
    document.body.style.zoom = String(zoom)
  }, PAGE_ZOOM)

  await recorder.start(outputPath)
  await sleep(INITIAL_HOLD_MS)

  console.log('Scrolling page by page (smooth)...')
  await page.evaluate(
    async ({ maxSteps, betweenWaitMs }) => {
      const viewportHeight = window.innerHeight
      const totalHeight = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      )

      let currentY = 0
      let step = 0
      while (currentY < totalHeight - viewportHeight && step < maxSteps) {
        currentY = Math.min(currentY + viewportHeight, totalHeight - viewportHeight)
        window.scrollTo({ top: currentY, behavior: 'smooth' })
        await new Promise((r) => setTimeout(r, betweenWaitMs))
        step += 1
      }
    },
    { maxSteps: MAX_SCROLL_STEPS, betweenWaitMs: BETWEEN_SCROLL_WAIT_MS }
  )

  await sleep(FINAL_HOLD_MS)

  console.log('Stopping recording...')
  await recorder.stop()
  await browser.close()

  const stat = fs.statSync(outputPath)
  if (!stat || stat.size < 50_000) {
    throw new Error('Recorded video is empty or too small')
  }
  execFileSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height',
    '-of', 'default=noprint_wrappers=1',
    outputPath,
  ])

  console.log(`✅ Done! Video saved to ${outputPath}`)
  updateJob({ status: 'done', filename: `${filename}-paged.mp4`, source_url: finalUrl })
}

const url = process.argv[2]

if (!url) {
  console.error('Usage: node record-paged.js <url>')
  console.error('Example: node record-paged.js https://tkrupt.com')
  process.exit(1)
}

Promise.race([
  recordPagedVideo(url),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timed out after ${MAX_JOB_MS}ms`)), MAX_JOB_MS)
  ),
]).catch((err) => {
  console.error('Error:', err.message)
  updateJob({ status: 'error', error: err.message })
  process.exit(1)
})
