# dsh-think-zh

把模型的**思考过程（reasoning）实时翻译成中文**显示：中文在上、英文原文可折叠。
只作用于显示层 —— 会话记录、Trajectory、导出文件里的推理文本一个字节都不改。

> 原型阶段（v0.1.0）。已在真实宿主上验证：翻译链路、分块缓存、客户端 bundle 装载、
> 插槽遮蔽注册。UI 观感仍需你在自己的窗口里确认。

> ## ⚠️ 安装前必读：当前版本有已知风险
>
> **这个插件可用且正在日常使用**，但有几条必须在安装前知道的风险。
>
> ### 1. 安装失败可能让应用无法启动，并重置你的配置
>
> DSH 对客户端插件的容错是**全有或全无**：任何一个 bundle 抛异常，应用直接提示
> 「应用无法启动或已意外停止」。**而且**应用内置的恢复模式在修复时会
> **重写 `package.json` 与 `cordis.patch.yml`**，把你手写的 provider 配置
> （例如本地 Ollama 路由）一起清掉。
>
> **本插件的客户端 bundle 目前没有顶层异常防御。** 所以如果它在你的机器上初始化失败，
> 代价不是一个坏掉的插件，而是**一次启动失败 + 配置被重置**。
> 原文件会备份成 `*.bak-<时间戳>`，可据此恢复（见「出问题怎么回滚」）。
>
> ### 2. 安装路径只验证过一种
>
> 实测可用的是仓库里的 `scripts/install-desktop.sh`（软链 + patch 追加 + 安装前闸门）。
> **标准的 `dsh plugin --profile desktop add` 那条路没有测过。**
>
> ### 3. 一个尚未定性的显示问题
>
> 少数情况下思考行会出现**看着重复的摘要**。已确认**不是渲染重复**
> （DOM 里 39 条摘要文本互不相同），但尚未定性是模型自身重复输出还是折叠分组的表现。
>
> ### 4. 依赖没有稳定性承诺的内部约定
>
> 插槽键名、遮蔽优先级规则、内置条目的 `inject` 契约、事件流形状——
> 都可能随 DSH 升级变化。**每次升级都需要重新验证。**
>
> ---
>
> **结论：目前建议自用或小范围试用，不建议装在重要环境里。**
> 逐项检查见 [docs/发布检查清单.md](docs/发布检查清单.md)，未完成项已如实标出。

## 效果

思考行折叠时显示**中文摘要**（取自译文最新段落），展开后是**中文正文**，
正文下方是一行 `展开英文原文（N 字符）`，点开才显示模型原始英文。

## 它怎么工作

```
DeepSeek 流式 reasoning-delta
        │
        │  会话事件（只读，永不改写）
        ▼
assistant-step 节点 ── blocks[] = [{kind:'reasoning', text}, ...]
        │
        │  客户端插槽遮蔽：conversation.chat.node / key=assistant-step / priority=-1
        ▼
dsh-think-zh 影子渲染器
        │  ① 把 reasoning 块的 text 换成已缓存的中文译文
        │  ② 在内置渲染器之上再画一行自己的推理行（中文 + 可折叠英文）
        ▼
浏览器显示
        ▲
        │  POST /dsh-think-zh/translate  {key, text}
        │
宿主半区：分句 → 命中缓存 → 只翻新增句 → 返回整段译文
        │
        ├── engine: dsh    → ctx.llm.stream()（复用你已配置的模型与账号）
        ├── engine: ollama → http://127.0.0.1:11434/api/chat（本地、零成本）
        └── engine: openai-compatible → 任意 /chat/completions 端点
```

三个设计约束：

1. **不改会话状态。** 翻译结果只存在于渲染层与插件自己的缓存里，绝不写回 session event、
   Trajectory 或导出。模型下一轮收到的仍是原始英文推理（DeepSeek 适配器会把推理原样回传，
   含 thinking 签名 —— 改写它等于篡改模型上下文）。
2. **不重复付费。** 推理是流式的，但句子一旦结束就不再变化；因此**缓存以整句原文为键**，
   每轮只为新出现的句子 + 当前未完成的半句付费。实测：253 字符首次翻译 1.8 秒，
   文本增长后重发只翻新增部分，0.5 秒。
3. **失败要安全。** 影子渲染器只接管 `reasoning` 块，其它块按引用原样透传；渲染抛错时
   插槽会弃用影子条目并回退到内置渲染器。

## 安装（桌面版）

**实测可用的方式**（本插件一直是这样装上的）：

```bash
cd <本目录>
node scripts/build-client.mjs      # 改了 client.source.js 之后必须重跑
bash scripts/install-desktop.sh    # 建软链 + 往 profile patch 追加插件行；幂等
# 然后完全退出并重新打开桌面应用
```

脚本做三件事：把本目录软链进 profile 的 `node_modules`、在 `cordis.patch.yml` 末尾追加
一行插件声明（改写前自动备份）、跑安装前闸门。

> 另一条路是 `dsh plugin --profile desktop add file:<绝对路径>`（转发给 pnpm）。
> 本插件**没有实测过那条路**——它要求 pnpm 可用、且应用必须完全退出，
> 而这个应用的 `desktop` profile 由 Electron 独占管理（CLI 会直接拒绝操作它）。
> 上面的脚本是验证过的路径。

**必须重启应用**：桌面端的启动图是宿主启动时的快照，刷新页面不会重新组装，
实测刷新后 entry 数不变、插件不出现。

## 配置

首次运行会把配置写到 `$DSH_HOME/dsh-think-zh/config.json`
（默认 `~/.dsh/dsh-think-zh/config.json`）：

```json
{
  "enabled": true,
  "engine": "dsh",
  "showOriginal": true,
  "defaultOpenOriginal": false,
  "minChars": 40,
  "glossary": [],
  "engines": {
    "dsh": { "provider": "deepseek-account", "model": "deepseek-flash", "reasoningEffort": "off", "maxTokens": 1024, "temperature": 0 },
    "ollama": { "baseURL": "http://127.0.0.1:11434", "model": "qwen3.8:latest", "keepAlive": "30m", "timeoutMs": 120000 },
    "openai-compatible": { "baseURL": "", "model": "", "apiKey": "", "displayName": "OpenAI-compatible", "timeoutMs": 60000 }
  }
}
```

| 字段 | 说明 |
|---|---|
| `enabled` | 总开关。关掉即完全恢复原生英文显示 |
| `engine` | `dsh` / `ollama` / `openai-compatible` |
| `showOriginal` | 是否提供「展开英文原文」入口 |
| `defaultOpenOriginal` | 是否默认展开英文原文 |
| `minChars` | 推理短于这个长度不翻译 |
| `engines.dsh.provider` / `.model` | 留空时回退到 `agentDefaultModel` 的当前选择 |

界面右上角有一个标着「思」的小圆钮（页面固定定位，不占布局），点开是设置面板：
开关、英文原文开关、引擎切换、引擎连通性测试。面板里改动即时保存到上面的配置文件。

如果右上角与你的界面控件打架，改 `client.source.js` 里那两个 `top`/`right` 常量再重新构建即可。

## 引擎选择

| 引擎 | 实测延迟 | 成本 | 隐私 |
|---|---|---|---|
| `dsh`（复用已配置模型） | 355–950ms，中位 ~650ms（deepseek-flash） | 消耗账户额度 | 推理片段发给模型提供方 |
| `ollama` + `qwen2.5:1.5b` | **200–419ms**，中位 ~202ms，2.11GB 常驻 | **0** | 不出本机 |
| `ollama` + `qwen3.8:latest`（27B） | 6.7–9.3s ❌ | 0 | 不出本机 |
| `openai-compatible` | 取决于端点 | 取决于端点 | 取决于端点 |

本地选型已实测（11 个 Ollama 模型）：**选 `qwen2.5:1.5b`**。它是唯一同时满足
「完整不漏译 + 尾句正确 + 延迟在可用线内」的本地模型，装上后比 API 还快。

> ⚠️ **不要用 Qwen3.6 / Qwen3.8 做这个插件的引擎。** 它们是 Gated DeltaNet 混合线性
> 注意力，循环状态无法回退到任意前缀位置，llama.cpp 只能整段重算提示词：
> 每次调用光读 371 token 指令就要 5.8 秒。插件**永远处于"新片段"场景**，所以
> "系统提示词固定 ⇒ 缓存必然命中"这个直觉在这里不成立。

## 挑选翻译模型的标准

翻译是**在一次对话里被反复调用**的：推理每新增约 24 字符就可能触发一次，
所以单次延迟直接叠加到"中文比英文慢多久出现"上。按重要性排序：

1. **单次延迟：目标 < 500ms，可接受 < 1.5s，超过 3s 就不要用。**
   本机 27B 实测 6.7–9.3s/次，等于中文比英文慢一个数量级，流式体验不成立。
   API 侧 `deepseek-flash` 实测 355–950ms（中位约 650ms），这才是有用的区间。
2. **格式服从性：只输出译文。** 不能有开场白、不能重复原文、不能用代码块包裹整段。
   插件会丢弃不合规的输出（`sanitizeTranslation`），丢弃的后果是那一段**没有中文**，
   而不是显示错的字 —— 所以格式不服从 = 功能失效。
3. **Markdown 结构必须逐字保留**：列表符号、编号、缩进、代码块围栏、行内代码、URL、
   文件路径、命令、变量名/函数名/包名（`slot registry`、`assistant-step`、
   `dsh plugin --profile desktop add`）都不能被翻译掉。
4. **必须能翻译不完整的半句。** 尾句在推理过程中是逐字增长的，
   补全句子 = 显示内容和模型实际想法脱节。
   （实测违反者：`granite3.3:2b` 会把 `...so the row does not` 补成「…这样行就不需要
   进行探测」；`gemma3:1b` 会凭空生成「第 6 步」。）
5. **不需要推理能力。** 必须能关掉思考（`reasoningEffort: off`，Ollama 用 `think: false`）。
   带思考的模型即使标签被剥掉，也多付几倍 token 和延迟。
6. **上下文要求很低**：3k 就够。每次请求 ≈ 600 token 系统提示 + < 1k 片段。
7. **成本 = 每次调用单价 × 每轮约 5–15 次调用。** 按每轮推送约 2–6k 推理 token 估算，
   每次调用的输入大约几百 token。便宜的小模型足够，不必上旗舰。
8. **不能静默漏译。** 丢一整句比慢更危险——读者无法察觉推理里少了东西。
   实测 `qwen2.5:0.5b` 虽然 387ms 达标，但稳定丢掉整句，因此不可用。

> 关于漏译的自动检测：**没有可靠阈值。** 实测中文产出稳定是英文源
> 1.33–1.76 内容单元，而从 3 句批次里丢掉一整句只把比值压到 ~0.82 ——
> 高于合法译文的最低值 0.71，两个分布重叠。所以插件不做重试，
> 只在日志里记录可疑比值（`low output ratio`），靠选引擎而不是靠事后补救。

### 怎么测

不需要装插件、不需要重启应用。插件已经把翻译暴露成本机 HTTP 接口：

```bash
node scripts/bench-engine.mjs --url http://127.0.0.1:19399 --runs 3
```

它会用 4 个真实形态的样本（正文 / Markdown 列表 / 代码块 / 半句尾巴）打出
首次延迟、中位延迟、中文占比，并自动判定是否丢了标识符、丢了 Markdown、
开头带客套话。换引擎只需改 `$DSH_HOME/dsh-think-zh/config.json` 里的
`engine` 与对应 `engines.<engine>` 字段，然后 POST 一次
`/dsh-think-zh/config` 让宿主重建引擎（也可点界面右上角「思」按钮切换）。

机器可读的明细写进 `--json <path>`，方便把多个模型的结果放在一起比。

> ⚠️ **本插件的完整事故记录见 [CRASH-RECORD.md](CRASH-RECORD.md)** —— 含 8 次启动崩溃的时间线、
> 7 次配置被恢复模式改写的证据、以及"真实错误被宿主丢弃"的源码定位。

## 一个必须知道的事故：客户端 bundle 抛错会把应用打到恢复模式

装机后首次启动时踩到过：应用连续 5 次启动失败，随后自动进入恢复模式，
**把 `cordis.patch.yml` 重置成只含设置项**（我加的插件行、以及你手写的 Ollama provider
配置块一起被清掉），并在旁边留下 `cordis.patch.yml.bak-<毫秒时间戳>`。

原因不是插件功能有 bug，而是**加载顺序**：

```
宿主推给页面的注入行顺序：
  1. kind:"script"      定义 __ModuleLoader__ 队列      → 桌面壳：同步 append，不 await
  2. kind:"script-preload"  应用 combo 预加载            → 桌面壳：跳过
  3. kind:"script-src"  加载 client-modules 引导         → 桌面壳：await loadScript()
  4. kind:"global"      __DSH_BOOT__ 启动图
```

桌面壳自己应用这些行（`renderer` 侧的 `hM()`），于是**应用 combo 的 `<script>` 在第 3 步之前
就同步执行了**，那一刻 `_ModuleLoader__` 还不存在。裸调 `_ModuleLoader__.load(...)` 抛
`ReferenceError`，而应用 combo 里的异常会被判为**致命启动错误**（`web boot: N entry did not
activate`），应用直接拒绝启动 → 恢复模式。

Web 形态（`dsh --profile web`）不受影响：它把注入行作为真实 `<script src>` 标记写进 HTML，
浏览器按依赖顺序同步解析，所以我之前的宿主验证完全没覆盖到这条路径。

**修法**：bundle 不再直接调用，而是先找 `globalThis._ModuleLoader__`；找不到就等它出现
（有界轮询，最多 6 秒）再注册。期间不会有任何未捕获异常。

**同一事故里的第二个坑（更隐蔽）**：构建脚本最初把这个全局名写成了
`__ModuleLoader__`（双下划线），只差一个字符。它在 Node 侧测试里"通过"是因为测试自己
装了 `_ModuleLoader__` 的 stub，而 bundle 去读另一个名字，于是它安静地什么都不注册 ——
在应用里则是启动失败。为此加了两道闸：

- `test/registration.test.mjs`：钉死注册契约（同步注册、`window.__ModuleLoader__` 双下划线、`apply`/`inject`）
  （无 loader 先执行 → loader 出现 → 必须恰好注册一次）。旧的裸调用写法在这个测试下立刻抛
  `ReferenceError`。
- `scripts/smoke-client.mjs`：**安装前硬闸门**，在无 loader 的浏览器式全局里求值 bundle，
  抛错或没注册就 exit 1；`install-desktop.sh` 直接拒绝安装。反向验证过：把拼写改回双下划线，
  闸门立刻拦下。

**结论（也是这个插件对宿主的唯一硬要求）**：客户端 bundle 的顶层代码绝不允许抛异常。
一旦抛，连"插件不生效"这种温和失败都拿不到，而是整个应用起不来。

## 缓存与磁盘占用

配置写在 `$DSH_HOME/dsh-think-zh/config.json`，翻译缓存在同目录的 `cache.json`。

缓存按**原文整句**存，**上限 4000 条，满了按最旧淘汰**。长期使用后会达到上限
（实测约 1.9 MB），此时新译文顶掉最旧的条目——被淘汰的译文再次出现时会重新翻译一次，
**只是慢一点，不影响正确性**。

清空缓存：删掉 `cache.json` 后重启应用（或重存一次设置）。
想留更多历史：把 `lib/index.js` 里的 `new TranslationCache(4000, cacheFile)` 调大后重启。

## 已知限制

- **只覆盖 Chat 视图。** `ui-trajectory` 独立渲染推理，不经过本次遮蔽的插槽。
- **折叠的「过程组」标题仍是英文。** 进程组的运行中标题来自另一份数据源，不在本次接管范围内。
- **展开内置的「思考」行会看到英文正文。** 中文行是另画的一行；内置行保留原文作为证据。
- **翻译不进入服务端，也不进会话日志**，因此历史会话里存的是英文原文，中文是每次显示时重算的
  （有缓存，但缓存按长度存，重启宿主后首次显示会重新翻一次）。
- 翻译质量取决于引擎；短到几个词的碎片可能被跳过（避免无意义调用）。
- 设置面板挂在页面右上角。若与你的界面控件重叠，调整 `client.source.js` 中的定位值即可。
- 引擎不是启动时一次解析就固定：模型服务（`llm`）出现或变化时会自动重建引擎；
  引擎不可用时面板会说明原因，翻译请求返回空结果并保持英文原文显示。

## 开发

```bash
node scripts/build-client.mjs   # client.source.js -> lib/client.js（__ModuleLoader__ 包壳）
node test/text.test.mjs         # 分句 / 语言判定 / Markdown 掩码
node test/translator.test.mjs   # 分块、缓存命中、成本不重复
node test/client.test.mjs       # bundle 装载、插槽遮蔽注册、块替换
```

`lib/client.js` 是生成物，不要直接改；改 `client.source.js` 后重新构建。
