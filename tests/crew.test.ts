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
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })

  const empty = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await empty.find({ type: 'Text', text: /AGENT CREW/ })).toBeUndefined()
  await empty.unmount()

  expect((await $.command.run({ command: 'crew', args: 'demo', ...RUN })).text).toContain('Demo crew')
  await clock.advance(10_000)

  const desk = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await desk.find({ type: 'Text', text: /AGENT CREW/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /^Map the auth/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /left/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /Step \d\/5/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /└/ })).toBeDefined()
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /^\d+(\.\d)?k? tok$/ })).toBeDefined()

  // The arrow button opens a row's details
  await desk.press({ key: 'open-demo-1' })
  expect(await desk.find({ type: 'Text', text: /re-read from cache/ })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /\[x\]|\[>\]/ })).toBeDefined()
  expect(await desk.find({ key: 'open-demo-1' })).toMatchObject({ props: { label: '▾' } }) // the arrow turned down

  // Opening another row closes the first: one panel at a time
  await desk.press({ key: 'open-demo-0' })
  expect(await desk.find({ type: 'Text', text: /^Map the auth flow$/ })).toBeDefined() // the full task, in the panel
  expect(await desk.find({ type: 'Text', text: /\[x\]|\[>\]/ })).toBeUndefined()

  // Pressing it again closes it
  await desk.press({ key: 'open-demo-0' })
  expect(await desk.find({ type: 'Text', text: /re-read from cache/ })).toBeUndefined()
  expect(await desk.find({ key: 'open-demo-0' })).toMatchObject({ props: { label: '▸' } })
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
  await clock.advance(10_000)

  const term = await $.ui.mount({ plugin: 'agent-crew', surface: 'terminal', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await term.find({ type: 'Text', text: /AGENT CREW/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /└/ })).toBeDefined()
  await term.press({ key: 'open-demo-1' }) // the arrow is a button on the terminal, for the keyboard
  expect(await term.find({ type: 'Text', text: /re-read from cache/ })).toBeDefined()
  await term.unmount()

  // Once everyone is finished: done, failed and cancelled each show
  await clock.advance(40_000)
  const end = await $.ui.mount({ plugin: 'agent-crew', surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: VIEW })
  expect(await end.find({ type: 'Text', text: /^Done$/ })).toBeDefined()
  expect(await end.find({ type: 'Text', text: /^Failed$/ })).toBeDefined()
  expect(await end.find({ type: 'Text', text: /Cancelled/ })).toBeDefined()
  await $.command.run({ command: 'crew', args: '', ...RUN }) // hide
  expect(await end.find({ type: 'Text', text: /AGENT CREW/ })).toBeUndefined()
  await end.unmount()
})
