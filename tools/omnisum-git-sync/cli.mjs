#!/usr/bin/env node
/**
 * 用法：
 *   node tools/omnisum-git-sync/cli.mjs --repo <clone 目录> [--remote origin] [--branch main] [--json] [--quiet] [--browse]
 *     --browse：同步成功后在本地生成 browse/（人读 Markdown；失败只报告，不影响同步结果）。
 *   node tools/omnisum-git-sync/cli.mjs install-launchd --repo <clone 目录> [--interval 300] [--apply]
 *   node tools/omnisum-git-sync/cli.mjs uninstall-launchd --repo <clone 目录>
 *
 * 退出码：0 成功；1 失败（网络/推送等，可稍后重试）；2 环境不允许（非仓库/合并中/已有进程）；3 受管目录之外的冲突（需人工）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { GitSyncError, runGitSync } from './git-sync.mjs';
import { buildPlist, launchdLabel, plistPath } from './launchd.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { args._.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}

async function writeStatus(repoDir, status) {
  try {
    await fs.writeFile(path.join(repoDir, '.git', 'omnisum-sync-status.json'), `${JSON.stringify(status, null, 2)}\n`);
  } catch { /* 状态文件只是诊断辅助 */ }
}

/** 同步后生成本地 browse/（只写 browse/；失败只返回错误，不抛出）。 */
async function generateBrowse(repoDir) {
  try {
    const { generateBrowse: generate } = await import('../omnisum-browse/browse.mjs');
    const result = await generate({ repoDir, outDir: 'browse' });
    return { ok: true, files: result.files, issues: result.issues.length };
  } catch (error) {
    return { ok: false, message: error?.message || String(error) };
  }
}

async function installLaunchd(args) {
  const repoDir = path.resolve(String(args.repo || process.cwd()));
  const scriptPath = fileURLToPath(import.meta.url);
  const plist = buildPlist({
    repoDir, nodePath: process.execPath, scriptPath,
    intervalSeconds: Number(args.interval || 300), remote: String(args.remote || 'origin'), branch: args.branch ? String(args.branch) : null,
  });
  const target = plistPath(repoDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, plist);
  console.log(`已写入 ${target}`);
  if (args.apply) {
    const domain = `gui/${os.userInfo().uid}`;
    try { execFileSync('launchctl', ['bootout', `${domain}/${launchdLabel(repoDir)}`], { stdio: 'ignore' }); } catch { /* 之前未加载 */ }
    execFileSync('launchctl', ['bootstrap', domain, target], { stdio: 'inherit' });
    console.log('已加载，将每隔指定秒数自动同步。');
  } else {
    console.log(`加载命令：launchctl bootstrap gui/$(id -u) "${target}"`);
  }
}

async function uninstallLaunchd(args) {
  const repoDir = path.resolve(String(args.repo || process.cwd()));
  const target = plistPath(repoDir);
  try { execFileSync('launchctl', ['bootout', `gui/${os.userInfo().uid}/${launchdLabel(repoDir)}`], { stdio: 'ignore' }); } catch { /* 未加载 */ }
  await fs.rm(target, { force: true });
  console.log(`已移除 ${target}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;
  if (command === 'install-launchd') return installLaunchd(args);
  if (command === 'uninstall-launchd') return uninstallLaunchd(args);

  const repoDir = path.resolve(String(args.repo || process.cwd()));
  const startedAt = Date.now();
  try {
    const result = await runGitSync({
      repoDir, remote: String(args.remote || 'origin'), branch: args.branch ? String(args.branch) : null, hostname: os.hostname(),
    });
    const browse = args.browse ? await generateBrowse(repoDir) : undefined;
    await writeStatus(repoDir, { ok: true, at: new Date().toISOString(), durationMs: Date.now() - startedAt, ...result, ...(browse && { browse }) });
    if (args.json) console.log(JSON.stringify({ ok: true, ...result, ...(browse && { browse }) }));
    else if (!args.quiet) {
      console.log(`同步完成：提交=${result.committed} 合并=${result.merged} 推送=${result.pushed} 冲突按整文件解决=${result.resolved.length}`);
      if (browse && !browse.ok) console.error(`browse/ 生成失败（不影响同步）：${browse.message}`);
    }
    return 0;
  } catch (error) {
    const known = error instanceof GitSyncError;
    const status = { ok: false, at: new Date().toISOString(), code: known ? error.code : 'unexpected', message: error.message };
    await writeStatus(repoDir, status);
    console.error(args.json ? JSON.stringify(status) : `同步失败（${status.code}）：${error.message}`);
    return known ? error.exitCode : 1;
  }
}

process.exitCode = await main();
