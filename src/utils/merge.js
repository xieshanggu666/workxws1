// 三路合并工具（diff3）
// base：双方编辑前的共同版本；ours：本地未提交修改；theirs：远端（其他窗口）已保存的最新版本
// 互不重叠的修改自动合并；双方改动同一区域时产出结构化冲突，由调用方让用户逐处选择，内容绝不丢失。

const FIELD_LABELS = { title: '标题', body: '正文', categoryId: '分类', visibility: '可见性', tagIds: '标签' }

// ---- 分词 ----
// 正文是富文本 HTML：标签整体作为一个 token，中文按字、英文按词，保证合并粒度足够细且不会拆坏标签
const RE_HTML_FINE = /<[^>]*(>|$)|&[#a-zA-Z0-9]+;|[一-龥]|[A-Za-z0-9_]+|\s+|[^\s<>&]/g
// 内嵌 base64 图片等超长文档时退化为粗粒度（标签 / 文本节点），避免 LCS 矩阵过大
const RE_HTML_COARSE = /<[^>]*(>|$)|[^<]+/g
const RE_TEXT = /[一-龥]|[A-Za-z0-9_]+|\s+|[^\s\w]/g
const FINE_TOKEN_LIMIT = 3000

function tokenize(text, mode) {
  const s = text == null ? '' : String(text)
  if (mode === 'html') {
    const fine = s.match(RE_HTML_FINE) || []
    if (fine.length <= FINE_TOKEN_LIMIT) return fine
    return s.match(RE_HTML_COARSE) || []
  }
  return s.match(RE_TEXT) || []
}

// ---- LCS 差异脚本：base -> target 的 keep/del/ins 操作序列 ----
function diffScript(base, target) {
  const n = base.length
  const m = target.length
  const w = m + 1
  const dp = new Uint16Array((n + 1) * w)
  for (let i = 1; i <= n; i++) {
    const row = i * w
    const prev = (i - 1) * w
    for (let j = 1; j <= m; j++) {
      dp[row + j] =
        base[i - 1] === target[j - 1]
          ? dp[prev + j - 1] + 1
          : Math.max(dp[prev + j], dp[row + j - 1])
    }
  }
  const ops = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && base[i - 1] === target[j - 1]) {
      ops.push({ op: 'keep', token: base[i - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[(i - 1) * w + j] < dp[i * w + j - 1])) {
      ops.push({ op: 'ins', token: target[j - 1] })
      j--
    } else {
      ops.push({ op: 'del', token: base[i - 1] })
      i--
    }
  }
  ops.reverse()
  return ops
}

// 以 base 下标为锚点整理一方的修改：kept[k] 表示保留的 base token，insBefore[k] 为插在 k 之前的 token
function sideModel(base, ops) {
  const insBefore = Array.from({ length: base.length + 1 }, () => [])
  const kept = new Array(base.length).fill(null)
  let bi = 0
  for (const o of ops) {
    if (o.op === 'ins') insBefore[bi].push(o.token)
    else {
      if (o.op === 'keep') kept[bi] = o.token
      bi++
    }
  }
  return { insBefore, kept }
}

function arrEq(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// 文本三路合并，返回分段（普通文本段 / 冲突段）与冲突清单
export function threeWayText(baseStr, oursStr, theirsStr, mode, makeConflict) {
  const base = tokenize(baseStr, mode)
  const ours = tokenize(oursStr, mode)
  const theirs = tokenize(theirsStr, mode)
  const mo = sideModel(base, diffScript(base, ours))
  const mt = sideModel(base, diffScript(base, theirs))

  const synced = new Uint8Array(base.length)
  for (let k = 0; k < base.length; k++) {
    synced[k] = mo.kept[k] !== null && mt.kept[k] !== null
  }

  const segments = []
  const conflicts = []
  let conflictIndex = 0
  const pushText = (tokens) => {
    if (!tokens.length) return
    const v = tokens.join('')
    const last = segments[segments.length - 1]
    if (last && last.t === 'text') last.v += v
    else segments.push({ t: 'text', v })
  }
  const pushConflict = (bTokens, oTokens, tTokens) => {
    const id = makeConflict({
      kind: 'text',
      index: ++conflictIndex,
      base: bTokens.join(''),
      ours: oTokens.join(''),
      theirs: tTokens.join('')
    })
    segments.push({ t: 'cf', id, ours: oTokens.join(''), theirs: tTokens.join('') })
    conflicts.push(id)
  }
  // 同一点位（base 下标 pos 之前）双方插入内容的归并
  const mergeBoundary = (pos, consumed) => {
    if (consumed) return
    const o = mo.insBefore[pos]
    const t = mt.insBefore[pos]
    if (!o.length && !t.length) return
    if (arrEq(o, t)) pushText(o)
    else if (!o.length) pushText(t)
    else if (!t.length) pushText(o)
    else pushConflict([], o, t)
  }
  const renderRegion = (model, b0, b1) => {
    const out = []
    for (const tk of model.insBefore[b0]) out.push(tk)
    for (let k = b0; k < b1; k++) if (model.kept[k] !== null) out.push(model.kept[k])
    for (const tk of model.insBefore[b1]) out.push(tk)
    return out
  }

  let i = 0
  let boundaryConsumedAt = -1
  while (i <= base.length) {
    if (i === base.length) {
      mergeBoundary(i, boundaryConsumedAt === i)
      break
    }
    if (synced[i]) {
      mergeBoundary(i, boundaryConsumedAt === i)
      pushText([base[i]])
      i++
      continue
    }
    let j = i + 1
    while (j < base.length && !synced[j]) j++
    const br = base.slice(i, j)
    const orr = renderRegion(mo, i, j)
    const trr = renderRegion(mt, i, j)
    if (arrEq(orr, br)) pushText(trr)
    else if (arrEq(trr, br)) pushText(orr)
    else if (arrEq(orr, trr)) pushText(orr)
    else pushConflict(br, orr, trr)
    boundaryConsumedAt = j // 区域渲染已包含 j 点位的插入，跳过避免重复
    i = j
  }

  return { segments, conflicts, value: segments.map((s) => (s.t === 'text' ? s.v : '')).join('') }
}

export function resolveSegments(segments, choices) {
  return segments
    .map((s) => {
      if (s.t === 'text') return s.v
      return choices[s.id] === 'theirs' ? s.theirs : s.ours
    })
    .join('')
}

// 标签的三路集合合并：双方各自新增保留，双方共同删除才移除，单方删除另一方保留时保守保留
function mergeTags(base, ours, theirs) {
  const out = new Set(base)
  ours.forEach((x) => out.add(x))
  theirs.forEach((x) => out.add(x))
  for (const x of base) {
    if (!ours.includes(x) && !theirs.includes(x)) out.delete(x)
  }
  return [...out]
}

function looseEqual(a, b) {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return arrEq([...a], [...b])
  if (a == null && b == null) return true
  return false
}

const MERGE_FIELDS = ['title', 'body', 'categoryId', 'visibility', 'tagIds']

// 按 patch（仅包含用户实际提交的字段）做三路合并
// 返回 { fields: 无冲突字段的最终值, segmentsMap: 文本字段分段（含冲突）, conflicts: 冲突清单 }
export function mergeDocPatch(base, remote, patch) {
  const fields = {}
  const segmentsMap = {}
  const conflicts = []
  let seq = 0

  const makeConflict = (part) => {
    const id = 'cf-' + ++seq
    conflicts.push({ id, label: FIELD_LABELS[part.field] || part.field, ...part })
    return id
  }

  for (const field of MERGE_FIELDS) {
    if (!(field in patch)) continue
    const b = base[field]
    const o = patch[field]
    const t = remote[field]
    // 我方未改：采用远端；远端未改：采用我方；双方改成相同结果：直接采用
    if (looseEqual(o, b)) {
      fields[field] = Array.isArray(t) ? [...t] : t
      continue
    }
    if (looseEqual(t, b)) {
      fields[field] = Array.isArray(o) ? [...o] : o
      continue
    }
    if (looseEqual(o, t)) {
      fields[field] = Array.isArray(o) ? [...o] : o
      continue
    }
    if (field === 'title' || field === 'body') {
      const r = threeWayText(
        b == null ? '' : b,
        o == null ? '' : o,
        t == null ? '' : t,
        field === 'body' ? 'html' : 'text',
        (part) => makeConflict({ field, ...part })
      )
      if (!r.conflicts.length) fields[field] = r.value
      else segmentsMap[field] = r.segments
    } else if (field === 'tagIds') {
      fields[field] = mergeTags(b || [], o || [], t || [])
    } else {
      makeConflict({ field, kind: 'scalar', base: b, ours: o, theirs: t })
    }
  }

  return { fields, segmentsMap, conflicts }
}

// 根据用户对每处冲突的选择（id -> 'ours' | 'theirs'）生成最终补丁
export function resolveMerge(merge, choices = {}) {
  const out = { ...merge.fields }
  for (const field of Object.keys(merge.segmentsMap)) {
    out[field] = resolveSegments(merge.segmentsMap[field], choices)
  }
  for (const c of merge.conflicts) {
    if (c.kind === 'scalar') out[c.field] = choices[c.id] === 'theirs' ? c.theirs : c.ours
  }
  return out
}
