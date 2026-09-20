import restart from 'vite-plugin-restart'
import shotWriter from './vite-plugin-shot-writer.js'

export default {
    root: 'src/',                          // Sources files (typically where index.html is)
    publicDir: '../static/',               // Path from "root" to static assets (files that are served as they are)
    server:
    {
        host: true,                        // Open to local network and display URL
        open: !('SANDBOX_URL' in process.env || 'CODESANDBOX_HOST' in process.env) // Open if it's not a CodeSandbox
    },
    build:
    {
        outDir: '../dist/',                // Output in the dist/ folder
        emptyOutDir: true,                 // Empty the folder first
        sourcemap: true                    // Add sourcemap
    },
    plugins:
    [
        // Restart server on static asset change. Deliberately NOT '../static/**':
        // /capture.html writes slide-N.jpg into static/loading/, and a matching glob
        // would restart the server mid-export, killing the remaining POSTs and forcing
        // a reload (= another 40MB glTF load).
        restart({ restart: [
            '../static/map/**',
            '../static/character/**',
            '../static/animations/**',
            '../static/textures/**',
        ] }),
        shotWriter(),   // dev-only: POST /__shot/[1-5] → static/loading/slide-N.jpg
    ],
}
