import { describe, expect, it } from 'vitest'
import { FetchBudgetExceededError } from '../../fetch/SafeFetchService.js'
import { GenericWebSourceProvider } from '../GenericWebSourceProvider.js'
import { fixture, providerFor } from './GenericFixtureHarness.js'

describe('GenericWebSourceProvider url handling', () => {
  it('accepts any http(s) url and rejects everything else', () => {
    const { provider } = providerFor({})
    expect(provider.canHandle('https://unknown-novel.example/book/1/')).toBe(true)
    expect(provider.canHandle('http://unknown-novel.example/book/1/')).toBe(true)
    expect(provider.canHandleHost('https://unknown-novel.example/anything')).toBe(true)
    expect(provider.canHandle('ftp://unknown-novel.example/book/1/')).toBe(false)
    expect(provider.canHandle('not a url')).toBe(false)
  })

  it('keys chapters by host and query so two sites cannot collide', () => {
    const { provider } = providerFor({})
    expect(provider.getChapterKey('https://a.example/read/1.html'))
      .toBe('generic:a.example/read/1.html')
    expect(provider.getChapterKey('https://b.example/read/1.html'))
      .toBe('generic:b.example/read/1.html')
    expect(provider.getChapterKey('https://a.example/read.php?id=7'))
      .toBe('generic:a.example/read.php?id=7')
    expect(provider.getChapterKey('https://a.example/read/1.html#top'))
      .toBe('generic:a.example/read/1.html')
  })

  it('has no search backend', async () => {
    const { provider } = providerFor({})
    await expect(provider.search('石橋記')).resolves.toEqual([])
  })
})

describe('GenericWebSourceProvider.parseChapterList', () => {
  it('reads a ul list, ignoring nav, sidebar, comments and a script that contains </div>', async () => {
    const url = 'https://novel.example/book/20451/'
    const { provider, safeFetch } = providerFor({ [url]: { html: fixture('ul-utf8-list.html') } })

    const parsed = await provider.parseChapterList(url)

    expect(safeFetch.fetchBuffer).toHaveBeenCalledWith(url, expect.objectContaining({ maxBytes: 4 * 1024 * 1024 }))
    expect(parsed.title).toBe('燈下故事集')
    expect(parsed.providerId).toBe('generic')
    expect(parsed.chapters).toHaveLength(140)
    expect(parsed.chapters[0]).toEqual({
      index: 0,
      title: expect.stringContaining('第1章'),
      url: 'https://novel.example/book/20451/100001.html',
    })
    expect(parsed.chapters[139].url).toBe('https://novel.example/book/20451/100140.html')
    // The nav block's "最新章節" links point at chapters 139/140 but sit outside
    // the list container, so they must not appear as extra leading entries.
    expect(parsed.chapters.map((chapter) => chapter.url)).not.toContain('https://novel.example/fake/1.html')
    expect(parsed.chapters.some((chapter) => chapter.url.includes('/user/'))).toBe(false)
    expect(parsed.chapters.some((chapter) => chapter.url.includes('/book/9001/'))).toBe(false)
    expect(parsed.warnings?.[0]).toBe('通用解析（信心：高）：請確認章節數與首尾章名')
  })

  it('handles a dl list whose titles are 第N頁, reporting low confidence', async () => {
    const url = 'https://pagesite.example/n/kg8m2r7'
    const { provider } = providerFor({ [url]: { html: fixture('dl-page-list.html') } })

    const parsed = await provider.parseChapterList(url)

    expect(parsed.chapters).toHaveLength(96)
    expect(parsed.chapters[0].title).toBe('第1頁')
    expect(parsed.chapters[0].url).toBe('https://pagesite.example/n/kg8m2r7/p1k1?chapterNumber=0')
    expect(parsed.chapters[95].title).toBe('第96頁')
    expect(parsed.warnings?.[0]).toBe('通用解析（信心：低）：請確認章節數與首尾章名')
  })

  it('decodes a gb2312 table list declared only by a meta http-equiv tag', async () => {
    const url = 'https://gb.example/read/3312/'
    const { provider } = providerFor({
      [url]: { html: fixture('table-gb2312-list.html'), encoding: 'gb2312', contentType: 'text/html' },
    })

    const parsed = await provider.parseChapterList(url)

    expect(parsed.title).toBe('灯下故事集')
    expect(parsed.chapters).toHaveLength(88)
    expect(parsed.chapters[0].title).toBe('第1章 山道')
    expect(parsed.chapters[87].title).toBe('第88章 夜行')
    expect(parsed.debugMessages?.[0]).toContain('gb18030')
  })

  it('reverses a descending list and says so', async () => {
    const url = 'https://rev.example/b/778/'
    const { provider } = providerFor({ [url]: { html: fixture('reversed-list.html') } })

    const parsed = await provider.parseChapterList(url)

    expect(parsed.chapters[0].title).toBe('第1章 第1段路')
    expect(parsed.chapters[59].title).toBe('第60章 第60段路')
    expect(parsed.warnings).not.toContain('目錄為倒序，已自動反轉為由舊到新')
    expect(parsed.debugMessages).toContain('目錄為倒序，已自動反轉為由舊到新')
  })

  it('honours <base href> and protocol-relative hrefs', async () => {
    const url = 'https://www.basehost.example/read/5566/'
    const { provider } = providerFor({ [url]: { html: fixture('base-href-list.html') } })

    const parsed = await provider.parseChapterList(url)

    expect(parsed.chapters).toHaveLength(70)
    // Protocol-relative href keeps the CDN subdomain but inherits https from the base.
    expect(parsed.chapters[0].url).toBe('https://cdn.basehost.example/read/5566/c1.html')
  })

  it('drops the other book when one page lists two books in the same container', async () => {
    const url = 'https://two.example/book/1001/'
    const { provider } = providerFor({ [url]: { html: fixture('two-books-list.html') } })

    const parsed = await provider.parseChapterList(url)

    expect(parsed.chapters).toHaveLength(80)
    expect(parsed.chapters.every((chapter) => chapter.url.includes('/book/1001/'))).toBe(true)
    expect(parsed.chapters.some((chapter) => chapter.url.includes('/book/1002/'))).toBe(false)
    expect(parsed.debugMessages?.join('\n')).toContain('剔除 24 條')
  })

  it('keeps every link and warns when the book-id guard would drop most of the list', async () => {
    const url = 'https://mismatch.example/index/7777/'
    const chapters = Array.from(
      { length: 40 },
      (_, index) => `<li><a href="/chapters/8888/${index + 1}.html">第${index + 1}章 測試</a></li>`,
    ).join('')
    const { provider } = providerFor({
      [url]: { html: `<html><head><title>錯位書號</title></head><body><h1>錯位書號</h1><ul>${chapters}</ul></body></html>` },
    })

    const parsed = await provider.parseChapterList(url)

    expect(parsed.chapters).toHaveLength(40)
    expect(parsed.warnings).toContain('無法用書號過濾，章節可能混入其他書籍的連結')
  })

  it('warns when the first chapter ordinal is not 1', async () => {
    const url = 'https://partial.example/book/55/'
    const chapters = Array.from(
      { length: 12 },
      (_, index) => `<li><a href="/book/55/${900 + index}.html">第${900 + index}章 測試</a></li>`,
    ).join('')
    const { provider } = providerFor({
      [url]: { html: `<html><head><title>殘缺目錄</title></head><body><h1>殘缺目錄</h1><ul>${chapters}</ul></body></html>` },
    })

    const parsed = await provider.parseChapterList(url)

    expect(parsed.warnings).toContain('目錄可能不完整：首章序號 > 1')
  })

  it('scopes to the deepest container holding the cluster, dropping same-shaped sidebar links', async () => {
    const url = 'https://scope.example/book/3120/'
    const chapters = Array.from(
      { length: 40 },
      (_, index) => `<li><a href="/book/3120/${index + 1}.html">第${index + 1}章 山道</a></li>`,
    ).join('')
    // Same URL shape and same book id as the real list, so only the container
    // boundary can tell these apart.
    const popular = Array.from(
      { length: 6 },
      (_, index) => `<li><a href="/book/3120/${900 + index}.html">第${900 + index}章 熱門</a></li>`,
    ).join('')
    const { provider } = providerFor({
      [url]: {
        html: '<html><head><title>層層容器</title></head><body><h1>層層容器</h1>'
          + '<div class="outer"><div class="middle">'
          + `<div class="listmain"><ul class="chapter">${chapters}</ul></div>`
          + `<div class="sidebar"><ul class="hot">${popular}</ul></div>`
          + '</div></div></body></html>',
      },
    })

    const parsed = await provider.parseChapterList(url)

    expect(parsed.chapters).toHaveLength(40)
    expect(parsed.chapters.some((chapter) => chapter.title.includes('熱門'))).toBe(false)
    expect(parsed.chapters[39].url).toBe('https://scope.example/book/3120/40.html')
    // <ul class="chapter"> holds 40 of the 46 clustered links — over the 80%
    // threshold — and is deeper than the divs that hold all 46.
    expect(parsed.debugMessages?.join('\n')).toContain('容器：<ul class="chapter">')
  })

  it('refuses a page with too few chapter-shaped links instead of guessing', async () => {
    const url = 'https://empty.example/book/1/'
    const { provider } = providerFor({
      [url]: {
        html: '<html><head><title>空頁</title></head><body><div id="app"></div>'
          + '<a href="/about">關於</a><a href="/tos">條款</a></body></html>',
      },
    })

    await expect(provider.parseChapterList(url)).rejects.toMatchObject({
      name: 'WebSourceParseError',
      message: expect.stringContaining('找不到章節列表（通用解析）'),
    })
  })

  it('classifies an upstream error page instead of parsing it as a book', async () => {
    const url = 'https://down.example/book/1/'
    const { provider } = providerFor({
      [url]: { html: '<html><body>Not Found</body></html>', statusCode: 404 },
    })

    await expect(provider.parseChapterList(url)).rejects.toMatchObject({ name: 'WebSourceHttpError' })
  })
})

describe('GenericWebSourceProvider directory pagination', () => {
  const listUrl = 'https://paged.example/b/1/1028/'
  const pagedDirectory = () => ({
    [listUrl]: { html: fixture('paged-index-1.html') },
    'https://paged.example/b/1/1028/index_2.html': { html: fixture('paged-index-2.html') },
    'https://paged.example/b/1/1028/index_3.html': { html: fixture('paged-index-3.html') },
  })

  it('merges every page of an index_N.html directory into one ascending list', async () => {
    const { provider, safeFetch } = providerFor(pagedDirectory())

    const parsed = await provider.parseChapterList(listUrl)

    expect(safeFetch.fetchBuffer).toHaveBeenCalledTimes(3)
    expect(parsed.chapters).toHaveLength(250)
    expect(parsed.chapters[0].url).toBe('https://paged.example/b/1/1028/123401.html')
    expect(parsed.chapters[100].title).toContain('第101章')
    expect(parsed.chapters[249].title).toContain('第250章')
    expect(parsed.chapters[249].url).toBe('https://paged.example/b/1/1028/123650.html')
    expect(parsed.warnings).not.toContain('目錄分頁：已合併 3 頁')
    expect(parsed.debugMessages).toContain('目錄分頁：已合併 3 頁')
    // A complete merge is no less trustworthy than a one-page directory.
    expect(parsed.warnings?.[0]).toBe('通用解析（信心：高）：請確認章節數與首尾章名')
    expect(parsed.debugMessages?.join('\n')).toContain('https://paged.example/b/1/1028/index_3.html')
  })

  it('walks a ?page=N directory whose only forward link is rel=next', async () => {
    const url = 'https://qp.example/book/9/'
    const { provider, safeFetch } = providerFor({
      [url]: { html: fixture('paged-query-1.html') },
      'https://qp.example/book/9/?page=2': { html: fixture('paged-query-2.html') },
    })

    const parsed = await provider.parseChapterList(url)

    expect(safeFetch.fetchBuffer).toHaveBeenCalledTimes(2)
    expect(parsed.chapters).toHaveLength(100)
    expect(parsed.chapters[59].url).toBe('https://qp.example/book/9/c60.html')
    expect(parsed.chapters[99].url).toBe('https://qp.example/book/9/c100.html')
    expect(parsed.debugMessages).toContain('目錄分頁：已合併 2 頁')
  })

  it('stops at maxListPages, says the list may be short, and drops confidence to 低', async () => {
    const { provider, safeFetch } = providerFor(pagedDirectory(), { maxListPages: 2 })

    const parsed = await provider.parseChapterList(listUrl)

    expect(safeFetch.fetchBuffer).toHaveBeenCalledTimes(2)
    expect(parsed.chapters).toHaveLength(200)
    expect(parsed.chapters[199].title).toContain('第200章')
    expect(parsed.warnings).toContain('目錄分頁超過上限，僅載入前 2 頁（可能不完整）')
    expect(parsed.warnings?.[0]).toBe('通用解析（信心：低）：請確認章節數與首尾章名')
  })

  it('ignores pagination links that belong to a different book', async () => {
    const url = 'https://other.example/b/1/1028/'
    const { provider, safeFetch } = providerFor({ [url]: { html: fixture('paged-other-book.html') } })

    const parsed = await provider.parseChapterList(url)

    expect(safeFetch.fetchBuffer).toHaveBeenCalledTimes(1)
    expect(parsed.chapters).toHaveLength(60)
    expect(parsed.warnings?.some((warning) => warning.includes('目錄分頁'))).toBe(false)
  })

  it('keeps the pages it already merged when the fetch budget runs out mid-walk', async () => {
    const { provider, safeFetch } = providerFor({
      ...pagedDirectory(),
      'https://paged.example/b/1/1028/index_3.html': { error: new FetchBudgetExceededError('fetches') },
    })

    const parsed = await provider.parseChapterList(listUrl)

    expect(safeFetch.fetchBuffer).toHaveBeenCalledTimes(3)
    expect(parsed.chapters).toHaveLength(200)
    expect(parsed.warnings).toContain('目錄分頁因抓取預算中止，僅載入前 2 頁')
    expect(parsed.warnings?.[0]).toBe('通用解析（信心：低）：請確認章節數與首尾章名')
  })

  it('makes no extra request for a directory that carries no page links', async () => {
    const url = 'https://novel.example/book/20451/'
    const { provider, safeFetch } = providerFor({ [url]: { html: fixture('ul-utf8-list.html') } })

    const parsed = await provider.parseChapterList(url)

    expect(safeFetch.fetchBuffer).toHaveBeenCalledTimes(1)
    expect(parsed.chapters).toHaveLength(140)
    expect(parsed.warnings?.some((warning) => warning.includes('目錄分頁'))).toBe(false)
  })
})

/** `<li><a href="{dir}{100+n}.html">第{n}章 測試</a></li>` for n in [start, start+count). */
function chapterItems(dir: string, start: number, count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `<li><a href="${dir}${100 + start + index}.html">第${start + index}章 測試</a></li>`,
  ).join('')
}

describe('GenericWebSourceProvider directory pagination via <select> and image-only anchors', () => {
  it('follows a <select> page picker with relative option values across 3 pages', async () => {
    const dir = '/n/501/'
    const listUrl = 'https://selectpager.example/n/501/'
    const select = '<select onchange="location.href=this.value">'
      + '<option value="index_1.html">第1頁</option>'
      + '<option value="index_2.html">第2頁</option>'
      + '<option value="index_3.html">第3頁</option>'
      + '</select>'
    const page = (start: number, count: number): string =>
      `<html><head><title>下拉分頁書</title></head><body><h1>下拉分頁書</h1>`
      + `<div class="listmain">${select}<ul class="chapter">${chapterItems(dir, start, count)}</ul></div>`
      + `</body></html>`

    const { provider, safeFetch } = providerFor({
      [listUrl]: { html: page(1, 6) },
      'https://selectpager.example/n/501/index_2.html': { html: page(7, 6) },
      'https://selectpager.example/n/501/index_3.html': { html: page(13, 6) },
    })

    const parsed = await provider.parseChapterList(listUrl)

    expect(safeFetch.fetchBuffer).toHaveBeenCalledTimes(3)
    expect(parsed.chapters).toHaveLength(18)
    expect(parsed.chapters[0].url).toBe('https://selectpager.example/n/501/101.html')
    expect(parsed.chapters[17].url).toBe('https://selectpager.example/n/501/118.html')
    expect(parsed.debugMessages).toContain('目錄分頁：已合併 3 頁')
  })

  it('follows a <select> page picker whose option values are absolute urls', async () => {
    const dir = '/n/77/'
    const listUrl = 'https://abssel.example/n/77/'
    const select = '<select onchange="location.href=this.value">'
      + '<option value="https://abssel.example/n/77/index_1.html">1</option>'
      + '<option value="https://abssel.example/n/77/index_2.html">2</option>'
      + '</select>'
    const page = (start: number, count: number): string =>
      `<html><head><title>絕對路徑分頁書</title></head><body><h1>絕對路徑分頁書</h1>`
      + `<div class="listmain">${select}<ul class="chapter">${chapterItems(dir, start, count)}</ul></div>`
      + `</body></html>`

    const { provider, safeFetch } = providerFor({
      [listUrl]: { html: page(1, 6) },
      'https://abssel.example/n/77/index_2.html': { html: page(7, 6) },
    })

    const parsed = await provider.parseChapterList(listUrl)

    expect(safeFetch.fetchBuffer).toHaveBeenCalledTimes(2)
    expect(parsed.chapters).toHaveLength(12)
    expect(parsed.chapters[11].url).toBe('https://abssel.example/n/77/112.html')
    expect(parsed.debugMessages).toContain('目錄分頁：已合併 2 頁')
  })

  it('follows a chain of image-only 下一頁 anchors across 3 pages', async () => {
    const dir = '/pic/9001/'
    const listUrl = 'https://imgnext.example/pic/9001/'
    const nextLink = (href: string): string => `<a class="next" href="${href}"><img src="/i/next.png" alt="下一頁"></a>`
    const page = (start: number, count: number, next: string | null): string =>
      `<html><head><title>圖示分頁書</title></head><body><h1>圖示分頁書</h1>`
      + `<div class="listmain"><ul class="chapter">${chapterItems(dir, start, count)}</ul>`
      + `${next ? nextLink(next) : ''}</div></body></html>`

    const { provider, safeFetch } = providerFor({
      [listUrl]: { html: page(1, 5, 'index_2.html') },
      'https://imgnext.example/pic/9001/index_2.html': { html: page(6, 5, 'index_3.html') },
      'https://imgnext.example/pic/9001/index_3.html': { html: page(11, 5, null) },
    })

    const parsed = await provider.parseChapterList(listUrl)

    expect(safeFetch.fetchBuffer).toHaveBeenCalledTimes(3)
    expect(parsed.chapters).toHaveLength(15)
    expect(parsed.chapters[0].url).toBe('https://imgnext.example/pic/9001/101.html')
    expect(parsed.chapters[14].url).toBe('https://imgnext.example/pic/9001/115.html')
    // The image-only next-page anchor must never surface as a chapter itself.
    expect(parsed.chapters.some((chapter) => chapter.url.includes('index_'))).toBe(false)
    expect(parsed.debugMessages).toContain('目錄分頁：已合併 3 頁')
  })

  it('does not follow a <select> whose option values belong to a different book/volume', async () => {
    const url = 'https://volsel.example/book/55/'
    const select = '<select onchange="location.href=this.value">'
      + '<option value="/vol/2/index_2.html">第二卷</option>'
      + '<option value="/vol/3/index_2.html">第三卷</option>'
      + '</select>'
    const html = `<html><head><title>選卷書</title></head><body><h1>選卷書</h1>${select}`
      + `<ul class="chapter">${chapterItems('/book/55/', 1, 6)}</ul></body></html>`
    const { provider, safeFetch } = providerFor({ [url]: { html } })

    const parsed = await provider.parseChapterList(url)

    expect(safeFetch.fetchBuffer).toHaveBeenCalledTimes(1)
    expect(parsed.chapters).toHaveLength(6)
  })

  it('never turns a text-less anchor into a chapter, marker or not', async () => {
    const url = 'https://iconlinks.example/book/8/'
    const html = `<html><head><title>圖示連結書</title></head><body><h1>圖示連結書</h1>`
      + `<div class="toolbar">`
      + `<a href="/" class="home"><img src="/i/home.png" alt="首頁"></a>`
      + `<a class="next" href="index_2.html"><img src="/i/next.png" alt="下一頁"></a>`
      + `</div><ul class="chapter">${chapterItems('/book/8/', 1, 6)}</ul></body></html>`
    const { provider, safeFetch } = providerFor({
      [url]: { html },
      'https://iconlinks.example/book/8/index_2.html': {
        html: `<html><head><title>圖示連結書</title></head><body><h1>圖示連結書</h1>`
          + `<ul class="chapter">${chapterItems('/book/8/', 7, 6)}</ul></body></html>`,
      },
    })

    const parsed = await provider.parseChapterList(url)

    expect(safeFetch.fetchBuffer).toHaveBeenCalledTimes(2)
    expect(parsed.chapters).toHaveLength(12)
    // Neither the text-less home icon nor the text-less next-page icon becomes a chapter.
    expect(parsed.chapters.some((chapter) => chapter.url === 'https://iconlinks.example/')).toBe(false)
    expect(parsed.chapters.some((chapter) => chapter.url.includes('index_2.html'))).toBe(false)
  })
})

describe('GenericWebSourceProvider.fetchChapterText', () => {
  it('picks the tightest content div and strips promo, nav and repeated-title lines', async () => {
    const url = 'https://novel.example/book/20451/100012.html'
    const { provider } = providerFor({ [url]: { html: fixture('content-nested-div.html') } })

    const text = await provider.fetchChapterText(url)
    const paragraphs = text.split('\n\n')

    expect(paragraphs).toHaveLength(14)
    expect(text).not.toContain('請記住本站域名')
    expect(text).not.toContain('手機版閱讀')
    expect(text).not.toContain('（本章完）')
    expect(text).not.toContain('腳本假章節')
    expect(text).not.toContain('第12章 石橋')
    expect(text).not.toContain('上一章')
    // The reader adds its own indent, so leading full-width spaces are normalized away.
    expect(paragraphs.every((paragraph) => !/^[\s　]/.test(paragraph))).toBe(true)
  })

  it('falls back to the longest <br> run when the page has no content container', async () => {
    const url = 'https://nc.example/html/9/915/40002.html'
    const { provider } = providerFor({ [url]: { html: fixture('content-br-only.html') } })

    const text = await provider.fetchChapterText(url)

    expect(text.split('\n\n')).toHaveLength(12)
    expect(text).not.toContain('返回目錄')
    expect(text).not.toContain('切換章節')
    expect(text).not.toContain('廣告位')
    expect(text.startsWith('她低頭看著掌心的紋路')).toBe(true)
  })

  it('follows in-chapter pagination across three parts', async () => {
    const first = 'https://pg.example/read/8800/c15.html'
    const { provider, safeFetch } = providerFor({
      [first]: { html: fixture('content-part1.html') },
      'https://pg.example/read/8800/c15_2.html': { html: fixture('content-part2.html') },
      'https://pg.example/read/8800/c15_3.html': { html: fixture('content-part3.html') },
    })

    const text = await provider.fetchChapterText(first)

    expect(safeFetch.fetchBuffer).toHaveBeenCalledTimes(3)
    expect(text.split('\n\n')).toHaveLength(24)
    // Part 3's only forward link is 下一章, which belongs to the next chapter.
    expect(safeFetch.fetchBuffer).not.toHaveBeenCalledWith('https://pg.example/read/8800/c16.html', expect.anything())
  })

  it('does not follow a 下一章 link from the first page', async () => {
    const url = 'https://pg.example/read/8800/c15_3.html'
    const { provider, safeFetch } = providerFor({ [url]: { html: fixture('content-part3.html') } })

    await provider.fetchChapterText(url)

    expect(safeFetch.fetchBuffer).toHaveBeenCalledTimes(1)
  })

  it('reports a parse failure when the page carries no readable prose', async () => {
    const url = 'https://js.example/read/1.html'
    const { provider } = providerFor({
      [url]: { html: '<html><head><title>需要 JS</title></head><body><div id="root"></div></body></html>' },
    })

    await expect(provider.fetchChapterText(url)).rejects.toMatchObject({
      name: 'WebSourceParseError',
      message: expect.stringContaining('找不到內文（通用解析）'),
    })
  })
})

describe('GenericWebSourceProvider encoding detection', () => {
  const url = 'https://enc.example/b/778/'
  const withoutMeta = (): string => fixture('reversed-list.html').replace(/<meta charset="utf-8">/i, '')

  it('strips a UTF-8 BOM before parsing', async () => {
    const { provider } = providerFor({
      [url]: { html: withoutMeta(), bom: [0xef, 0xbb, 0xbf], contentType: 'text/html' },
    })

    const parsed = await provider.parseChapterList(url)

    expect(parsed.title).toBe('石橋記')
    expect(parsed.chapters).toHaveLength(60)
    expect(parsed.debugMessages?.[0]).toContain('來源：bom')
  })

  it('follows a <meta charset=gbk> declaration', async () => {
    const gbkUrl = 'https://gbk.example/read/3312/'
    const { provider } = providerFor({
      [gbkUrl]: {
        html: fixture('table-gb2312-list.html').replace('charset=gb2312', 'charset=gbk'),
        encoding: 'gbk',
      },
    })

    const parsed = await provider.parseChapterList(gbkUrl)

    expect(parsed.title).toBe('灯下故事集')
    expect(parsed.chapters[0].title).toBe('第1章 山道')
    expect(parsed.debugMessages?.[0]).toContain('gb18030')
  })

  it('detects big5 bytes that declare no charset at all', async () => {
    const { provider } = providerFor({
      [url]: { html: withoutMeta(), encoding: 'big5', contentType: 'text/html' },
    })

    const parsed = await provider.parseChapterList(url)

    expect(parsed.title).toBe('石橋記')
    expect(parsed.chapters[0].title).toBe('第1章 第1段路')
    expect(parsed.debugMessages?.[0]).toContain('來源：detected')
  })

  it('explains a non-HTML url rather than surfacing a fetch-layer error', async () => {
    const pdfUrl = 'https://enc.example/book.pdf'
    const failing = new GenericWebSourceProvider({
      fetchBuffer: async () => {
        const error = new Error('Unsupported content type: application/pdf')
        error.name = 'UnsupportedContentTypeError'
        throw error
      },
    })

    await expect(failing.parseChapterList(pdfUrl)).rejects.toMatchObject({
      name: 'WebSourceParseError',
      message: expect.stringContaining('此網址不是網頁'),
    })
  })
})
