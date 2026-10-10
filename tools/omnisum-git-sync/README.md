# omnisum-git-sync

把 `ominisum-sync` 的**本地 clone 目录**与 GitHub 互通：提交 → 拉取 → 合并 → 推送。
浏览器插件（MV3）不能运行 git，只读写 clone 目录里的 `_omnisum_sync/`；本脚本补上 git 这一半，
因此日常同步**不消耗 GitHub REST API 配额**（不会再触发"请求频率受限"）。

## 前置条件

- 已安装 `git` 与 Node 20+；clone 的远端凭据已配置好（SSH key 或 credential helper），脚本不接触令牌。
- 在插件"设置 → 数据管理 → 同步"里把**这个 clone 目录**授权给插件（与"数据目录"是两个独立授权）。

## 手动运行

```bash
node tools/omnisum-git-sync/cli.mjs --repo ~/ominisum-sync          # 同步一次
node tools/omnisum-git-sync/cli.mjs --repo ~/ominisum-sync --json    # 机器可读输出
node tools/omnisum-git-sync/cli.mjs --repo ~/ominisum-sync --browse  # 同步后在本地生成 browse/（人读 Markdown，已被 .gitignore 排除；失败只报告）
```

## 把工具随数据仓库一起发布（一次性）

在插件源码仓库运行 `node tools/install.mjs --clone ~/ominisum-sync`（`--dry-run` 先预览）：把 `omnisum-browse`、`omnisum-agent`、`omnisum-git-sync` 复制到 clone 的 `tools/`，生成给外部 Agent 的 `AGENTS.md`、`DATASET.md` 与 `.gitignore`（排除 `_omnisum_archive/`、`browse/`、`agent-index/`）。脚本不会替你提交；审阅后手动 `git add tools AGENTS.md DATASET.md .gitignore && git commit && git push` 一次，其他设备和外部 Agent 即可直接使用。同名文件若不是本工具生成的，需 `--force` 才会覆盖。

## 定时运行（macOS launchd）

```bash
node tools/omnisum-git-sync/cli.mjs install-launchd --repo ~/ominisum-sync --interval 300 --apply
node tools/omnisum-git-sync/cli.mjs uninstall-launchd --repo ~/ominisum-sync
```

每个 clone 一个独立的 LaunchAgent；日志在 `~/Library/Logs/com.omnisum.git-sync.<hash>.log`。
最近一次结果写在 `<clone>/.git/omnisum-sync-status.json`。

## 合并规则（重要）

| 情形 | 处理 |
| --- | --- |
| 只有一方改了 `_omnisum_sync/` 下的文件 | 采用改动方 |
| 双方都改了同一文件 | 取**远端整文件版本**；本机版本由插件下一轮同步识别为内容冲突，不会静默丢失 |
| 一方删除、另一方修改 | **保留修改** |
| `_omnisum_sync/` 之外的冲突 | 中止合并，退出码 3，交给人工 |
| 推送被拒绝（远端又前进） | 重新拉取合并，最多重试 5 次；**从不 `--force`** |

脚本在仓库内（`.git/info/attributes`）为受管目录设置 `merge=binary`，保证按**整文件**合并——行级混合会使对象信封哈希不符而被插件拒收。

## 退出码

`0` 成功 · `1` 可稍后重试的失败（网络、推送） · `2` 环境不允许（不是仓库、正在合并/变基、已有同步进程） · `3` 受管目录之外的冲突。

## 替代方案：Obsidian Git

不想安装脚本时，可在 clone 目录上用 Obsidian Git 插件做定时 commit / pull / push。务必：

1. 在 clone 的 `.git/info/attributes` 加一行 `_omnisum_sync/** merge=binary`（整文件合并）；
2. 冲突时对 `_omnisum_sync/` 下的文件选"接受远端"，不要手工拼接内容；
3. 不要对该目录使用 `--force` 推送或 rebase。
