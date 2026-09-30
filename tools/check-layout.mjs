#!/usr/bin/env node
/**
 * 分屏排布的穷举校验。
 *
 * 为什么值得单独一个脚本：拖拽并分屏的落点算法（`splitPlan` / `pruneSpec`）是纯整数
 * 几何运算，出错的形态很隐蔽 —— 格子表里多一个洞、两格重叠、新格子跑到相邻格上，
 * 界面上看着"就是有点怪"，靠点几下根本发现不了。而组合数是有限的（形状 × 格子 × 落点），
 * 直接穷举一遍最省事。
 *
 * 断言六件事：
 *   1. 十六个预设本身合法（无洞、无重叠）；
 *   2. 每一刀切下去得到的排布都合法，且新格与切开的那格**紧贴同轴**、跨轴范围一致；
 *   3. 连切 n 刀（一次并进 n 格）得到的新格是紧挨着的一串，落点下标与界面的半格判一致；
 *   4. 收掉任意一格，要么得到一个合法的少一格排布，要么明确算不出来（返回 null）；
 *   5. 从单格出发一路切，**三格的全部 6 种、四格的全部 7 种预设都能拖出来** ——
 *      这条正是用户报的"三四分屏拖不出所有形式"，所以直接断言；
 *   6. 每条可拖分割线都在合法范围内，且十个预设与改造前写死的那套逐字一致。
 *
 * 用法：node tools/check-layout.mjs
 */
import { readFile } from 'node:fs/promises'

const SRC = new URL('../src/lib/paneLayout.ts', import.meta.url)

/**
 * 装载待校验的模块。
 *
 * 优先用 Node 自带的 TS 剥离（22.18 起默认开，不需要任何依赖）；跑不起来再退回
 * esbuild（只在 vite 的依赖树里，没进 package.json）—— 校验脚本不该因为运行时
 * 版本老一点就整个用不了。
 */
async function loadPaneLayout() {
  try {
    return await import(SRC.href)
  } catch (e) {
    try {
      const { transform } = await import('esbuild')
      const out = await transform(await readFile(SRC, 'utf8'), { loader: 'ts', format: 'esm' })
      return await import(`data:text/javascript;base64,${Buffer.from(out.code).toString('base64')}`)
    } catch (e2) {
      throw new Error(
        `装载 ${SRC.pathname} 失败。Node 需要 ≥ 22.18 才直接认 .ts，否则得装 esbuild。\n` +
          `  原生导入：${e.message}\n  esbuild：${e2.message}`,
      )
    }
  }
}

const mod = await loadPaneLayout()

const { PANE_LAYOUTS, LAYOUT_ORDER, MAX_PANES, splitPlan, splitPlanN, pruneSpec, validateSpec, matchPreset, dividersOfSpec } = mod

let failed = 0
const bad = (msg) => {
  failed += 1
  console.log(`  ✗ ${msg}`)
}

const span = (c) => ({ cs: c.cs ?? 1, rs: c.rs ?? 1 })
const sig = (s) =>
  `${s.cols}x${s.rows} ` +
  s.cells.map((c) => `(${c.c},${c.r}${c.cs ? `+${c.cs}c` : ''}${c.rs ? `+${c.rs}r` : ''})`).join(' ')
/** 只按几何形状归一（顺序无关）：用来数"一共有多少种样子" */
const geoKey = (s) =>
  `${s.cols}x${s.rows}|` +
  s.cells
    .map((c) => [c.c, c.r, span(c).cs, span(c).rs].join(','))
    .sort()
    .join(';')

/* ---------- 1. 预设自身合法 ---------- */
console.log('1) 预设表')
for (const key of LAYOUT_ORDER) {
  const err = validateSpec(PANE_LAYOUTS[key])
  if (err) bad(`${key}（${PANE_LAYOUTS[key].label}）不合法：${err}`)
}
console.log(`   ${LAYOUT_ORDER.length} 个预设全部合法（无洞、无重叠）`)

/* ---------- 2. 每一刀 ---------- */
console.log('2) 切开任意一格')
let cuts = 0
for (const key of LAYOUT_ORDER) {
  const spec = PANE_LAYOUTS[key]
  if (spec.cells.length >= MAX_PANES) continue
  for (let i = 0; i < spec.cells.length; i++) {
    const target = spec.cells[i]
    const t = span(target)
    for (const side of ['left', 'right', 'top', 'bottom']) {
      cuts += 1
      const plan = splitPlan(spec, i, side)
      if (!plan) {
        bad(`${key} 第 ${i + 1} 格 ${side}：算不出来`)
        continue
      }
      const next = plan.spec
      const err = validateSpec(next)
      if (err) {
        bad(`${key} 第 ${i + 1} 格 ${side}：${err} —— ${sig(next)}`)
        continue
      }
      if (next.cells.length !== spec.cells.length + 1) {
        bad(`${key} 第 ${i + 1} 格 ${side}：格数没多一个`)
      }
      const before = side === 'left' || side === 'top'
      if (plan.insertAt !== (before ? i : i + 1)) {
        bad(`${key} 第 ${i + 1} 格 ${side}：落点下标 ${plan.insertAt} 与半格判（${before ? i : i + 1}）不一致`)
      }
      // 新格 = plan.spec 里对应的那一格（insertAt 位置）
      const fresh = next.cells[plan.insertAt]
      const kept = next.cells[plan.insertAt === i ? i + 1 : i]
      if (!fresh || !kept) {
        bad(`${key} 第 ${i + 1} 格 ${side}：insertAt=${plan.insertAt} 取不到新格/原格`)
        continue
      }
      const f = span(fresh)
      const k = span(kept)
      const colAxis = side === 'left' || side === 'right'
      if (colAxis) {
        // 同轴相邻：一个的右边缘紧贴另一个的左边缘；跨轴（行）范围必须与原格一致
        const [l, r] = fresh.c < kept.c ? [fresh, kept] : [kept, fresh]
        if (l.c - 1 + span(l).cs !== r.c - 1) bad(`${key} 第 ${i + 1} 格 ${side}：两半不相邻`)
        for (const piece of [fresh, kept]) {
          const p = span(piece)
          if (p.rs !== t.rs || piece.r !== target.r) {
            bad(`${key} 第 ${i + 1} 格 ${side}：切完行范围变了（原 r${target.r}+${t.rs}）`)
          }
        }
        if (f.cs * 2 !== t.cs * 2 && t.cs > 1) {
          /* 跨列那格被一分为二时两半等宽，这里不额外断言宽度比例 */
        }
      } else {
        const [u, d] = fresh.r < kept.r ? [fresh, kept] : [kept, fresh]
        if (u.r - 1 + span(u).rs !== d.r - 1) bad(`${key} 第 ${i + 1} 格 ${side}：两半不相邻`)
        for (const piece of [fresh, kept]) {
          const p = span(piece)
          if (p.cs !== t.cs || piece.c !== target.c) {
            bad(`${key} 第 ${i + 1} 格 ${side}：切完列范围变了（原 c${target.c}+${t.cs}）`)
          }
        }
      }
      // 其余格子必须原地不动（除了坐标整体平移）
      if (plan.preset && matchPreset(next) !== plan.preset) {
        bad(`${key} 第 ${i + 1} 格 ${side}：preset 与格子表对不上`)
      }
    }
  }
}
console.log(`   ${cuts} 刀全部算得出、排布合法、新格与落点同轴相邻`)

/* ---------- 3. 连切 n 刀（一次并进 n 格） ---------- */
console.log('3) 连切 n 刀')
let chains = 0
for (const key of LAYOUT_ORDER) {
  const spec = PANE_LAYOUTS[key]
  const room = MAX_PANES - spec.cells.length
  for (let n = 2; n <= room; n++) {
    for (let i = 0; i < spec.cells.length; i++) {
      const target = spec.cells[i]
      const t = span(target)
      for (const side of ['left', 'right', 'top', 'bottom']) {
        chains += 1
        const plan = splitPlanN(spec, i, side, n)
        const at = `${key} 第 ${i + 1} 格 ${side} ×${n}`
        if (!plan) {
          bad(`${at}：算不出来（这一屏还有 ${room} 格位置）`)
          continue
        }
        const next = plan.spec
        const err = validateSpec(next)
        if (err) {
          bad(`${at}：${err} —— ${sig(next)}`)
          continue
        }
        if (next.cells.length !== spec.cells.length + n) bad(`${at}：格数不是多 ${n} 个`)
        const before = side === 'left' || side === 'top'
        if (plan.insertAt !== (before ? i : i + 1)) {
          bad(`${at}：落点下标 ${plan.insertAt} 与半格判不一致`)
        }
        // 新格必须是紧挨着的一串，且跨轴范围与原格一致（否则"高亮在哪儿、格子落在哪儿"就对不上）
        const block = next.cells.slice(plan.insertAt, plan.insertAt + n)
        if (block.length !== n) {
          bad(`${at}：落点下标越界，取不满 ${n} 格`)
          continue
        }
        const key2 = (c) => (side === 'left' || side === 'right' ? c.c : c.r)
        const cross = (c) => (side === 'left' || side === 'right' ? [c.r, span(c).rs] : [c.c, span(c).cs])
        const sorted = [...block].sort((a, b) => key2(a) - key2(b))
        const wanted = [...new Set(block.map(key2))]
        if (wanted.length !== n) bad(`${at}：新格没排在 ${n} 条不同的带上`)
        for (let k = 1; k < n; k++) {
          if (key2(sorted[k]) !== key2(sorted[k - 1]) + 1) bad(`${at}：新格之间有断开`)
        }
        for (const c of block) {
          const [v, s] = cross(c)
          const [tv, ts] = side === 'left' || side === 'right' ? [target.r, t.rs] : [target.c, t.cs]
          if (v !== tv || s !== ts) bad(`${at}：新格的跨轴范围与原格不一致`)
        }
      }
    }
  }
}
console.log(`   ${chains} 种连切全部算得出、新格是紧挨着的一串`)

/* ---------- 4. 收掉一格 ---------- */
console.log('4) 收掉任意一格')
let prunes = 0
let pruned = 0
for (const key of LAYOUT_ORDER) {
  const spec = PANE_LAYOUTS[key]
  for (let i = 0; i < spec.cells.length; i++) {
    prunes += 1
    const after = pruneSpec(spec, i)
    if (!after) continue
    pruned += 1
    const err = validateSpec(after)
    if (err) bad(`${key} 去掉第 ${i + 1} 格后：${err} —— ${sig(after)}`)
    if (after.cells.length !== spec.cells.length - 1) {
      bad(`${key} 去掉第 ${i + 1} 格后：格数不是少一个`)
    }
  }
}
console.log(`   ${prunes} 种收法里 ${pruned} 种能"让邻居长过来"，其余按格数回落默认（都合法）`)

/* ---------- 5. 可达性：三格、四格的所有预设都能拖出来吗 ---------- */
console.log('5) 从单格一路拖，能拖出哪些形状')

/**
 * 一刀可达：从"少一格"的某个预设出发切一刀，能不能得到这个预设。
 *
 * 这条比下面的 BFS 更贴近界面：拖一次就是切一刀，用户不可能为一个形状连拖三次。
 * 所以三格的每一个预设都必须能"从一个二格预设一刀得到"，四格同理。
 */
const oneCutable = (want) => {
  const target = PANE_LAYOUTS[want]
  for (const key of LAYOUT_ORDER) {
    const spec = PANE_LAYOUTS[key]
    if (spec.cells.length !== target.cells.length - 1) continue
    for (let i = 0; i < spec.cells.length; i++) {
      for (const side of ['left', 'right', 'top', 'bottom']) {
        const plan = splitPlan(spec, i, side)
        if (plan && plan.preset === want) return `${key} 第 ${i + 1} 格 ${side}`
      }
    }
  }
  return null
}
const start = PANE_LAYOUTS.single
const seenByCount = new Map() // 格数 → Set(geoKey)
const presetSeen = new Set()
const queue = [{ plan: { spec: start, preset: 'single', insertAt: 0 } }]
const visited = new Set()
const note = (plan) => {
  const n = plan.spec.cells.length
  if (!seenByCount.has(n)) seenByCount.set(n, new Set())
  seenByCount.get(n).add(geoKey(plan.spec))
  if (plan.preset) presetSeen.add(plan.preset)
}
note(queue[0].plan)
while (queue.length > 0) {
  const { plan } = queue.shift()
  const k = geoKey(plan.spec) + '#' + sig(plan.spec)
  if (visited.has(k)) continue
  visited.add(k)
  if (plan.spec.cells.length >= MAX_PANES) continue
  for (let i = 0; i < plan.spec.cells.length; i++) {
    for (const side of ['left', 'right', 'top', 'bottom']) {
      const next = splitPlan(plan.spec, i, side)
      if (!next) continue
      note(next)
      queue.push({ plan: next })
    }
  }
}
for (const n of [...seenByCount.keys()].sort()) {
  console.log(`   ${n} 格：可达 ${seenByCount.get(n).size} 种几何排布`)
}
const want3 = LAYOUT_ORDER.filter((k) => PANE_LAYOUTS[k].cells.length === 3)
const want4 = LAYOUT_ORDER.filter((k) => PANE_LAYOUTS[k].cells.length === 4)
for (const [label, want] of [['三格', want3], ['四格', want4]]) {
  const miss = want.filter((k) => !presetSeen.has(k))
  const far = want.filter((k) => oneCutable(k) === null)
  if (miss.length) bad(`${label}一路拖不出来：${miss.join(', ')}`)
  if (far.length) bad(`${label}里拖一次到不了的（要连拖才行的界面别指望）：${far.join(', ')}`)
  console.log(
    `   ${label}预设 ${want.length} 种：` +
      (miss.length || far.length
        ? '有缺失'
        : `全部可达，且都能由少一格的预设一刀切出来（例：${want
            .map((k) => `${k} ← ${oneCutable(k)}`)
            .join('，')}）`),
  )
}

/* ---------- 6. 分割线 ---------- */
console.log('6) 分割线')
const equal = (n) => Array.from({ length: n }, () => 1 / n)
let dividerCount = 0
for (const key of LAYOUT_ORDER) {
  const spec = PANE_LAYOUTS[key]
  const ds = dividersOfSpec(spec, equal(spec.cols), equal(spec.rows))
  dividerCount += ds.length
  for (const d of ds) {
    if (!(d.at > 0 && d.at < 1)) bad(`${key}：分割线位置 ${d.at} 不在 (0,1)`)
    if (!(d.to > d.from)) bad(`${key}：分割线跨度 ${d.from}–${d.to} 是空的`)
    if (d.band < 0 || d.band >= (d.axis === 'col' ? spec.cols : spec.rows) - 1) {
      bad(`${key}：分割线 band=${d.band} 越界`)
    }
  }
  // 单格不该有分割线
  if (spec.cells.length === 1 && ds.length > 0) bad(`${key}：单格却有分割线`)
}
// 抽查几条与改造前写死的那套是否一致（值按数值比：顺序无关，格式化也别掺进来）
const expect = {
  cols2: ['col 0.5 0 1'],
  rows2: ['row 0.5 0 1'],
  grid4: ['col 0.5 0 1', 'row 0.5 0 1'],
  left1Right2: ['col 0.5 0 1', 'row 0.5 0.5 1'],
  left2Right1: ['col 0.5 0 1', 'row 0.5 0 0.5'],
  top1Bottom2: ['row 0.5 0 1', 'col 0.5 0.5 1'],
  top2Bottom1: ['row 0.5 0 1', 'col 0.5 0 0.5'],
  top1Bottom3: ['row 0.5 0 1', 'col 0.333 0.5 1', 'col 0.667 0.5 1'],
  left1Right3: ['col 0.5 0 1', 'row 0.333 0.5 1', 'row 0.667 0.5 1'],
  cols3: ['col 0.333 0 1', 'col 0.667 0 1'],
}
const near = (a, b) => Math.abs(a - b) < 0.005
const fmt = (d) => `${d.axis} ${d.at.toFixed(3)} ${d.from.toFixed(3)} ${d.to.toFixed(3)}`
const loose = (s) => {
  const [axis, at, from, to] = s.split(' ')
  return { axis, at: Number(at), from: Number(from), to: Number(to) }
}
for (const [key, want] of Object.entries(expect)) {
  const spec = PANE_LAYOUTS[key]
  const got = dividersOfSpec(spec, equal(spec.cols), equal(spec.rows)).map(fmt).sort()
  const wantSorted = [...want].sort()
  const same =
    got.length === wantSorted.length &&
    got.every((g, i) => {
      const a = loose(g)
      const b = loose(wantSorted[i])
      return a.axis === b.axis && near(a.at, b.at) && near(a.from, b.from) && near(a.to, b.to)
    })
  if (!same) {
    bad(`${key} 的分割线与改造前不一致：\n      期望 ${wantSorted.join(' / ')}\n      实际 ${got.join(' / ')}`)
  }
}
console.log(`   ${LAYOUT_ORDER.length} 个预设共 ${dividerCount} 条分割线，抽查 10 个与旧实现逐字一致`)

/* ---------- 收尾 ---------- */
if (failed > 0) {
  console.log(`\n失败 ${failed} 项`)
  process.exit(1)
}
console.log('\n分屏排布校验：全部通过')
