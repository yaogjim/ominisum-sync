/**
 * 把本机生成的人读页面发布为 `browse` 分支（GIT-009），让 GitHub 网页可直接阅读。
 *
 * 设计要点（见 docs/features/github-user-data-sync/git-transport.md 4.3）：
 *  - 页面是 `_omnisum_sync/` 的派生内容，**不进 main**；分支是无父的孤儿历史，只保留一个提交；
 *  - 用临时目录 + 临时索引 + `write-tree`/`commit-tree` 构造提交，**不碰 clone 的工作区、索引、HEAD 与 main**；
 *  - 远端 browse 的 tree 与新 tree 相同则不推送；
 *  - 只允许对 `refs/heads/browse` 使用 `--force-with-lease`（带上次看到的 sha），他人抢先推送则失败并报告，不覆盖；
 *  - `main` 与受管数据仍然永不强推（见 git-sync.mjs）。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultGit, redact } from './git-sync.mjs';

export const BROWSE_BRANCH = 'browse';
const BROWSE_REF = `refs/heads/${BROWSE_BRANCH}`;
const REMOTE_TRACKING_PREFIX = 'refs/remotes';

/** 默认渲染：读取 clone 内的受管目录，返回 Map<相对路径, 文本>（缺协议文件等会抛错）。 */
export async function renderBrowseFiles(repoDir) {
  const { loadDataset, renderBrowse } = await import('../omnisum-browse/browse.mjs');
  const dataset = await loadDataset(repoDir);
  return { files: renderBrowse(dataset), issues: dataset.issues.length };
}

async function writeFiles(siteDir, files) {
  for (const [relative, text] of files) {
    const target = path.resolve(siteDir, relative);
    if (path.relative(siteDir, target).startsWith('..') || path.isAbsolute(path.relative(siteDir, target))) {
      throw new Error(`页面路径越界：${relative}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text);
  }
}

async function fetchRemoteBrowse(run, remote) {
  const tracking = `${REMOTE_TRACKING_PREFIX}/${remote}/${BROWSE_BRANCH}`;
  try {
    await run(['fetch', remote, `+${BROWSE_REF}:${tracking}`]);
  } catch (error) {
    if (/couldn't find remote ref/i.test(error.message)) return null;
    throw error;
  }
  return (await run(['rev-parse', '--verify', tracking])).trim();
}

/**
 * @param {{
 *   repoDir: string, remote?: string, hostname?: string, tmpRoot?: string,
 *   git?: (cwd: string, args: string[], options?: { env?: object }) => Promise<string>,
 *   render?: (repoDir: string) => Promise<{ files: Map<string, string>, issues?: number }>,
 *   hooks?: { beforePush?: () => Promise<void>|void },
 * }} options
 * @returns {Promise<{ published: boolean, reason?: string, created?: boolean, files?: number, issues?: number, commit?: string, error?: string }>}
 *   渲染失败（如缺少 protocol.json）抛错；推送被拒（租约失败等）返回 `{ published: false, error }`。
 */
export async function publishBrowseBranch({
  repoDir, remote = 'origin', hostname = '', tmpRoot = os.tmpdir(), git = defaultGit, render = renderBrowseFiles, hooks = {},
}) {
  const { files, issues = 0 } = await render(repoDir);
  if (!files.size) return { published: false, reason: 'empty' };

  const tmp = await fs.mkdtemp(path.join(tmpRoot, 'omnisum-browse-publish-'));
  try {
    const siteDir = path.join(tmp, 'site');
    await fs.mkdir(siteDir);
    await writeFiles(siteDir, files);

    const gitDir = (await git(repoDir, ['rev-parse', '--absolute-git-dir'])).trim();
    const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
    const inSite = (args) => git(siteDir, [`--git-dir=${gitDir}`, `--work-tree=${siteDir}`, ...args], { env });
    await inSite(['add', '-A', '-f']);
    const tree = (await inSite(['write-tree'])).trim();

    const run = (args) => git(repoDir, args);
    const remoteSha = await fetchRemoteBrowse(run, remote);
    if (remoteSha) {
      const remoteTree = (await run(['rev-parse', `${remoteSha}^{tree}`])).trim();
      if (remoteTree === tree) return { published: false, reason: 'unchanged', files: files.size, issues };
    }

    const suffix = hostname ? ` @${hostname}` : '';
    const commit = (await run(['commit-tree', tree, '-m', `omnisum browse: ${files.size} page(s)${suffix}`])).trim();
    await hooks.beforePush?.();
    try {
      // 租约只覆盖"我们刚 fetch 到的那一版"（不存在则要求远端也不存在）；refspec 只能是 browse 分支。
      await run(['push', `--force-with-lease=${BROWSE_REF}:${remoteSha || ''}`, remote, `${commit}:${BROWSE_REF}`]);
    } catch (error) {
      return { published: false, error: redact(error.message), files: files.size, issues };
    }
    return { published: true, created: !remoteSha, files: files.size, issues, commit };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
