// Draws the README's animated images from the mod's own pixel art.
// Run with Node 25+ (it strips the TypeScript types): node scripts/docs.mjs
// Each image is a flip-book: one frame per second, every frame a full drawing, shown in turn by CSS.
import { writeFileSync } from 'node:fs'
import { barSvg, modelLabel, spriteSvg, typeColor, typeLabel } from '../hooks/draw.ts'

const OUT = new URL('../docs/', import.meta.url)

// ── Look ─────────────────────────────────────────────────────
const INK = {
  card: '#1f1e1d',
  edge: '#3a3836',
  text: '#ece9e4',
  subtle: '#9c9893',
  claude: '#D97757',
  green: '#2FB67C',
  red: '#E0533F',
  yellow: '#F4C542',
  grey: '#8A8F98',
}
const FONT = `font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"`
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const text = (x, y, s, { color = INK.text, size = 13, bold = false, anchor = 'start' } = {}) =>
  `<text x="${x}" y="${y}" fill="${color}" font-size="${size}"${bold ? ' font-weight="700"' : ''} text-anchor="${anchor}">${esc(s)}</text>`
/** A nested drawing (a sprite or a bar) placed at x, y. */
const place = (svg, x, y) => svg.replace('<svg ', `<svg x="${x}" y="${y}" `)
/** A critter, a little larger than in the band so it reads at README size. */
const critterAt = (svg, x, y, k = 1.3) => `<g transform="translate(${x} ${y}) scale(${k})">${svg}</g>`
/** Cuts text to a pixel budget (about 7.6 px a character at this size). */
const fit = (s, px) => (s.length * 7.6 > px ? `${s.slice(0, Math.max(1, Math.floor(px / 7.6) - 1))}…` : s)

/** A whole agent as the mod keeps it, filled in from a scene's short description. */
function agent(id, o) {
  return {
    id,
    type: 'Explore',
    description: '',
    model: 'demo',
    status: 'running',
    activity: 'thinking',
    target: '',
    activityAt: 0,
    seenAt: 0,
    startedAt: 0,
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    tools: 0,
    requests: 0,
    prevActivity: o.activity ?? 'thinking',
    ...o,
  }
}

const STATUS_COLOR = { running: null, done: INK.green, failed: INK.red, cancelled: INK.grey }
const LABEL = { searching: 'Searching', reading: 'Reading', writing: 'Writing', running: 'Running', web: 'Browsing', thinking: 'Thinking', starting: 'Getting ready' }

// ── Pieces of the band ───────────────────────────────────────
const W = 940

/** The framed title row. */
function title({ y, now, label = 'AGENT CREW', said, right, critter, arrow = '▾', alert = false, model = '' }) {
  return [
    `<rect x="10" y="${y}" width="${W - 20}" height="58" rx="10" fill="none" stroke="${INK.claude}" stroke-width="1.5"/>`,
    critter ? critterAt(spriteSvg(critter, now), 22, y + 6) : '',
    text(92, y + 34, label, { color: INK.claude, bold: true }),
    model ? text(label.length > 6 ? 196 : 148, y + 34, model, { color: INK.subtle, size: 12 }) : '',
    text((label.length > 6 ? 196 : 148) + (model ? model.length * 7.4 + 14 : 0), y + 34, said, { color: alert ? INK.yellow : INK.text }),
    text(W - 56, y + 34, right, { color: INK.subtle, anchor: 'end' }),
    arrow ? text(W - 36, y + 34, arrow, { color: INK.text }) : '',
  ].join('')
}

/** One agent's row: critter, type, task, what it does, bar, percent, time left, tokens, arrow. */
function row({ y, now, a, doing, extra = '', share = 0, eta = '', tokens = '', helper = false, open = false, alert = false }) {
  const dx = helper ? 30 : 0
  const color = STATUS_COLOR[a.status] ?? typeColor(a.type)
  const done = a.status !== 'running'
  const doingX = 380
  const extraX = doingX + doing.length * 7.8 + 10
  return [
    helper ? text(24, y + 29, '└', { color: INK.subtle }) : '',
    critterAt(spriteSvg(a, now), 18 + dx, y + 2),
    text(92 + dx, y + (modelLabel(a.model) ? 24 : 29), typeLabel(a.type), { color: typeColor(a.type), bold: true, size: 10.5 }),
    modelLabel(a.model) ? text(92 + dx, y + 37, modelLabel(a.model), { color: INK.subtle, size: 9.5 }) : '',
    text(176 + dx, y + 29, fit(a.description, 196 - dx), { color: helper ? INK.subtle : INK.text, bold: !helper, size: 12.5 }),
    text(doingX, y + 29, doing, { color: alert ? INK.yellow : color, bold: true, size: 12.5 }),
    extra ? text(extraX, y + 29, fit(extra, 588 - 12 - extraX), { color: INK.subtle, size: 12 }) : '',
    place(barSvg(share, color, !done, 104, 14, 7), 588, y + 23),
    text(706, y + 29, `${Math.round(share * 100)}%`, { bold: true, size: 12.5 }),
    text(750, y + 29, eta, { color: done ? INK.subtle : INK.text, bold: !done, size: 12.5 }),
    text(840, y + 29, tokens, { color: INK.subtle, size: 12 }),
    text(W - 36, y + 29, open ? '▾' : '▸', { color: INK.text }),
  ].join('')
}

/** A flip-book: each frame a full drawing, one per second, looping. */
function flipbook(name, height, frames, seconds = 1) {
  const n = frames.length
  const total = n * seconds
  const visible = (100 / n).toFixed(3)
  const body = frames
    .map((f, i) => `<g class="fr" style="animation-delay:${i * seconds}s">${f}</g>`)
    .join('')
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" ${FONT}>` +
    `<style>.fr{opacity:0;animation:show ${total}s steps(1,end) infinite}@keyframes show{0%,${visible}%{opacity:1}${(+visible + 0.001).toFixed(3)}%,100%{opacity:0}}</style>` +
    `<rect width="${W}" height="${height}" rx="14" fill="${INK.card}"/>` +
    body +
    `</svg>`
  writeFileSync(new URL(`${name}.svg`, OUT), svg)
  console.log(`docs/${name}.svg  ${frames.length} frames  ${(svg.length / 1024).toFixed(0)} KB`)
}

// ── Scene 1: the crew at work (hero) ─────────────────────────
{
  const frames = []
  for (let t = 0; t < 14; t++) {
    const now = t * 1000
    const p = (start, len) => Math.max(0, Math.min(1, (t - start) / len))
    const ex = p(0, 8)
    const ge = p(0, 13)
    const he = p(3, 6)
    const pl = p(0, 10)
    const explore = agent('hero-explore', {
      type: 'Explore', description: 'Map the auth flow', model: 'claude-haiku-5-5',
      status: ex >= 1 ? 'done' : 'running',
      activity: t < 3 ? 'searching' : t < 6 ? 'reading' : 'thinking', activityAt: t < 6 ? 0 : 6000,
    })
    const general = agent('hero-general', {
      type: 'general-purpose', description: 'Write and run the tests', model: 'claude-sonnet-5-5',
      status: ge >= 1 ? 'done' : 'running',
      activity: t < 4 ? 'writing' : t < 9 ? 'thinking' : 'running', activityAt: t < 4 ? 0 : t < 9 ? 4000 : 9000,
    })
    const helper = agent('hero-helper', {
      type: 'Explore', description: 'Find mock data', parentId: 'hero-general', model: 'claude-haiku-5-5',
      status: he >= 1 ? 'done' : 'running', activity: t < 6 ? 'searching' : 'reading',
    })
    const plan = agent('hero-plan', {
      type: 'Plan', description: 'Plan the refactor', model: 'claude-opus-5-5',
      status: pl >= 1 ? 'done' : 'running', activity: 'thinking', activityAt: 0,
    })
    const left = s => (s >= 1 ? '' : `~0:${String(Math.round((1 - s) * 14)).padStart(2, '0')} left`)
        const runningCount = [ex, ge, pl].filter(s => s < 1).length
    const said = runningCount === 0 ? 'All done' : `${runningCount} agent${runningCount > 1 ? 's' : ''} working${he < 1 && t >= 3 ? ', 1 helper working' : ''}`
    const tokens = (s, max) => `${(s * max).toFixed(1)}k tok`
    let y = 16
    let f = title({ y, now, said, right: `${(ex * 3.1 + ge * 5.4 + he * 0.9 + pl * 2.6).toFixed(1)}k tokens  ·  ${Math.round(((ex + ge + pl) / 3) * 100)}%`, critter: agent('hero-title', { status: runningCount ? 'running' : 'done' }) })
    y += 72
    const doingOf = (a, s) => (s >= 1 ? 'Done' : LABEL[a.activity])
    f += row({ y, now, a: explore, doing: doingOf(explore, ex), extra: ex < 1 ? (t < 3 ? 'func login(' : t < 6 ? 'AuthService.swift' : '') : '', share: ex, eta: left(ex) || 'took 0:08', tokens: tokens(ex, 3.1) })
    y += 52
    f += row({ y, now, a: general, doing: ge >= 1 ? 'Done' : 'Step ' + Math.min(5, 1 + Math.floor(ge * 5)) + '/5', extra: ge < 1 && he < 1 && t >= 3 ? 'waiting on 1 helper' : '', share: ge, eta: left(ge) || 'took 0:13', tokens: tokens(ge, 5.4) })
    y += 52
    if (t >= 3) {
      f += row({ y, now, a: helper, doing: doingOf(helper, he), extra: he < 1 ? 'MockUser' : '', share: he, eta: left(he) || 'took 0:06', tokens: tokens(Math.max(he, 0.1), 0.9), helper: true })
      y += 52
    }
    f += row({ y, now, a: plan, doing: doingOf(plan, pl), share: pl, eta: left(pl) || 'took 0:10', tokens: tokens(pl, 2.6) })
    frames.push(f)
  }
  frames.push(frames[frames.length - 1], frames[frames.length - 1]) // a pause on "All done"
  flipbook('hero', 320, frames)
}

// ── Scene 2: Claude working alone, then the thin line ───────
{
  const steps = [
    ['searching', 'func login('], ['searching', 'func login('], ['reading', 'AuthService.swift'], ['reading', 'AuthService.swift'],
    ['thinking', ''], ['thinking', ''], ['thinking', ''], ['writing', 'AuthService.swift'], ['writing', 'AuthService.swift'], ['running', 'swift test'], ['running', 'swift test'],
  ]
  const frames = []
  steps.forEach(([activity, target], t) => {
    const now = t * 1000
    const me = agent('claude-main', { activity, activityAt: activity === 'thinking' ? 4000 : 0 })
    frames.push(title({ y: 18, now, label: 'AGENT', model: 'Opus 5.5', said: `${LABEL[activity]}  ${target}`, right: `0:${String(t * 3 + 4).padStart(2, '0')}  ·  ${(1.2 + t * 0.4).toFixed(1)}k tokens`, critter: me, arrow: '▸' }))
  })
  const thin =
    text(24, 52, 'AGENT', { color: INK.claude, bold: true }) +
    text(80, 52, 'Done', { color: INK.green }) +
    text(124, 52, '·  last turn 0:37  ·  5.6k tokens  ·  9 tools', { color: INK.subtle }) +
    text(W - 36, 52, '▸', { color: INK.text })
  frames.push(thin, thin, thin)
  flipbook('agent-line', 94, frames)
}

// ── Scene 3: waiting on your approval ───────────────────────
{
  const frames = []
  for (let t = 0; t < 6; t++) {
    const now = t * 1000
    const asking = t < 4
    const a = agent('approval', { type: 'general-purpose', description: 'Clean the build folder', model: 'claude-sonnet-5-5', activity: 'running', waitingFor: asking ? 'Bash rm -r build' : undefined })
    let f = title({ y: 16, now, said: asking ? '1 agent needs your approval' : 'Clean the build folder: running', right: '2.1k tokens  ·  40%', critter: agent('approval-title', {}), alert: asking })
    f += row({ y: 88, now, a, doing: asking ? 'Needs approval' : 'Running', extra: asking ? 'Bash rm -r build' : 'rm -r build', share: 0.4, eta: '~0:09 left', tokens: '2.1k tok', alert: asking })
    frames.push(f)
  }
  flipbook('approval', 148, frames)
}

// ── Scene 4: the thinking scenes, up close ──────────────────
{
  const frames = []
  for (let t = 0; t < 9; t++) {
    const now = t * 1000
    const big = (id, x) => {
      const svg = spriteSvg(agent(id, { activity: 'thinking', activityAt: 0 }), now)
      return `<g transform="translate(${x} 18) scale(3)">${svg}</g>`
    }
    frames.push(big('c0', 150) + big('c1', 380) + big('c2', 610))
  }
  flipbook('thinking', 140, frames)
}

// ── Scene 5: how "time left" is worked out ──────────────────
{
  const past = [38, 52, 44, 61, 47] // seconds, earlier runs of the same agent type
  const scale = 6 // px a second
  const bars = (highlight) =>
    past
      .map((sec, i) => {
        const y = 62 + i * 22
        const mid = highlight && sec === 47
        return `<rect x="40" y="${y}" width="${sec * scale}" height="12" rx="3" fill="${mid ? INK.claude : '#4a4743'}"/>` +
          text(40 + sec * scale + 10, y + 11, `0:${sec}`, { color: mid ? INK.claude : INK.subtle, size: 12 })
      })
      .join('')
  const caption = (s1, s2 = '') => text(40, 36, s1, { bold: true, size: 15 }) + (s2 ? text(W - 40, 36, s2, { color: INK.subtle, size: 12.5, anchor: 'end' }) : '')
  const live = (sec, left, note, over = false) => {
    const y = 210
    const w = Math.min(sec, 47) * scale
    return `<rect x="40" y="${y}" width="${47 * scale}" height="14" rx="3" fill="none" stroke="#4a4743" stroke-dasharray="4 3"/>` +
      `<rect x="40" y="${y}" width="${w}" height="14" rx="3" fill="${typeColor('Explore')}"/>` +
      (over ? `<rect x="${40 + 47 * scale}" y="${y}" width="${(sec - 47) * scale}" height="14" rx="3" fill="${INK.yellow}"/><rect x="${40 + sec * scale}" y="${y}" width="${15 * scale}" height="14" rx="3" fill="none" stroke="${INK.yellow}" stroke-dasharray="4 3"/>` : '') +
      text(40, y + 38, `this run: 0:${String(sec).padStart(2, '0')}`, { color: INK.subtle, size: 12.5 }) +
      text(220, y + 38, left, { bold: true, size: 13 }) +
      text(360, y + 38, note, { color: over ? INK.yellow : INK.subtle, size: 12.5 })
  }
  const frames = [
    caption('It remembers how long this kind of agent usually takes', 'last 20 runs, per type and model') + bars(false),
    caption('It expects the middle one, not the average', 'one slow run never skews it') + bars(true),
    caption('While the agent works, the clock counts down', 'more requests than usual? it adjusts') + bars(true) + live(20, '~0:27 left', 'expected 0:47'),
    caption('While the agent works, the clock counts down', 'more requests than usual? it adjusts') + bars(true) + live(35, '~0:12 left', 'expected 0:47'),
    caption('Running long? It re-estimates instead of going negative') + bars(true) + live(55, '~0:06 left', 're-estimated: runs this long ended near 1:01', true),
    caption('Plain arithmetic on your machine: no model is asked, no tokens spent') + bars(true) + live(55, '~0:06 left', 're-estimated: runs this long ended near 1:01', true),
  ]
  flipbook('estimate', 270, frames, 2.5)
}

// ── Scene 6: the details panel ──────────────────────────────
{
  const a = agent('details', { type: 'general-purpose', description: 'Write and run the tests', model: 'claude-sonnet-5-5', activity: 'writing', target: 'AuthTests.swift' })
  const closed = (now) => title({ y: 16, now, said: 'Write and run the tests: step 3/5', right: '4.7k tokens  ·  ~0:14 left  ·  50%', critter: agent('details-title', {}) }) +
    row({ y: 88, now, a, doing: 'Step 3/5', extra: 'Write login tests', share: 0.5, eta: '~0:14 left', tokens: '4.7k tok' })
  const line = (y, label, value, note = '') => text(110, y, label, { color: INK.subtle, size: 12.5 }) + text(190, y, value, { size: 12.5 }) + (note ? text(190 + value.length * 7.6 + 12, y, note, { color: INK.subtle, size: 12 }) : '')
  const open = (now) =>
    title({ y: 16, now, said: 'Write and run the tests: step 3/5', right: '4.7k tokens  ·  ~0:14 left  ·  50%', critter: agent('details-title', {}) }) +
    `<rect x="12" y="84" width="${W - 24}" height="290" rx="8" fill="none" stroke="${INK.yellow}" stroke-dasharray="6 4"/>` +
    row({ y: 88, now, a, doing: 'Step 3/5', extra: 'Write login tests', share: 0.5, eta: '~0:14 left', tokens: '4.7k tok', open: true }) +
    line(160, 'Task', 'Write and run the tests for the login flow') +
    line(182, 'Now', 'Writing: AuthTests.swift') +
    text(110, 206, '[x] Review existing tests', { color: INK.subtle, size: 12.5 }) +
    text(110, 226, '[x] Prepare fixtures', { color: INK.subtle, size: 12.5 }) +
    text(110, 246, '[>] Write login tests', { bold: true, size: 12.5 }) +
    text(110, 266, '[ ] Run the tests', { size: 12.5 }) +
    line(292, 'Changed', 'AuthTests.swift  ·  Fixtures.swift') +
    line(314, 'Tokens', '4.7k', '(input 2.1k · output 2.6k)') +
    line(336, 'Cache', '0.5k written · 148k re-read', '·  the conversation, kept by Claude between requests') +
    line(358, 'Run', 'sonnet · 14 tools · 9 requests · 0:31 elapsed')
  flipbook('details', 392, [closed(0), closed(1000), open(2000), open(3000), open(4000), open(5000), open(6000)], 1)
}

// ── Site sprites: one small animated critter per state ──────
{
  const dir = new URL('../site/sprites/', import.meta.url)
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  const book = (name, make, n) => {
    const frames = Array.from({ length: n }, (_, t) => place(spriteSvg(make(t), t * 1000), 0, 0))
    const visible = (100 / n).toFixed(3)
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="34" viewBox="0 0 44 34">` +
      (n > 1 ? `<style>.fr{opacity:0;animation:show ${n}s steps(1,end) infinite}@keyframes show{0%,${visible}%{opacity:1}${(+visible + 0.001).toFixed(3)}%,100%{opacity:0}}</style>` : '') +
      frames.map((f, i) => (n > 1 ? `<g class="fr" style="animation-delay:${i}s">${f}</g>` : f)).join('') +
      `</svg>`
    writeFileSync(new URL(`${name}.svg`, dir), svg)
  }
  const one = o => () => agent('site', o)
  for (const activity of ['searching', 'reading', 'writing', 'running', 'web', 'starting']) book(activity, one({ activity }), 1)
  book('thinking', t => agent('c1', { activity: 'thinking', activityAt: 0 }), 9) // cycles hourglass, cloud and bulb
  book('waiting', one({ activity: 'running', waitingFor: 'Bash' }), 1)
  book('done', one({ status: 'done' }), 1)
  book('failed', one({ status: 'failed' }), 1)
  book('cancelled', one({ status: 'cancelled' }), 1)
  console.log('site/sprites/  11 critters')
}
