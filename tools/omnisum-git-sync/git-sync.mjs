/**
 * OmniSum clone 目录同步脚本（G2）：对 `ominisum-sync` 的本地 clone 做 提交 → 拉取 → 合并 → 推送。
 *
 * 浏览器插件（MV3）不能运行 git，只负责读写 clone 目录里的 `_omnisum_sync/`；
 * 本脚本负责把这些改动与远端（GitHub）互通，因此同步不消耗 GitHub REST API 配额。
 *
 * 合并约定（与插件的谱系规则配套，见 docs/features/github-user-data-sync/git-transport.md）：
 *  - `_omnisum_sync/**` 以"整文件"为单位合并（`merge=binary`），绝不做行级混合——混合后的信封会哈希不符；
 *  - 双方都改了同一文件：取远端版本（theirs），本机版本由插件下一轮同步检测为内容冲突，不会静默丢失；
 *  - 一方删除、另一方修改：保留修改（绝不丢编辑）；
 *  - 受管目录之外的冲突：中止合并并报错，交给人工；
 *  - 永不 `--force`；推送被拒绝（远端又前进）则重新拉取合并，有限次数重试。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const MANAGED_PATH = '_omnisum_sync';
export const DEFAULT_MAX_PUSH_ATTEMPTS = 5;
const ATTRIBUTE_LINE = `${MANAGED_PATH}/** merge=binary`;
const STALE_LOCK_MS = 15 * 60 * 1000;

export class GitSyncError extends Error {
  constructor(code, message, { exitCode = 1, detail = null } = {}) {
    super(message);
    this.name = 'GitSyncError';
    this.code = code;
    this.exitCode = exitCode;
    this.detail = detail;
  }
}

/** 把形如 `https://user:token@host/...` 的凭据从输出中抹去。 */
export function redact(text) {
  return String(text || '').replace(/(https?:\/\/)[^\s/@]+@/g, '$1***@');
}

async function defaultGit(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return stdout;
  } catch (error) {
    const wrapped = new Error(redact(error.stderr || error.message));
    wrapped.code = error.code;
    wrapped.stderr = redact(error.stderr || '');
    throw wrapped;
  }
}

const exists = async (target) => fs.access(target).then(() => true, () => false);

async function acquireLock(gitDir, now) {
  const lockDir = path.join(gitDir, 'omnisum-sync.lock');
  try {
    await fs.mkdir(lockDir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = await fs.stat(lockDir);
    if (now() - stat.mtimeMs < STALE_LOCK_MS) {
      throw new GitSyncError('already_running', '另一个同步进程正在运行。', { exitCode: 2 });
    }
    await fs.rm(lockDir, { recursive: true, force: true });
    await fs.mkdir(lockDir);
  }
  return () => fs.rm(lockDir, { recursive: true, force: true });
}

/** 让 git 在本仓库内对受管目录使用"整文件"合并（不改动已提交的 .gitattributes）。 */
async function ensureMergeAttributes(gitDir) {
  const file = path.join(gitDir, 'info', 'attributes');
  const current = (await fs.readFile(file, 'utf8').catch(() => ''));
  if (current.split('\n').includes(ATTRIBUTE_LINE)) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${ATTRIBUTE_LINE}\n`);
}

async function busyReason(gitDir) {
  for (const [name, reason] of [
    ['MERGE_HEAD', 'merge_in_progress'], ['rebase-merge', 'rebase_in_progress'],
    ['rebase-apply', 'rebase_in_progress'], ['index.lock', 'git_locked'],
  ]) {
    if (await exists(path.join(gitDir, name))) return reason;
  }
  return null;
}

/**
 * @param {{
 *   repoDir: string, remote?: string, branch?: string|null, maxPushAttempts?: number,
 *   git?: (cwd: string, args: string[]) => Promise<string>, now?: () => number,
 *   hostname?: string, hooks?: { beforePush?: (attempt: number) => Promise<void>|void },
 * }} options
 */
export async function runGitSync({
  repoDir, remote = 'origin', branch = null, maxPushAttempts = DEFAULT_MAX_PUSH_ATTEMPTS,
  git = defaultGit, now = () => Date.now(), hostname = '', hooks = {},
}) {
  const run = (args) => git(repoDir, args);
  const gitDir = path.join(repoDir, '.git');
  if (!(await exists(gitDir))) throw new GitSyncError('not_a_repository', `${repoDir} 不是 git 仓库根目录。`, { exitCode: 2 });
  const busy = await busyReason(gitDir);
  if (busy) throw new GitSyncError('repository_busy', `仓库正处于 ${busy}，请先处理后再同步。`, { exitCode: 2, detail: busy });

  const release = await acquireLock(gitDir, now);
  const result = {
    committed: false, merged: false, pushed: false, resolved: [], attempts: 0, branch: null, head: null,
  };
  try {
    await ensureMergeAttributes(gitDir);
    result.branch = branch || (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (result.branch === 'HEAD') throw new GitSyncError('detached_head', '仓库处于分离 HEAD，无法同步。', { exitCode: 2 });

    result.committed = await commitLocalChanges(run, hostname);

    for (let attempt = 1; attempt <= maxPushAttempts; attempt += 1) {
      result.attempts = attempt;
      const hasRemoteBranch = await fetchRemote(run, remote, result.branch);
      if (hasRemoteBranch) {
        const merged = await mergeRemote(run, `${remote}/${result.branch}`, result);
        result.merged = result.merged || merged;
      }
      await hooks.beforePush?.(attempt);
      const ahead = hasRemoteBranch
        ? Number((await run(['rev-list', '--count', `${remote}/${result.branch}..HEAD`])).trim())
        : 1;
      if (!ahead) {
        result.head = (await run(['rev-parse', 'HEAD'])).trim();
        return result;
      }
      try {
        await run(['push', remote, `HEAD:refs/heads/${result.branch}`]);
        result.pushed = true;
        result.head = (await run(['rev-parse', 'HEAD'])).trim();
        return result;
      } catch (error) {
        if (!isPushRejected(error)) throw new GitSyncError('push_failed', redact(error.message), { exitCode: 1 });
        // 远端又前进了：回到循环开头重新拉取并合并
      }
    }
    throw new GitSyncError('remote_busy', '远端持续有新提交，已停止重试；稍后再运行即可。', { exitCode: 1 });
  } finally {
    await release();
  }
}

const isPushRejected = (error) => /rejected|non-fast-forward|fetch first|failed to push some refs/i.test(`${error.stderr || ''}${error.message || ''}`);

async function commitLocalChanges(run, hostname) {
  try {
    await run(['add', '-A', '--', MANAGED_PATH, `:(exclude)${MANAGED_PATH}/.probe`]);
  } catch (error) {
    // 受管目录尚不存在（插件还没写入过）：没有可提交的内容
    if (/did not match any files/i.test(error.message)) return false;
    throw error;
  }
  const staged = (await run(['diff', '--cached', '--name-only', '--', MANAGED_PATH])).split('\n').filter(Boolean);
  if (!staged.length) return false;
  const suffix = hostname ? ` @${hostname}` : '';
  await run(['commit', '-m', `omnisum sync: ${staged.length} file(s)${suffix}`, '--', MANAGED_PATH]);
  return true;
}

/** @returns {Promise<boolean>} 远端是否已有该分支（空仓库首次推送时没有） */
async function fetchRemote(run, remote, branch) {
  try {
    await run(['fetch', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
    return true;
  } catch (error) {
    if (/couldn't find remote ref|Couldn't find remote ref/i.test(error.message)) return false;
    throw new GitSyncError('fetch_failed', redact(error.message), { exitCode: 1 });
  }
}

/** @returns {Promise<boolean>} 是否产生了合并（包含快进） */
async function mergeRemote(run, remoteRef, result) {
  const ahead = Number((await run(['rev-list', '--count', `HEAD..${remoteRef}`])).trim());
  if (!ahead) return false;
  try {
    await run(['merge', '--no-edit', '-m', 'omnisum sync: merge remote', remoteRef]);
    return true;
  } catch (error) {
    const conflicted = (await run(['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
    if (!conflicted.length) throw new GitSyncError('merge_failed', redact(error.message), { exitCode: 1 });
    const outside = conflicted.filter((file) => !file.startsWith(`${MANAGED_PATH}/`));
    if (outside.length) {
      await run(['merge', '--abort']).catch(() => {});
      throw new GitSyncError('unmanaged_conflict', `受管目录之外存在冲突，已中止合并：${outside.slice(0, 5).join(', ')}`, { exitCode: 3, detail: outside });
    }
    for (const file of conflicted) await resolveManagedConflict(run, file, result);
    await run(['commit', '--no-edit']);
    return true;
  }
}

/** 整文件解决：双方修改取 theirs；一方删除另一方修改则保留修改。 */
async function resolveManagedConflict(run, file, result) {
  const stages = (await run(['ls-files', '-u', '--', file])).split('\n').filter(Boolean)
    .map((line) => Number(line.split(/\s+/)[2]));
  const hasOurs = stages.includes(2);
  const hasTheirs = stages.includes(3);
  if (hasTheirs) {
    await run(['checkout', '--theirs', '--', file]);
    await run(['add', '--', file]);
    result.resolved.push({ file, kept: hasOurs ? 'theirs' : 'theirs-modified' });
  } else if (hasOurs) {
    await run(['add', '--', file]);
    result.resolved.push({ file, kept: 'ours-modified' });
  } else {
    await run(['rm', '--cached', '--quiet', '--', file]).catch(() => {});
    result.resolved.push({ file, kept: 'removed' });
  }
}
