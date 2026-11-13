import { describe, expect, it } from 'vitest'
import {
  cleanText,
  extractAllBalancedElements,
  extractBalancedElement,
  extractFirstElementInner,
  extractSearchHits,
  splitParagraphs,
  stripScriptsAndStyles,
  stripTitle,
} from '../html.js'

describe('stripScriptsAndStyles', () => {
  it('removes script and style elements with their contents', () => {
    const html = '<p>a</p><script>var x = "</p>"</script><style>p{color:red}</style><p>b</p>'
    expect(stripScriptsAndStyles(html)).toBe('<p>a</p><p>b</p>')
  })
})

describe('extractBalancedElement', () => {
  it('returns the inner html of the first balanced match, keeping nested same-tag blocks', () => {
    const html = '<div class="list"><div><a>1</a></div><a>2</a></div><div class="list">second</div>'
    expect(extractBalancedElement(html, { tag: 'div', by: 'class', value: 'list' }))
      .toBe('<div><a>1</a></div><a>2</a>')
  })

  it('tolerates spaces around the attribute equals sign', () => {
    const html = '<div class = "content">body</div>'
    expect(extractBalancedElement(html, { tag: 'div', by: 'class', value: 'content' })).toBe('body')
  })

  it('matches a class as a whole word, not a substring', () => {
    const html = '<div class="contents-extra">wrong</div><div class="a content b">right</div>'
    expect(extractBalancedElement(html, { tag: 'div', by: 'class', value: 'content' })).toBe('right')
  })

  it('strips scripts first so a literal closing tag inside a script cannot truncate', () => {
    const html = '<div id="c">before<script>var s = "</div>";</script>after</div><p>outside</p>'
    expect(extractBalancedElement(html, { tag: 'div', by: 'id', value: 'c' })).toBe('beforeafter')
  })

  it('matches by bare tag and by attribute name', () => {
    expect(extractBalancedElement('<x><section>body</section></x>', { tag: 'section' })).toBe('body')
    expect(extractBalancedElement(
      '<div style="text-indent:2em">body</div>',
      { tag: 'div', by: 'attr', attrName: 'style', value: 'text-indent' },
    )).toBe('body')
  })

  it('returns null when nothing matches, and the rest of the document when unclosed', () => {
    expect(extractBalancedElement('<p>x</p>', { tag: 'div', by: 'id', value: 'c' })).toBeNull()
    expect(extractBalancedElement('<div id="c">tail', { tag: 'div', by: 'id', value: 'c' })).toBe('tail')
  })
})

describe('extractAllBalancedElements', () => {
  it('returns every match in document order, including nested ones', () => {
    const html = '<div style="text-indent:2em">outer<div style="text-indent:2em">inner</div></div>'
    expect(extractAllBalancedElements(html, { tag: 'div', by: 'attr', attrName: 'style', value: 'text-indent' }))
      .toEqual(['outer<div style="text-indent:2em">inner</div>', 'inner'])
  })
})

describe('extractFirstElementInner', () => {
  it('is non-greedy and keeps an empty match distinct from no match', () => {
    expect(extractFirstElementInner('<h1>a</h1><h1>b</h1>', { tag: 'h1' })).toBe('a')
    expect(extractFirstElementInner('<h1></h1>', { tag: 'h1' })).toBe('')
    expect(extractFirstElementInner('<p>a</p>', { tag: 'h1' })).toBeNull()
  })
})

describe('cleanText', () => {
  it('drops markup, decodes entities, turns br into line breaks and trims blank lines', () => {
    const html = '  <span>&nbsp;&nbsp;甲</span><br /><br />  <b>乙</b>  <script>noise()</script>'
    expect(cleanText(html)).toBe('甲\n乙')
  })

  it('applies extra strips before text extraction', () => {
    expect(cleanText('a<!--PAGE 2-->b', [/<!--PAGE\s+\d+-->/gi])).toBe('ab')
  })
})

describe('stripTitle', () => {
  it('applies strips in order and falls back to a generic label', () => {
    expect(stripTitle('大奉打更人_作者:賣報小郎君', [/[_\-｜|].*$/u])).toBe('大奉打更人')
    expect(stripTitle('全民游戏最新章节-飘天文学', [/最新章[节節].*$/u, /[_｜|,，].*$/u])).toBe('全民游戏')
    expect(stripTitle('   ', [])).toBe('線上書源')
  })
})

describe('splitParagraphs', () => {
  const html = '<p>一</p><div>x</div><p>  </p><p>二<br>三</p>'

  it('p-elements takes each p pair and drops empty ones', () => {
    expect(splitParagraphs(html, 'p-elements')).toEqual(['一', '二\n三'])
  })

  it('br-lines takes one paragraph per text line', () => {
    expect(splitParagraphs('甲<br>乙<br><br>丙', 'br-lines')).toEqual(['甲', '乙', '丙'])
  })

  it('p-open-split splits on self-closing p markers', () => {
    expect(splitParagraphs('head<p>甲<p>乙', 'p-open-split')).toEqual(['head', '甲', '乙'])
  })
})

describe('extractSearchHits', () => {
  const html = `
    <a href="/read/1/"><img src="cover.jpg"></a>
    <a href="/read/1/">第一本</a>
    <a href="/read/1">第一本重複</a>
    <a href="/other/2/">不是書</a>
    <a href="https://elsewhere.example/read/3/">別站</a>
    <a>沒有 href</a>
  `

  it('dedupes by canonical url, skips empty titles and foreign hosts', () => {
    expect(extractSearchHits(html, {
      baseUrl: 'https://site.example/search',
      providerId: 'demo',
      hostPattern: (host) => host === 'site.example',
      pathPattern: /^\/read\/(\d+)\/?$/,
      hitUrl: (origin, captures) => `${origin}/read/${captures[0]}/`,
    })).toEqual([{ providerId: 'demo', title: '第一本', url: 'https://site.example/read/1/' }])
  })

  it('honours scopeTo, titleSub and limit', () => {
    const scoped = `
      <span class="wd10"><a href="/read/1/"><div class="name">甲</div>雜訊</a></span>
      <span class="wd10"><a href="/read/2/"><div class="name">乙</div></a></span>
      <a href="/read/3/">範圍外</a>
    `
    expect(extractSearchHits(scoped, {
      baseUrl: 'https://site.example/search',
      providerId: 'demo',
      hostPattern: () => true,
      pathPattern: /^\/read\/(\d+)\/$/,
      hitUrl: (origin, captures) => `${origin}/read/${captures[0]}/`,
      scopeTo: /<span\b[^>]*class\s*=\s*"[^"]*\bwd10\b[^"]*"[^>]*>[\s\S]*?<\/span>/gi,
      titleSub: /<div\b[^>]*class\s*=\s*"[^"]*\bname\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      limit: 1,
    })).toEqual([{ providerId: 'demo', title: '甲', url: 'https://site.example/read/1/' }])
  })

  it('skips hrefs that cannot be resolved into a url', () => {
    expect(extractSearchHits('<a href="http://[bad">壞</a>', {
      baseUrl: 'https://site.example/search',
      providerId: 'demo',
      hostPattern: () => true,
      pathPattern: /^\//,
      hitUrl: (origin) => origin,
    })).toEqual([])
  })
})
