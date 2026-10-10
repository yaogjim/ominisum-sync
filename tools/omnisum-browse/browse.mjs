/**
 * OmniSum 数据仓库浏览生成器（GUS-008 / S6）。
 *
 * 零依赖、只读：读取数据仓库 `_omnisum_sync/` 下的同步对象，校验后渲染成 Markdown 写入 `browse/`。
 * 不依赖扩展代码——校验所需的协议最小实现在本文件内自包含，漂移由
 * `tests/unit/omnisum-browse.test.js` 中的契约测试兜底（扩展侧生成的信封必须全部通过）。
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { htmlToMarkdown, textToMarkdown } from './html-to-markdown.mjs';

export const MANAGED_DIRECTORY = '_omnisum_sync';
export const PROTOCOL_FILE = 'protocol.json';
export const OUTPUT_MARKER = '.omnisum-browse';
export const PROTOCOL_NAME = 'omnisum-user-data-sync';
export const PROTOCOL_VERSION = 1;
const SCHEMA_VERSION = 1;
const MAX_OBJECT_BYTES = 10 * 1024 * 1024;
const MAX_ID_BYTES = 100;
const ENTITY_TYPES = ['session', 'session-content', 'message', 'favorite', 'knowledge-asset', 'composite-snapshot', 'tombstone'];
const TOMBSTONE_TARGETS = ['session', 'message', 'favorite', 'knowledge-asset', 'composite-snapshot'];

export class BrowseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BrowseError';
    this.code = code;
  }
}

// ── 协议最小实现（与 js/services/sync/UserDataSyncProtocol.js 保持一致） ─────────────

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) sorted[key] = sortValue(value[key]);
    }
    return sorted;
  }
  return value;
}

const canonicalize = (value) => JSON.stringify(sortValue(value));
const sha256Hex = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');
const payloadHashOf = (payload) => `sha256:${sha256Hex(canonicalize(payload))}`;
const revisionIdOf = (parents, payloadHash) => `sha256:${sha256Hex(canonicalize({ parents: [...new Set(parents)].sort(), payloadHash }))}`;

function encodeSegment(id) {
  const text = String(id ?? '');
  const bytes = Buffer.from(text, 'utf8');
  if (!text || bytes.length > MAX_ID_BYTES) throw new BrowseError('invalid_id', '对象 ID 无效。');
  return /^[a-z0-9_-]+$/.test(text) ? text : `~${bytes.toString('hex')}`;
}

function buildObjectPath(entityType, id, refs = {}) {
  switch (entityType) {
    case 'session': return `sessions/${encodeSegment(id)}/session.json`;
    case 'session-content': return `sessions/${encodeSegment(id)}/content.json`;
    case 'message':
      if (!refs.sessionId) throw new BrowseError('invalid_refs', '消息缺少 sessionId。');
      return `sessions/${encodeSegment(refs.sessionId)}/messages/${encodeSegment(id)}.json`;
    case 'favorite': return `favorites/${encodeSegment(id)}.json`;
    case 'knowledge-asset': return `knowledge-assets/${encodeSegment(id)}.json`;
    case 'composite-snapshot': return `composite-snapshots/${encodeSegment(id)}.json`;
    case 'tombstone':
      if (!TOMBSTONE_TARGETS.includes(refs.entityType)) throw new BrowseError('invalid_refs', '删除标记缺少合法的 entityType。');
      return `tombstones/${refs.entityType}/${encodeSegment(id)}.json`;
    default: throw new BrowseError('unknown_entity_type', `不支持的对象类型：${entityType}`);
  }
}

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** 解析并校验一个对象文件；失败抛 BrowseError。 */
function parseEnvelope(text, expectedPath) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new BrowseError('invalid_json', '不是有效 JSON。');
  }
  if (!isPlainObject(envelope)) throw new BrowseError('invalid_envelope', '对象格式无效。');
  if (envelope.schemaVersion !== SCHEMA_VERSION) throw new BrowseError('unsupported_schema', 'schemaVersion 不受支持。');
  if (!ENTITY_TYPES.includes(envelope.entityType)) throw new BrowseError('unknown_entity_type', '未知对象类型。');
  if (typeof envelope.id !== 'string' || !envelope.id) throw new BrowseError('invalid_envelope', '缺少 id。');
  const refs = isPlainObject(envelope.refs) ? envelope.refs : {};
  let expected;
  try {
    expected = buildObjectPath(envelope.entityType, envelope.id, refs);
  } catch {
    throw new BrowseError('path_mismatch', '对象身份与路径不一致。');
  }
  if (expected !== expectedPath) throw new BrowseError('path_mismatch', '对象身份与路径不一致。');
  if (!isPlainObject(envelope.payload)) throw new BrowseError('invalid_payload', 'payload 必须是对象。');
  if (!Array.isArray(envelope.parentRevisionIds)) throw new BrowseError('invalid_envelope', '缺少父修订。');
  if (payloadHashOf(envelope.payload) !== envelope.payloadHash) throw new BrowseError('hash_mismatch', '内容哈希校验失败。');
  if (revisionIdOf(envelope.parentRevisionIds, envelope.payloadHash) !== envelope.revisionId) {
    throw new BrowseError('revision_mismatch', '修订 ID 校验失败。');
  }
  return {
    path: expectedPath,
    entityType: envelope.entityType,
    id: envelope.id,
    refs,
    createdAt: Number(envelope.createdAt) || 0,
    updatedAt: Number(envelope.updatedAt) || 0,
    payloadHash: envelope.payloadHash,
    revisionId: envelope.revisionId,
    payload: envelope.payload,
  };
}

// ── 加载 ────────────────────────────────────────────────────────

const OBJECT_PATH_PATTERNS = [
  /^sessions\/[^/]+\/(?:session|content)\.json$/,
  /^sessions\/[^/]+\/messages\/[^/]+\.json$/,
  /^(?:favorites|knowledge-assets|composite-snapshots)\/[^/]+\.json$/,
  /^tombstones\/[^/]+\/[^/]+\.json$/,
];
const TOP_DIRECTORIES = ['sessions', 'favorites', 'knowledge-assets', 'composite-snapshots', 'tombstones'];

async function isRealDirectory(path) {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function* walkFiles(root, prefix) {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) yield* walkFiles(root, rel);
    else if (entry.isFile() && entry.name.endsWith('.json')) yield rel;
  }
}

async function readProtocol(managedRoot) {
  let file;
  try {
    file = JSON.parse(await readFile(join(managedRoot, PROTOCOL_FILE), 'utf8'));
  } catch {
    throw new BrowseError('invalid_protocol', `未找到有效的 ${MANAGED_DIRECTORY}/${PROTOCOL_FILE}。`);
  }
  if (!isPlainObject(file) || typeof file.datasetId !== 'string' || !file.datasetId) {
    throw new BrowseError('invalid_protocol', 'protocol.json 格式无效。');
  }
  if (file.protocol !== PROTOCOL_NAME || file.version !== PROTOCOL_VERSION) {
    throw new BrowseError('unsupported_protocol', `数据集协议不受支持（需要 ${PROTOCOL_NAME} v${PROTOCOL_VERSION}），请升级本工具。`);
  }
  return { datasetId: file.datasetId };
}

/**
 * 读取并校验数据仓库中的同步对象。
 * `deletedPaths`：被删除标记（含已删会话的子对象）隐藏的路径；`orphanPaths`：会话缺失/未通过校验而无法归属的正文与消息
 * （不能当作"已删除"）；`tombstoneKeys`：全部删除标记的 `<类型>:<id>`（插件同步删除时会同时移除远端对象文件，
 * 此时文件已不存在，只有标记可证明"确实被删除"）。三者供增量读取工具区分"确认删除"与"暂时读不到"。
 * @returns {Promise<{ protocol: { datasetId: string }, objects: Map<string, object>, issues: Array<{ path: string, code: string }>, hidden: number, deletedPaths: Set<string>, orphanPaths: Set<string>, tombstoneKeys: Set<string> }>}
 */
export async function loadDataset(repoDir) {
  const managedRoot = join(resolve(repoDir), MANAGED_DIRECTORY);
  if (!(await isRealDirectory(managedRoot))) {
    throw new BrowseError('invalid_protocol', `未找到 ${MANAGED_DIRECTORY}/ 目录。`);
  }
  const protocol = await readProtocol(managedRoot);
  const all = new Map();
  const issues = [];

  for (const top of TOP_DIRECTORIES) {
    if (!(await isRealDirectory(join(managedRoot, top)))) continue;
    for await (const rel of walkFiles(managedRoot, top)) {
      if (!OBJECT_PATH_PATTERNS.some((pattern) => pattern.test(rel))) continue;
      try {
        const info = await lstat(join(managedRoot, rel));
        if (info.size > MAX_OBJECT_BYTES) throw new BrowseError('object_too_large', '文件超过大小上限。');
        all.set(rel, parseEnvelope(await readFile(join(managedRoot, rel), 'utf8'), rel));
      } catch (error) {
        issues.push({ path: rel, code: error instanceof BrowseError ? error.code : 'read_failed' });
      }
    }
  }

  const { objects, hidden, deletedPaths, orphanPaths, tombstoneKeys } = applyTombstones(all);
  return { protocol, objects, issues, hidden, deletedPaths, orphanPaths, tombstoneKeys };
}

/** 删除标记按哈希隐藏对象；会话被隐藏时其正文与消息一并隐藏；没有会话的孤儿正文/消息不渲染。 */
function applyTombstones(all) {
  const tombstones = new Map();
  for (const object of all.values()) {
    if (object.entityType === 'tombstone') tombstones.set(`${object.refs.entityType}:${object.id}`, object);
  }
  const isDeleted = (object) => {
    const keyType = object.entityType === 'session-content' ? 'session' : object.entityType;
    const deleted = tombstones.get(`${keyType}:${object.id}`)?.payload?.deletedObjects;
    return !!deleted && deleted[object.path] === object.payloadHash;
  };

  const objects = new Map();
  const deletedPaths = new Set();
  const orphanPaths = new Set();
  let hidden = 0;
  const deletedSessions = new Set();
  for (const object of all.values()) {
    if (object.entityType === 'session' && isDeleted(object)) deletedSessions.add(object.id);
  }
  const liveSessions = new Set(
    [...all.values()].filter((o) => o.entityType === 'session' && !deletedSessions.has(o.id)).map((o) => o.id),
  );
  for (const object of all.values()) {
    if (object.entityType === 'tombstone') continue;
    const sessionId = object.entityType === 'session' || object.entityType === 'session-content'
      ? object.id : object.entityType === 'message' ? object.refs.sessionId : null;
    const orphan = sessionId !== null && !liveSessions.has(sessionId);
    if (orphan || isDeleted(object)) {
      hidden += 1;
      if (isDeleted(object) || deletedSessions.has(sessionId)) deletedPaths.add(object.path);
      else orphanPaths.add(object.path);
      continue;
    }
    objects.set(object.path, object);
  }
  return { objects, hidden, deletedPaths, orphanPaths, tombstoneKeys: new Set(tombstones.keys()) };
}

// ── 渲染安全 ────────────────────────────────────────────────────

/** 单行文本（标题、元信息）：压缩空白、截断，并转义 Markdown/HTML 特殊字符。 */
export function escapeInline(text, limit = 200) {
  let value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value.length > limit) value = `${value.slice(0, limit)}…`;
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]()#|~!]/g, '\\$&');
}

/** 围栏长度取内容中最长反引号连续串 + 1（至少 3）。 */
export function fenced(text, info = '') {
  const longest = Math.max(0, ...(String(text).match(/`+/g) || []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${String(text).replace(/\s+$/, '')}\n${fence}`;
}

const UNSAFE_LINK = /\]\(\s*(?:javascript|vbscript|data|file):/gi;
const UNSAFE_REFERENCE = /^(\s{0,3}\[[^\]]+\]:\s*)(?:javascript|vbscript|data|file):/i;
/** 只处理行内代码（成对反引号）之外的片段；代码内容按字面保留。 */
function mapOutsideCodeSpans(line, transform) {
  let result = '';
  let last = 0;
  for (const match of line.matchAll(/(`+)[^\n]*?\1(?!`)/g)) {
    result += transform(line.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return result + transform(line.slice(last));
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** 把 Markdown 正文嵌入页面：围栏代码内原样保留，其余部分转义原始 HTML 并中和危险链接协议；未闭合的围栏会被补齐。 */
export function sanitizeMarkdown(text, { keepCodeSpans = false } = {}) {
  const output = [];
  let open = null;
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const match = FENCE_OPEN.exec(line);
    if (open) {
      output.push(line);
      if (match && match[1][0] === open.char && match[1].length >= open.length && line.trim() === match[1]) open = null;
      continue;
    }
    if (match) {
      open = { char: match[1][0], length: match[1].length };
      output.push(line);
      continue;
    }
    const neutralize = (segment) => segment
      .replace(/<(?=[A-Za-z/!?])/g, '&lt;')
      .replace(UNSAFE_LINK, '](#blocked-scheme:')
      .replace(UNSAFE_REFERENCE, '$1#blocked-scheme:');
    output.push(keepCodeSpans ? mapOutsideCodeSpans(line, neutralize) : neutralize(line));
  }
  if (open) output.push(open.char.repeat(open.length));
  return output.join('\n');
}

function safeLink(label, url) {
  const text = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(text)) return text ? `\`${text.replace(/`/g, "'").slice(0, 300)}\`` : '';
  const target = text.replace(/[\s()<>]/g, (char) => encodeURIComponent(char).replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29')));
  return `[${escapeInline(label, 120)}](${target})`;
}

// ── 渲染 ────────────────────────────────────────────────────────

const isoDate = (ms) => (Number(ms) > 0 ? new Date(Number(ms)).toISOString().slice(0, 10) : 'unknown');
const isoTime = (ms) => (Number(ms) > 0 ? new Date(Number(ms)).toISOString().replace('T', ' ').slice(0, 19) : '未知时间');
const segmentOf = (object) => (object.path.startsWith('sessions/') ? object.path.split('/')[1] : object.path.split('/')[1].replace(/\.json$/, ''));
const pageOf = (object) => `${DIRECTORY_OF[object.entityType]}/${segmentOf(object)}.md`;
const DIRECTORY_OF = {
  session: 'sessions', favorite: 'favorites', 'knowledge-asset': 'knowledge-assets', 'composite-snapshot': 'composite-snapshots',
};
const TYPE_LABEL = {
  session: '文章', favorite: '收藏', 'knowledge-asset': '知识成果', 'composite-snapshot': '综合分析',
};
const SECTION_TITLE = {
  sessions: '文章', favorites: '收藏', 'knowledge-assets': '知识成果', 'composite-snapshots': '综合分析快照',
};

/** 相对链接：从 `fromPage` 所在目录指向 `toPage`。 */
function href(fromPage, toPage) {
  const from = fromPage.split('/').slice(0, -1);
  const to = toPage.split('/');
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common += 1;
  return [...Array(from.length - common).fill('..'), ...to.slice(common)].join('/');
}

function metaLines(payload, skip) {
  const lines = [];
  for (const [key, value] of Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))) {
    if (skip.has(key) || value === null || value === undefined || value === '') continue;
    let shown;
    if (['string', 'number', 'boolean'].includes(typeof value)) shown = value;
    else if (Array.isArray(value) && value.every((v) => ['string', 'number', 'boolean'].includes(typeof v))) shown = value.join(', ');
    else continue;
    lines.push(`- ${escapeInline(key, 60)}: ${escapeInline(shown)}`);
  }
  return lines;
}

/** 会话标题是网址式（无空格且含 `/` 或 `.`）或为空时，用 AI 分类标题替代，索引与页面标题更可读。 */
function displayTitle(object, raw) {
  if (object.entityType !== 'session') return raw;
  const better = typeof object.payload.classifyTitle === 'string' ? object.payload.classifyTitle.trim() : '';
  if (better && (!raw || (!/\s/.test(raw) && /[/.]/.test(raw)))) return better;
  return raw;
}

export function titleOf(object) {
  const p = object.payload;
  const raw = object.entityType === 'favorite' ? (p.pageTitle || p.question || '')
    : object.entityType === 'composite-snapshot' ? (p.page?.title || p.page?.name || '')
      : (p.title || '');
  return displayTitle(object, String(raw).trim()) || `${TYPE_LABEL[object.entityType]} ${object.id.slice(0, 40)}`;
}

// ── 单篇页（S6.1：BRW-009 ~ BRW-012） ─────────────────────────────

const SCORE_LABEL = {
  information_density: '信息密度', novelty: '新颖性', relevance: '相关性', actionability: '可操作性',
  methodology_value: '方法论价值', evidence_quality: '证据质量', transferability: '可迁移性', long_term_leverage: '长期杠杆',
};
/** 元信息表里的字段中文名；未列出的字段按原字段名展示。 */
const META_LABEL = {
  classifyAction: '建议操作', deepRead: '深度阅读', classifySourceType: '来源类型', shouldArchive: '建议归档', shouldDelete: '建议删除',
  deleteReason: '删除理由', byline: '作者署名', metaAuthor: '作者', published: '发布时间', siteName: '站点', sourceType: '会话类型',
  sourceUrls: '来源链接',
};
/** 元信息表隐藏：内部/运行态字段，以及已在标题、信息行、摘要卡片、分析要点中展示过的字段。 */
const META_HIDDEN = new Set([
  'title', 'url', 'domain', 'favicon', 'classifyTitle', 'rating', 'totalScore', 'primaryCategory', 'secondaryCategories', 'tags',
  'oneLineReview', 'summaryBrief', 'oneHighValuePoint', 'knowledgePoints', 'actionItems', 'retentionDecision', 'archiveReason', 'rejectReason',
  'classifiedAt', 'classifyPartial', 'classifyWarnings', 'classifyScores', 'contentRef', 'archiveChecksum', 'digestPrompt',
]);
const TAG_LIMIT = 12;
const TEXT_LIMIT = 2000;

const textOf = (value) => (typeof value === 'string' ? value.trim() : '');
const listOf = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : []);

/** 内容里的 `</details>`、`</summary>`（含围栏内）一律中和，保证用户内容无法闭合我们生成的折叠块。 */
const neutralizeStructuralTags = (text) => text.replace(/<\/(details|summary)/gi, '&lt;/$1');

function collapsible(summary, markdown) {
  return `<details>\n<summary>${summary}</summary>\n\n${markdown}\n\n</details>`;
}

/** 评级信息行：来源、创建日、评级、类别、标签。 */
function sessionFacts(session) {
  const p = session.payload;
  const lines = [];
  const first = [];
  if (p.url) first.push(`来源：${safeLink(p.domain || p.url, p.url)}`);
  first.push(`创建：${isoDate(session.createdAt)}`);
  lines.push(first.join(' · '));
  const second = [];
  if (textOf(p.rating)) second.push(`评级：**${escapeInline(p.rating, 10)}**${Number.isFinite(Number(p.totalScore)) && p.totalScore !== '' && p.totalScore !== null ? `（${Number(p.totalScore)} 分）` : ''}`);
  if (textOf(p.primaryCategory)) second.push(`类别：${escapeInline(p.primaryCategory, 60)}${listOf(p.secondaryCategories).length ? ` / ${listOf(p.secondaryCategories).map((c) => escapeInline(c, 40)).join(' / ')}` : ''}`);
  if (second.length) lines.push(second.join(' · '));
  const tags = listOf(p.tags).slice(0, TAG_LIMIT).map((tag) => `\`${tag.replace(/[`\s]+/g, ' ').trim().slice(0, 40)}\``);
  if (tags.length) lines.push(`标签：${tags.join(' ')}`);
  return lines.join('  \n');
}

function summaryCard(payload) {
  const rows = [['一句话点评', payload.oneLineReview], ['摘要', payload.summaryBrief]]
    .map(([label, value]) => [label, textOf(value)]).filter(([, value]) => value);
  if (!rows.length) return [];
  return [rows.map(([label, value]) => `> **${label}**：${escapeInline(value, TEXT_LIMIT)}`).join('\n>\n'), ''];
}

function analysisSection(payload) {
  const points = [];
  if (textOf(payload.oneHighValuePoint)) points.push(`- **核心高价值点**：${escapeInline(payload.oneHighValuePoint, TEXT_LIMIT)}`);
  if (textOf(payload.retentionDecision)) {
    const reason = textOf(payload.archiveReason);
    points.push(`- **留存建议**：${escapeInline(payload.retentionDecision, 400)}${reason ? `（${escapeInline(reason, TEXT_LIMIT)}）` : ''}`);
  } else if (textOf(payload.archiveReason)) {
    points.push(`- **留存理由**：${escapeInline(payload.archiveReason, TEXT_LIMIT)}`);
  }
  if (textOf(payload.rejectReason)) points.push(`- **不足**：${escapeInline(payload.rejectReason, TEXT_LIMIT)}`);
  const out = [];
  if (points.length) out.push(...points, '');
  for (const [label, items] of [['知识要点', listOf(payload.knowledgePoints)], ['行动项', listOf(payload.actionItems)]]) {
    if (items.length) out.push(`**${label}**`, '', ...items.map((item) => `- ${escapeInline(item, TEXT_LIMIT)}`), '');
  }
  return out.length ? ['## 分析要点', '', ...out] : [];
}

/** 正文：HTML 白名单转 Markdown；转换结果为空或失败时回退 pageContent 的转义分段文本。 */
function bodySection(content, withAnchor) {
  const out = [...(withAnchor ? ['<a id="tab-body"></a>', ''] : []), '## 正文', ''];
  const payload = content?.payload ?? {};
  let markdown = '';
  let note = '';
  try {
    markdown = guardRenderedBody(htmlToMarkdown(payload.contentHtml, { headingOffset: 2 }).markdown);
  } catch {
    note = '_（正文转换失败，已改用纯文本。）_';
  }
  if (!markdown.trim()) markdown = textToMarkdown(payload.pageContent);
  if (note) out.push(note, '');
  out.push(markdown.trim() ? markdown : '_（无正文）_', '');
  return out;
}

/** 转换结果的纵深防御：围栏代码与行内代码之外不允许出现标签起始或危险链接协议。 */
function guardRenderedBody(markdown) {
  return sanitizeMarkdown(markdown, { keepCodeSpans: true });
}

/** 提示词类消息（提示词模板全文、system、摘要提示词等）：作者的提示词不对外展示，一律不渲染。 */
function isPromptMessage(m) {
  return m.is_prompt === true || m.role === 'system' || textOf(m.prompt_type) !== '';
}

/** 提示词消息只用来给紧随其后的回答命名类别（如"解读"）；内容本身不输出。 */
function promptCategory(message) {
  const m = message.payload;
  const content = typeof m.content === 'string' ? m.content : '';
  const tag = /^\s*\[([^\]\n]{1,80})\]/.exec(content)?.[1]?.trim() ?? '';
  const named = textOf(m.prompt_template_name) || textOf(m.template_name);
  let name = named;
  if (/^Digest\s+Prompt/i.test(tag)) name = '摘要';
  else if (/^Prompt\s*:/i.test(tag)) name = tag.replace(/^Prompt\s*:\s*/i, '').trim() || named || '提示词';
  else if (tag) name = tag;
  return { name, classify: name === '自动分类评分' || tag === '自动分类评分' };
}

const PROMPT_PROBE_LENGTH = 30;
const PROMPT_MIN_LENGTH = 12;
const squashText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * 已知提示词匹配器：数据集里所有提示词消息与会话 `digestPrompt` 的前 30 个字符作为"指纹"。
 * 用户有时把同样的提示词直接粘贴到聊天框（没有 `is_prompt` 标记），这类消息按已知提示词处理，不显示。
 * 仅是启发式：从未保存为模板、也未出现在数据集里的手写提示词无法识别。
 */
function buildKnownPromptMatcher(objects) {
  const probes = new Set();
  const learn = (text) => {
    const normalized = squashText(String(text ?? '').replace(/^\s*\[[^\]\n]*\]\s*/, ''));
    if (normalized.length >= PROMPT_MIN_LENGTH) probes.add(normalized.slice(0, PROMPT_PROBE_LENGTH));
  };
  for (const object of objects) {
    if (object.entityType === 'message' && isPromptMessage(object.payload) && typeof object.payload.content === 'string') learn(object.payload.content);
    if (object.entityType === 'session') learn(object.payload.digestPrompt);
  }
  return (text) => {
    if (!probes.size || typeof text !== 'string') return false;
    const normalized = squashText(text);
    for (const probe of probes) if (normalized.includes(probe)) return true;
    return false;
  };
}

/** 把对话分成：按类别分栏的可读对话（回答、追问）与自动分类评分结果（折叠）。 */
function groupConversation(messages, isKnownPrompt = () => false) {
  const categories = new Map();
  const classification = [];
  const add = (name, entry) => {
    if (!categories.has(name)) categories.set(name, []);
    categories.get(name).push(entry);
  };
  let pending = null;
  let freeQuestion = false;
  for (const message of messages) {
    const m = message.payload;
    if (isPromptMessage(m)) {
      if (m.role !== 'system') pending = promptCategory(message);
      continue;
    }
    if (m.role === 'assistant') {
      if (m.type === 'classification' || pending?.classify) classification.push(message);
      else add(pending?.name || (freeQuestion ? '追问' : m.type === 'summary' ? '总结' : '追问'), { message, kind: 'answer' });
      pending = null;
      freeQuestion = false;
    } else if (isKnownPrompt(m.content)) {
      pending = { name: '追问', classify: false };
    } else {
      add('追问', { message, kind: 'question' });
      freeQuestion = true;
    }
  }
  return { categories: [...categories].map(([name, entries]) => ({ name, entries })), classification };
}

/** 对话正文：转义原始 HTML、中和折叠块结构标签、标题下移到小节标题之下。 */
function messageBody(message) {
  const m = message.payload;
  const body = typeof m.content === 'string' ? sanitizeMarkdown(m.content) : fenced(JSON.stringify(m.content ?? null, null, 2), 'json');
  return demoteHeadings(neutralizeStructuralTags(body), 3);
}

/** 围栏代码之外的 ATX 标题整体下移 `by` 级（最深 6 级）。 */
function demoteHeadings(text, by) {
  let open = null;
  return text.split('\n').map((line) => {
    const fence = FENCE_OPEN.exec(line);
    if (open) {
      if (fence && fence[1][0] === open.char && fence[1].length >= open.length && line.trim() === fence[1]) open = null;
      return line;
    }
    if (fence) {
      open = { char: fence[1][0], length: fence[1].length };
      return line;
    }
    return line.replace(/^( {0,3})(#{1,6})(?=\s|$)/, (_, space, hashes) => `${space}${'#'.repeat(Math.min(6, hashes.length + by))}`);
  }).join('\n');
}

const categoryTitle = ({ name, entries }) => {
  const answers = entries.filter((entry) => entry.kind === 'answer').length;
  return `${escapeInline(name, 40)}（${answers || entries.length}）`;
};

/** 顶部切换栏：GitHub 不执行脚本，用锚点链接在同一页内跳转到正文与各类别。 */
function tabBar(categories) {
  if (!categories.length) return [];
  const links = ['[正文](#tab-body)', ...categories.map((category, index) => `[${categoryTitle(category)}](#tab-${index + 1})`)];
  return [`**切换：** ${links.join(' · ')}`, ''];
}

function categorySections(categories) {
  const out = [];
  categories.forEach((category, index) => {
    out.push(`<a id="tab-${index + 1}"></a>`, '', `## ${categoryTitle(category)}`, '');
    for (const entry of category.entries) {
      const m = entry.message.payload;
      const time = isoTime(m.timestamp || entry.message.createdAt);
      let label = '';
      if (entry.kind === 'question') label = m.role === 'user' ? '提问' : escapeInline(m.role || '消息', 40);
      else if (category.name === '追问') label = '回答';
      out.push(`### ${label ? `${label} · ` : ''}${time}`, '', messageBody(entry.message), '');
    }
  });
  return out;
}

function classificationSection(messages) {
  const out = [];
  for (const message of messages) {
    const time = isoTime(message.payload.timestamp || message.createdAt);
    out.push(collapsible(`自动分类评分结果 · ${time}`, messageBody(message)), '');
  }
  return out;
}

function metaSection(session) {
  const p = session.payload;
  const rows = [['会话 ID', session.id], ['创建时间', `${isoTime(session.createdAt)} UTC`], ['更新时间', `${isoTime(session.updatedAt)} UTC`]];
  if (p.classifyScores && typeof p.classifyScores === 'object' && !Array.isArray(p.classifyScores)) {
    const scores = Object.entries(p.classifyScores).filter(([, value]) => Number.isFinite(Number(value)))
      .map(([key, value]) => `${SCORE_LABEL[key] ?? key} ${Number(value)}`);
    if (scores.length) rows.push(['评分维度', scores.join(' · ')]);
  }
  for (const [key, value] of Object.entries(p).sort(([a], [b]) => a.localeCompare(b))) {
    if (META_HIDDEN.has(key) || value === null || value === undefined || value === '') continue;
    let shown;
    if (typeof value === 'boolean') shown = value ? '是' : '否';
    else if (['string', 'number'].includes(typeof value)) shown = String(value);
    else if (Array.isArray(value) && value.length && value.every((v) => ['string', 'number'].includes(typeof v))) shown = value.join(', ');
    else continue;
    rows.push([META_LABEL[key] ?? key, shown]);
  }
  const table = ['| 字段 | 值 |', '|---|---|', ...rows.map(([key, value]) => `| ${escapeInline(key, 60)} | ${escapeInline(value, 200)} |`)];
  return [collapsible('元信息', table.join('\n')), ''];
}

function renderSession(session, content, messages, pagePath, linkedFavorites, isKnownPrompt) {
  const p = session.payload;
  const { categories, classification } = groupConversation(messages, isKnownPrompt);
  const out = [`# ${escapeInline(titleOf(session))}`, ''];
  out.push(`[← 返回总览](${href(pagePath, 'README.md')}) · [按日期浏览](${href(pagePath, 'by-date/index.md')})`, '');
  out.push(sessionFacts(session), '');
  out.push(...tabBar(categories));
  out.push(...summaryCard(p));
  out.push(...analysisSection(p));
  out.push(...bodySection(content, categories.length > 0));
  out.push(...categorySections(categories));
  out.push(...classificationSection(classification));
  if (linkedFavorites.length) {
    out.push('## 相关收藏', '');
    for (const favorite of linkedFavorites) out.push(`- [${escapeInline(titleOf(favorite))}](${href(pagePath, pageOf(favorite))})`);
    out.push('');
  }
  out.push(...metaSection(session));
  return out.join('\n');
}

function renderFavorite(favorite, sessions, pagePath) {
  const p = favorite.payload;
  const out = [`# ${escapeInline(titleOf(favorite))}`, '', `[← 返回总览](${href(pagePath, 'README.md')})`, ''];
  const facts = [`创建：${isoTime(favorite.createdAt)} UTC`];
  if (p.pageUrl) facts.unshift(`来源：${safeLink(p.pageTitle || p.pageUrl, p.pageUrl)}`);
  const session = p.sessionId ? sessions.get(p.sessionId) : null;
  if (session) facts.push(`所属文章：[${escapeInline(titleOf(session))}](${href(pagePath, pageOf(session))})`);
  out.push(facts.join(' · '), '');
  if (p.question) out.push('## 问题', '', sanitizeMarkdown(p.question), '');
  out.push('## 回答', '', sanitizeMarkdown(p.answer ?? ''), '');
  const meta = metaLines(p, new Set(['question', 'answer', 'pageTitle', 'pageUrl', 'pageContent', 'contentHtml', 'digestPrompt', 'sessionId']));
  if (meta.length) out.push('## 元信息', '', ...meta, '');
  return out.join('\n');
}

function renderAsset(asset, pagePath) {
  const p = asset.payload;
  const out = [`# ${escapeInline(titleOf(asset))}`, '', `[← 返回总览](${href(pagePath, 'README.md')})`, ''];
  out.push(`创建：${isoTime(asset.createdAt)} UTC · 更新：${isoTime(asset.updatedAt)} UTC`, '');
  const textFields = ['summary', 'content', 'markdown', 'body'].filter((key) => typeof p[key] === 'string' && p[key].trim());
  for (const key of textFields) out.push(`## ${escapeInline(key, 40)}`, '', sanitizeMarkdown(p[key]), '');
  const meta = metaLines(p, new Set(['title', ...textFields]));
  if (meta.length) out.push('## 元信息', '', ...meta, '');
  const rest = Object.fromEntries(Object.entries(p).filter(([key, value]) => !textFields.includes(key) && key !== 'title' && isPlainObject(value)));
  if (Object.keys(rest).length) out.push('## 结构化字段', '', fenced(JSON.stringify(rest, null, 2), 'json'), '');
  return out.join('\n');
}

function renderSnapshot(snapshot, pagePath) {
  const out = [`# ${escapeInline(titleOf(snapshot))}`, '', `[← 返回总览](${href(pagePath, 'README.md')})`, ''];
  out.push(`创建：${isoTime(snapshot.createdAt)} UTC · 来源：${escapeInline(snapshot.payload.source || 'unknown', 40)}`, '');
  out.push('## 页面快照', '', fenced(JSON.stringify(snapshot.payload.page ?? null, null, 2), 'json'), '');
  return out.join('\n');
}

function byDateDescThenTitle(a, b) {
  return (b.createdAt - a.createdAt) || titleOf(a).localeCompare(titleOf(b)) || a.id.localeCompare(b.id);
}

// ── 评级页与高频标签页（BRW-014） ─────────────────────────────

export const TAG_PAGE_MIN = 10;
const ratingOf = (object) => (object.entityType === 'session' ? textOf(object.payload.rating) : '');
const RATING_ORDER = ['S', 'A', 'B', 'C', 'D', 'E'];
const UNRATED = '未评级';

function sessionLine(session) {
  const score = Number(session.payload.totalScore);
  const parts = [`${isoDate(session.createdAt)} [${escapeInline(titleOf(session))}](../sessions/${segmentOf(session)}.md)`];
  if (Number.isFinite(score) && session.payload.totalScore !== '' && session.payload.totalScore !== null) parts.push(`${score} 分`);
  const category = textOf(session.payload.primaryCategory);
  if (category) parts.push(escapeInline(category, 40));
  return `- ${parts.join(' · ')}`;
}

/** 评级页与高频标签页；没有源数据则不生成。返回哪类页面已生成，供总览链接。 */
function addLookupPages(files, sessionList) {
  const byScoreThenDate = (a, b) => (Number(b.payload.totalScore) || 0) - (Number(a.payload.totalScore) || 0)
    || b.createdAt - a.createdAt || a.id.localeCompare(b.id);

  const ratingGroups = new Map();
  for (const session of sessionList) {
    const rating = ratingOf(session).toUpperCase();
    const key = RATING_ORDER.includes(rating) ? rating : UNRATED;
    if (!ratingGroups.has(key)) ratingGroups.set(key, []);
    ratingGroups.get(key).push(session);
  }
  const ratingKeys = [...RATING_ORDER, UNRATED].filter((key) => ratingGroups.has(key));
  const ratingFile = (key) => (key === UNRATED ? 'none' : key.toLowerCase());
  for (const key of ratingKeys) {
    const list = ratingGroups.get(key).sort(byScoreThenDate);
    files.set(`by-rating/${ratingFile(key)}.md`, `${[
      `# 评级：${key}（${list.length}）`, '', '[← 评级索引](index.md) · [总览](../README.md)', '',
      ...list.map((session) => sessionLine(session)),
    ].join('\n')}\n`);
  }
  if (ratingKeys.length) {
    files.set('by-rating/index.md', `${[
      '# 按评级浏览', '', '[← 总览](../README.md)', '',
      ...ratingKeys.map((key) => `- [${key}](${ratingFile(key)}.md)（${ratingGroups.get(key).length}）`),
    ].join('\n')}\n`);
  }

  const tagGroups = new Map();
  for (const session of sessionList) {
    for (const tag of new Set(listOf(session.payload.tags).map((t) => t.trim()).filter(Boolean))) {
      if (!tagGroups.has(tag)) tagGroups.set(tag, []);
      tagGroups.get(tag).push(session);
    }
  }
  const hotTags = [];
  for (const [tag, list] of tagGroups) {
    if (list.length < TAG_PAGE_MIN) continue;
    let segment;
    try { segment = encodeSegment(tag); } catch { continue; }
    hotTags.push({ tag, segment, list });
  }
  hotTags.sort((a, b) => b.list.length - a.list.length || a.tag.localeCompare(b.tag));
  for (const { tag, segment, list } of hotTags) {
    files.set(`by-tag/${segment}.md`, `${[
      `# 标签：${escapeInline(tag, 80)}（${list.length}）`, '', '[← 标签索引](index.md) · [总览](../README.md)', '',
      ...list.sort(byScoreThenDate).map((session) => sessionLine(session)),
    ].join('\n')}\n`);
  }
  if (hotTags.length) {
    files.set('by-tag/index.md', `${[
      `# 常用标签（出现 ≥${TAG_PAGE_MIN} 篇）`, '', '[← 总览](../README.md)', '',
      ...hotTags.map(({ tag, segment, list }) => `- [${escapeInline(tag, 80)}](${segment}.md)（${list.length}）`),
    ].join('\n')}\n`);
  }
  return { rating: ratingKeys.length > 0, tag: hotTags.length > 0 };
}

/**
 * 纯函数：把数据集渲染为 Map<浏览目录内的相对路径, 文本>。
 */
export function renderBrowse(dataset) {
  const files = new Map();
  const byType = (type) => [...dataset.objects.values()].filter((o) => o.entityType === type).sort(byDateDescThenTitle);
  const sessions = new Map(byType('session').map((o) => [o.id, o]));
  const contents = new Map(byType('session-content').map((o) => [o.id, o]));
  const messagesOf = new Map();
  for (const message of byType('message')) {
    if (!messagesOf.has(message.refs.sessionId)) messagesOf.set(message.refs.sessionId, []);
    messagesOf.get(message.refs.sessionId).push(message);
  }
  const isKnownPrompt = buildKnownPromptMatcher(dataset.objects.values());
  const favorites = byType('favorite');
  const assets = byType('knowledge-asset');
  const snapshots = byType('composite-snapshot');

  for (const list of messagesOf.values()) {
    list.sort((a, b) => ((a.payload.timestamp || a.createdAt) - (b.payload.timestamp || b.createdAt)) || a.id.localeCompare(b.id));
  }
  const favoritesOfSession = (sessionId) => favorites.filter((f) => f.payload.sessionId === sessionId);

  for (const session of sessions.values()) {
    const page = pageOf(session);
    files.set(page, renderSession(session, contents.get(session.id), messagesOf.get(session.id) || [], page, favoritesOfSession(session.id), isKnownPrompt));
  }
  for (const favorite of favorites) files.set(pageOf(favorite), renderFavorite(favorite, sessions, pageOf(favorite)));
  for (const asset of assets) files.set(pageOf(asset), renderAsset(asset, pageOf(asset)));
  for (const snapshot of snapshots) files.set(pageOf(snapshot), renderSnapshot(snapshot, pageOf(snapshot)));

  // 按日期：创建日 + 旧文章新增对话的日期（UTC）。
  const days = new Map();
  const day = (date) => {
    if (!days.has(date)) days.set(date, new Map());
    return days.get(date);
  };
  const touch = (date, object) => {
    const entries = day(date);
    if (!entries.has(object.path)) entries.set(object.path, { object, created: false, messages: 0 });
    return entries.get(object.path);
  };
  for (const object of [...sessions.values(), ...favorites, ...assets, ...snapshots]) touch(isoDate(object.createdAt), object).created = true;
  for (const [sessionId, list] of messagesOf) {
    for (const message of list) touch(isoDate(message.payload.timestamp || message.createdAt), sessions.get(sessionId)).messages += 1;
  }
  const sortedDays = [...days.keys()].sort().reverse();
  const entryLine = (page, { object, created, messages }, withNotes = true) => {
    const notes = withNotes ? [created ? '创建' : null, messages ? `新增对话 ${messages} 条` : null].filter(Boolean).join('，') : '';
    const rating = ratingOf(object);
    return `- ${TYPE_LABEL[object.entityType]}：[${escapeInline(titleOf(object))}](${href(page, pageOf(object))})${notes ? ` — ${notes}` : ''}${rating ? ` · 评级 ${escapeInline(rating, 10)}` : ''}`;
  };
  const sortedEntries = (date) => [...days.get(date).values()]
    .sort((a, b) => titleOf(a.object).localeCompare(titleOf(b.object)) || a.object.id.localeCompare(b.object.id));
  for (const date of sortedDays) {
    const page = `by-date/${date}.md`;
    const heading = date === 'unknown' ? '日期未知' : date;
    const lines = [`# ${heading}`, '', `[← 日期索引](index.md) · [总览](${href(page, 'README.md')})`, ''];
    for (const entry of sortedEntries(date)) lines.push(entryLine(page, entry));
    files.set(page, `${lines.join('\n')}\n`);
  }

  // 年 → 月 → 日：月页按天分段，索引按年、月给出数量
  const months = new Map();
  for (const date of sortedDays.filter((d) => d !== 'unknown')) {
    const month = date.slice(0, 7);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(date);
  }
  for (const [month, monthDays] of months) {
    const page = `by-date/${month}.md`;
    const lines = [`# ${month}`, '', `[← 日期索引](index.md) · [总览](${href(page, 'README.md')})`, ''];
    for (const date of monthDays) {
      lines.push(`## [${date}](${date}.md)（${days.get(date).size}）`, '');
      for (const entry of sortedEntries(date)) lines.push(entryLine(page, entry));
      lines.push('');
    }
    files.set(page, `${lines.join('\n').replace(/\n+$/, '')}\n`);
  }
  const indexLines = ['# 按日期浏览（UTC）', '', '[← 总览](../README.md)', ''];
  let currentYear = '';
  for (const [month, monthDays] of months) {
    if (month.slice(0, 4) !== currentYear) {
      currentYear = month.slice(0, 4);
      const yearItems = [...months].filter(([m]) => m.startsWith(currentYear)).reduce((sum, [, ds]) => sum + ds.reduce((n, d) => n + days.get(d).size, 0), 0);
      indexLines.push(`## ${currentYear}（${yearItems} 项）`, '');
    }
    indexLines.push(`- [${month}](${month}.md)（${monthDays.length} 天 · ${monthDays.reduce((n, d) => n + days.get(d).size, 0)} 项）`);
  }
  if (days.has('unknown')) indexLines.push('', `## 日期未知`, '', `- [日期未知](unknown.md)（${days.get('unknown').size} 项）`);
  if (!sortedDays.length) indexLines.push('_（暂无内容）_');
  files.set('by-date/index.md', `${indexLines.join('\n')}\n`);

  // 各类型索引（文章按"年-月"分组）
  const sections = [['sessions', [...sessions.values()]], ['favorites', favorites], ['knowledge-assets', assets], ['composite-snapshots', snapshots]];
  for (const [directory, list] of sections) {
    const page = `${directory}/index.md`;
    const lines = [`# ${SECTION_TITLE[directory]}（${list.length}）`, '', '[← 总览](../README.md)', ''];
    if (!list.length) lines.push('_（暂无内容）_');
    else if (directory === 'sessions') {
      let group = null;
      for (const object of list) {
        const month = isoDate(object.createdAt).slice(0, 7);
        if (month !== group) {
          group = month;
          const count = list.filter((o) => isoDate(o.createdAt).slice(0, 7) === month).length;
          lines.push('', `## ${month === 'unknown' ? '日期未知' : month}（${count}）`, '');
        }
        const rating = ratingOf(object);
        lines.push(`- ${isoDate(object.createdAt)} [${escapeInline(titleOf(object))}](${segmentOf(object)}.md)${rating ? ` · ${escapeInline(rating, 10)}` : ''}`);
      }
    } else {
      for (const o of list) lines.push(`- ${isoDate(o.createdAt)} [${escapeInline(titleOf(o))}](${segmentOf(o)}.md)`);
    }
    files.set(page, `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`);
  }

  const hasLookup = addLookupPages(files, [...sessions.values()]);

  const readme = [
    '# OmniSum 数据浏览', '',
    `数据集：\`${dataset.protocol.datasetId.replace(/[^\w.-]/g, '_').slice(0, 80)}\``, '',
    '本目录由 `tools/omnisum-browse` 从 `_omnisum_sync/` 生成，**只读派生产物**，请勿手工编辑；重新生成会覆盖。', '',
    '## 浏览', '',
    `- [按日期浏览](by-date/index.md)（${months.size} 个月 · ${sortedDays.length} 天）`,
    ...(hasLookup.rating ? ['- [按评级浏览](by-rating/index.md)'] : []),
    ...(hasLookup.tag ? [`- [按常用标签浏览](by-tag/index.md)（出现 ≥${TAG_PAGE_MIN} 篇的标签）`] : []),
    ...sections.map(([directory, list]) => `- [${SECTION_TITLE[directory]}](${directory}/index.md)（${list.length}）`),
    '',
    '## 如何查找', '',
    '- **页内查找**：在任意页面按 `Ctrl+F` / `Cmd+F`，对长索引页（文章、日期、评级、标签）最快。',
    '- **按时间**：[日期索引](by-date/index.md) 按年 → 月 → 日逐级进入。',
    ...(hasLookup.rating || hasLookup.tag ? [`- **按评级/标签**：${[hasLookup.rating ? '[评级页](by-rating/index.md)' : '', hasLookup.tag ? '[常用标签页](by-tag/index.md)' : ''].filter(Boolean).join('、')}。`] : []),
    '- **全文检索**：GitHub 的代码搜索可能不索引非默认分支（本分支），请在本地克隆后用 `grep -r 关键词 browse/` 或 `omnisum-agent` 工具检索原始数据。',
    '',
  ];
  const recent = [...sessions.values()].slice(0, 20);
  if (recent.length) {
    readme.push('## 最近文章', '');
    for (const s of recent) readme.push(`- ${isoDate(s.createdAt)} [${escapeInline(titleOf(s))}](${pageOf(s)})`);
    readme.push('');
  }
  if (dataset.hidden) readme.push(`已按删除标记隐藏 ${dataset.hidden} 个对象。`, '');
  if (dataset.issues.length) {
    readme.push('## 问题清单', '', '以下文件未通过校验，已跳过（不会渲染其内容）：', '');
    for (const issue of dataset.issues) readme.push(`- \`${issue.path.replace(/[`\s]/g, "'")}\` — \`${issue.code}\``);
    readme.push('');
  }
  files.set('README.md', `${readme.join('\n')}\n`);
  return files;
}

// ── 写出 ────────────────────────────────────────────────────────

/** 输出目录必须在仓库内，且不能是仓库根、受管目录或 `.git`。 */
export function resolveOutputDirectory(repoDir, outDir) {
  const repo = resolve(repoDir);
  const out = resolve(repo, outDir);
  const rel = relative(repo, out);
  const first = rel.split(sep)[0];
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || first === MANAGED_DIRECTORY || first === '.git') {
    throw new BrowseError('invalid_output', '输出目录必须位于仓库内，且不能是仓库根、受管目录或 .git。');
  }
  return out;
}

export async function prepareOutputDirectory(out, marker = OUTPUT_MARKER, generator = 'omnisum-browse') {
  let info = null;
  try {
    info = await lstat(out);
  } catch {
    // 不存在：稍后创建
  }
  if (info) {
    if (info.isSymbolicLink() || !info.isDirectory()) throw new BrowseError('invalid_output', '输出路径不是普通目录。');
    const entries = await readdir(out);
    if (entries.length && !entries.includes(marker)) {
      throw new BrowseError('output_not_managed', `输出目录非空且不是由本工具生成（缺少 ${marker}），已拒绝覆盖。`);
    }
    for (const entry of entries) {
      if (entry !== marker) await rm(join(out, entry), { recursive: true, force: true });
    }
  }
  await mkdir(out, { recursive: true });
  await writeFile(join(out, marker), `Generated by ${generator}. Safe to delete or regenerate.\n`);
}

/**
 * 生成浏览目录。协议/输出目录校验失败时抛错且不写任何文件。
 * @returns {Promise<{ outDir: string, files: number, issues: Array<{ path: string, code: string }>, counts: object }>}
 */
export async function generateBrowse({ repoDir = process.cwd(), outDir = 'browse' } = {}) {
  const out = resolveOutputDirectory(repoDir, outDir);
  const dataset = await loadDataset(repoDir);
  const files = renderBrowse(dataset);
  await prepareOutputDirectory(out);
  for (const [path, text] of files) {
    const target = join(out, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  const count = (type) => [...dataset.objects.values()].filter((o) => o.entityType === type).length;
  return {
    outDir: out,
    files: files.size,
    issues: dataset.issues,
    counts: {
      sessions: count('session'), messages: count('message'), favorites: count('favorite'),
      knowledgeAssets: count('knowledge-asset'), compositeSnapshots: count('composite-snapshot'), hidden: dataset.hidden,
    },
  };
}
