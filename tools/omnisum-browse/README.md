# omnisum-browse

把 OmniSum 同步到 GitHub 数据仓库里的 `_omnisum_sync/`（带哈希的 JSON）生成**人可读的 Markdown**，无需插件、无需令牌、无需联网。零依赖，仅需 Node ≥ 18。设计与验收见 [S6 文档](../../docs/features/github-user-data-sync/browse.md)。

## 使用

1. 把本目录整体复制到数据仓库的 `tools/omnisum-browse/`，并 `git clone` 该仓库。
2. 在仓库根目录运行：

   ```bash
   node tools/omnisum-browse/cli.mjs            # 读取 ./_omnisum_sync，写入 ./browse
   node tools/omnisum-browse/cli.mjs --repo /path/to/clone --out browse
   ```

3. 打开 `browse/README.md`（GitHub 页面或任意 Markdown 阅读器）。入口：按日期（年 → 月 → 日，UTC）、按评级、按常用标签（出现 ≥10 篇）、文章、收藏、知识成果、综合分析快照；总览里有"如何查找"。

退出码：`0` 成功；`1` 已生成，但有文件未通过校验（列在 `browse/README.md` 的问题清单与 stderr）；`2` 数据集/参数/输出目录错误（不写任何文件）。

## 行为与边界

- **只读**：只读取 `_omnisum_sync/`，只写 `browse/`；输出目录必须在仓库内，不能是仓库根、`_omnisum_sync/` 或 `.git`。`browse/` 内的 `.omnisum-browse` 标记表示由本工具管理，重新生成会清空并重建；无标记的非空目录会被拒绝。
- **校验**：协议名/版本、路径与对象身份一致、`payloadHash` 与 `revisionId` 可复算；符号链接、白名单外文件、超 10MB 文件被忽略/拒绝。
- **删除**：按删除标记隐藏已删除的对象（会话连同其对话）。
- **单篇页版式**：标题 → 来源/评级/类别/标签 → 摘要卡片 → 分析要点（高价值点、知识要点、行动项、留存建议）→ 正文 → 对话（每条默认折叠）→ 折叠的元信息表。缺失字段整块省略；网址式标题改用 AI 分类标题。
- **正文**：`contentHtml` 经 `html-to-markdown.mjs`（零依赖白名单转换器）转成 Markdown：段落、标题、列表、引用、代码、粗斜体、`http(s)` 链接与图片；`script/style/iframe/object/embed/svg` 连内容丢弃；转换为空时回退 `pageContent`。
- **安全渲染**：对话/收藏中的原始 HTML 转义，`javascript:` 等链接协议被中和，对话内的 `</details>` 无法闭合折叠块；来源只有 `http(s)` 渲染为链接。仍建议不要在不受信任的 Markdown 渲染器里打开来源不明的仓库。
- **幂等**：同一输入生成字节一致的输出（不含生成时间）。
- **不包含**：静态 HTML、搜索、写回、GitHub Actions/Pages。
