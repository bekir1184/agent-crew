import { expect, mock, test } from 'claude-code/testing'

const BAND = { hasSurvey: false, isWorking: true, maxRows: 30, bodyColumns: 140, scroll: { offset: 0, bodyRows: 30 }, view: {} }
const RUN = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 140 } }
const VIEW = { columns: 140, rows: 50 }

test('the demo crew draws on every surface, progresses and finishes', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text' as const, props: {}, children: ['ENGINE ROW'] }))
  // The prompt box's suggestion: what was proposed last, and by whom
  const shown: { text: string; by: string }[] = []
  on('prompt.suggest', ($, e) => {
    shown.push({ text: e.text, by: e.origin?.kind ?? '?' })
    return { isShown: true }
  })
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  const empty = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await empty.find({ type: 'Text', text: /AGENT CREW/ })).toBeUndefined()
  await empty.unmount()

  expect((await $.command.run({ command: 'crew', args: 'demo', ...RUN })).text).toContain('Demo crew')
  // For the recording, the box shows the demo's English hint, and Claude Code's own guess waits
  expect(shown.at(-1)).toEqual({ text: '/crew clear', by: 'plugin' })
  // Claude starts alone: the band is just the AGENT line
  await clock.advance(1_000)
  const alone = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await alone.find({ type: 'Text', text: /^AGENT$/ })).toBeDefined()
  await alone.unmount()
  await clock.advance(13_000) // the crew has arrived one by one

  const desk = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await desk.find({ type: 'Text', text: /AGENT CREW/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /^Map the auth/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /left/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /Step \d\/5/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /└/ })).toBeDefined()
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  // Each row names its model under the type; Claude's own sits beside the title
  const labels = (await desk.findAll({ type: 'Svg' })).map(s => (s.props as { alt?: string }).alt)
  expect(labels).toContain('EXPLORE, Haiku 5.5')
  expect(await desk.find({ type: 'Text', text: /^Opus 5\.5$/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /^\d+(\.\d)?k? tok$/ })).toBeDefined()
  // The recording moment: one agent waits on your approval
  expect(await desk.find({ type: 'Text', text: /^Needs approval$/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /1 agent needs your approval/ })).toBeDefined()

  // The arrow button opens a row's details
  await desk.press({ key: 'open-demo-2' })
  expect(await desk.find({ type: 'Text', text: / re-read$/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /\[x\]|\[>\]/ })).toBeDefined()
  expect(await desk.find({ key: 'open-demo-2' })).toMatchObject({ props: { label: '▾' } }) // the arrow turned down

  // Opening another row closes the first: one panel at a time
  await desk.press({ key: 'open-demo-1' })
  expect(await desk.find({ type: 'Text', text: /^Map the auth flow$/ })).toBeDefined() // the full task, in the panel
  // The other panel slides shut over a moment, then is gone
  expect(await desk.find({ type: 'Text', text: /\[x\]|\[>\]/ })).toBeDefined()
  await clock.advance(200)
  expect(await desk.find({ type: 'Text', text: /\[x\]|\[>\]/ })).toBeUndefined()

  // Pressing it again closes it
  await desk.press({ key: 'open-demo-1' })
  await clock.advance(200)
  expect(await desk.find({ type: 'Text', text: / re-read$/ })).toBeUndefined()
  expect(await desk.find({ key: 'open-demo-1' })).toMatchObject({ props: { label: '▸' } })
  await desk.unmount()

  // Run the demo twice and clear early: no doubled timers, and helpers don't reappear on a cleared stage
  await $.command.run({ command: 'crew', args: 'demo', ...RUN })
  await $.command.run({ command: 'crew', args: 'demo', ...RUN })
  await $.command.run({ command: 'crew', args: 'clear', ...RUN })
  await clock.advance(12_000)
  const cleared = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await cleared.find({ type: 'Text', text: /AGENT CREW/ })).toBeUndefined()
  await cleared.unmount()
  await $.command.run({ command: 'crew', args: 'demo', ...RUN })
  await clock.advance(14_000) // the whole crew is on stage by now

  const term = await $.ui.mount({ plugin: 'agent-crew', surface: 'terminal', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await term.find({ type: 'Text', text: /AGENT CREW/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /└/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /^● $/ })).toBeDefined() // a state dot, no critter
  // On the terminal the arrows take letters, pressed once the band has the focus (ctrl+x tab)
  expect(await term.find({ key: 'collapse' })).toMatchObject({ props: { hotkey: 'h' } })
  expect(await term.find({ key: 'open-demo-0' })).toMatchObject({ props: { hotkey: 'a' } })
  expect(await term.find({ key: 'open-demo-1' })).toMatchObject({ props: { hotkey: 'b' } })
  await term.press({ key: 'open-demo-1' }) // the arrow is a button on the terminal, for the keyboard
  expect(await term.find({ type: 'Text', text: / re-read$/ })).toBeDefined()
  await term.unmount()

  // The demo ends with the whole crew done, flags up
  await clock.advance(40_000)
  const end = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await end.find({ type: 'Text', text: /^Done$/ })).toBeDefined()
  expect(await end.find({ type: 'Text', text: /^(Failed|Cancelled)$/ })).toBeUndefined()
  expect(await end.find({ type: 'Text', text: /All done/ })).toBeDefined()
  await $.command.run({ command: 'crew', args: '', ...RUN }) // hide
  expect(await end.find({ type: 'Text', text: /AGENT CREW/ })).toBeUndefined()
  await end.unmount()
})
