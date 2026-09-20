/**
 * ═══════════════════════════════════════════════════════════
 * vite-plugin-shot-writer — dev-only screenshot sink
 * ───────────────────────────────────────────────────────────
 * Gives /capture.html somewhere to put the shell art:
 *
 *     POST /__shot/slide-3   (body = raw JPEG)  →  static/loading/slide-3.jpg
 *     POST /__shot/menu                         →  static/loading/menu.jpg
 *
 * apply:'serve' — this never runs during `vite build`, so it cannot
 * leak into dist/ or into anything a player downloads.
 * ═══════════════════════════════════════════════════════════
 */

import fs from 'node:fs'
import path from 'node:path'

const MAX_BYTES = 32 * 1024 * 1024

// The charset excludes "/" and ".", and the name must then be one of NAMES, so
// "../", absolute paths and URL-encoded traversal are all structurally
// impossible — not merely filtered.
const ROUTE = /^\/__shot\/([a-z0-9-]{1,20})$/
const NAMES = new Set([
    'slide-1', 'slide-2', 'slide-3', 'slide-4', 'slide-5',   // loading slideshow
    'menu',                                                   // shell backdrop
    'cutscene',                                               // intro sepia still
])

function readRawBody(req, limit = MAX_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (c) => {
            size += c.length
            if (size > limit) {
                reject(Object.assign(new Error('payload too large'), { status: 413 }))
                req.destroy()
            } else {
                chunks.push(c)
            }
        })
        req.on('end',   () => resolve(Buffer.concat(chunks)))
        req.on('error', reject)
    })
}

/** OneDrive's sync engine and Defender take transient locks on fresh files. */
function writeWithRetry(file, buf, attempts = 3) {
    for (let i = 0; ; i++) {
        try {
            fs.writeFileSync(file, buf)
            return
        } catch (err) {
            if (i >= attempts - 1 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err
            // 60ms synchronous sleep — no async yield, so nothing else can grab the file
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
        }
    }
}

export default function shotWriter({ dir = 'loading', ext = 'jpg' } = {}) {
    let outDir = null

    return {
        name: 'shot-writer',
        apply: 'serve',

        configResolved(config) {
            // config.publicDir is already absolute (<project>/static). Do NOT use
            // process.cwd() (wherever npm was launched) or config.root (<project>/src).
            const base = config.publicDir || path.resolve(config.root, '../static')
            outDir = path.resolve(base, dir)
        },

        configureServer(server) {
            // Registered here (not in a returned post-hook) so it runs BEFORE Vite's
            // own middlewares, which would otherwise 404 the POST.
            server.middlewares.use(async (req, res, next) => {
                if (req.method !== 'POST') return next()

                const pathname = (req.url || '').split('?')[0]
                const m = ROUTE.exec(pathname)
                if (!m || !NAMES.has(m[1])) return next()

                const name = `${m[1]}.${ext}`
                const file = path.join(outDir, name)

                try {
                    const buf = await readRawBody(req)

                    if (!buf.length) {
                        res.statusCode = 400
                        return res.end('empty body')
                    }
                    // JPEG SOI marker — catches a client bug before it corrupts the art
                    if (buf[0] !== 0xff || buf[1] !== 0xd8) {
                        res.statusCode = 415
                        return res.end('not a JPEG')
                    }

                    fs.mkdirSync(outDir, { recursive: true })
                    writeWithRetry(file, buf)

                    server.config.logger.info(
                        `[shot] wrote ${path.relative(server.config.root, file)} ` +
                        `(${(buf.length / 1024).toFixed(1)} KB)`
                    )

                    res.statusCode = 200
                    res.setHeader('Content-Type', 'application/json')
                    res.end(JSON.stringify({ ok: true, file: `/${dir}/${name}`, bytes: buf.length }))
                } catch (err) {
                    server.config.logger.error(`[shot] ${err.message}`)
                    res.statusCode = err.status || 500
                    res.end(String(err.message))
                }
            })
        },
    }
}
