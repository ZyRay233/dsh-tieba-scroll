/**
 * lib/tieba.mjs —— 贴吧 HTTP 层（本插件的心脏）
 * ============================================================================
 * 贴吧**没有官方 API**，网页端才是唯一免费、不用登录就能读的入口 ⇒ 全部走 HTML。
 * 这里只干四件事：发请求（超时 + 重试 + 人话错误）、解析页面、写凭证、发帖/回帖。
 *
 * 所有导出都是 async 且**永不抛异常**：统一返回 `{ ok: true, ... }` 或
 * `{ ok: false, error: '人话原因', hint: '怎么办' }`（凭证三个函数是同步的 fs 读写，
 * 同样不抛 —— 契约里它们的签名就是 `export function`；await 一个同步函数也能正常工作，
 * 所以 index.js 那边写不写 await 都不会坏）。
 *
 * ── 数据来源（2026-11 实测，全部是本文件跑通的） ──────────────────────────
 * 列表   GET  https://tieba.baidu.com/mo/q/m?kw=<吧名>            + UA_MOBILE
 *             · 页面里嵌着 `thread_list: [ {...} ]` 的 JSON（tid/title/reply_num/
 *               is_top/is_good/author/last_time …）⇒ **优先啃这个**，比啃 HTML 稳
 *             · 兜底才解析 `<li class="tl_shadow">`（ti_title / ti_author / ti_time /
 *               .btn_reply > .btn_icon）
 *             · 吧信息：`.forum-name-txt`、`.info_paragraph` 里的「关注 / 贴子」
 * 正文   GET  https://tieba.baidu.com/mo/q/m?kz=<tid>             + UA_MOBILE
 *             · 楼层 = `<li tid="…" fn="N" data-info="{json}">`，里面 `.list_item_wrapper`
 *               > `.list_main`；作者 `.list_item_top_name .user_name`、时间 `.list_item_time`、
 *               正文 `.content`（`lz="1"` = 楼主）、楼中楼数 `.j_floor_panel[data-list-count]`
 *             · 第 1 楼标题在 `.post_title_embed`；吧名 `.post_title_text`；
 *               翻页/总页数在页面 JS 里 `"current_page":N,"total_page":M`
 * 楼中楼 GET  https://tieba.baidu.com/p/comment?tid=<tid>&pid=<pid>&pn=1   + UA_DESKTOP
 *             ⚠️ 契约原来猜的 `&pid=…&lzl=1` **实测是错的**：那个 URL 返回的还是整页正文
 *             （`mo/q/m` 根本不认 lzl 参数）。真接口是 /p/comment，返回
 *             `<li class="lzl_single_post">`：作者在 li 的 data-field.showname、
 *             时间 `.lzl_time`、正文 `.lzl_content_main`
 * tbs    GET  http://tieba.baidu.com/dc/common/tbs              （带 Cookie BDUSS）
 *             返回 `{"tbs":"…","is_login":0|1}` —— 顺手当"登录态探针"用
 * 发帖   POST https://tieba.baidu.com/f/commit/thread/add        （网页端表单，**未验证**：无账号）
 * 回帖   POST https://tieba.baidu.com/f/commit/post/add           （网页端表单，**未验证**：无账号）
 * 楼中楼 POST 同上 + pid                                          （**未验证**，见 replySubPost 注释）
 *
 * ── 两条踩过的坑（别再踩） ──────────────────────────────────────────────
 * ① **PC 端的 `/f?kw=` 别用**：那是 11KB 的 JS 空壳，里面根本没有帖子。
 * ② **`pn` 不是页码，是「从第几个帖子开始」（1 基）**：实测 `&pn=2` 拿到的是第一页
 *    去掉 1 条，`&pn=31` 才是第二页。所以对外仍按契约用页码，内部换算成 `(page-1)*30+1`。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import {
  absUrl, attrOf, collectImages, decodeEntities, findElements, firstElement,
  htmlToText, pageTitle, textOfClass, toCount, truncate,
} from './html.mjs'

/** 移动端 UA：`/mo/q/m` 的列表/正文都靠它，换成 PC UA 会拿到 JS 空壳 */
export const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
/** PC 端 UA：/p/comment、/f/commit/* 这些老接口用桌面 UA 更稳 */
export const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const BASE = 'https://tieba.baidu.com'
const MO = BASE + '/mo/q/m'
const TBS_URL = 'http://tieba.baidu.com/dc/common/tbs'
const USERINFO_URL = BASE + '/f/user/json_userinfo'
const COMMENT_URL = BASE + '/p/comment'
const POST_ADD_URL = BASE + '/f/commit/post/add'
const THREAD_ADD_URL = BASE + '/f/commit/thread/add'
const CREDENTIAL_FILE = 'tieba_credential.json'

/** 一页 30 条 / 30 楼（页面 JS 里写死的 req_num:30） */
const PAGE_SIZE = 30
/** 单次请求超时：契约要求 15 秒 */
const TIMEOUT_MS = 15000
/** 失败最多重试 1 次 */
const RETRIES = 1
/** 单楼正文最多留 4000 字（防止一条把模型上下文爆了） */
const MAX_FLOOR_CHARS = 4000
/** 两次请求之间至少隔这么久 —— 贴吧风控很敏感，连发会直接 403「百度安全验证」 */
const MIN_GAP_MS = 700

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 统一的失败对象（永不抛异常） */
function fail(error, hint) {
  return hint ? { ok: false, error, hint } : { ok: false, error }
}

// ────────────────────────────── 请求层 ──────────────────────────────

let lastRequestAt = 0

/** 全局节流：请求之间留点喘息，别把风控招来 */
async function throttle() {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now()
  if (wait > 0) await sleep(wait)
  lastRequestAt = Date.now()
}

/**
 * 组 Cookie。
 *
 * ⭐⭐ 2026-10-28 真机实测（这条是整件事的关键）：
 *   贴吧对「只带 BDUSS、没有风控 cookie」的请求直接回 **403 百度安全验证**。
 *   浏览器能正常看，是因为它带着 `BDORZ` / `BAIDUID` / `ZFY` / `BIDUPSID` 那一串百度风控标记。
 *   ⇒ credential 里如果存了 `cookieRaw`（浏览器整串 cookie），**整串优先用**；
 *     光有 BDUSS 照样会被当机器人拦。
 */
function cookieOf({ bduss, stoken, cookieRaw } = {}) {
  const raw = String(cookieRaw ?? '').trim()
  if (raw) {
    // 整串里必须带 BDUSS，否则补一条（用户可能只导了风控 cookie）
    if (bduss && !/(?:^|;\s*)BDUSS=/.test(raw)) {
      return `${raw.replace(/;\s*$/, '')}; BDUSS=${String(bduss).trim()}`
    }
    return raw
  }
  const parts = []
  if (bduss) parts.push('BDUSS=' + String(bduss).trim())
  if (stoken) parts.push('STOKEN=' + String(stoken).trim())
  return parts.join('; ')
}

/**
 * ⭐ 读接口（列表 / 正文 / 楼中楼）的形参里没有凭证，但贴吧风控要求请求必须带 cookie。
 *   index.js 在 apply 时调 `configure({ stateDir })`，之后读接口会自动从家目录读凭证。
 */
let configuredStateDir = ''
export function configure({ stateDir } = {}) {
  configuredStateDir = String(stateDir || '')
}
function readCred() {
  if (!configuredStateDir) return {}
  try {
    const c = loadCredential(configuredStateDir)
    if (!c) return {}
    return { bduss: c.bduss, stoken: c.stoken, cookieRaw: c.cookieRaw }
  } catch { return {} }
}

/**
 * 底层请求：超时 15s + 失败重试 1 次，**永不抛**。
 * @returns {Promise<{ok:true,status:number,text:string,finalUrl:string}|{ok:false,error:string,hint:string}>}
 */
async function request(url, opts = {}) {
  const {
    method = 'GET',
    ua = UA_MOBILE,
    bduss,
    stoken,
    cookieRaw,
    form,
    referer,
    xhr = false,
    accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    timeout = TIMEOUT_MS,
  } = opts

  // 浏览器里「页面导航」和「后台 XHR」发出去的 sec-fetch-* 完全不同 ——
  // 用错了贴吧照样回 403（2026-10-28 楼中楼接口就栽在这儿）
  const isForm = Boolean(form && method !== 'GET')
  const isXhr = Boolean(xhr) || isForm

  const headers = {
    'user-agent': ua,
    accept,
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    // ⭐⭐ 2026-10-28 实测（致命细节）：光有 cookie 还不够 —— 贴吧风控会看
    //    `sec-fetch-*` / `upgrade-insecure-requests` / `accept-encoding` 这一整套浏览器头。
    //    缺了它们，即使 cookie 完全正确也照样回 403「百度安全验证」。
    //    （对照实验：裸请求 403；只带风控 cookie 200；只带 BDUSS 403；两者都带 200）
    'accept-encoding': 'gzip, deflate, br',
    'upgrade-insecure-requests': '1',
    'sec-fetch-dest': isXhr ? 'empty' : 'document',
    'sec-fetch-mode': isXhr ? 'cors' : 'navigate',
    'sec-fetch-site': referer ? 'same-origin' : (isXhr ? 'same-origin' : 'none'),
    // 只有导航类请求才有 sec-fetch-user（XHR / 表单提交没有）
    ...(isXhr ? {} : { 'sec-fetch-user': '?1' }),
  }
  const cookie = cookieOf({ bduss, stoken, cookieRaw })
  if (cookie) headers.cookie = cookie
  if (referer) headers.referer = referer
  let body
  if (form && method !== 'GET') {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(form).toString()
  }

  let lastRes = null
  let lastErr = null
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(800)
    try {
      await throttle()
      const res = await fetch(url, { method, headers, body, redirect: 'follow', signal: AbortSignal.timeout(timeout) })
      const text = await res.text()
      const r = { ok: true, status: res.status, text, finalUrl: res.url }
      // 5xx / 429 值得重试；其它状态码直接交回给上层判定
      if (res.status >= 500 || res.status === 429) { lastRes = r; continue }
      return r
    } catch (e) {
      lastErr = e
    }
  }
  if (lastRes) return lastRes
  const msg = String(lastErr?.message ?? lastErr ?? '')
  if (/abort|timeout|timed out/i.test(msg) || lastErr?.name === 'TimeoutError' || lastErr?.name === 'AbortError') {
    return fail(`请求贴吧超时（${Math.round(timeout / 1000)} 秒没响应）`, '网络慢或被墙了；等一下再试，或检查代理设置')
  }
  return fail('连不上贴吧（网络不通）', '检查网络/代理；公司网或校园网有时挡 tieba.baidu.com')
}

/** 贴吧风控页的特征（百度安全验证 / wappass 验证） */
function looksBlocked(text) {
  const t = typeof text === 'string' ? text : ''
  if (!t) return false
  // ⭐ 2026-10-28 误判修：真正的风控页很短（约 2.4KB），而**正常页面里也会引用**
  //    `wappass.baidu.com` 的登录脚本 ⇒ 光靠关键词会把「200 + 正常帖子页」误判成风控页，
  //    表现就是「明明抓到了却报风控」。所以长页面直接放行。
  if (t.length > 20000) return false
  return t.includes('百度安全验证') || t.includes('wappass.baidu.com') || t.includes('seccaptcha')
}

/** 贴吧自带的 404 页（HTML 版，HTTP 状态还是 200） */
function looks404(text) {
  return typeof text === 'string' && (text.includes('贴吧404') || text.includes('抱歉，该吧尚未建立') || text.includes('该吧不存在'))
}

/**
 * 把一次响应翻译成"能不能继续"：返回 null = 正常，否则返回失败对象。
 * 这一步是全部人话错误的源头 —— 上层永远不需要自己判 HTTP 码。
 */
function guard(res) {
  if (!res.ok) return res
  if (looksBlocked(res.text)) {
    return fail('贴吧要求安全验证（百度风控）', '这是被限流了：等 5–10 分钟再试，别连续刷同一个吧；换网络（手机热点）也能解开')
  }
  if (res.status === 403) return fail('贴吧拒绝访问（403）', '多半是风控：等几分钟再试')
  if (res.status === 404) return fail('贴吧说这个页面不存在（404）', '检查帖子/吧名是否拼错；帖子可能已经被删')
  if (res.status === 429) return fail('请求太频繁，被贴吧限流了', '等几分钟再试，别一轮刷太多吧')
  if (res.status >= 500) return fail(`贴吧服务器出错（${res.status}）`, '等一会儿再试')
  if (res.status !== 200) return fail(`贴吧返回了意外的状态码 ${res.status}`, '等一会儿再试；一直这样就反馈给作者')
  if (looks404(res.text)) return fail('贴吧说这个页面不存在', '检查帖子/吧名是否拼错；帖子可能已经被删')
  return null
}

/** 宽容地解析 JSON（前后可能有 BOM / 空白 / 夹带） */
function parseJson(text) {
  const s = String(text ?? '').trim()
  const start = s.search(/[[{]/)
  if (start < 0) return null
  try { return JSON.parse(s.slice(start)) } catch { return null }
}

/**
 * 从 HTML 里抠出 `label: [ ... ]` 那个 JSON 数组（按括号配平，跳过字符串里的括号）。
 * 贴吧把列表数据整块塞在 `<script>` 的 JS 对象字面量里，比啃 DOM 稳得多。
 * ⚠️ 页面里 `thread_list` 这个名字**还被 JS 模块名用着**（`sfrs/widget/thread_list`），
 *    所以要把所有 `label: [` 候选都试一遍，谁能 JSON.parse 成功就用谁。
 */
function jsonArrayAt(src, start) {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') {
      depth--
      if (depth === 0) {
        try { return JSON.parse(src.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

function extractJsonArray(html, label) {
  const s = String(html ?? '')
  const re = new RegExp(String(label) + '\\s*:\\s*\\[', 'g')
  let m
  while ((m = re.exec(s))) {
    const arr = jsonArrayAt(s, m.index + m[0].length - 1)
    if (Array.isArray(arr) && arr.length) return arr
  }
  return null
}

// ────────────────────────────── 解析：列表 ──────────────────────────────

/**
 * 正文噪声清洗：贴吧会在楼层正文/楼层尾巴里塞"引导去 App"的句子，
 * 比如「查看高清大图，就在手机贴吧」「打开贴吧App，查看全部40条评论」「打开手百APP阅读全文」。
 * 这些不是吧友说的话 ⇒ 一律删掉（否则模型会把营销话当内容读）。
 */
const CONTENT_NOISE = [
  /查看?高清大图[，,]?\s*(?:就)?在?\s*手机贴吧/g,
  /打开(?:贴吧|手百|百度)\s*App\s*[，,]?\s*查看全部\s*\d+\s*条评论/g,
  /打开(?:贴吧|手百|百度)\s*App\s*[，,]?\s*查看(?:全部|更多)?(?:回复|评论)?/g,
  /打开手百\s*APP\s*阅读全文/gi,
  /查看全部\s*\d+\s*条(?:评论|回复)/g,
  /点击展开[，,]?\s*查看(?:全部|更多)/g,
  // 2026-10-28 真机补：正文末尾那句「下载贴吧APP，马上闯入高清视界」漏网了
  /下载贴吧\s*APP[，,]?\s*马上闯入高清视界/g,
  /下载(?:贴吧|手百|百度)\s*APP[，,]?\s*(?:马上|立即)?(?:闯入|查看|解锁|打开)[^。\n]{0,20}/g,
  // 「4图」「3图」这种图片计数残留（图本身已经单独收集到 images 里了）
  /^\s*\d+\s*图\s*$/gm,
]

/** 清掉正文里的引流噪声 + 收一下空白 */
function cleanContent(text) {
  let s = String(text ?? '')
  for (const re of CONTENT_NOISE) s = s.replace(re, '')
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 从页面里挖吧信息（名称 / 关注数 / 贴子数） */
function parseBarInfo(html) {
  let name = textOfClass(html, 'forum-name-txt')
  if (!name) {
    const t = pageTitle(html)
    name = t.replace(/[_\-]\s*百度贴吧.*$/i, '').trim()
  }
  let memberCount = 0
  let threadCount = 0
  const para = firstElement(html, 'info_paragraph')
  if (para) {
    const re = /<span class="info_label">\s*([\s\S]*?)<\/span>\s*<span class="info_value">\s*([\s\S]*?)<\/span>/g
    let m
    while ((m = re.exec(para.inner))) {
      const label = htmlToText(m[1])
      const value = toCount(htmlToText(m[2]))
      if (/关注|粉丝/.test(label)) memberCount = value
      else if (/贴子|帖子|主题/.test(label)) threadCount = value
    }
  }
  const barName = name.replace(/吧$/, '') || name
  return {
    // name 原样保留页面显示的形态（「原神吧」），报告标题直接用它
    name: name || '',
    // kw 是去掉尾巴「吧」的形态，可以原样喂回 listThreads / postThread 的 kw
    kw: barName,
    url: barName ? `${BASE}/f?kw=${encodeURIComponent(barName)}` : '',
    intro: textOfClass(html, 'forum_intro') || '',
    memberCount,
    threadCount,
  }
}

/** 一条 thread_list JSON → 契约里的 thread 对象 */
function threadFromJson(it) {
  const tid = String(it?.tid ?? it?.id ?? '')
  if (!tid) return null
  const media = Array.isArray(it?.media) ? it.media.length : 0
  return {
    tid,
    title: htmlToText(String(it?.title ?? '')),
    author: String(it?.author?.name_show || it?.author?.name || ''),
    time: String(it?.last_time ?? ''),
    replyCount: Number(it?.reply_num ?? 0) || 0,
    pinned: Number(it?.is_top ?? 0) === 1,
    hasImage: (Number(it?.media_num ?? 0) || 0) > 0 || media > 0,
    isGood: Number(it?.is_good ?? 0) === 1,
    url: `${BASE}/p/${tid}`,
  }
}

/** 兜底：解析 `<li class="tl_shadow">` / 置顶 `<li class="tl_top">` 的 HTML（JSON 块缺失时才用） */
function threadsFromHtml(html) {
  const out = []
  const seen = new Set()
  // 置顶帖在移动列表里是单独的 `<li class="tl_top">`（不是 tl_shadow），两拨都要扫
  const items = [
    ...findElements(html, 'tl_top', { tag: 'li', limit: 200 }),
    ...findElements(html, 'tl_shadow', { tag: 'li', limit: 400 }),
  ].sort((a, b) => a.start - b.start) // 保持页面顺序（置顶在最前）
  for (const li of items) {
    const tid = li.attrs['data-tid'] || li.attrs.tid || ''
    if (!tid || seen.has(tid)) continue
    seen.add(tid)
    const body = li.inner
    const time = textOfClass(body, 'ti_time')
    const replyBlock = firstElement(body, 'btn_reply')
    const replyText = replyBlock ? (firstElement(replyBlock.inner, 'btn_icon')?.inner ?? '') : ''
    // ti_title 里除了标题还有「置顶 / 精华」这类图标 span ⇒ 只取没有 class 的那个 span
    const titleEl = firstElement(body, 'ti_title')
    let title = titleEl ? htmlToText(titleEl.inner) : ''
    if (titleEl) {
      const spans = [...titleEl.inner.matchAll(/<span((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/span>/g)]
      const plain = spans.find((s) => !/\bclass\s*=/.test(s[1]))
      if (plain) title = htmlToText(plain[2])
    }
    out.push({
      tid: String(tid),
      title,
      author: textOfClass(body, 'ti_author'),
      time,
      replyCount: toCount(htmlToText(replyText)),
      // 置顶：li 自己的 class 里带 tl_top（`<li class="tl_top …">`），或者带「置顶」图标
      pinned: li.attrs['data-floor'] === '0'
        || /^class="[^"]*\btl_top\b/.test(li.outer.slice(0, 200))
        || /ti_icon_zhiding/.test(li.outer),
      hasImage: /medias_wrap|medias_one_pic|medias_box/.test(li.outer),
      isGood: /ti_icon_jinghua/.test(li.outer),
      url: `${BASE}/p/${tid}`,
    })
  }
  return out
}

/** 列表页 → { bar, threads }（纯函数，单测直接喂固定 HTML） */
export function parseListPage(html) {
  const bar = parseBarInfo(html)
  const json = extractJsonArray(html, 'thread_list')
  let threads = Array.isArray(json) ? json.map(threadFromJson).filter(Boolean) : []
  if (!threads.length) threads = threadsFromHtml(html)
  return { bar, threads }
}

// ────────────────────────────── 解析：正文楼层 ──────────────────────────────

/**
 * 解析 li 上的内嵌 JSON：楼层用 `data-info`，楼中楼/翻页用 `data-field`
 * （实测：`/p/comment` 返回的 li 只有 data-field，别只认 data-info）。
 */
function parseDataInfo(li) {
  const raw = li?.attrs?.['data-info'] ?? li?.attrs?.['data-field']
  if (!raw) return {}
  const j = parseJson(decodeEntities(raw))
  return j && typeof j === 'object' ? j : {}
}

/** 从页面 JS 里读当前页 / 总页数 */
function parsePaging(html, fallbackPage = 1) {
  const m = /"current_page"\s*:\s*(\d+)\s*,\s*"total_page"\s*:\s*(\d+)/.exec(String(html ?? ''))
  if (m) return { page: Number(m[1]) || fallbackPage, totalPage: Number(m[2]) || 1 }
  return { page: fallbackPage, totalPage: 1 }
}

/** 一个楼层 li → 契约里的 floor 对象 */
function floorFromLi(li) {
  const info = parseDataInfo(li)
  const body = li.inner
  const pid = String(li.attrs['data-tid'] || li.attrs.pid || li.attrs.tid || info.pid || '')
  if (!pid) return null
  const floorNo = Number(li.attrs.fn ?? info.floor_num ?? 0) || 0
  const userWrap = firstElement(body, 'list_item_user_wrap')
  const author = (userWrap ? textOfClass(userWrap.inner, 'user_name') : '') || textOfClass(body, 'user_name') || ''
  const time = textOfClass(body, 'list_item_time')
  const contentEl = firstElement(body, 'content')
  const contentHtml = contentEl ? contentEl.inner : ''
  const panel = firstElement(body, 'j_floor_panel')
  const subPostCount = panel ? toCount(panel.attrs['data-list-count'] || '0') : 0
  return {
    pid,
    floor: floorNo,
    author,
    time,
    content: truncate(cleanContent(htmlToText(contentHtml)), MAX_FLOOR_CHARS),
    images: collectImages(contentHtml),
    likeCount: 0, // 移动版正文页不显示点赞数（实测无 j_praise / like_num），如实给 0
    subPostCount,
    isOp: contentEl ? contentEl.attrs.lz === '1' || floorNo === 1 : floorNo === 1,
    _title: textOfClass(body, 'post_title_embed'),
  }
}

/** 正文页 → { title, bar, author, createdAt, page, totalPage, floors } */
export function parseThreadPage(html, fallbackPage = 1) {
  const floors = []
  for (const li of findElements(html, 'list_item', { tag: 'li', limit: 200 })) {
    const f = floorFromLi(li)
    if (f) floors.push(f)
  }
  const first = floors[0] || null
  const title = (first && first._title) || pageTitle(html)
  const barName = textOfClass(html, 'post_title_text')
  const paging = parsePaging(html, fallbackPage)
  for (const f of floors) delete f._title
  return {
    title,
    // 和列表页保持一致：bar 用页面显示的形态（「原神吧」）
    bar: barName,
    kw: barName.replace(/吧$/, '') || barName,
    author: first ? first.author : '',
    createdAt: first ? first.time : '',
    page: paging.page,
    totalPage: paging.totalPage,
    floors,
  }
}

// ────────────────────────────── 解析：楼中楼 ──────────────────────────────

/** 去掉楼中楼正文开头的「回复 某人 :」（贴吧自己加的引用前缀） */
function stripReplyPrefix(text) {
  return String(text ?? '')
    .replace(/^\s*回复\s*@?[^:：]{0,30}[:：]\s*/, '')
    .replace(/^\s*@[^:：\s]{1,30}[:：]\s*/, '')
    .trim()
}

/** 楼中楼 HTML（/p/comment 的返回）→ 回复数组 */
export function parseSubPosts(html) {
  const replies = []
  for (const li of findElements(html, 'lzl_single_post', { tag: 'li', limit: 100 })) {
    const info = parseDataInfo(li)
    const body = li.inner
    const authorLink = firstElement(body, 'lzl_p_p')
    const author = String(info.showname || info.user_name || authorLink?.attrs.username || '')
    const contentEl = firstElement(body, 'lzl_content_main')
    replies.push({
      author,
      time: textOfClass(body, 'lzl_time'),
      content: truncate(cleanContent(stripReplyPrefix(htmlToText(contentEl ? contentEl.inner : ''))), MAX_FLOOR_CHARS),
    })
  }
  let total = 0
  let totalPage = 1
  const pager = firstElement(html, 'lzl_li_pager')
  if (pager) {
    const j = parseDataInfo(pager)
    total = Number(j.total_num ?? 0) || 0
    totalPage = Number(j.total_page ?? 1) || 1
  }
  return { replies, total, totalPage }
}

// ────────────────────────────── URL 拼装 ──────────────────────────────

/**
 * 列表 URL。
 * ⚠️ 贴吧移动列表的 `pn` 是「从第几个帖子开始」（1 基）而不是页码：
 *    实测 `&pn=2` = 第一页去掉 1 条，`&pn=31` 才是第 2 页 ⇒ 这里替调用方换算。
 * @param {{kw:string, page?:number, good?:boolean}} o page 从 1 开始；0/1 = 首页
 */
function listUrl({ kw, page = 0, good = false }) {
  const p = new URLSearchParams()
  p.set('kw', String(kw ?? ''))
  const pageNo = Number(page) || 0
  if (pageNo > 1) p.set('pn', String((pageNo - 1) * PAGE_SIZE + 1))
  // 精品区：桌面端「精品」tab 用的是 lm=4。⚠️ 实测移动列表加 &lm=4 没有明显过滤效果，
  // 所以 good=true 时上层还会按 is_good 再筛一道（见 listThreads）。
  if (good) p.set('lm', '4')
  return `${MO}?${p.toString()}`
}

/** 正文 URL。page 从 1 开始（契约里 readThread 的 pn 默认 1） */
function threadUrl({ tid, page = 1 }) {
  const p = new URLSearchParams()
  p.set('kz', String(tid ?? ''))
  const pageNo = Number(page) || 1
  if (pageNo > 1) p.set('pn', String((pageNo - 1) * PAGE_SIZE + 1))
  return `${MO}?${p.toString()}`
}

/** 楼中楼 URL（实测跑通的那个） */
function commentUrl({ tid, pid, page = 1 }) {
  const p = new URLSearchParams()
  p.set('tid', String(tid ?? ''))
  p.set('pid', String(pid ?? ''))
  p.set('pn', String(Number(page) || 1))
  return `${COMMENT_URL}?${p.toString()}`
}

// ────────────────────────────── 凭证 ──────────────────────────────

function credentialPath(stateDir) {
  return join(String(stateDir || '.'), CREDENTIAL_FILE)
}

/**
 * 读凭证：文件不存在 / 内容坏了都返回 null（**永不抛**）。
 * @returns {{bduss:string, stoken:string, uname:string}|null}
 */
/**
 * 清理凭证值：去空白、去首尾引号。
 * ⭐ 2026-10-28：用户从浏览器复制 BDUSS 时经常把**首尾的双引号也带上**（`"thUE…"`），
 *    那样贴吧就不认了，而且报的是"BDUSS 无效"这种看不出原因的话。这里统一剥掉。
 */
function cleanCredValue(v) {
  return String(v ?? '').trim().replace(/^["'`]+|["'`]+$/g, '').trim()
}

export function loadCredential(stateDir) {
  try {
    if (!stateDir) return null // 没给家目录就当没登录，绝不往当前目录瞎写
    const file = credentialPath(stateDir)
    if (!existsSync(file)) return null
    const j = JSON.parse(readFileSync(file, 'utf8'))
    const bduss = cleanCredValue(j?.bduss)
    if (!bduss) return null
    // ⭐ cookieRaw 必须带出来 —— 贴吧风控要的整串 cookie 就在这儿，
    //    漏了这个字，读接口永远 403（2026-10-28 真机排查了两轮才定位到）
    const cookieRaw = String(j?.cookieRaw ?? '').trim()
    return {
      bduss,
      stoken: cleanCredValue(j?.stoken),
      uname: String(j?.uname ?? '').trim(),
      ...(cookieRaw ? { cookieRaw } : {}),
    }
  } catch { return null }
}

/** 写凭证（顺手把权限收到只有自己能读；写失败就算了，不抛） */
export function saveCredential(stateDir, cred) {
  try {
    if (!stateDir) return
    const dir = String(stateDir)
    mkdirSync(dir, { recursive: true })
    const file = credentialPath(dir)
    writeFileSync(file, JSON.stringify({
      bduss: cleanCredValue(cred?.bduss),
      stoken: cleanCredValue(cred?.stoken),
      // ⭐ cookieRaw = 浏览器整串 cookie（贴吧风控要的那串）。没给就不存这个键。
      ...(String(cred?.cookieRaw ?? '').trim() ? { cookieRaw: String(cred.cookieRaw).trim() } : {}),
      uname: String(cred?.uname ?? '').trim(),
      savedAt: new Date().toISOString(),
    }, null, 2), 'utf8')
    try { if (process.platform !== 'win32') chmodSync(file, 0o600) } catch { /* 权限收不了也不影响用 */ }
  } catch { /* 写不进去（目录只读等）也不抛 —— 上层会看到"未登录" */ }
}

/** 删凭证（退出登录），**永不抛** */
export function clearCredential(stateDir) {
  try {
    if (!stateDir) return
    rmSync(credentialPath(stateDir), { force: true })
  } catch { /* 删不掉也当已退出 */ }
}

// ────────────────────────────── 登录态 ──────────────────────────────

/**
 * 拿 tbs（贴吧所有写操作都要的防伪票据）。
 * @returns {Promise<string>} 失败返回 ''（契约：失败返回空串，不抛）
 */
export async function ensureTbs({ bduss } = {}) {
  if (!bduss) return ''
  const res = await request(TBS_URL, { ua: UA_DESKTOP, bduss })
  if (!res.ok) return ''
  const j = parseJson(res.text)
  return String(j?.tbs ?? '')
}

/**
 * 看当前 BDUSS 是谁。
 * ① /dc/common/tbs 的 `is_login` 判断登录态（实测无 Cookie 时稳定返回 0）
 * ② /f/user/json_userinfo 拿用户名（无 Cookie 时返回字面量 `null`）
 * @returns {Promise<{ok:true, uname:string, loggedIn:true}|{ok:false, error:string, hint:string, loggedIn:false}>}
 */
export async function whoami({ bduss, stoken } = {}) {
  if (!bduss) return { ...fail('未登录', '去设置页把 BDUSS 粘进来（浏览器登录贴吧后从 Cookie 里复制）'), loggedIn: false }

  const tbsRes = await request(TBS_URL, { ua: UA_DESKTOP, bduss, stoken })
  const tbsJson = tbsRes.ok ? parseJson(tbsRes.text) : null
  if (!tbsRes.ok) return { ...tbsRes, loggedIn: false }
  if (!tbsJson) return { ...fail('贴吧返回的登录信息看不懂（可能被风控拦了）', '等几分钟再试；一直这样就去设置页重新粘 BDUSS'), loggedIn: false }
  if (Number(tbsJson.is_login) !== 1) {
    return { ...fail('BDUSS 无效或已过期（贴吧认为没登录）', '去浏览器重新登录贴吧，重新复制一份 BDUSS 粘到设置页'), loggedIn: false }
  }

  const infoRes = await request(USERINFO_URL, {
    ua: UA_DESKTOP, bduss, stoken, xhr: true, referer: `${BASE}/`,
    accept: 'application/json, text/plain, */*', ...readCred(),
  })
  if (!infoRes.ok) return { ...fail('登录成功了，但读用户名失败', '不影响使用；如果一直这样，等几分钟再试'), loggedIn: true, uname: '' }
  if (looksBlocked(infoRes.text)) return { ok: true, uname: '', loggedIn: true }
  const j = parseJson(infoRes.text)
  const uname = String(j?.user_name || j?.name || j?.user?.name || j?.data?.user_name || j?.data?.name || '').trim()
  return { ok: true, uname, loggedIn: true }
}

// ────────────────────────────── 读：列表 ──────────────────────────────

/**
 * 吧内帖子列表。
 * @param {{kw:string, pn?:number, good?:boolean}} o
 *        pn = 页码（0/1 = 首页，2 = 第二页 …）；good = 只看精品
 */
export async function listThreads({ kw, pn = 0, good = false } = {}) {
  const bar = String(kw ?? '').trim()
  if (!bar) return fail('没给吧名', '调用时要传 kw（例如「原神」）')

  const res = await request(listUrl({ kw: bar, page: pn, good }), { ua: UA_MOBILE, ...readCred() })
  const bad = guard(res)
  if (bad) return bad

  const { bar: barInfo, threads } = parseListPage(res.text)
  if (!barInfo.name && threads.length === 0) {
    return fail('没解析到这个吧的页面（可能是吧名不存在，或者贴吧又改版了）', '检查吧名是否写错（注意别带「吧」字以外的符号）；还不行就把这个吧换掉')
  }
  const list = good ? threads.filter((t) => t.isGood) : threads
  return { ok: true, bar: barInfo, threads: list }
}

// ────────────────────────────── 读：正文 ──────────────────────────────

/**
 * 读一篇帖子的楼层。
 * @param {{tid:string|number, pn?:number}} o pn = 页码（从 1 开始，一页 30 楼）
 */
export async function readThread({ tid, pn = 1 } = {}) {
  const id = String(tid ?? '').trim()
  if (!/^\d+$/.test(id)) return fail('帖子 ID 不对（应该是纯数字）', 'tid 从列表里的帖子链接 /p/<tid> 拿')

  const page = Math.max(1, Number(pn) || 1)
  const res = await request(threadUrl({ tid: id, page }), { ua: UA_MOBILE, ...readCred() })
  const bad = guard(res)
  if (bad) return bad

  const parsed = parseThreadPage(res.text, page)
  if (!parsed.floors.length) {
    return fail('这篇帖子没解析出楼层（可能被删了，或者贴吧改版了）', '先确认帖子里还有人说话；一直这样就反馈给作者')
  }
  return {
    ok: true,
    tid: id,
    title: parsed.title,
    bar: parsed.bar,
    author: parsed.author,
    createdAt: parsed.createdAt,
    page: parsed.page,
    totalPage: parsed.totalPage,
    floors: parsed.floors,
  }
}

// ────────────────────────────── 读：楼中楼 ──────────────────────────────

/**
 * 读某一层楼的楼中楼。
 * @param {{tid:string|number, pid:string|number, pn?:number}} o
 */
export async function readSubPosts({ tid, pid, pn = 1 } = {}) {
  const t = String(tid ?? '').trim()
  const p = String(pid ?? '').trim()
  if (!/^\d+$/.test(t)) return fail('帖子 ID 不对（应该是纯数字）', 'tid 从列表里的帖子链接 /p/<tid> 拿')
  if (!/^\d+$/.test(p)) return fail('楼层 ID 不对（pid 是纯数字，来自 readThread 的 floors[].pid）', '先跑一遍 tieba_thread，拿 floors[i].pid')

  const res = await request(commentUrl({ tid: t, pid: p, page: pn }),
    { ua: UA_DESKTOP, accept: 'text/html, */*', xhr: true, referer: `${BASE}/p/${t}`, ...readCred() })
  const bad = guard(res)
  if (bad) return bad

  const { replies, total, totalPage } = parseSubPosts(res.text)
  return { ok: true, replies, total, totalPage }
}

// ────────────────────────────── 写：发帖 / 回帖 ──────────────────────────────

/**
 * 把发帖接口的 JSON 翻成人话失败对象。
 * ⚠️ 只有 `no=265 / err_code=230265`（未登录）是**实测**到的（没账号，只探到这一层）；
 *    剩下的分支按贴吧历史口径推测，所以文案写宽一点，别让用户被误导。
 */
function commitError(j) {
  const no = Number(j?.no ?? 0)
  const code = Number(j?.err_code ?? 0)
  const text = String(j?.error ?? j?.error_msg ?? '')
  if (no === 265 || code === 230265) {
    return fail('未登录（BDUSS 失效或没带上）', '去设置页重新粘一份 BDUSS；登录态过期通常是浏览器退出登录导致的')
  }
  if (/验证码|captcha|验证/i.test(text)) {
    return fail('贴吧要求输入验证码（风控）', '这个号/这个 IP 被贴吧盯上了：等十几分钟再试，或换个网络；别连着发')
  }
  if (/tbs/i.test(text)) {
    return fail('tbs 过期了（贴吧的防伪票据）', '重新点一次就好；一直这样说明 BDUSS 快过期了，去设置页重粘')
  }
  if (/频繁|太快|太快了|间隔/.test(text)) {
    return fail('发得太快了，被贴吧限流', '等几分钟再发；把「每轮最多回几条」调小一点')
  }
  if (/封|禁言|权限|禁止/.test(text)) {
    return fail('这个号在这个吧没有发言权限（可能被封/禁言/等级不够）', '换自己的号去贴吧页面确认一下；被封的话等解封')
  }
  return fail(`贴吧拒绝了这次发言：${text || 'no=' + no}`, '把这句话原文发给作者；常见原因是验证码/登录态过期/吧内限制')
}

/** 校验写操作的公共前置条件 */
function writablePrecheck({ bduss, kw, content }) {
  if (!String(bduss ?? '').trim()) return fail('未登录', '去设置页把 BDUSS 粘进来；自动回帖需要登录态')
  if (kw !== undefined && !String(kw ?? '').trim()) return fail('没给吧名', '调用时要传 kw（例如「原神」）')
  if (content !== undefined && !String(content ?? '').trim()) return fail('内容不能为空', '写点什么再发')
  return null
}

/** 从吧页面里挖 fid（发帖/回帖接口都要） */
async function resolveFid(kw) {
  const res = await request(listUrl({ kw }), { ua: UA_MOBILE, ...readCred() })
  const bad = guard(res)
  if (bad) return bad
  const html = res.text
  const m = /forum_id\s*:\s*"?(\d{2,})"?/.exec(html) || /\/mo\/q\/postreport\?fid=(\d+)/.exec(html) || /"fid"\s*:\s*(\d{2,})/.exec(html)
  if (!m) return fail('找不到这个吧的 fid（发帖接口必填）', '吧名可能写错了；去贴吧网页版确认一下这个吧存在')
  return { ok: true, fid: m[1] }
}

/**
 * 发主题帖。
 * ⚠️ **未验证**：网页端表单接口 `/f/commit/thread/add`（ie/kw/fid/rich_text/tbs/content/title/__type__=thread）
 *    实测"接口存在且未登录时返回 no:265"，但成功路径需要真实账号，本层没有号可验。
 *    ⇒ 参数照社区长期可用的那套写；失败时的 hint 会指向 未登录 / 验证码 / tbs 过期。
 * @returns {Promise<{ok:true, tid:string, url:string}|{ok:false, error:string, hint?:string}>}
 */
export async function postThread({ bduss, stoken, kw, title, content, fid } = {}) {
  const pre = writablePrecheck({ bduss, kw, content })
  if (pre) return pre
  const bar = String(kw).trim()
  const tt = String(title ?? '').trim()
  if (!tt) return fail('标题不能为空', '发主题帖必须有标题')

  let fidText = String(fid ?? '').trim()
  if (!/^\d+$/.test(fidText)) {
    const r = await resolveFid(bar)
    if (!r.ok) return r
    fidText = r.fid
  }

  const tbs = await ensureTbs({ bduss })
  if (!tbs) return fail('拿不到 tbs（贴吧的防伪票据）', 'BDUSS 大概过期了：去设置页重新粘一份再试')

  const res = await request(THREAD_ADD_URL, {
    method: 'POST',
    ua: UA_DESKTOP,
    bduss,
    stoken,
    cookieRaw: readCred().cookieRaw,     // ⭐ 发帖同样要风控 cookie，只有 BDUSS 会被 403
    referer: `${BASE}/f?kw=${encodeURIComponent(bar)}`,
    form: { ie: 'utf-8', kw: bar, fid: fidText, rich_text: '1', tbs, content: String(content), title: tt, __type__: 'thread' },
  })
  const bad = guard(res)
  if (bad) return bad

  const j = parseJson(res.text)
  if (!j) return fail('发帖接口返回的不是 JSON（贴吧可能换接口了）', '把返回原文发给作者；这是需要改代码的情况')
  if (Number(j.no) === 0) {
    const tid = String(j?.data?.tid ?? j?.data?.thread_id ?? j?.data?.id ?? '')
    return { ok: true, tid, url: tid ? `${BASE}/p/${tid}` : `${BASE}/f?kw=${encodeURIComponent(bar)}` }
  }
  return commitError(j)
}

/**
 * 回主题帖（在帖子底下发一层楼）。
 * ⚠️ **未验证**（成功路径需要真实账号）：`/f/commit/post/add`（ie/kw/fid/rich_text/tbs/content/tid/__type__=reply）。
 *    实测该接口存在、未登录返回 `{no:265, err_code:230265}`。
 * @returns {Promise<{ok:true, pid:string, tid:string, url:string}|{ok:false, error:string, hint?:string}>}
 */
export async function replyPost({ bduss, stoken, tid, content } = {}) {
  const pre = writablePrecheck({ bduss, content })
  if (pre) return pre
  const id = String(tid ?? '').trim()
  if (!/^\d+$/.test(id)) return fail('帖子 ID 不对（应该是纯数字）', 'tid 从列表里的帖子链接 /p/<tid> 拿')

  // 发帖接口要 kw + fid，而调用方只给 tid ⇒ 从帖子页面上读回来（顺带确认帖子还在）
  const pageRes = await request(threadUrl({ tid: id, page: 1 }), { ua: UA_MOBILE, ...readCred() })
  const bad = guard(pageRes)
  if (bad) return bad
  const parsed = parseThreadPage(pageRes.text)
  const bar = String(parsed.bar || '').replace(/吧$/, '')
  if (!bar) return fail('读不出这个帖子属于哪个吧', '帖子可能被删了；或者贴吧改版了')
  const fidRes = await resolveFid(bar)
  if (!fidRes.ok) return fidRes

  const tbs = await ensureTbs({ bduss })
  if (!tbs) return fail('拿不到 tbs（贴吧的防伪票据）', 'BDUSS 大概过期了：去设置页重新粘一份再试')

  const res = await request(POST_ADD_URL, {
    method: 'POST',
    ua: UA_DESKTOP,
    bduss,
    stoken,
    cookieRaw: readCred().cookieRaw,     // ⭐ 发帖同样要风控 cookie，只有 BDUSS 会被 403
    referer: `${BASE}/p/${id}`,
    form: {
      ie: 'utf-8', kw: bar, fid: fidRes.fid, rich_text: '1', tbs,
      content: String(content), tid: id, __type__: 'reply',
    },
  })
  const bad2 = guard(res)
  if (bad2) return bad2

  const j = parseJson(res.text)
  if (!j) return fail('回帖接口返回的不是 JSON（贴吧可能换接口了）', '把返回原文发给作者')
  if (Number(j.no) === 0) {
    const pid = String(j?.data?.pid ?? j?.data?.post_id ?? j?.data?.id ?? '')
    return { ok: true, pid, tid: id, url: `${BASE}/p/${id}` }
  }
  return commitError(j)
}

/**
 * 回楼中楼（在某一层楼下面接话）。
 * ⚠️ **未验证**：贴吧网页端**没有**独立的楼中楼写接口 —— 实测 `f/commit/lzl/add`、
 *    `f/commit/sub/add`、`f/commit/comment/add`、`f/commit/reply/add` 全是 404（贴吧404 页），
 *    只有 `f/commit/post/add` 和 `f/commit/thread/add` 真实存在。
 *    ⇒ 这里按社区长期用法：复用 `post/add` 多带一个 `pid`（被回复楼层的 pid）。
 *    没有真实账号，**成功路径没验过**；失败时错误信息会指向 未登录/验证码/tbs 过期/权限。
 *    （带 MD5 sign 的 `c.tieba.baidu.com` 接口能确定地做楼中楼，但那要算签名，本插件不碰。）
 * @returns {Promise<{ok:true}|{ok:false, error:string, hint?:string}>}
 */
export async function replySubPost({ bduss, stoken, tid, pid, content } = {}) {
  const pre = writablePrecheck({ bduss, content })
  if (pre) return pre
  const id = String(tid ?? '').trim()
  const floorPid = String(pid ?? '').trim()
  if (!/^\d+$/.test(id)) return fail('帖子 ID 不对（应该是纯数字）', 'tid 从列表里的帖子链接 /p/<tid> 拿')
  if (!/^\d+$/.test(floorPid)) return fail('楼层 ID 不对（pid 是纯数字）', '先跑 tieba_thread 拿 floors[i].pid，别拿 tid 当 pid')

  const pageRes = await request(threadUrl({ tid: id, page: 1 }), { ua: UA_MOBILE, ...readCred() })
  const bad = guard(pageRes)
  if (bad) return bad
  const parsed = parseThreadPage(pageRes.text)
  const bar = String(parsed.bar || '').replace(/吧$/, '')
  if (!bar) return fail('读不出这个帖子属于哪个吧', '帖子可能被删了；或者贴吧改版了')
  const fidRes = await resolveFid(bar)
  if (!fidRes.ok) return fidRes

  const tbs = await ensureTbs({ bduss })
  if (!tbs) return fail('拿不到 tbs（贴吧的防伪票据）', 'BDUSS 大概过期了：去设置页重新粘一份再试')

  const res = await request(POST_ADD_URL, {
    method: 'POST',
    ua: UA_DESKTOP,
    bduss,
    stoken,
    cookieRaw: readCred().cookieRaw,     // ⭐ 发帖同样要风控 cookie，只有 BDUSS 会被 403
    referer: `${BASE}/p/${id}`,
    form: {
      ie: 'utf-8', kw: bar, fid: fidRes.fid, rich_text: '1', tbs,
      content: String(content), tid: id, pid: floorPid, __type__: 'reply',
    },
  })
  const bad2 = guard(res)
  if (bad2) return bad2
  const j = parseJson(res.text)
  if (!j) return fail('楼中楼接口返回的不是 JSON（这条路径本来就没验证过）', '把返回原文发给作者')
  if (Number(j.no) === 0) return { ok: true }
  return commitError(j)
}

// ────────────────────────────── 仅供单测 ──────────────────────────────

/**
 * 内部函数的出口（**只给 test/ 用**，index.js 别碰这些）。
 * 单测不联网，所以必须能单独测 URL 拼装和解析函数。
 */
export const __test = {
  PAGE_SIZE, MAX_FLOOR_CHARS,
  listUrl, threadUrl, commentUrl,
  parseListPage, parseThreadPage, parseSubPosts,
  extractJsonArray, parsePaging, stripReplyPrefix, commitError, cleanContent,
  looksBlocked, looks404, absUrl, attrOf, decodeEntities, htmlToText,
}
