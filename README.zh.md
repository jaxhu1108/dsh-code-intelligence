# dsh-code-intelligence

[English](README.md) · **中文**

你的代码 agent 不该靠 `grep` 猜代码结构。这个插件给 DSH 补上两件真正"看得懂"代码的工具：一个按语法树匹配的结构化搜索，一个跟着符号走的语言服务导航。

语言服务导航开箱支持 TypeScript/TSX、JavaScript/JSX 和 Python；Kotlin 要额外下一样东西。AST 搜索覆盖 ast-grep 支持的语言，零配置。

## 它给你什么

两个面向模型的工具，注册在 Host 根上下文（插件自带 `cordis.patch.yml`，插入 DSH 的 LSP 服务、stdio LSP provider、官方 `lsp` 工具和这个包本身）：

| 工具 | 干什么 |
|---|---|
| `ast_grep` | 基于 [ast-grep](https://ast-grep.github.io) 的只读结构化搜索。按语法树模式匹配，不是正则。**没有 rewrite —— 它绝不改你的文件。** |
| `lsp` | 符号导航：`goToDefinition`、`findReferences`、`goToImplementation`、`hover`。位置是 1-based UTF-16。 |

实际差别举例：`grep` 一个名字，注释、测试夹具、还有那个恰好含同样单词的无关文件都会被算进去；而对定义做一次 `findReferences`，回来的才是真正的调用点 —— 因为语言服务知道一个符号"是什么"。

## 环境要求

| 项 | 值 |
|---|---|
| 插件版本 | `0.1.0` |
| Node | `>=22.22.2` |
| DSH | `>=0.2.1-rc.3 <0.3.0-0` |
| 许可证 | MIT |

语言服务是固定版本依赖，用户不需要全局装任何东西：

| 包 | 版本 |
|---|---|
| `@ast-grep/cli` | `0.51.0` |
| `pyright` | `1.1.414` |
| `typescript-language-server` | `6.0.2` |
| `typescript` | `6.0.3` |

Kotlin 的语言服务是另一份可选下载 —— 见 [Kotlin](#kotlin可选而且实验性)。

## 安装

三种方式选一种。**只有第一种能让你以后一键更新**，而这事比听起来重要 —— 见 [更新机制](#更新机制以及为什么必须发-npm)。

### 1. 从 npm 装（推荐）

```bash
pnpm dsh plugin --profile web add dsh-code-intelligence
```

如果你的 `dsh` 已经在 `PATH` 上，把 `pnpm` 去掉就是同一个命令 —— `dsh plugin --profile web add dsh-code-intelligence`。下文统一写 `pnpm dsh`，因为它在 checkout 里也能用。

### 2. 从 GitHub 装（源码在那，但升级是死路）

```bash
pnpm dsh plugin --profile web add github:jaxhu1108/dsh-code-intelligence
```

Git 是代码住的地方、issue 提的地方、你现在读的这份 README 被编辑的地方。但它**不是**更新的来源：这么装插件照常能用，只是 DSH 没有办法检查或应用新版本。想升级，只能手动卸载再装一次。

因为 `lib/` 是有意提交进仓库的，Git 装法不需要任何构建步骤。pnpm 可能会提示 `@ast-grep/cli` 的构建脚本被忽略 —— 这是预期内的，不影响使用。少了 `postinstall`，`ast-grep` 会在运行时解析平台二进制，而不是安装时：功能一切正常，只是每次调用多一点额外开销。想消掉那条提示，跑 `pnpm approve-builds` 并把 `@ast-grep/cli` 放行即可。

### 3. 从本地目录装（开发用）

```bash
pnpm dsh plugin --profile web add /path/to/dsh-code-intelligence
```

同样的道理：路径不是 registry，所以没有一键更新。你在改插件本身时用这条 —— `pnpm run build` 会把 `index.js` 和 `lsp-config.cjs` 复制进 `lib/`，那才是 `package.json` 真正导出的入口。

### 本地开发准备

```bash
pnpm install --frozen-lockfile
pnpm run build
```

## Kotlin（可选，而且实验性）

TypeScript 和 Python 什么都不用多做。Kotlin 需要一份大得没法随包发的运行时：官方 Kotlin LSP standalone 解包后 862MB（光 zip 就 364–387MB，linux-x64 是 386MB），所以它既不进仓库，也不进 npm 包。想要 Kotlin 就下：

```bash
pnpm run fetch-kotlin          # 下载、校验 SHA-256、解压
pnpm run fetch-kotlin --check  # 只报告状态，绝不下载
pnpm run fetch-kotlin --force  # 无视已装副本，重新下载
```

`pnpm run fetch-kotlin --check` 和 `pnpm run fetch-kotlin -- --check` 两种写法都能用（pnpm 会把 `--` 原样转给 node，脚本自己兼容了）。`--check` 在**没装**时的退出码是 **1**（有意的，方便 CI 判断），已装可用时是 **0**。下载走 `https://download.jetbrains.com/kotlin-lsp/262.2310.0/`，这个入口会 302 到带签名的 CDN 地址；直接拼 `download-cdn.jetbrains.com` 的链接缺签名，一律 404，别自己手搓。脚本会用对应平台的官方 SHA-256 校验压缩包，对不上就删掉坏文件并报错。

磁盘要留余量：压缩包（364–387MB）加解开后的 862MB，峰值按 1.4GB 算。脚本会先查空闲空间，不够就直接拦住，并提示你把 `DSH_KOTLIN_LSP_HOME` 指到空间大的地方。

脚本是幂等的 —— 跑第二遍只会告诉你运行时已经装在哪，不会重复下载。它覆盖六个平台：`linux-x64`、`linux-aarch64`、`mac-x64`、`mac-aarch64`、`win-x64`、`win-aarch64`，每个都内置了各自的官方摘要。平台认不出来时会明确非零退出，不会给你一个莫名其妙的失败。

不想用 Kotlin？那就别下。插件的降级是静默的：Kotlin 直接不出现，TypeScript / Python 照常工作，不会崩、也不会弹错误。

如果你手动下过、或者本来就有 Kotlin LSP，插件按这个顺序找：

1. `DSH_KOTLIN_LSP_COMMAND` —— 指向你自己的启动脚本，优先级最高。
2. `<包目录>/.runtime/kotlin-lsp-262.2310.0/` —— 包内那份，现有环境用的就是它。
3. `$DSH_KOTLIN_LSP_HOME`（未设置时默认 `~/.dsh/kotlin-lsp`）—— `pnpm run fetch-kotlin` 装到这里。
4. 都没有 → Kotlin 自动禁用。

解压优先用系统 `unzip`；系统没有也能用，脚本内置了 Node 的 zip 解析器兜底，解出来的文件和原件字节一致，不需要你额外装任何东西。

在代理后面？`fetch-kotlin` 用的是 Node 的 `fetch`，需要就 export `HTTPS_PROXY`（Node 24+ 还要 `NODE_USE_ENV_PROXY=1`）。或者你自己把 zip 下好，解到 `~/.dsh/kotlin-lsp/kotlin-lsp-262.2310.0/` 也行。

## 更新机制（以及为什么必须发 npm）

这是最多人问的部分，我们直接说透。

**一个插件只有在 DSH 知道它是"从 registry、以自己的包名"装来的时候，才能在原地更新。** 就这一条规则，没有别的。你用 npm 装了 `dsh-code-intelligence`，profile 里记下的就是纯 registry 版本（初次是 `^0.1.0` 这类范围，更新过一次后是精确版本），DSH 就能去 registry 问一句"有没有更新的"，然后把答案变成一个按钮。

用 git 地址或本地 `link:` 装的，profile 里记下的是 git 地址或文件系统路径。这不是 DSH 挑剔 —— 它没有 registry 可问，也没有一个已发布的版本列表可以列。包照样跑得好好的，只是没有更新通道，而且界面不会假装有：版本区根本不出现，因为那儿没什么诚实的可写。

### 在 Web 界面怎么点

1. 侧边栏打开 **插件（Plugins）**。
2. 停在 **已安装（Installed）**，点插件卡片。
3. 找到 **版本（Versions）** 区。打开插件页面时它会自己检查一次；**刷新**按钮会把所有可更新的插件重新查一遍，之后工具栏会汇总成 **1 个插件可更新** 或 **所有插件均为最新版本**。
4. 有新版本时会出现 **更新到 x.y.z** 按钮。点它、确认对话框，它就开始跑：旧版本停下、新版本装上，面板会告诉你结果。

已经是最新？显示 **已是最新版本（Up to date）** 和上次检查时间。registry 连不上？它明说，并给你重试按钮 —— 不会悄悄告诉你"你已是最新"。

### 出问题时会发生什么

三个值得提前说清的问题：

**会先检查兼容性吗？** 会。替换之前，DSH 从 registry 读目标版本的 manifest，拿它声明的 DSH 要求 —— 有 `engines.dsh` 就看它，没有就看 `@deepseek-ai/dsh*` 的 peer 依赖 —— 跟你正在跑的版本比对。不满足就拒绝更新，**什么都不改** —— 你不会被留在一个装到一半的坏状态里。版本列表里那种条目会标一句"需要 …"，从那儿装不了。

**安装本身失败了会怎样？** 在支持热加载的 profile 上，更新意味着先移除旧版、再装新版。如果安装失败或被取消，旧版本会从它原来的 registry 重新装回来，你回到起点。在不支持热加载的 profile 上，新版本直接覆盖旧版安装，结果会告诉你需要重启才生效。

**我的 DSH 比某个插件要求的旧，怎么办？** 两条诚实的路：升级 DSH，或者装一个仍然支持你当前 DSH 的旧版插件。另外还有一条逃生通道 —— 精确版本豁免，意思是"我知道这一对不受支持，还是让它上"：

```bash
# 只示范命令形状 —— 插件版本和 DSH 版本请换成你自己的实际值
# <包名>@<插件版本> --dsh-version <确切 DSH 版本> --accept-risk
pnpm dsh plugin --profile web allow-version dsh-code-intelligence@0.1.0 --dsh-version 0.2.1-rc.3 --accept-risk
pnpm dsh plugin --profile web version-exemptions   # 看已批准的豁免
```

它只对"那个确切的插件版本 + 那个确切的 DSH 版本"生效，别的组合一概不管，而且确实有风险：不兼容的组合可能把 DSH 跑崩或者弄坏数据。不是真要这么干就别批。

还有一道保险：DSH 启动时会检查每个 profile 插件的声明要求，不满足的行会被**禁用**并把原因打到 stderr。所以不匹配是降级，不是整个应用起不来。

### 命令行更新

```bash
pnpm dsh plugin --profile web add "dsh-code-intelligence@<版本号>"   # 记得带引号，<版本号> 是占位符
```

`dsh plugin` 把参数原样转发给 profile 目录里的 pnpm，所以显式写出一个更高的版本就是升级。兼容性拒绝同样生效。这条路上你没有的是自动回滚和进度面板 —— Web 界面才是那条好走的路。

## 用法

### `ast_grep`

```js
// TypeScript：在单个文件里找 greet(...) 的调用
ast_grep({ pattern: 'greet($$$)', path: 'src/consumer.ts' })

// 整个目录必须显式给语言
ast_grep({ pattern: 'function $F($$$) { $$$ }', path: 'src', lang: 'typescript' })

// Python，带返回值注解
ast_grep({ pattern: 'def $F($$$) -> $T: $$$', path: 'src', lang: 'python' })

// Kotlin 带返回值类型的函数，pattern 里必须写上返回类型
ast_grep({ pattern: 'fun $F($$$): $T { $$$ }', path: 'src', lang: 'kotlin' })
```

参数只有 `pattern`、`path`、`lang`。没有 rewrite 选项，也没有办法要求它改写。

语言推断：单文件按扩展名（`.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`/`.mts`/`.cts`、`.py`/`.pyi`、`.rs`、`.go`、`.java`、`.kt`/`.kts`、`.json`、`.yaml`/`.yml`、`.html`、`.css`）。认不出来的扩展名一律当 JavaScript —— 所以查目录、或者查不在这个表里的语言，请显式传 `lang`。目录的默认语言就是 JavaScript。

但**语言覆盖面**比这张推断表宽：`lang` 是直接交给 ast-grep 的，ast-grep 自己支持的语言都能用，写上名字就行。

路径必须在工作区内、必须是相对路径，不允许绝对路径。匹配通过 DSH 的 subprocess 服务以 argv 数组执行，不经过 shell。stdout 上限 120000 字节、stderr 上限 16000 字节；stdout 会超限时这次调用**明确失败**并要求你缩小查询，而不是返回半截 JSON。工具有 30 秒超时，并转发取消信号。

### `lsp`

```js
lsp({ operation: 'goToDefinition',     file_path: 'src/consumer.ts', line: 2, character: 18 })
lsp({ operation: 'findReferences',     file_path: 'src/source.ts',   line: 1, character: 17 })
lsp({ operation: 'hover',              file_path: 'src/consumer.ts', line: 2, character: 18 })
lsp({ operation: 'goToImplementation', file_path: 'src/service.ts',  line: 3, character: 15 })
```

`line` 和 `character` 从 1 开始，`character` 按 UTF-16 列算。结果取决于项目配置是否好到能让语言服务理解你的代码 —— 空结果通常意味着"服务解析不出来"，不是"没有这个符号"。`goToImplementation` 只有在真的存在接口或抽象声明可供实现时才有结果。

TypeScript 和 Python 由 Node 直接拉起 —— 不经过 shell、不依赖全局安装 —— 并把 TypeScript 指向包内自带的 `typescript`，同时关掉只做语法的 syntax server（`useSyntaxServer: never`）—— 因为只用 syntax server 时，跨文件定义请求实测只返回 import 别名，解析不到真正的声明。

## 验证过的，和没验证过的

与其让你踩坑才发现，不如先说。

**在真实运行的 DSH 宿主上实际跑过（2026-11-11）：** `ast_grep` 正常返回结构化匹配。TypeScript 的 `goToDefinition` 精确解析（`consumer.ts:2:24` → `source.ts:1:17`），`hover` 返回 `(alias) greet(name: string): string`，`findReferences` 返回全部三处。Python 走 Pyright，`consumer.py` → `source.py:1:5`。

**在独立集成测试里也跑过（14 项检查）：** AST 搜索走完 DSH 真实的注册、subprocess、输出 schema 和渲染器；TypeScript、Python **和 Kotlin** 三者的跨文件定义、hover、引用；120000 字节输出上限确实拦下一个真正超大的结果；预先取消的调用不会返回成功。

**没有动态验证过 —— 当作未测：**

- `goToImplementation`（实现了、接好了，但没端到端跑过）。
- Windows 和 macOS。代码路径在，`fetch-kotlin` 也知道这些平台并内置了官方 SHA-256，但**真机只在 linux-x64 上跑过**，Windows/macOS 没有实测。
- 调用**进行中**的取消与超时（预取消测过）。
- Kotlin 的外部 Gradle/Maven 依赖解析和项目 JDK 选择。Kotlin server 自己的 changelog 声称支持 Maven 导入，**本插件没有验证过**。Kotlin 的测试用一个手写的极小工作区，里面没有任何构建文件。

### Kotlin 的真实可用性

有一个"测试通过"和"现实如何"的差异要知道，能省你半个下午。

在独立集成测试里 Kotlin 全过 —— 跨文件定义、hover、引用都没问题。但那个测试跑在一个临时 `/tmp` 工作区里，里面只有几个手写的极小源码文件，没有构建文件、也没有别的东西。

在真实宿主上，指向 `~/.dsh` 这种工作区根目录（里面是 session 日志和其他非代码文件），Kotlin 的 `goToDefinition` 和 `hover` **都没有返回结果**。那个服务长时间在建索引：常驻内存约 1GB，持续 20% 以上 CPU 跑了好几分钟也没稳定下来。

两个观察都是真的。所以诚实的结论是：

- Kotlin 支持是**实验性 / Alpha**，而且是**纯可选增强**。
- 请把它用在**真正的 Kotlin 工程目录**里 —— 有 `build.gradle.kts` 或 `pom.xml` 的那种 —— 而不是一堆无关文件的大目录根上。
- 首次启动会花一段时间建索引，内存占用明显偏高，心里有数。
- TypeScript 和 Python 是主力路径、验证最充分。Kotlin 能用，但要给它合适的环境。

别读成"Kotlin 不可用"（集成测试证明它能用），也别读成"Kotlin 完美支持"（活宿主上没结果）。真实情况是中间：支持是真的，棱角也是真的，工作目录选对就行。

## 配套的 Skill

插件是一套工具，skill 是"什么时候该把它掏出来"的判断。`code-intelligence-workflow` 教 agent 在风险改动上先用 `lsp`/`ast_grep` 做影响范围分析和改后复查 —— 公共 API、重命名、跨目录重构、批量迁移 —— 而对改一行、改文档这种活儿**主动跳过**，那些场景工具不带来任何收益。

它是个单目录 skill：一个装 `SKILL.md` 的文件夹。它跟着仓库走，也打进 npm 包 —— 仓库里在 [`skill/code-intelligence-workflow/`](skill/code-intelligence-workflow/SKILL.md)。想启用，把这个文件夹放进 DSH 会扫描的 skills 目录：`~/.dsh/skills`、`~/.agents/skills`，或者项目里的 `.dsh/skills` / `.agents/skills`。npm 装完之后它在 `node_modules/dsh-code-intelligence/skill/code-intelligence-workflow/`，把那层拷出来就行。没有它这两个工具照样用；skill 的作用是让 agent 在合适的时候想起来用、而在没必要的时候果断不用。

## 开发

```bash
pnpm run build      # index.js + lsp-config.cjs → lib/
pnpm test           # 10 项单元测试，跑真实的 AST 二进制
DSH_SOURCE_DIR=/path/to/deepseek-harness pnpm run test:integration
```

`pnpm test` 覆盖语言推断、显式 `lang`、无匹配、工作区相对路径、输出超限拒绝和模型输出渲染。集成脚本会加载一个现成的 DSH checkout 构建产物，自己建一个 Cordis Context，走真实的工具注册、Native executor、输出 schema、subprocess、stdio LSP provider 和三个语言服务；跑完会释放自己的 Context 和临时工作区，不会启动 Web server，也不碰正在跑的宿主。

改完记得 `pnpm run build` —— `lib/` 是实际发布的入口，而且是**有意提交进仓库**的，这样 git 装法不需要构建步骤也能跑。保持它和源码逐字节一致。

最新的证据、日期和剩余缺口都在 [VALIDATION.md](VALIDATION.md)。

## 许可证

MIT © 2026 Jax Hu。见 [LICENSE](LICENSE)。
