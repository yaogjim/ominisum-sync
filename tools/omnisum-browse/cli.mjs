#!/usr/bin/env node
/**
 * 用法：node tools/omnisum-browse/cli.mjs [--repo <数据仓库目录，默认当前目录>] [--out <输出目录，默认 browse>]
 * 退出码：0 成功；1 已生成但有对象未通过校验；2 协议/参数/输出目录错误（未写任何文件）。
 */
import { BrowseError, generateBrowse } from './browse.mjs';

function parseArguments(argv) {
  const options = { repoDir: process.cwd(), outDir: 'browse' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--repo' || flag === '--out') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new BrowseError('invalid_arguments', `${flag} 需要一个值。`);
      options[flag === '--repo' ? 'repoDir' : 'outDir'] = value;
      i += 1;
    } else if (flag === '--help' || flag === '-h') {
      options.help = true;
    } else {
      throw new BrowseError('invalid_arguments', `未知参数：${flag}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('用法：node tools/omnisum-browse/cli.mjs [--repo <dir>] [--out <dir>]');
    return 0;
  }
  const result = await generateBrowse(options);
  const { counts } = result;
  console.log(`已生成 ${result.files} 个页面 → ${result.outDir}`);
  console.log(`文章 ${counts.sessions}，对话 ${counts.messages}，收藏 ${counts.favorites}，知识成果 ${counts.knowledgeAssets}，综合分析 ${counts.compositeSnapshots}，已按删除标记隐藏 ${counts.hidden}`);
  if (result.issues.length) {
    console.error(`警告：${result.issues.length} 个文件未通过校验，已跳过：`);
    for (const issue of result.issues) console.error(`  - ${issue.path} (${issue.code})`);
    return 1;
  }
  return 0;
}

main().then((code) => { process.exitCode = code; }, (error) => {
  console.error(`错误：${error instanceof BrowseError ? error.message : error?.stack || error}`);
  process.exitCode = 2;
});
