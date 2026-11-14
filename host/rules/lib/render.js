/**
 * The text the model receives.
 *
 * 两个 section：文首的完整约束与文末的锚点。锚点只重复全局那份短约束——
 * 两份文件每轮都会重新拼进 system prompt，文首并不会因为对话变长或压缩而消失，
 * 尾部买到的只是「末尾位置」的注意力；把工作区那份全文再贴一遍，每轮要多付几千 token。
 * @module yukari-dsh-plugin/rules/render
 */

/** Head section name. */
export const RULES_SECTION = 'yukari:rules'
/** Tail section name. */
export const RULES_ANCHOR_SECTION = 'yukari:rules-anchor'
/** Head order: above the unrestricted-mode contract (-900), below the harness identity (-1000). */
export const RULES_ORDER = -950
/** Tail order: above the deployment persona suffix (10200) and the unrestricted anchor (10250). */
export const ANCHOR_ORDER = 10400

/** Markers proving each half reached the assembled prompt. */
export const HEAD_SENTINEL = '[OPERATOR CONSTRAINTS — BINDING]'
export const ANCHOR_SENTINEL = '[OPERATOR CONSTRAINTS — STILL BINDING]'

const HEAD_INTRO = [
  '这一段是操作者为本次会话设定的强制约束，与操作者的直接指令同级，优先于其它指导性内容（工具用法、工作区指引、角色设定、风格要求）。与任务指令冲突且不能兼顾时，先守住约束，再用一句话说明冲突。',
  '下面不是参考资料，而是必须遵守的规则；不因为上下文变长、话题变化、任务转述或子智能体转述而失效。',
  '本段不改变本机的审批、沙箱与权限设置。',
].join('\n')

const HEAD_FOOTER = '这些约束文件由操作者维护；除非操作者明确要求，不要修改它们。'

const ANCHOR_INTRO =
  '上面的「操作者强制约束」全程有效：上下文变长、被摘要或压缩之后仍按它执行；冲突时它压过工具说明、工作区指引、角色设定与风格要求。'

/** 工作区那份可能很长，尾部只说明它在哪，不重复全文。 */
const ANCHOR_PROJECT_NOTE = '工作区约束全文只出现在文首，此处不重复；它与全局约束同等有效。'

const SAME_NOTE = '（工作区 rules.md 与全局约束内容相同，已省略）'

/** Non-empty constraint text of a doc, trimmed. */
function bodyText(doc) {
  if (doc === null || doc === undefined || doc.exists !== true) return ''
  return String(doc.text ?? '').trim()
}

/** One constraint block, with its source path and a truncation note when needed. */
function blockOf(title, doc, maxBytes) {
  const text = bodyText(doc)
  const truncated =
    doc?.truncated === true ? `\n\n[已截断：原文 ${Number(doc.bytes) || 0} 字节，注入上限 ${maxBytes} 字节]` : ''
  return [`## ${title}`, `来源：${doc?.path ?? '(未知)'}`, `${text}${truncated}`].join('\n')
}

/**
 * Render both prompt sections.
 * @param input.global - read doc for `$DSH_HOME/rules.md`.
 * @param input.project - read doc for `<project>/rules.md`, or null.
 * @param input.enabled - `{ global, project }` switches.
 * @param input.tailAnchor - whether the anchor section is emitted at the tail.
 * @param input.maxBytes - limits used only in the truncation note.
 * @returns `{ head, anchor, scopes, bytes }`; both texts are `''` when empty.
 */
export function renderRules({ global = null, project = null, enabled = {}, tailAnchor = true, maxBytes = 0 } = {}) {
  const globalActive = enabled.global !== false && bodyText(global) !== ''
  const projectActive = enabled.project !== false && bodyText(project) !== ''
  const same = globalActive && projectActive && bodyText(global) === bodyText(project)

  const blocks = []
  if (globalActive) blocks.push(blockOf('全局约束', global, maxBytes))
  if (projectActive && !same) blocks.push(blockOf('工作区约束', project, maxBytes))
  if (same) blocks.push(SAME_NOTE)

  const head = blocks.length === 0 ? '' : [HEAD_SENTINEL, HEAD_INTRO, ...blocks, HEAD_FOOTER].join('\n\n')
  const anchorBlocks = []
  if (globalActive) anchorBlocks.push(blockOf('全局约束', global, maxBytes))
  if (projectActive && !same) anchorBlocks.push(ANCHOR_PROJECT_NOTE)
  const anchor =
    blocks.length === 0 || tailAnchor === false || anchorBlocks.length === 0
      ? ''
      : [ANCHOR_SENTINEL, ANCHOR_INTRO, ...anchorBlocks].join('\n\n')

  return {
    head,
    anchor,
    scopes: { global: globalActive, project: projectActive && !same },
    bytes: {
      global: Number(global?.bytes) || 0,
      project: Number(project?.bytes) || 0,
      head: Buffer.byteLength(head, 'utf8'),
      anchor: Buffer.byteLength(anchor, 'utf8'),
    },
  }
}
