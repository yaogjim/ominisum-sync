/**
 * 把不可信的文章 HTML 安全地转成 Markdown（BRW-010）。零依赖、单遍扫描、纯函数。
 *
 * 安全约定（输入完全不可信）：
 *  - **永不输出原始 HTML**：文本里的 `<`、`>`、`&` 一律以实体输出；未知标签只丢标签保留文本；
 *  - `script/style/iframe/textarea/noscript/title` 连内容丢弃（按原始文本元素跳过），
 *    `object/embed/svg/template/math/head/canvas/audio/video/select` 连嵌套内容丢弃；
 *  - 只输出 `http(s)` 链接与图片；`javascript:`、`data:`、`vbscript:`、相对/协议相对地址只保留文本；
 *  - 事件属性、样式、`id/class`（语言名除外）一律不读取；
 *  - 线性时间：不对大输入做正则整体匹配；输入长度与嵌套深度有上限，超限截断并提示。
 */

export const DEFAULT_MAX_LENGTH = 2_000_000;
export const DEFAULT_MAX_DEPTH = 64;

const RAW_SKIP = new Set(['script', 'style', 'iframe', 'textarea', 'noscript', 'title', 'xmp']);
const NESTED_SKIP = new Set(['object', 'embed', 'svg', 'template', 'math', 'head', 'canvas', 'audio', 'video', 'select']);
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr', 'area', 'base', 'col', 'source', 'track', 'param', 'embed']);
const INLINE_FRAMES = new Set(['a', 'strong', 'em', 'code']);
const STRONG_TAGS = new Set(['b', 'strong']);
const EM_TAGS = new Set(['i', 'em', 'cite', 'dfn']);
const CODE_TAGS = new Set(['code', 'kbd', 'samp', 'tt']);
const WANTED_ATTRIBUTES = new Set(['href', 'src', 'alt', 'class']);
const ATTRIBUTE_LIMIT = 2000;

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,6});/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** 文本节点转义：先实体化 `&`，再处理 Markdown 特殊字符与尖括号。 */
function escapeText(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/[\\`*_[\]|~]/g, '\\$&')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function safeUrl(value) {
  const text = String(value ?? '').replace(CONTROL, '').trim();
  if (!/^https?:\/\//i.test(text) || text.length > 2000) return '';
  return text.replace(/[\s()<>"`\\]/g, (char) => (char === '(' ? '%28' : char === ')' ? '%29' : encodeURIComponent(char)));
}

function fence(text, info = '') {
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map((run) => run.length));
  const mark = '`'.repeat(Math.max(3, longest + 1));
  return `${mark}${info}\n${text}\n${mark}`;
}

const newFrame = (kind, extra = {}) => ({ kind, buf: [], blocks: [], items: [], ...extra });

function readAttributes(source, start, end) {
  const attrs = {};
  let i = start;
  while (i < end) {
    while (i < end && /[\s/]/.test(source[i])) i += 1;
    const nameStart = i;
    while (i < end && !/[\s=/>]/.test(source[i])) i += 1;
    const name = source.slice(nameStart, i).toLowerCase();
    while (i < end && /\s/.test(source[i])) i += 1;
    let value = '';
    if (source[i] === '=') {
      i += 1;
      while (i < end && /\s/.test(source[i])) i += 1;
      const quote = source[i];
      if (quote === '"' || quote === "'") {
        const close = source.indexOf(quote, i + 1);
        const stop = close === -1 || close > end ? end : close;
        value = source.slice(i + 1, stop);
        i = stop + 1;
      } else {
        const valueStart = i;
        while (i < end && !/[\s>]/.test(source[i])) i += 1;
        value = source.slice(valueStart, i);
      }
    }
    if (name && WANTED_ATTRIBUTES.has(name) && !(name in attrs)) attrs[name] = decodeEntities(value.slice(0, ATTRIBUTE_LIMIT));
  }
  return attrs;
}

/** 找到开始标签的 `>`（引号内的 `>` 不算）；找不到返回 -1。 */
function findTagEnd(source, from) {
  let quote = '';
  for (let i = from; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      // 只有紧跟在 `=` 之后的引号才开启引号区间，避免 `it's` 之类孤立引号吞掉后面的 `>`
      let k = i - 1;
      while (k >= from && /\s/.test(source[k])) k -= 1;
      if (source[k] === '=') quote = char;
    } else if (char === '>') {
      return i;
    }
  }
  return -1;
}

function codeLanguage(attrs) {
  for (const token of String(attrs.class || '').split(/\s+/)) {
    const match = /^(?:language|lang)-([\w+-]{1,20})$/.exec(token);
    if (match) return match[1];
  }
  return '';
}

function renderParagraphs(parts) {
  const raw = parts.join('').replace(/[ \t]*\n[ \t]*/g, '\n');
  const paragraphs = [];
  for (const chunk of raw.split(/\n{2,}/)) {
    const lines = chunk.split('\n').map((line) => line.replace(/ {2,}/g, ' ').trim()).filter(Boolean).map(escapeLineStart);
    if (lines.length) paragraphs.push(lines.join('  \n'));
  }
  return paragraphs;
}

/** 行首的 Markdown 语法字符（标题、列表、引用、分隔线、有序列表）加反斜杠。 */
function escapeLineStart(line) {
  return line.replace(/^([-+=#>])/, '\\$1').replace(/^(\d+)([.)])(?=\s|$)/, '$1\\$2');
}

function wrapInline(mark, inner) {
  const core = inner.trim();
  if (!core) return inner.length ? ' ' : '';
  const lead = inner.startsWith(' ') ? ' ' : '';
  const trail = inner.endsWith(' ') ? ' ' : '';
  return `${lead}${mark}${core}${mark}${trail}`;
}

/** 纯文本 → Markdown：按空行分段并转义所有语法字符（正文 HTML 为空时的回退）。 */
export function textToMarkdown(value, { maxLength = DEFAULT_MAX_LENGTH } = {}) {
  let source = typeof value === 'string' ? value : '';
  const truncated = source.length > maxLength;
  if (truncated) source = source.slice(0, maxLength);
  const cleaned = source.replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(/[\t\u00a0]+/g, ' ');
  const escaped = cleaned.split('\n').map((line) => escapeText(line)).join('\n');
  const markdown = renderParagraphs([escaped]).join('\n\n');
  return truncated ? `${markdown}${markdown ? '\n\n' : ''}_（原文过长，已截断）_` : markdown;
}

/**
 * @param {unknown} html
 * @param {{ maxLength?: number, maxDepth?: number, headingOffset?: number }} [options]
 * @returns {{ markdown: string, truncated: boolean }}
 */
export function htmlToMarkdown(html, { maxLength = DEFAULT_MAX_LENGTH, maxDepth = DEFAULT_MAX_DEPTH, headingOffset = 0 } = {}) {
  let source = typeof html === 'string' ? html : '';
  let truncated = false;
  if (source.length > maxLength) {
    source = source.slice(0, maxLength);
    truncated = true;
  }

  const root = newFrame('root');
  const stack = [root];
  const top = () => stack[stack.length - 1];

  const flushInline = (frame) => {
    if (!frame.buf.length) return;
    const parts = frame.buf;
    frame.buf = [];
    frame.blocks.push(...renderParagraphs(parts));
  };

  function finalize(frame) {
    const parent = stack[stack.length - 1];
    switch (frame.kind) {
      case 'a': {
        const inner = frame.buf.join('').replace(/\s+/g, ' ').trim();
        const url = safeUrl(frame.href);
        if (url && inner) parent.buf.push(`[${inner}](${url})`);
        else if (url) parent.buf.push(`[${escapeText(url.slice(0, 80))}](${url})`);
        else parent.buf.push(frame.buf.join(''));
        break;
      }
      case 'strong': parent.buf.push(wrapInline('**', frame.buf.join(''))); break;
      case 'em': parent.buf.push(wrapInline('*', frame.buf.join(''))); break;
      case 'code': {
        const text = frame.buf.join('').replace(/\s+/g, ' ').trim();
        if (!text) break;
        const mark = '`'.repeat(Math.max(0, ...(text.match(/`+/g) || []).map((run) => run.length)) + 1);
        parent.buf.push(text.startsWith('`') || text.endsWith('`') ? `${mark} ${text} ${mark}` : `${mark}${text}${mark}`);
        break;
      }
      case 'h': {
        const text = renderParagraphs([frame.buf.join('').replace(/\n+/g, ' ')]).join(' ');
        if (text) parent.blocks.push(`${'#'.repeat(Math.min(6, frame.level + headingOffset))} ${text.replace(/^\\([#>+=-])/, '$1')}`);
        break;
      }
      case 'pre': {
        const text = frame.buf.join('').replace(/^\n/, '').replace(/\s+$/, '');
        if (text.trim()) parent.blocks.push(fence(text, frame.lang || ''));
        break;
      }
      case 'blockquote': {
        flushInline(frame);
        const text = frame.blocks.join('\n\n');
        if (text) parent.blocks.push(text.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n'));
        break;
      }
      case 'li': {
        flushInline(frame);
        const text = frame.blocks.join('\n');
        if (text) parent.items.push(text);
        break;
      }
      case 'ul':
      case 'ol': {
        // 列表里的游离文本/块（非法嵌套或超过深度上限时 <li> 未建立）并入条目，避免内容丢失
        flushInline(frame);
        frame.items.push(...frame.blocks);
        const lines = frame.items.map((item, index) => {
          const marker = frame.kind === 'ol' ? `${index + 1}. ` : '- ';
          const pad = ' '.repeat(marker.length);
          return item.split('\n').map((line, n) => (n === 0 ? `${marker}${line}` : `${pad}${line}`)).join('\n');
        });
        if (lines.length) parent.blocks.push(lines.join('\n'));
        break;
      }
      default: break;
    }
  }

  function closeFrame() {
    const frame = stack.pop();
    finalize(frame);
  }

  const closeInlineFrames = () => {
    while (INLINE_FRAMES.has(top().kind)) closeFrame();
  };

  const blockBoundary = () => {
    closeInlineFrames();
    flushInline(top());
  };

  function pushFrame(frame) {
    if (stack.length >= maxDepth) return false;
    stack.push(frame);
    return true;
  }

  function closeKind(kind) {
    for (let index = stack.length - 1; index > 0; index -= 1) {
      if (stack[index].kind === kind) {
        while (stack.length > index) closeFrame();
        return true;
      }
    }
    return false;
  }

  function text(chunk) {
    const frame = top();
    if (frame.kind === 'pre' || frame.kind === 'code' && frame.raw) {
      frame.buf.push(decodeEntities(chunk).replace(/\r\n?/g, '\n').replace(CONTROL, ''));
      return;
    }
    const cleaned = decodeEntities(chunk).replace(CONTROL, '').replace(/[\s\u00a0]+/g, ' ');
    if (!cleaned) return;
    if ((frame.kind === 'ul' || frame.kind === 'ol')) {
      if (!cleaned.trim()) return;
      pushFrame(newFrame('li'));
    }
    top().buf.push(top().kind === 'code' ? cleaned : escapeText(cleaned));
  }

  function openTag(name, attrs, selfClosing) {
    const inPre = stack.some((frame) => frame.kind === 'pre');
    if (inPre) {
      if (name === 'br') top().buf.push('\n');
      else if (name === 'code' && !stack.find((frame) => frame.kind === 'pre').lang) stack.find((frame) => frame.kind === 'pre').lang = codeLanguage(attrs);
      else if (name === 'p' || name === 'div') top().buf.push('\n');
      return;
    }
    if (/^h[1-6]$/.test(name)) {
      blockBoundary();
      pushFrame(newFrame('h', { level: Number(name[1]) }));
    } else if (name === 'ul' || name === 'ol') {
      blockBoundary();
      pushFrame(newFrame(name));
    } else if (name === 'li') {
      blockBoundary();
      if (top().kind === 'li') closeFrame();
      if (top().kind !== 'ul' && top().kind !== 'ol') pushFrame(newFrame('ul'));
      pushFrame(newFrame('li'));
    } else if (name === 'blockquote') {
      blockBoundary();
      pushFrame(newFrame('blockquote'));
    } else if (name === 'pre') {
      blockBoundary();
      pushFrame(newFrame('pre', { lang: '' }));
    } else if (name === 'hr') {
      blockBoundary();
      top().blocks.push('---');
    } else if (name === 'br') {
      top().buf.push(top().kind === 'h' ? ' ' : '\n');
    } else if (name === 'img') {
      const url = safeUrl(attrs.src);
      const alt = decodeEntities(String(attrs.alt || '')).replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (url) top().buf.push(`![${escapeText(alt)}](${url})`);
      else if (alt) top().buf.push(escapeText(alt));
    } else if (name === 'a') {
      closeKind('a');
      pushFrame(newFrame('a', { href: attrs.href }));
    } else if (STRONG_TAGS.has(name)) {
      pushFrame(newFrame('strong'));
    } else if (EM_TAGS.has(name)) {
      pushFrame(newFrame('em'));
    } else if (CODE_TAGS.has(name)) {
      pushFrame(newFrame('code', { raw: true }));
    } else if (name === 'td' || name === 'th') {
      top().buf.push(' ');
    } else if (BLOCK_TRANSPARENT.has(name)) {
      blockBoundary();
    }
    if (selfClosing && !VOID.has(name)) closeTag(name);
  }

  function closeTag(name) {
    const preIndex = stack.findIndex((frame) => frame.kind === 'pre');
    if (preIndex !== -1) {
      if (name === 'pre') closeKind('pre');
      return;
    }
    if (/^h[1-6]$/.test(name)) { closeInlineFrames(); closeKind('h'); return; }
    if (name === 'ul' || name === 'ol' || name === 'li' || name === 'blockquote') {
      closeInlineFrames();
      closeKind(name);
      return;
    }
    if (name === 'a') closeKind('a');
    else if (STRONG_TAGS.has(name)) closeKind('strong');
    else if (EM_TAGS.has(name)) closeKind('em');
    else if (CODE_TAGS.has(name)) closeKind('code');
    else if (BLOCK_TRANSPARENT.has(name)) blockBoundary();
  }

  let skip = null; // { name, depth }
  const length = source.length;
  let i = 0;
  while (i < length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      if (!skip) text(source.slice(i));
      break;
    }
    if (lt > i && !skip) text(source.slice(i, lt));
    const next = source[lt + 1];

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end === -1 ? length : end + 3;
    } else if (next === '!' || next === '?') {
      const end = source.indexOf('>', lt + 2);
      i = end === -1 ? length : end + 1;
    } else if (next === '/') {
      const match = /^[A-Za-z][A-Za-z0-9:-]*/.exec(source.slice(lt + 2, lt + 40));
      if (!match) {
        if (!skip) text('<');
        i = lt + 1;
        continue;
      }
      const end = source.indexOf('>', lt + 2);
      i = end === -1 ? length : end + 1;
      const name = match[0].toLowerCase();
      if (skip) {
        if (name === skip.name) {
          skip.depth -= 1;
          if (skip.depth <= 0) skip = null;
        }
      } else {
        closeTag(name);
      }
    } else if (next && /[A-Za-z]/.test(next)) {
      const match = /^[A-Za-z][A-Za-z0-9:-]*/.exec(source.slice(lt + 1, lt + 40));
      const name = match[0].toLowerCase();
      const end = findTagEnd(source, lt + 1 + match[0].length);
      if (end === -1) {
        i = length; // 未终止的标签：丢弃剩余部分
        continue;
      }
      const selfClosing = source[end - 1] === '/';
      i = end + 1;
      if (skip) {
        if (name === skip.name && !selfClosing) skip.depth += 1;
        continue;
      }
      if (RAW_SKIP.has(name)) {
        if (selfClosing) continue;
        const closer = new RegExp(`</${name}[\\s/>]`, 'ig');
        closer.lastIndex = i;
        const found = closer.exec(source);
        if (!found) { i = length; continue; }
        const stop = source.indexOf('>', found.index);
        i = stop === -1 ? length : stop + 1;
        continue;
      }
      if (NESTED_SKIP.has(name)) {
        if (!selfClosing && !VOID.has(name)) skip = { name, depth: 1 };
        continue;
      }
      openTag(name, readAttributes(source, lt + 1 + match[0].length, end), selfClosing);
    } else {
      if (!skip) text('<');
      i = lt + 1;
    }
  }

  while (stack.length > 1) closeFrame();
  flushInline(root);
  let markdown = root.blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  if (truncated) markdown += `${markdown ? '\n\n' : ''}_（原文过长，已截断）_`;
  return { markdown, truncated };
}

const BLOCK_TRANSPARENT = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'figure', 'figcaption', 'nav', 'details', 'summary', 'address',
  'dl', 'dt', 'dd', 'tr', 'table', 'tbody', 'thead', 'tfoot', 'caption', 'fieldset', 'form', 'center', 'body', 'html',
]);
