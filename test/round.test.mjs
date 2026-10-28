/**
 * test/round.test.mjs —— lib/round.mjs 里那些**纯函数**的离线单测
 * ============================================================================
 * 跑一轮里有三处最容易悄悄坏掉、而且坏了很难看出来：
 *   ① 模型的输出不一定是干净 JSON（可能包围栏、可能带废话）→ extractJson
 *   ② 模型会**瞎编 tid**／重复／给错档位／超额 → validatePicks 必须挡住
 *   ③ 这两处一旦放过坏数据，就是往日报里写假内容、甚至拿用户账号回错帖子
 * 所以它们全部不联网、纯函数、直接测。
 * ============================================================================
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractJson, validatePicks } from '../lib/round.mjs'

// ────────────────────────── extractJson ──────────────────────────

test('extractJson：干净 JSON 直接过', () => {
  const j = extractJson('{"picks":[],"skipped":[],"summary":"ok"}')
  assert.equal(j.summary, 'ok')
  assert.deepEqual(j.picks, [])
})

test('extractJson：```json 围栏能剥掉', () => {
  const j = extractJson('```json\n{"picks":[{"tid":"1","tier":"值得看"}]}\n```')
  assert.equal(j.picks.length, 1)
})

test('extractJson：前后带废话也能捞出那段 JSON', () => {
  const j = extractJson('好的，我的判断如下：\n{"picks":[],"summary":"没什么可挑的"}\n以上。')
  assert.equal(j.summary, '没什么可挑的')
})

test('extractJson：字符串里的花括号不会把截取搞错', () => {
  const j = extractJson('{"summary":"他说 {不是结构} 而是文字","picks":[]}')
  assert.equal(j.summary, '他说 {不是结构} 而是文字')
})

test('extractJson：根本不是 JSON → null（这一轮作废，不落盘）', () => {
  assert.equal(extractJson('这轮帖子都不太行'), null)
  assert.equal(extractJson(''), null)
  assert.equal(extractJson(null), null)
})

test('extractJson：坏 JSON（少个括号）→ null，不硬猜', () => {
  assert.equal(extractJson('{"picks":[{"tid":"1"}'), null)
})

// ──────────────────────── validatePicks ─────────────────────────

const TIDS = ['111', '222', '333', '444']

test('validatePicks：正常输出原样收下', () => {
  const r = validatePicks({
    picks: [
      { tid: '111', tier: '值得看', why: '有干货', oneLine: '妙', reply: '说得对' },
      { tid: '222', tier: '可以看', why: '还行', oneLine: '', reply: '' },
    ],
    skipped: [{ tid: '333', why: '广告' }],
    summary: '挑了两条',
  }, TIDS, 5)
  assert.equal(r.picks.length, 2)
  assert.equal(r.picks[0].tier, '值得看')
  assert.equal(r.skipped.length, 1)
  assert.equal(r.summary, '挑了两条')
})

test('validatePicks：模型瞎编的 tid 被丢掉（绝不回错帖）', () => {
  const r = validatePicks({
    picks: [
      { tid: '999', tier: '值得看', why: '编的' },
      { tid: '111', tier: '值得看', why: '真的' },
    ],
  }, TIDS, 5)
  assert.equal(r.picks.length, 1)
  assert.equal(r.picks[0].tid, '111')
})

test('validatePicks：重复 tid 只留第一次', () => {
  const r = validatePicks({
    picks: [
      { tid: '111', tier: '值得看', why: 'A' },
      { tid: '111', tier: '可以看', why: 'B' },
    ],
  }, TIDS, 5)
  assert.equal(r.picks.length, 1)
  assert.equal(r.picks[0].why, 'A')
})

test('validatePicks：三档以外的词（模型自创）被丢掉', () => {
  const r = validatePicks({
    picks: [
      { tid: '111', tier: '强烈推荐', why: '自创档位' },
      { tid: '222', tier: '可以看', why: '合规' },
    ],
  }, TIDS, 5)
  assert.equal(r.picks.length, 1)
  assert.equal(r.picks[0].tier, '可以看')
})

test('validatePicks：超配额截断到配额', () => {
  const r = validatePicks({
    picks: TIDS.map((t) => ({ tid: t, tier: '值得看', why: 'x' })),
  }, TIDS, 2)
  assert.equal(r.picks.length, 2)
})

test('validatePicks：picks 不是数组 → null（整轮作废）', () => {
  assert.equal(validatePicks({ picks: '不是数组' }, TIDS, 5), null)
  assert.equal(validatePicks({}, TIDS, 5), null)
  assert.equal(validatePicks(null, TIDS, 5), null)
})

test('validatePicks：skipped 里瞎编的 tid 也挡掉', () => {
  const r = validatePicks({
    picks: [],
    skipped: [{ tid: '777', why: '编的' }, { tid: '222', why: '真的' }],
  }, TIDS, 5)
  assert.equal(r.skipped.length, 1)
  assert.equal(r.skipped[0].tid, '222')
})

test('validatePicks：超长字段被截断（别把一整篇塞进日报）', () => {
  const r = validatePicks({
    picks: [{ tid: '111', tier: '值得看', why: '呀'.repeat(500), oneLine: '嗯'.repeat(500) }],
  }, TIDS, 5)
  assert.ok(r.picks[0].why.length <= 200)
  assert.ok(r.picks[0].oneLine.length <= 200)
})
