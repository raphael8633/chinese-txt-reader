import { describe, expect, it } from 'vitest'
import { getAttribute, MAX_TOKENS, tokenize } from '../generic/tokenizer.js'
import { providerFor } from './GenericFixtureHarness.js'

const textOf = (html: string): string =>
  tokenize(html).filter((token) => token.kind === 'text').map((token) => token.text.trim()).join('|')

describe('generic tokenizer', () => {
  it('skips script, style, noscript, template and svg content entirely', () => {
    const html = '<div>甲<script>var a = "</div>乙";</script><style>.x{content:"丙"}</style>'
      + '<noscript>丁</noscript><template><a href="/x">戊</a></template>'
      + '<svg><text>己</text></svg>庚</div>'

    expect(textOf(html)).toBe('甲|庚')
    expect(tokenize(html).filter((token) => token.kind === 'close' && token.name === 'div')).toHaveLength(1)
  })

  it('drops comments and doctype without swallowing the markup around them', () => {
    expect(textOf('<!doctype html><p>甲</p><!-- <p>乙</p> --><p>丙</p>')).toBe('甲|丙')
  })

  it('keeps a > that appears inside a quoted attribute value inside the tag', () => {
    const tokens = tokenize('<a href="/x?a=1&b=2" title="甲>乙">丙</a>')
    const anchor = tokens[0]

    expect(anchor.kind).toBe('open')
    expect(anchor.kind === 'open' && getAttribute(anchor.attrs, 'href')).toBe('/x?a=1&b=2')
    expect(textOf('<a href="/x" title="甲>乙">丙</a>')).toBe('丙')
  })

  it('gives void and self-closed elements a matching close token', () => {
    const names = tokenize('<p>甲<br>乙<img src="/i.png"><hr /></p>')
      .map((token) => (token.kind === 'text' ? 'text' : `${token.kind}:${token.name}`))

    expect(names).toEqual([
      'open:p', 'text', 'open:br', 'close:br', 'text',
      'open:img', 'close:img', 'open:hr', 'close:hr', 'close:p',
    ])
  })

  it('matches attributes by exact name, so data-href never answers for href', () => {
    expect(getAttribute('data-href="/decoy" href="/real"', 'href')).toBe('/real')
    expect(getAttribute("data-href='/decoy'", 'href')).toBeNull()
    expect(getAttribute('href=/bare class="x"', 'href')).toBe('/bare')
  })

  it('ends an unclosed anchor at the next anchor instead of swallowing the page', () => {
    const anchors = Array.from(
      { length: 12 },
      (_, index) => `<li><a href="/b/2/${index + 1}.html">第${index + 1}章 山道`,
    ).join('')
    const url = 'https://sloppy.example/b/2/'
    const { provider } = providerFor({
      [url]: { html: `<html><head><title>未閉合</title></head><body><h1>未閉合</h1><ul>${anchors}</ul></body></html>` },
    })

    return provider.parseChapterList(url).then((parsed) => {
      expect(parsed.chapters).toHaveLength(12)
      expect(parsed.chapters[0].title).toBe('第1章 山道')
      expect(parsed.chapters[11].title).toBe('第12章 山道')
    })
  })

  it('does not count an unclosed anchor as link text across the rest of the page', async () => {
    const url = 'https://sloppy.example/b/2/9.html'
    const prose = Array.from({ length: 10 }, (_, index) => `<p>第${index + 1}段，山道上只剩下腳步聲與遠處的水流聲，霧氣散去之後才看清前路。</p>`).join('')
    const { provider } = providerFor({
      [url]: {
        html: `<html><head><title>第9章</title></head><body><div class="nav"><a href="/b/2/8.html">上一章`
          + `</div><div class="content">${prose}</div></body></html>`,
      },
    })

    const text = await provider.fetchChapterText(url)

    expect(text.split('\n\n')).toHaveLength(10)
    expect(text).not.toContain('上一章')
  })

  it('refuses a page with more tokens than the cap instead of hanging', () => {
    const html = `<body>${'<p>甲</p>'.repeat(200)}</body>`

    expect(() => tokenize(html, 50)).toThrowError(/頁面結構過於龐大/)
  })
})

const flatListHtml = (anchorCount: number): string => {
  const anchors = Array.from(
    { length: anchorCount },
    (_, index) => `<li><a href="/b/4471/${index + 1}.html">第${index + 1}章 山道與燈</a></li>`,
  ).join('')
  return `<html><head><meta charset="utf-8"><title>壓力測試</title></head>`
    + `<body><h1>壓力測試</h1><div class="listmain"><ul>${anchors}</ul></div></body></html>`
}

/**
 * Median of three: a single timing on a loaded machine swings by well over a
 * second here, which made an absolute bound alone flaky in both directions.
 */
async function medianParseMs(anchorCount: number, runs = 3): Promise<number> {
  const html = flatListHtml(anchorCount)
  const url = 'https://perf.example/b/4471/'
  const times: number[] = []
  for (let run = 0; run < runs; run += 1) {
    const { provider } = providerFor({ [url]: { html } })
    const startedAt = performance.now()
    const parsed = await provider.parseChapterList(url)
    times.push(performance.now() - startedAt)
    expect(parsed.chapters).toHaveLength(anchorCount)
  }
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)]
}

describe('generic parsing performance', () => {
  it('parses a 3 MB page with 50k anchors, and scales near-linearly with anchor count', async () => {
    const html = flatListHtml(50_000)
    expect(Buffer.byteLength(html)).toBeGreaterThan(3 * 1024 * 1024)
    expect(tokenize(html).length).toBeLessThan(MAX_TOKENS)

    const median25k = await medianParseMs(25_000)
    const median50k = await medianParseMs(50_000)

    expect(median50k).toBeLessThan(4000)
    // The absolute bound alone would not notice quadratic work on a fast machine;
    // doubling the input must not do appreciably more than double the work.
    expect(median50k).toBeLessThan(median25k * 3)
  }, 120_000)

  it('stays linear when 20k anchors sit under 2000 nested elements', async () => {
    // Nesting is the cheap dimension: one token and five bytes per <div>, so a
    // page far under both caps can still make depth × anchors enormous. Copying
    // the nesting stack per anchor took 3.2 s and 365 MB here.
    const depth = 2000
    const anchors = Array.from(
      { length: 20_000 },
      (_, index) => `<li><a href="/b/9/${index + 1}.html">第${index + 1}章 山道與燈</a></li>`,
    ).join('')
    const html = `<html><head><meta charset="utf-8"><title>深層巢狀</title></head><body><h1>深層巢狀</h1>`
      + `${'<div class="wrap">'.repeat(depth)}<ul>${anchors}</ul>${'</div>'.repeat(depth)}`
      + `</body></html>`
    expect(Buffer.byteLength(html)).toBeLessThan(4 * 1024 * 1024)
    expect(tokenize(html).length).toBeLessThan(MAX_TOKENS)

    const url = 'https://deep.example/b/9/'
    const { provider } = providerFor({ [url]: { html } })

    const heapBefore = process.memoryUsage().heapUsed
    const startedAt = performance.now()
    const parsed = await provider.parseChapterList(url)
    const elapsedMs = performance.now() - startedAt
    const heapGrowthMb = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024)

    expect(parsed.chapters).toHaveLength(20_000)
    expect(elapsedMs).toBeLessThan(2000)
    expect(heapGrowthMb).toBeLessThan(300)
  }, 120_000)
})
