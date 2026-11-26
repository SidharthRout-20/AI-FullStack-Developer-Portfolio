import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, it } from 'vitest'
import { QualityPage } from './QualityPage'

it('the Quality page renders before any run exists', () => {
  expect(renderToString(h(QualityPage))).toContain('Measured, not claimed.')
})
