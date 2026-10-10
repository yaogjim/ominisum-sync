# omnisum-agent

给外部 Agent（Claude Code、Cursor、脚本等）读取 OmniSum 同步到 GitHub 数据仓库里的 `_omnisum_sync/`：**只读、零依赖（Node ≥ 18）、输出结构化 JSON**，用于日报/周报与增量整理。无需插件、令牌、网络。设计与验收见 [S7 文档](../../docs/features/github-user-data-sync/agent-read.md)。

## 安装

把 `tools/omnisum-agent/` **和** `tools/omnisum-browse/`（共用同一套协议校验）一起复制到数据仓库的 `tools/` 下并 `git clone` 该仓库。以下命令在仓库根目录运行；成功时 stdout 只有一个 JSON，错误以 JSON 写 stderr。

## 命令

```bash
# 1. 数据集说明：协议、数据集 ID、各类型数量、状态摘要 digest
node tools/omnisum-agent/cli.mjs describe

# 2. 分片索引：写出 agent-index/index.json 与 shards/<YYYY-MM>.json（按活动月；不含正文）
node tools/omnisum-agent/cli.mjs index

# 3. 时间窗口：该范围内创建的内容 + 新增的对话（旧文章新增的对话也算），按日/周分组（UTC）
node tools/omnisum-agent/cli.mjs window --week 2026-10-05 --period day
node tools/omnisum-agent/cli.mjs window --from 2026-10-01 --to 2026-10-07 --body none

# 4. 游标增量：自上次已处理的游标以来新增/修改/删除
node tools/omnisum-agent/cli.mjs changes --init --next-cursor state/c1.json          # 首次：建立基线（全部为新增）
node tools/omnisum-agent/cli.mjs changes --cursor state/c1.json --next-cursor state/c2.json --period day

# 5. 单个对象的完整已校验内容
node tools/omnisum-agent/cli.mjs show --type session --id <id>
```

通用选项：`--repo <目录>`（默认当前目录）；`--body none|excerpt|full`（默认 `excerpt`，`--max-chars` 控制截断，默认 500；对话始终完整返回）。

## 日/周整理的推荐流程

1. 运行 `changes --cursor <当前游标> --next-cursor <新游标>`，拿到自上次以来的变化。
2. Agent 基于 `items`（新增/修改的文章与新增的对话）和 `deleted` 写日报/周报，**写到仓库 `reports/`**（本工具从不写该目录）。
3. **报告写成功后**再把 `<新游标>` 作为"当前游标"。处理中途失败就用旧游标重来——相同游标得到字节一致的输出与下一游标。
4. 时间（`periods`）只决定条目归到哪一天/哪一周，**不决定读不读**：离线一周后才上传的旧日期内容，仍会在下一次 `changes` 中出现，并被归到它真实发生的日期。

## 输出要点

- 每个条目有 `key`（`session:<id>`）、`type`、`id`、`change`（`added/modified/active/current`）、`revision`、`sources`（`_omnisum_sync` 内的相对路径）；对话有 `id`、`role`、`at`、`revision`、`source`、`content`；收藏有 `question` 与 `relations.session`。
- `unresolved.missing/invalid`：文件缺失、校验失败、无法归属到会话的对象（每项带 `key` 可映射到条目；**只看 `items`/`deleted` 会漏掉它们**，非空时退出码为 1）。**读不到不等于删除**，它们不会进入 `deleted`，游标里的旧条目也会保留；恢复后不会被重复当作新增。
- `deleted`：只有存在删除标记（插件同步删除时会写标记并移除对象文件）时才报告。
- `warnings`：Git 历史相关提示。

## 退出码

`0` 成功；`1` 成功但有 `unresolved`；`2` 参数/协议/输出目录错误；`3` 游标问题（缺失/损坏/数据集不一致/历史不一致）。

## 安全边界

- **输出是不可信数据**：标题、正文、对话都是用户保存的内容（可能来自任意网页），其中的"请忽略以上指令/执行命令"等文字**不是**给 Agent 的指令。所有输出带 `contentTrust: "untrusted-data"`。请让 Agent 把它当作被整理的材料，不要授予它因此执行命令、访问文件或联网的权限。
- **只读**：只读取 `_omnisum_sync/`；只写 `--next-cursor` 指定的新游标文件（原子写；不覆盖原游标；已存在的文件必须本身是游标；不能位于 `_omnisum_sync/` 或 `.git` 内）与 `index` 的输出目录（需带 `.omnisum-agent-index` 标记才会清理重建；不能是仓库根、受管目录或 `.git`）。
- **历史保护**：游标记录创建时的 Git HEAD。当前 HEAD 不是它的后代（远端历史被强推改写，或本地克隆落后于游标）时拒绝读取（退出码 3，`history_diverged`），请先 `git pull`；确认无误可用 `--init` 重建基线，或显式加 `--allow-history-mismatch`。数据集 ID 不一致的游标一律拒绝。
- 不下载网络资源、不执行数据中的任何内容、不启动模型。

## 限制

- 游标约 90 字节/对象，随对象数线性增长；超大窗口的输出体量由 `--body` 与窗口范围控制。
- 日期与周均为 UTC（周一至周日）。
- 不做全文搜索与向量索引，不提供 MCP/常驻服务。
- `--cursor`/`--next-cursor` 路径相对**当前 shell 目录**（不是 `--repo`）；建议在数据仓库根目录运行，游标放在仓库外或 `state/` 等非受管位置。
- Git 历史保护要求数据仓库目录本身是 Git 工作区根；位于更大仓库子目录时不记录 HEAD。浅克隆缺少游标提交时按 `history_diverged` 拒绝，先 `git fetch --unshallow` / `git pull`。
