/**
 * lib/html.mjs —— 极小的 HTML 工具（零依赖）
 * ============================================================================
 * 贴吧没有官方 API，能拿到的只有网页 HTML ⇒ 这个插件的"解析层"必须自己长出来。
 * 但这儿**故意不写完整 DOM**：只要够用、可读、能单测就行：
 *   · decodeEntities / stripTags / htmlToText —— 三段式：剥标签 → 解实体 → 收空白
 *   · findElements —— 按 class 抓块（自己数嵌套深度找闭合标签，div 套 div 也不会截歪）
 *   · textOfClass / attrOf —— 最常见的两种取值
 *   · collectImages —— 把 <img data-url|src> 收成数组（贴吧的图常在 data-url 里）
 *   · truncate —— 单楼正文 4000 字上限（防止一条把上下文爆了）
 * ============================================================================
 */

/** 这些标签没有闭合标签，不能进嵌套深度统计 */
const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr'])

/** 数字实体 → 字符（越界就丢掉，不抛） */
function codePointToStr(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return ''
  if (n >= 0xd800 && n <= 0xdfff) return '' // 代理区，单字符不合法
  try { return String.fromCodePoint(n) } catch { return '' }
}

/**
 * 解 HTML 实体：`&amp; &lt; &gt; &quot; &#39; &nbsp;` 以及任意 `&#123;` / `&#x1F600;`。
 * ⚠️ `&amp;` 必须最后做 —— 否则 `&amp;lt;` 会被解成 `<` 而不是 `&lt;`。
 */
export function decodeEntities(s) {
  if (typeof s !== 'string' || s === '') return ''
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => codePointToStr(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePointToStr(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ensp;/gi, ' ')
    .replace(/&emsp;/gi, '　')
    .replace(/&thinsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&ldquo;/gi, '“')
    .replace(/&rdquo;/gi, '”')
    .replace(/&lsquo;/gi, '‘')
    .replace(/&rsquo;/gi, '’')
    .replace(/&hellip;/gi, '…')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&middot;/gi, '·')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

/**
 * 剥标签：`<br>` → `\n`，块级标签收尾也补 `\n`，其余标签直接删掉。
 * ⚠️ 先剥标签再解实体（顺序反了的话，正文里写的 `&lt;div&gt;` 会被当成标签删掉）。
 */
export function stripTags(html) {
  if (typeof html !== 'string' || html === '') return ''
  return html
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
}

/**
 * 正文 HTML → 纯文本：剥标签 + 解实体 + 收空白。
 * 保留换行（`<br>` 变成的），连续空行压成一个，行首行尾空格去掉。
 */
export function htmlToText(html) {
  if (typeof html !== 'string' || html === '') return ''
  let s = decodeEntities(stripTags(html))
  s = s.replace(/\r\n?/g, '\n')
  s = s.replace(/[ \t\f\v\u00a0\u3000]+/g, ' ')
  s = s.replace(/ *\n */g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

/** 解析一段属性串 → 对象（值里的实体也解掉） */
export function parseAttrs(attrText) {
  const out = {}
  if (typeof attrText !== 'string' || attrText === '') return out
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g
  let m
  while ((m = re.exec(attrText))) {
    const name = m[1].toLowerCase()
    const val = m[2] ?? m[3] ?? m[4] ?? ''
    if (!(name in out)) out[name] = decodeEntities(val)
  }
  return out
}

/** class="a b c" 里是否有 b（精确到词，别让 ti_title 命中 ti_title_extra） */
export function hasClass(classAttr, name) {
  if (!classAttr || !name) return false
  return String(classAttr).split(/\s+/).includes(name)
}

/** 从开标签文本里抠 class */
function classOfTag(tagText) {
  const m = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+))/i.exec(tagText)
  if (!m) return ''
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '')
}

/**
 * 从 `from` 开始找 `tagName` 的闭合标签位置（自己数嵌套深度）。
 * @returns {{ closeAt: number, innerEnd: number }}，找不到闭合就吃到末尾
 */
function findClose(src, from, tagName) {
  const re = new RegExp(`<(/?)${tagName}\\b((?:"[^"]*"|'[^']*'|[^>"'])*)>`, 'gi')
  re.lastIndex = from
  let depth = 1
  let m
  while ((m = re.exec(src))) {
    if (m[1] === '/') {
      depth--
      if (depth === 0) return { closeAt: m.index, innerEnd: m.index }
    } else if (!/\/\s*$/.test(m[2]) && !VOID_TAGS.has(tagName)) {
      depth++
    }
  }
  return { closeAt: src.length, innerEnd: src.length }
}

/**
 * 抓所有带某个 class 的元素块。
 * @param {string} html
 * @param {string} className
 * @param {{ tag?: string, limit?: number }} [opts] tag 省略 = 任意标签
 * @returns {Array<{ tag:string, attrs:object, start:number, outer:string, inner:string, end:number }>}
 */
export function findElements(html, className, opts = {}) {
  const src = typeof html === 'string' ? html : ''
  const limit = Number.isFinite(opts.limit) ? opts.limit : 500
  if (!src || !className) return []
  const tagFilter = opts.tag ? String(opts.tag).toLowerCase() : ''
  const clsRe = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 只挑开标签：`<tag ... class="... cls ...">`
  const openRe = new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)\\b((?:"[^"]*"|'[^']*'|[^>"'])*)>`, 'g')
  const out = []
  let m
  while ((m = openRe.exec(src)) && out.length < limit) {
    const tagName = m[1].toLowerCase()
    if (tagFilter && tagName !== tagFilter) continue
    const tagText = m[0]
    if (/\/>$/.test(tagText) || VOID_TAGS.has(tagName)) continue
    const cls = classOfTag(tagText)
    if (!hasClass(cls, className)) continue
    const start = m.index
    const openEnd = start + tagText.length
    const { innerEnd, closeAt } = findClose(src, openEnd, tagName)
    const end = closeAt + (src.slice(closeAt).match(new RegExp(`^</${tagName}\\s*>`, 'i'))?.[0].length ?? 0)
    out.push({
      tag: tagName,
      attrs: parseAttrs(m[2]),
      start,
      end,
      outer: src.slice(start, end),
      inner: src.slice(openEnd, innerEnd),
    })
    // 同一个外层块里不会再有同 class 的块（贴吧的 list 项是并列的），继续往后扫就行
    openRe.lastIndex = openEnd
  }
  return out
}

/** 第一个带该 class 的元素，没有就 null */
export function firstElement(html, className, opts = {}) {
  return findElements(html, className, { ...opts, limit: 1 })[0] ?? null
}

/** 某 class 元素的纯文本（取第一个）；没有就 '' */
export function textOfClass(html, className, opts = {}) {
  const el = firstElement(html, className, opts)
  return el ? htmlToText(el.inner) : ''
}

/** 某 class 元素的原始 inner HTML（取第一个）；没有就 '' */
export function htmlOfClass(html, className, opts = {}) {
  const el = firstElement(html, className, opts)
  return el ? el.inner : ''
}

/** 取 HTML 里**第一个标签**的某个属性值（顶层属性，比如 data-tid） */
export function attrOf(html, name) {
  const src = typeof html === 'string' ? html : ''
  if (!src) return ''
  const m = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/.exec(src)
  if (!m) return ''
  const attrs = parseAttrs(m[2])
  const v = attrs[String(name).toLowerCase()]
  return v === undefined ? '' : v
}

/** 页面的 <title> 纯文本 */
export function pageTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(typeof html === 'string' ? html : '')
  return m ? htmlToText(m[1]) : ''
}

/** 绝对化 URL（贴吧的图常常是 `//tb2.bdstatic.com/...`） */
export function absUrl(u, base = 'https://tieba.baidu.com') {
  const s = String(u ?? '').trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) return s
  if (s.startsWith('//')) return 'https:' + s
  if (s.startsWith('/')) return base.replace(/\/+$/, '') + s
  return base.replace(/\/+$/, '') + '/' + s
}

/**
 * 收集图片地址（去重、保序）。
 * 贴吧正文里 `<img class="BDE_Image" src="..." data-url="...">`，视频/表情也混在里面 ⇒ 只留 http(s) / //。
 */
export function collectImages(html) {
  const src = typeof html === 'string' ? html : ''
  const out = []
  const seen = new Set()
  const re = /<(?:img|a)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi
  let m
  while ((m = re.exec(src))) {
    const attrs = parseAttrs(m[1])
    for (const key of ['data-url', 'src', 'data-src', 'href']) {
      let u = attrs[key]
      if (!u) continue
      u = absUrl(u)
      if (!/^https?:\/\//i.test(u)) continue
      if (/\.(?:gif|png|jpe?g|webp|bmp)(?:\?|$)/i.test(u) || attrs['data-url']) {
        if (!seen.has(u)) { seen.add(u); out.push(u) }
      }
      break
    }
  }
  return out
}

/**
 * 截断：超过 max 就在 max 处切并补 `…`（贴吧单楼正文上限用）。
 * 按**码点**数，别把 emoji 劈成两半。
 */
export function truncate(text, max = 4000) {
  const s = String(text ?? '')
  if (!Number.isFinite(max) || max <= 0) return s
  const chars = Array.from(s)
  if (chars.length <= max) return s
  return chars.slice(0, max).join('') + '…'
}

/** 数字化的文本（"1.2万" → 12000，",114" → 114）；拿不到就 0 */
export function toCount(text) {
  const s = String(text ?? '').replace(/[,\s]/g, '')
  if (!s) return 0
  const m = /^(\d+(?:\.\d+)?)(万|w|W|亿)?/.exec(s)
  if (!m) return 0
  const n = Number(m[1])
  if (!Number.isFinite(n)) return 0
  const unit = m[2]
  if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(n * 10000)
  if (unit === '亿') return Math.round(n * 100000000)
  return Math.round(n)
}
