/**
 * ═══════════════════════════════════════════════════════════
 * cutscene.js — CSS-driven intro sequence
 * ───────────────────────────────────────────────────────────
 * A full-screen overlay whose layers animate via CSS @keyframes
 * (defined in style.css). The visual timing lives in CSS; JS only
 * holds the master timer that fires onFinish at the end and lets
 * the player skip with any key / click.
 *
 * Sequence (≈11s):
 *   black hold → sepia map still fades in → two text cards →
 *   fade to white → white fades out, revealing the live world.
 * ═══════════════════════════════════════════════════════════
 */

const TOTAL_MS = 11000

const CARDS = [
    'New Mexico Territory, 1887',
    'A stranger arrives in Dead Mesa…',
]

let _root      = null
let _timer     = null
let _onFinish  = null
let _skipBound = null

export function initCutscene() {
    if (_root) return
    _root = document.createElement('div')
    _root.id = 'cutscene'
    _root.className = 'hidden'
    _root.innerHTML = `
        <div class="cs-sepia"></div>
        <div class="cs-cards">
            ${CARDS.map((t, i) => `<div class="cs-card cs-card-${i + 1}">${t}</div>`).join('')}
        </div>
        <div class="cs-white"></div>
        <div class="cs-skip">Press any key to skip</div>
    `
    document.body.appendChild(_root)
}

/**
 * Play the intro. Calls onFinish() once (at natural end OR on skip).
 * The world should already be loading/loaded underneath so the final
 * white-out reveals a live frame.
 */
export function playIntro(onFinish) {
    initCutscene()
    _onFinish = onFinish

    // Restart CSS animations: toggle the class off→on across a reflow.
    _root.classList.remove('hidden')
    _root.classList.remove('playing')
    void _root.offsetWidth          // force reflow so re-adding replays animations
    _root.classList.add('playing')

    clearTimeout(_timer)
    _timer = setTimeout(finish, TOTAL_MS)

    _skipBound = () => finish()
    window.addEventListener('keydown', _skipBound, { once: true })
    window.addEventListener('mousedown', _skipBound, { once: true })
}

function finish() {
    if (!_onFinish) return            // already finished (guards double-fire)
    clearTimeout(_timer); _timer = null
    if (_skipBound) {
        window.removeEventListener('keydown', _skipBound)
        window.removeEventListener('mousedown', _skipBound)
        _skipBound = null
    }
    _root.classList.add('hidden')
    _root.classList.remove('playing')
    const cb = _onFinish
    _onFinish = null
    cb()
}
