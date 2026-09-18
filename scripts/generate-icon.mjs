import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const outputDirectory = new URL('../build/', import.meta.url)
const sizes = [16, 24, 32, 48, 64, 128, 256]

if (!process.versions.electron) {
  const require = createRequire(import.meta.url)
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [scriptPath], {
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  })
  child.on('error', (error) => {
    console.error(error)
    process.exitCode = 1
  })
  child.on('exit', (code) => {
    process.exitCode = code ?? 1
  })
} else {
  // Do not await app readiness at module scope: Electron must finish loading its entrypoint.
  void generateIcons()
}

async function generateIcons() {
  const { app, BrowserWindow, nativeImage } = await import('electron')
  let window
  try {
    await app.whenReady()
    const svg = await readFile(new URL('icon.svg', outputDirectory), 'utf8')
    window = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true },
    })
    await window.loadURL('data:text/html;charset=utf-8,<html><body></body></html>')
    // Chromium preserves the approved SVG's gradients, transparency, and original viewBox.
    const pngs = await window.webContents.executeJavaScript(`
      (async () => {
        const image = new Image()
        image.src = ${JSON.stringify(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)}
        await image.decode()
        const source = document.createElement('canvas')
        source.width = source.height = 1024
        source.getContext('2d').drawImage(image, 0, 0, 1024, 1024)
        return ${JSON.stringify([...sizes, 512])}.map((size) => {
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = size
          const context = canvas.getContext('2d')
          context.imageSmoothingEnabled = true
          context.imageSmoothingQuality = 'high'
          context.drawImage(source, 0, 0, size, size)
          return canvas.toDataURL('image/png').split(',')[1]
        })
      })()
    `)
    const images = pngs.map((png) => Buffer.from(png, 'base64'))
    for (const [index, image] of images.entries()) {
      const expected = [...sizes, 512][index]
      const actual = nativeImage.createFromBuffer(image).getSize()
      if (actual.width !== expected || actual.height !== expected) {
        throw new Error(`Invalid raster dimensions for ${expected}px`)
      }
    }

    const header = Buffer.alloc(6 + 16 * sizes.length)
    header.writeUInt16LE(1, 2)
    header.writeUInt16LE(sizes.length, 4)
    let offset = header.length
    sizes.forEach((size, index) => {
      const entry = 6 + 16 * index
      header[entry] = header[entry + 1] = size === 256 ? 0 : size
      header.writeUInt16LE(1, entry + 4)
      header.writeUInt16LE(32, entry + 6)
      header.writeUInt32LE(images[index].length, entry + 8)
      header.writeUInt32LE(offset, entry + 12)
      offset += images[index].length
    })
    await writeFile(new URL('icon.png', outputDirectory), images.at(-1))
    await writeFile(
      new URL('icon.ico', outputDirectory),
      Buffer.concat([header, ...images.slice(0, sizes.length)]),
    )
    console.log('Generated build/icon.png (512x512) from approved build/icon.svg')
    console.log(`Generated build/icon.ico (${sizes.join(', ')}; 32-bit PNG frames)`)
    app.exit(0)
  } catch (error) {
    console.error(error)
    if (window && !window.isDestroyed()) window.destroy()
    app.exit(1)
  }
}
