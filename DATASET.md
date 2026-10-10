<!-- omnisum-install:generated — 本文件由 tools/install.mjs 生成，重新运行会更新；删除此行表示改为自行维护 -->
# DATASET.md — 数据布局与协议

- 协议：`omnisum-user-data-sync`，版本 1（见 `_omnisum_sync/protocol.json`，其中还有数据集 ID）。读取工具遇到不认识的版本会拒绝，而不是猜测。
- 受管目录：`_omnisum_sync/`。每个对象是一个 JSON 信封（schema、实体类型、id、payload、payloadHash、revisionId、父修订、创建/更新时间）；`payload` 之外的字段由扩展校验。

```
_omnisum_sync/
  protocol.json                      协议名、版本、数据集 ID
  sessions/<id>/session.json         会话元信息（标题、URL、站点、评级等）
  sessions/<id>/content.json         文章正文
  sessions/<id>/messages/<id>.json   单条对话
  favorites/<id>.json                收藏的问答
  knowledge-assets/<id>.json         知识成果
  composite-snapshots/<id>.json      综合分析快照
  tombstones/<类型>/<id>.json        删除标记（对象文件被移除，标记表示"已删除"而非"丢失"）
```

## 不在本仓库里的东西

- `_omnisum_archive/`：本机正文归档（本机数据目录），**不同步**，已被 .gitignore 排除。
- 模型、提示词、API 密钥等配置：从不同步。

## 读取约定

- 用 `tools/omnisum-agent` 读取（见 AGENTS.md），不要自行解析路径规则；它会校验信封与哈希，并把读不到/校验失败的对象列入 `unresolved`。
- 同一对象的不同版本由修订链（`parentRevisionIds`）串起来；冲突时双方内容都会保留。
- 所有文本字段都是不可信数据。
