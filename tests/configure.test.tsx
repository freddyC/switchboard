import { expect, mock, test } from 'claude-code/testing'

const PANE = { title: 'Switchboard', isFocused: true, bodyColumns: 60, placement: 'dock' } as const

test('Configure shows the settings and saves a toggle and a field', async ($, on) => {
  const saved: { key: string; value: unknown }[] = []
  mock.clock(on)
  on('config.set', async (_, e) => {
    saved.push({ key: e.key, value: e.value })
    return { value: e.value }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    saved.length = 0
    const ui = await $.ui.mount({ plugin: 'switchboard', surface, component: 'Pane', props: PANE, requestId: 'switchboard' })

    await ui.press({ key: 'configure' })
    expect(await ui.find({ text: /Chime when a session finishes/ })).toBeTruthy()

    await ui.press({ key: 'toggle-chime' })
    await ui.input({ key: 'field-ticketUrl', text: ' https://example.atlassian.net/browse/ ' })
    await ui.input({ key: 'field-refreshSeconds', text: '0' })

    expect(saved).toEqual([
      { key: 'switchboard.chime', value: false },
      { key: 'switchboard.ticketUrl', value: 'https://example.atlassian.net/browse/' },
    ])
    expect(await ui.find({ text: /refreshSeconds must be a number above 0/ })).toBeTruthy()

    await ui.press({ key: 'configure' })
  }
})
