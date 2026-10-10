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
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** 把 Markdown 正文嵌入页面：围栏代码内原样保留，其余部分转义原始 HTML 并中和危险链接协议；未闭合的围栏会被补齐。 */
export function sanitizeMarkdown(text) {
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
    output.push(line
      .replace(/<(?=[A-Za-z/!?])/g, '&lt;')
      .replace(UNSAFE_LINK, '](#blocked-scheme:')
      .replace(UNSAFE_REFERENCE, '$1#blocked-scheme:'));
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

export function titleOf(object) {
  const p = object.payload;
  const raw = object.entityType === 'favorite' ? (p.pageTitle || p.question || '')
    : object.entityType === 'composite-snapshot' ? (p.page?.title || p.page?.name || '')
      : (p.title || '');
  return String(raw).trim() || `${TYPE_LABEL[object.entityType]} ${object.id.slice(0, 40)}`;
}

function renderSession(session, content, messages, pagePath, linkedFavorites) {
  const p = session.payload;
  const out = [`# ${escapeInline(titleOf(session))}`, ''];
  out.push(`[← 返回总览](${href(pagePath, 'README.md')}) · [按日期浏览](${href(pagePath, 'by-date/index.md')})`, '');
  const facts = [`创建：${isoTime(session.createdAt)} UTC`, `更新：${isoTime(session.updatedAt)} UTC`];
  if (p.url) facts.unshift(`来源：${safeLink(p.domain || p.url, p.url)}`);
  out.push(facts.join(' · '), '');
  const meta = metaLines(p, new Set(['title', 'url', 'domain', 'favicon']));
  if (meta.length) out.push('## 元信息', '', ...meta, '');
  const body = content?.payload.pageContent?.trim() ? content.payload.pageContent : content?.payload.contentHtml;
  out.push('## 正文', '', body?.trim() ? fenced(body, 'text') : '_（无正文）_', '');
  out.push(`## 对话（${messages.length}）`, '');
  if (!messages.length) out.push('_（暂无对话）_', '');
  for (const message of messages) {
    const m = message.payload;
    out.push(`### ${escapeInline(m.role || 'message', 40)} · ${isoTime(m.timestamp || message.createdAt)} UTC`, '');
    if (typeof m.content === 'string') out.push(sanitizeMarkdown(m.content), '');
    else out.push(fenced(JSON.stringify(m.content ?? null, null, 2), 'json'), '');
  }
  if (linkedFavorites.length) {
    out.push('## 相关收藏', '');
    for (const favorite of linkedFavorites) out.push(`- [${escapeInline(titleOf(favorite))}](${href(pagePath, pageOf(favorite))})`);
    out.push('');
  }
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
  const favorites = byType('favorite');
  const assets = byType('knowledge-asset');
  const snapshots = byType('composite-snapshot');

  for (const list of messagesOf.values()) {
    list.sort((a, b) => ((a.payload.timestamp || a.createdAt) - (b.payload.timestamp || b.createdAt)) || a.id.localeCompare(b.id));
  }
  const favoritesOfSession = (sessionId) => favorites.filter((f) => f.payload.sessionId === sessionId);

  for (const session of sessions.values()) {
    const page = pageOf(session);
    files.set(page, renderSession(session, contents.get(session.id), messagesOf.get(session.id) || [], page, favoritesOfSession(session.id)));
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
  for (const date of sortedDays) {
    const page = `by-date/${date}.md`;
    const heading = date === 'unknown' ? '日期未知' : date;
    const lines = [`# ${heading}`, '', `[← 日期索引](index.md) · [总览](${href(page, 'README.md')})`, ''];
    const entries = [...days.get(date).values()].sort((a, b) => titleOf(a.object).localeCompare(titleOf(b.object)) || a.object.id.localeCompare(b.object.id));
    for (const { object, created, messages } of entries) {
      const notes = [created ? '创建' : null, messages ? `新增对话 ${messages} 条` : null].filter(Boolean).join('，');
      lines.push(`- ${TYPE_LABEL[object.entityType]}：[${escapeInline(titleOf(object))}](${href(page, pageOf(object))})${notes ? ` — ${notes}` : ''}`);
    }
    files.set(page, `${lines.join('\n')}\n`);
  }
  files.set('by-date/index.md', `${[
    '# 按日期浏览（UTC）', '', '[← 总览](../README.md)', '',
    ...(sortedDays.length ? sortedDays.map((date) => `- [${date === 'unknown' ? '日期未知' : date}](${date}.md)（${days.get(date).size}）`) : ['_（暂无内容）_']),
  ].join('\n')}\n`);

  // 各类型索引
  const sections = [['sessions', [...sessions.values()]], ['favorites', favorites], ['knowledge-assets', assets], ['composite-snapshots', snapshots]];
  for (const [directory, list] of sections) {
    const page = `${directory}/index.md`;
    files.set(page, `${[
      `# ${SECTION_TITLE[directory]}（${list.length}）`, '', '[← 总览](../README.md)', '',
      ...(list.length ? list.map((o) => `- ${isoDate(o.createdAt)} [${escapeInline(titleOf(o))}](${segmentOf(o)}.md)`) : ['_（暂无内容）_']),
    ].join('\n')}\n`);
  }

  const readme = [
    '# OmniSum 数据浏览', '',
    `数据集：\`${dataset.protocol.datasetId.replace(/[^\w.-]/g, '_').slice(0, 80)}\``, '',
    '本目录由 `tools/omnisum-browse` 从 `_omnisum_sync/` 生成，**只读派生产物**，请勿手工编辑；重新生成会覆盖。', '',
    '## 浏览', '',
    `- [按日期浏览](by-date/index.md)（${sortedDays.length} 天）`,
    ...sections.map(([directory, list]) => `- [${SECTION_TITLE[directory]}](${directory}/index.md)（${list.length}）`),
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
