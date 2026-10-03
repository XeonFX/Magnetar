import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { ConfirmDialog, Modal } from './Modal.tsx'

/** Each dialog in `html` with the text of the element its aria-labelledby names, as a screen reader names it. */
function dialogNames(html: string): (string | null)[] {
  return [...html.matchAll(/<dialog[^>]*>/g)].map(([tag]) => {
    const id = /aria-labelledby="([^"]+)"/.exec(tag)?.[1]
    if (!id) return /aria-label="([^"]+)"/.exec(tag)?.[1] ?? null
    const labelled = new RegExp(`<[^>]+id="${id.replace(/[:]/g, '\\$&')}"[^>]*>(.*?)</`).exec(html)
    return labelled ? labelled[1]!.replace(/<[^>]+>/g, '') : null
  })
}

describe('dialogs', () => {
  test('are named by their visible title', () => {
    const html = renderToStaticMarkup(createElement(Modal, { open: true, title: 'Add download', onClose: () => {} }, 'body'))
    expect(dialogNames(html)).toEqual(['Add download'])
  })

  test('a question asking to delete files is named by its title', () => {
    const html = renderToStaticMarkup(createElement(ConfirmDialog<boolean>, {
      open: true, title: 'Delete download?', message: 'Also delete the files of <b>x</b>?', onResult: () => {},
      options: [{ label: 'Cancel', value: false }, { label: 'Delete files', value: true, tone: 'error' }],
    }))
    expect(dialogNames(html)).toEqual(['Delete download?'])
    // The message is text, never markup.
    expect(html).toContain('Also delete the files of &lt;b&gt;x&lt;/b&gt;?')
  })

  test('two dialogs on one page are each named by their own title', () => {
    const html = renderToStaticMarkup(createElement(Fragment, null,
      createElement(Modal, { open: true, title: 'Torrent details', onClose: () => {} }, 'a'),
      createElement(Modal, { open: true, title: 'Play', onClose: () => {} }, 'b')))
    expect(dialogNames(html)).toEqual(['Torrent details', 'Play'])
  })
})
