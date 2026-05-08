const puppeteer = require('puppeteer')
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder')
const fs = require('fs')
const path = require('path')

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

async function recordPagedVideo(url) {
  fs.mkdirSync('./outputs', { recursive: true })

  const filename = url
    .replace(/https?:\/\//, '')
    .replace(/[^a-z0-9]/gi, '-')
    .toLowerCase()
  const outputPath = `./outputs/${filename}-paged.mp4`

  console.log(`Recording (paged): ${url}`)
  console.log(`Output: ${outputPath}`)

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 720 })

  const recorder = new PuppeteerScreenRecorder(page, {
    fps: 30,
    videoFrame: { width: 1280, height: 720 },
    videoCodec: 'libx264',
    videoCrf: 18,
    videoPreset: 'ultrafast',
  })

  await recorder.start(outputPath)

  console.log('Loading page...')
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 })

  console.log('Scrolling page by page (smooth)...')
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

  await sleep(1000)

  console.log('Stopping recording...')
  await recorder.stop()
  await browser.close()

  console.log(`✅ Done! Video saved to ${outputPath}`)
  updateJob({ status: 'done', filename: `${filename}-paged.mp4` })
}

const url = process.argv[2]

if (!url) {
  console.error('Usage: node record-paged.js <url>')
  console.error('Example: node record-paged.js https://tkrupt.com')
  process.exit(1)
}

recordPagedVideo(url).catch((err) => {
  console.error('Error:', err.message)
  updateJob({ status: 'error', error: err.message })
  process.exit(1)
})
