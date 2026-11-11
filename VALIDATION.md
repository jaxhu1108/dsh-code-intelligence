# 验证记录

日期：2026-11-02，Asia/Shanghai。插件：dsh-code-intelligence 0.1.0。DSH：0.2.1-rc.3。Node：24.15.0。

## 已完成

- 已通过 DSH plugin add 安装到 web profile，本地包入口解析到插件 lib/index.js。
- 固定运行时依赖：@ast-grep/cli 0.51.0、pyright 1.1.414、typescript-language-server 6.0.2、typescript 6.0.3。profile 可解析 lsp-config export，其 command 使用 Node，tsserver.path 指向插件内 TypeScript。Kotlin standalone CLI 262.2310.0 已下载至 `.runtime/kotlin-lsp-262.2310.0`，官方 SHA-256 `c004242158f4b5e1d917ddd848e6f6a279484fa58a3e2bce8846b807d1ad16b1`，自带 JRE；未自动接受或伪造 263.7084.0 的 EULA。
- pnpm run build 成功；index.js/lib/index.js 和 lsp-config.cjs/lib/lsp-config.cjs 的 cmp 检查一致。
- pnpm test：10 项通过，0 失败。覆盖目录 JavaScript、文件 TypeScript/Python/Kotlin 推断、显式语言、无匹配、工作区相对路径、lossy 输出拒绝和模型输出渲染。
- pnpm run test:integration：14 项检查通过。使用现有 DSH 构建包创建独立 Cordis Context，经过真实工具注册、Native executor、输出 schema、subprocess、stdio LSP provider、TypeScript server、Pyright 和 Kotlin server。
- 集成证据：AST 匹配 greet('Jax')；consumer.ts:2:18 的定义跳转到 source.ts:1:17；hover 返回 greet(name: string) 的签名；引用查找包含 consumer.ts:2:17。Python 的 consumer.py 定义跳转到 source.py:1:5，hover 返回 typed signature，引用包含跨文件调用。Kotlin 的 consumer.kt:1:16 定义跳转到 source.kt:1:5，hover 返回 String 签名，引用包含跨文件调用。
- 集成边界：真实大量 AST 输出触发 120000 字节上限并明确失败；预先取消的调用未返回成功结果。Context 与临时测试目录在 finally 中释放。Kotlin 语义验收使用轻量跨文件工作区，未覆盖 Gradle/Maven 外部依赖导入。
- pnpm dsh --profile web --dump-config 退出码 0，含 code-lsp、code-lsp-stdio、code-tool-lsp、code-intelligence 四行。另有既存警告 patch: entry dsh-unlag not found，本任务未修改该插件。
- 独立只读复审未确认其他 AST/LSP 实质缺陷；其审查时缺失的集成脚本现已补齐并实际运行成功。

## 修复依据

- DSH subprocess readFrom(0) 返回 text、nextOffset、lossy；没有 startOffset/endOffset。输出超限使用 lossy 判断。
- 输出 renderer 接收 args 和 value 两个参数；已按官方契约修正。
- AST 固定 argv、-- 后的路径及语言参数，不调用 shell，不提供改写参数。默认目录语言明确为 JavaScript；单文件用扩展名推断；其他目录语言需显式指定。
- TypeScript-language-server 本身不携带运行时 TypeScript；pnpm 隔离下必须显式提供 tsserver.path。
- syntax server 的初次定义请求实测只返回 consumer.ts 中的 import 别名。useSyntaxServer: never 后完整语义服务在同一跨文件测试中返回 source.ts 的定义。

## Skill

新增用户级 Skill `code-intelligence-workflow/SKILL.md`（作者机器上的用户级 Skill 目录），front matter 名称为 `code-intelligence-workflow`。本次通过 DSH skill 加载入口实际加载，返回 provider=filesystem、resourceBase 指向该目录；因此当前 Agent 可读取完整工作流。它要求按风险选用 LSP/AST，不强迫简单改动使用工具。

## 当前宿主生效状态（2026-11-11 复核，已推翻旧结论）

2026-11-02 的记录曾写「当前宿主未重启、ast_grep 报 isAbsolute is not defined、不算激活」。**该结论已过期。** 2026-11-11 在真实运行中的 Web 宿主上直接调用两个工具，实测结果：

- `ast_grep`：正常返回结构化结果。传入工作区外绝对路径时按设计报 `ast_grep: path must be workspace-relative`；目录范围过大时按设计报 120000 字节上限并明确要求缩小查询——两者都是预期行为，不是故障。
- `lsp` + TypeScript：`consumer.ts:2:24` 的 `goToDefinition` 精确返回 `source.ts:1:17`；`hover` 返回 `(alias) greet(name: string): string`；`findReferences` 返回 `consumer.ts:1:10`、`consumer.ts:2:20`、`source.ts:1:17` 三处。
- `lsp` + Python（Pyright）：`consumer.py:3:11` 的 `goToDefinition` 返回 `source.py:1:5`。

即当前宿主加载的已是修复版，不再有 isAbsolute 缺失问题，无需为此重启。

## 2026-11-11 发布前复验

- `pnpm run build` 成功；`cmp` 确认 `index.js` 与 `lib/index.js`、`lsp-config.cjs` 与 `lib/lsp-config.cjs` 完全一致。
- `pnpm test`：10 项通过，0 失败。
- `DSH_SOURCE_DIR=/path/to/deepseek-harness pnpm run test:integration`：14 项全部 PASS，含 TypeScript/Pyright/Kotlin 跨文件定义、hover、引用，以及输出上限拒绝与预取消。
- `scripts/fetch-kotlin.mjs --check`：在本机正确识别 `.runtime` 里那份运行时为 `status: installed`。
- `lsp-config.cjs` 四级查找链实测：本机默认解析到 `.runtime/kotlin-lsp-262.2310.0/kotlin-lsp.sh`（现有 862MB 运行时照常可用）；`DSH_KOTLIN_LSP_HOME` 指向模拟缓存时正确命中；两者都不存在时 `kotlin` 从 `servers` 中消失、typescript/python 不受影响、不抛未捕获异常。
- 新用户路径验证：临时隐藏 `.runtime`、只保留下载缓存时，能正确解析出缓存里的 `kotlin-lsp.sh`。
- `cordis.patch.yml` 的 `!!js` 行在 profile 内实际可解析：`createRequire(profile/package.json)('dsh-code-intelligence/lsp-config')` 返回 `['typescript','python','kotlin']` 三个 server。
- `npm pack --dry-run`：9 个文件、约 16.7 KB，含 `scripts/fetch-kotlin.mjs`，不含 `.runtime`、`tests`、`node_modules`。

## Kotlin 在真实宿主上的实测边界（重要）

与集成测试的结论存在差异，两者都真实，需分开理解：

- **集成测试里 Kotlin 通过**：`consumer.kt:1:16 → source.kt:1:5`，hover、references 也通过。但测试用的是 `/tmp` 下的极轻量临时工作区（只有几个文件，无 Gradle/Maven 工程结构）。
- **真实宿主工作区里 Kotlin 未返回结果**：在 `~/.dsh` 这类混杂大量 session 日志等非代码文件的目录里，`goToDefinition` 与 `hover` 均无结果。观察到 Kotlin LSP 进程持续高 CPU/内存（RSS 约 0.95–1.2 GB，索引超过 8 分钟仍在进行）。
- 结论：Kotlin 属于实验性/可选增强，建议在正常 Kotlin 工程目录（有 `build.gradle.kts` 或 `pom.xml`）中使用；首次启动需等待索引。TypeScript 与 Python 是验证最充分的主力路径。

## 尚未动态验证

`goToImplementation`、Windows/macOS 平台、进程运行中取消与超时、Kotlin 的外部 Gradle/Maven 依赖解析与项目 JDK 选择，均无动态验证。不要扩大为全语言、全平台或全部操作已测。

重现：在插件目录依次运行 `pnpm run build`、`pnpm test`、`DSH_SOURCE_DIR=/path/to/deepseek-harness pnpm run test:integration`。DSH checkout 必须已具有对应构建包。

鸡腿记录：本次插件实现与验证 +2，累计 2。2026-11-11 发布前复验 +1，累计 3。未计上游 bug 修复奖励。
