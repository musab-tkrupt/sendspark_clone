const fs = require('fs')
const path = require('path')

const jobId = process.argv[3]
const supabaseUrl = (process.env.SUPABASE_URL || '').trim()
const supabaseServiceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
const scrollLogPath = (process.env.SCROLL_JOB_LOG || '').trim()

function log(msg) {
  const shortId = jobId ? String(jobId).slice(0, 8) : 'no-id'
  const line = `[${new Date().toISOString()}] [scroll:${shortId}] ${msg}`
  console.log(line)
  if (scrollLogPath) {
    try {
      fs.appendFileSync(scrollLogPath, `${line}\n`)
    } catch (_) {
      /* ignore disk errors */
    }
  }
}

async function updateDbJob(patch) {
  if (!jobId || !supabaseUrl || !supabaseServiceRoleKey) {
    log('supabase: PATCH skipped (recorder missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY)')
    return
  }
  const baseUrl = supabaseUrl.replace(/\/+$/, '')
  const res = await fetch(`${baseUrl}/rest/v1/scroll_jobs?id=eq.${encodeURIComponent(jobId)}`, {
    method: 'PATCH',
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Supabase scroll_jobs PATCH failed (${res.status}): ${body}`)
  }
}

function updateJob(data) {
  if (!jobId) return
  const dir = path.join(process.cwd(), '.jobs')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${jobId}.json`), JSON.stringify(data))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function recordPagedVideo(url) {
  log('node: loading puppeteer + puppeteer-screen-recorder')
  let puppeteer
  let PuppeteerScreenRecorder
  try {
    puppeteer = require('puppeteer')
    ;({ PuppeteerScreenRecorder } = require('puppeteer-screen-recorder'))
  } catch (e) {
    log(
      `error missing Node deps (${e.message}). On the server run: cd backend && npm ci`
    )
    throw e
  }

  log(`start url=${url}`)
  fs.mkdirSync('./outputs', { recursive: true })
  await updateDbJob({ status: 'recording', error: null, filename: null })

  const filename = url
    .replace(/https?:\/\//, '')
    .replace(/[^a-z0-9]/gi, '-')
    .toLowerCase()
  const outputPath = `./outputs/${filename}-paged.mp4`

  log(`output file ${outputPath}`)

  log('chromium: launching puppeteer')
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  log('chromium: browser launched')

  const page = await browser.newPage()
  log('chromium: new page + viewport 1280x720')
  await page.setViewport({ width: 1280, height: 720 })

  const recorder = new PuppeteerScreenRecorder(page, {
    fps: 30,
    videoFrame: { width: 1280, height: 720 },
    videoCodec: 'libx264',
    videoCrf: 18,
    videoPreset: 'ultrafast',
  })

  log('recorder: starting screen capture')
  await recorder.start(outputPath)
  log('recorder: capture started')

  // domcontentloaded fires as soon as the HTML is parsed — much faster than
  // networkidle0 which waits for ALL network requests to settle (never happens
  // on modern sites with analytics/fonts/websockets). We add a 3s wait
  // afterwards to let above-the-fold content render visually.
  log(`page: goto ${url} (domcontentloaded, 60s)`)
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  } catch (err) {
    // If even domcontentloaded times out, try to continue with whatever loaded.
    log(`page: goto warning — ${err.message} — continuing with partial load`)
  }
  log('page: waiting 3s for above-the-fold render')
  await sleep(3000)
  log('page: load complete')

  log('scroll: smooth page-by-page in page context')
  await page.evaluate(
    async () => {
      const viewportHeight = window.innerHeight
      const totalHeight = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      )

      let currentY = 0
      while (currentY < totalHeight - viewportHeight) {
        currentY = Math.min(currentY + viewportHeight, totalHeight - viewportHeight)
        window.scrollTo({ top: currentY, behavior: 'smooth' })
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
  )
  log('scroll: finished')

  await sleep(1000)

  log('recorder: stopping')
  await recorder.stop()
  log('chromium: closing browser')
  await browser.close()
  log('chromium: closed')

  log(`done video saved ${outputPath}`)
  log('supabase: updating job status → done')
  await updateDbJob({
    status: 'done',
    filename: `${filename}-paged.mp4`,
    error: null,
    completed_at: new Date().toISOString(),
  })
  updateJob({ status: 'done', filename: `${filename}-paged.mp4` })
}

const url = process.argv[2]

if (!url) {
  console.error('Usage: node record-paged.js <url>')
  console.error('Example: node record-paged.js https://tkrupt.com')
  process.exit(1)
}

recordPagedVideo(url).catch((err) => {
  log(`error ${err.message}`)
  console.error('Error:', err.message)
  updateDbJob({
    status: 'error',
    error: err.message,
    completed_at: new Date().toISOString(),
  }).catch((dbErr) => {
    console.error('Failed to update DB job:', dbErr.message)
  })
  updateJob({ status: 'error', error: err.message })
  process.exit(1)
})
