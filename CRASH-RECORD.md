# dsh-think-zh 崩溃记录

**项目**：`dsh-think-zh` —— 把模型思考过程（reasoning）实时翻译成中文显示的 DSH 插件
**宿主**：DeepSeek Harness Desktop 0.2.0-rc.2（Electron 44 / Chrome 152 / Node 24.18.1 / macOS arm64）
**事故窗口**：2026-10-02 07:33 – 08:45（约 72 分钟）
**结果**：**未解决**。插件已从 profile 移除，配置已还原。启动崩溃的真实原因**未被捕获**——它在代码里存在，但被宿主丢弃了。

---

## 一、崩溃签名

**用户可见**（原生对话框）：

```
应用无法启动或已意外停止。
web boot: 1 entry did not activate
dsh-think-zh: import failed (see console for the import error)
诊断报告：~/Library/Logs/DeepSeek Harness/crash-*-web-boot.log
```

**日志里只有这一句**，10 次崩溃完全一致：

```
Error: web boot: 1 entry did not activate
dsh-think-zh: import failed (see console for the import error)
    at file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/lib/main.js:11573:15
--- renderer console (error level, oldest first) ---
dsh-app://app/assets/index-5SrrfWpU.js:126 Error: web boot: 1 entry did not activate
dsh-think-zh: import failed (see console for the import error)
```

**关键**：`(see console for the import error)` 指向的 console **从不落盘**。
`ELECTRON_ENABLE_LOGGING=1` 对渲染层**无输出**（实测 `/tmp/dsh-boot.log` 2335 字节，只有 update / deepseek-account 请求行，无任何 `CONSOLE` 行）。

---

## 二、为什么这行错误拿不到（本记录最重要的一节）

`web-frontend`（`dist/assets/index-5SrrfWpU.js`）里生成该消息的代码：

```js
function eM(e, n) {                       // e = ctx, n = modules
  const o = [];
  for (const s of e.loader.entries()) {
    const a = s.options.name;
    if (s.fiber === void 0) {
      const f = n.importError(a);         // ← 真实错误在这里
      o.push(f === undefined
        ? `${a}: import failed (see console for the import error)`   // ← 走了这个分支
        : `${a}: import failed: ${f.message}`);                      // ← 真凶，永远没打印
      continue;
    }
    ...
  }
  if (o.length > 0) throw new Error(`web boot: ${String(o.length)} entry did not activate\n${o.join('\n')}`);
}
```

**宿主知道原因，只是把它丢了。** `importError(a)` 返回 `undefined`，于是打印兜底文案。

`importError` 位于模块系统内部对象（`ctx.modules`），经过以下尝试全部不可达：

| 尝试 | 结果 |
|---|---|
| 页面里找 `globalThis._ModuleLoader__` | `undefined`（boot 结束后已被移除） |
| `globalThis.dshDesktopBoot` | 只有 `{ ready, failed }` 两个方法，无 modules |
| `globalThis.__DSH_BOOT__` | 只有启动图（`entries` / `batches` / `rev`） |
| `__DSH_BOOT_READY__` | 只是个标记对象 |
| CDP 采集 renderer console | 基线正常，但**崩溃那次拿不到**（见下） |

### 闭环：想观测的进程正好是崩溃的那个

```
装插件 → 启动 → 宿主加载插件失败 → 应用退出
                                    ↓
                     宿主进程与调试端口一起消失
                                    ↓
                 CDP 探针（document-start）失去注入时机
                                    ↓
                 恢复模式清空 profile 配置
                                    ↓
                     下次启动的是「无插件」实例
```

`Page.addScriptToEvaluateOnNewDocument` 注入的探针在 app 重启时随 CDP 会话一起失效；
崩溃实例的 renderer 虽然还活着（能读到侧栏、67 个 entry），但里面没有那次失败的记录。

---

## 三、事故时间线

每一轮都是同一个循环：**装插件 → 崩溃 → 恢复模式改写配置 → 重开成无插件实例**。

| 时间 | 事件 | 证据 |
|---|---|---|
| 07:33:00 | 我首次安装（软链 + patch 行） | `cordis.patch.yml.bak-20261002-073300`（7 行，我装前的原版） |
| 07:36:20–07:37:17 | 连续 5 次启动失败 | `crash-*-web-boot.log` ×5 |
| 07:37:19 | **恢复模式第 1 次改写配置** | `cordis.patch.yml.bak-1790897839459`（8 行） |
| 07:45:14 | 修掉 `__ModuleLoader__` 拼写，重建产物 | `lib/client.js` |
| 07:46:21 | 我恢复配置（8 行） | `bak-before-restore-20261002-074621` |
| 07:47:19 | **恢复第 2 次改写** | `bak-1790898439622` |
| 07:46:56–07:53:16 | 又 4 次启动失败 | `crash-*` |
| 07:53:18 | **恢复第 3 次改写** | `bak-1790898798267` |
| 07:55:57 | 我再次安装（含 Ollama 配置） | `package.json.bak-with-plugin-*` |
| 08:11:26 | **恢复第 4 次改写** | `bak-1790900057487` |
| 08:14:17 | **恢复第 5 次改写** | `bak-1790900786700` |
| 08:22:34 | **恢复第 6 次改写** | `bak-1790901000272` |
| 08:26:26 | **恢复第 7 次改写** | `bak-1790901527130` |
| 08:29:41–08:38:44 | 又 4 次启动失败 | `crash-*` |
| 08:44:54 | 我回滚到可用状态 | `bak-before-restore-20261002-084454` |
| 08:45+ | 恢复你的原版配置（含 Ollama） | 见第七节 |

**累计**：8 次启动崩溃（`crash-*web-boot.log` 10 份中含 2 份为基线诊断），**7 次配置被恢复模式静默改写**。

### 恢复模式造成的附带损失（用户未必察觉）

`sanitizeProfile()`（`@deepseek-ai/dsh-app-boot`）会：

1. 把 `cordis.patch.yml` 重命名为 `cordis.patch.yml.bak-<毫秒时间戳>`
2. **只写回「设置类」row**，丢掉所有手写配置

实测被丢掉的：

| 丢失内容 | 后果 |
|---|---|
| `llm-pi-ai` row（Ollama provider：3 个本地模型定义 + `OLLAMA_API_KEY` 说明） | **Ollama 三个本地模型从界面消失** |
| `agent-default-model`（deepseek-account / deepseek-flash） | 默认模型选择丢失 |
| `ui-theme`（字号 15）、`agent-preset-registry`（preset cordis） | 界面偏好回默认 |
| `package.json` 里 `dsh-whale-widget` + 2 个 experimental bundle 的 bundles 条目 | **鲸鱼挂件与两个实验功能被禁用** |
| `ui-chat` 的 `transcriptView`/`performanceUsage` | 从 `detailed` 被重置为 `standard`/`compact` |

---

## 四、根因分析（未能定论，但已排除到只剩一个）

### 已确证的事实链

| 事实 | 证据来源 |
|---|---|
| 插件**宿主半区**在真实宿主里正常挂载并工作 | 隔离宿主 `/dsh-think-zh/config` → **HTTP 200**；`dsh` 引擎 1.8s 翻译成功；`ollama` 引擎 2.3s 翻译成功 |
| 客户端产物**本身可执行**：桌面加载顺序下不抛错、恰好注册一次 | 从宿主抓取真实产物（27460 字节）跑桌面顺序模拟 |
| bundle **被成功请求**且返回 200 | CDP 抓到 `<- HTTP 200 dsh-app://app/plugins/??dsh-think-zh/client.js&rev=27d551486a84` |
| 插件行**确实进入启动图** | 启动图 row：`{id: dsh-think-zh, url: plugins/??dsh-think-zh/client.js&rev=…, inject: [chat]}` |
| 桌面壳**会把 bundle 转发给宿主** | 读 `protocol.handle` + `forwardWebRequest`：`dsh-app://app/` 下除 index/assets 外全部带 cookie 转发，query 保留 |
| **宿主启动图是启动时快照，页面 reload 不刷新** | 实测：磁盘装插件后 reload，`entries: 67, hasMine: false` |
| 运行中的正常实例里 `_ModuleLoader__` 最终为 `undefined` | CDP 实测 `typeof globalThis._ModuleLoader__` → `"undefined"` |

### 唯一剩下的假设（有强证据但未直接验证）

宿主注入行的**下发顺序**与桌面壳的**应用方式**存在时序错位：

```js
// renderer 侧 hM()：桌面壳自己应用注入行
case "script":      document.head.append(s);   // 同步，不 await   ← 应用 combo 走这条
case "script-src":  await loadScript(src);     // await            ← 引导脚本走这条
```

而宿主按 `queue → script-preload → script-src(bootstrap) → global` 的顺序下发，也就是：

```
1. queue     定义 __ModuleLoader__ 队列      kind:"script"     同步执行
2. preload   应用 combo 预加载                kind:"script-preload" 桌面壳跳过
3. bootstrap 加载 client-modules             kind:"script-src"  await
4. global    __DSH_BOOT__                    kind:"script"
```

**旁证**：07:36 那次的 renderer console 里，抛 `ReferenceError: _ModuleLoader__ is not defined` 的是
**`index-5SrrfWpU.js` 的第 5855 行**，而我的 bundle 只有 711 行——**说明 DSH 自己的客户端 bundle 也在
`_ModuleLoader__` 未定义时执行了**。这不是我插件独有的问题，而是桌面端的既有行为。

然后 `create()` 的实现是：

```js
create(options) {
  if (this.mode !== "queue") throw new Error("...create called after module-system boot");
  const index = pendingQueue.findIndex(r => r.id === "@deepseek-ai/dsh-client-modules");
  const registration = pendingQueue[index];
  if (registration === undefined) throw new Error("client-modules: HTML did not preload ...");
  ...
}
```

**`create()` 只认已经躺在 `pendingQueue` 里的注册。** 我的 bundle 最早是"轮询等 `_ModuleLoader__` 出现再注册"（异步），
若 `create()` 在同一任务里先跑，就会判定该 entry 从未 preload → entry 永不激活 → `import failed`。

**为什么没能直接证实**：需要在那次失败启动的 renderer 里放一个 document-start 探针记录
`loader-published` / `our-registration-in-queue` / `create-called` 的先后，但探针与崩溃进程同生共死。

### 最终修复方向（下次继续时的第一选择）

不要把注册交给异步轮询。在 bundle 顶层**同步**处理两种时序：

```js
// 时序 A：应用 combo 先于引导脚本执行 —— 此时应能拿到队列 facade（第 1 行已执行）
// 时序 B：引导已完成 —— 此时 loader 不可用，应改为把注册登记到壳自己能看见的地方
```

具体做法需要先拿到**真实时序**，否则仍是猜测——这正是本次停手的原因。

---

## 五、验证手段与观测能力（踩过的坑）

### 有效的

| 手段 | 用途 |
|---|---|
| 隔离 profile（`DSH_HOME=/tmp/... --profile <name>`）复制真实 `package.json` + patch | 不碰用户 profile 就能真启动验证 |
| `dsh --dump-config` | 验证 YAML 组合能解析（**注意：只解析，不启动，不能替代真启动**） |
| 从宿主抓真实产物 + 在 Node 里按桌面顺序执行 | 验证产物本身与加载顺序 |
| **CDP**（`--remote-debugging-port=9222`） | 唯一能读到 renderer console 的手段；`scripts/cdp-console.mjs` |
| `Log.entryAdded` / `Runtime.exceptionThrown` / `Network.*` 三域全开 | 拿 URL、行列号、失败请求 |
| 应用自带 Electron 的 CDP 端点 | `DevTools listening on ws://127.0.0.1:9222/devtools/browser/...` |

### 无效的

| 手段 | 为什么无效 |
|---|---|
| `ELECTRON_ENABLE_LOGGING=1` | 对该应用渲染层零输出（实测 0 条 CONSOLE 行） |
| 崩溃日志 `crash-*-web-boot.log` | 只有兜底文案，没有 `f.message` |
| 在我环境里跑应用自带 Electron | `sandbox initialization failed: Operation not permitted`（我的沙箱限制） |
| `qlmanage -t` 抽视频帧 | 失败（无 ffmpeg 可用） |
| `Target.setAutoAttach` + `waitForDebuggerOnStart` 抓 boot | 崩溃时端口随进程消失，抓不到那一次 |
| `Page.addScriptToEvaluateOnNewDocument` 装探针 | app 重启导致 CDP 会话失效，探针随之失效 |

---

## 六、被证伪的假设（避免下次重走）

| # | 假设 | 证伪方式 |
|---|---|---|
| 1 | bundle 没有组装进启动图 | 启动图里明确有该 row，rev 与本地组装一致 |
| 2 | 客户端产物本身有问题 | 真实产物在桌面顺序下不抛错、注册一次 |
| 3 | 宿主半区没挂载 | 隔离宿主 `/dsh-think-zh/config` → 200 |
| 4 | 必须进 profile `dependencies` | 实测不需要；只在 `node_modules` 放软链 + patch 行即可激活 |
| 5 | 桌面壳没把 bundle 转发给宿主 | 读到 `HTTP 200` 响应；`forwardWebRequest` 代码确认 |
| 6 | `tapIndex` 在桌面端不生效需要注入行 | 与本插件无关（那是鲸鱼挂件走的路） |

---

## 七、当前状态

### profile（已还原为你的原版）

```
bundles: [dsh-base, dsh-web-app, dsh-whale-widget,
          dsh-experimental-auto-review, dsh-experimental-voice-input-bundle]
deps   : [dsh-whale-widget ^0.3.17]
patch  : 7 行  → agent-default-model / ui-settings-account / ui-chat / ui-settings
                 / llm-pi-ai（Ollama 3 个本地模型）/ ui-theme / agent-preset-registry
```

`dsh-think-zh` 无任何残留（软链、patch 行、依赖均已移除）。

### 插件产物（工作区保留）

```
dsh-think-zh/
  lib/index.js        宿主半区：路由、配置持久化、引擎装配、默认模型回退
  lib/translator.js   分句、按整句缓存、只翻新增、低产出比值告警
  lib/translate.js    三个引擎适配器（dsh / ollama / openai-compatible）
  lib/text.js         分句器（缩写、小数、首字母缩写、代码块掩码）
  client.source.js    浏览器半区源码（插槽遮蔽渲染器）
  lib/client.js       构建产物（_ModuleLoader__ 包壳 + 延迟注册）
  scripts/            build-client / smoke-client / bench-engine / cdp-console / install-desktop
  test/               text / translator / client / registration（4 套）
```

`node test/*.test.mjs` 全绿；`scripts/smoke-client.mjs` 通过。

### 关键备份（可回溯到任意阶段）

| 文件 | 内容 |
|---|---|
| `cordis.patch.yml.bak-20261002-073300` | **你的原版 patch**（7 行，含 Ollama），事故前状态 |
| `cordis.patch.yml.bak-1790897839459` | 第 1 次恢复前（8 行，含我加的插件行） |
| `package.json.bak-before-fix-20261002-075051` | 07:50 的 package.json |
| `/tmp/restored-patch.yml` | 我构造的 8 行完整版（含插件行） |

---

## 八、八条经验教训

1. **验证环境必须与部署环境同构。** 我在 Web 载体上验证通过，而桌面载体的注入方式完全不同（`script` 同步 append vs HTML 内联 `<script src>`）——结论不可迁移。

2. **可以 mock，但不能 mock 掉待验证的东西。** 我的测试装了 `_ModuleLoader__` 的 stub，结果既没发现 bundle 里写的是 `__ModuleLoader__`（只差一个下划线），也没发现加载顺序问题。

3. **`--dump-config` 通过 ≠ 能启动。** 我最后一次"验证"只跑了 dump（只解析 YAML），就请你重启——那是一切混乱的起点。

4. **客户端 bundle 顶层代码抛异常 = 应用无法启动。** 桌面端把应用 combo 里的异常当致命错误。任何插件改动都必须先过"无 loader 环境下不抛错"的闸门（`scripts/smoke-client.mjs` 就是为此加的）。

5. **应用的恢复模式会静默破坏用户配置。** 每次崩溃都会重写 `cordis.patch.yml` 与 `package.json`，丢掉手写配置与第三方 bundle。**插件出错的代价不是"插件不生效"，而是"用户的 Ollama 配置和挂件一起消失"。** 这条代价严重到足以改变是否该在用户主 profile 上做实验的决定。

6. **不要在拿到观测手段之前安装。** 我在能读到 renderer console 之前就让你重启了 5 次，每一次都在猜。正确顺序是：先建立可观测性（CDP），再动部署。

7. **失败要失败得安全。** 应该先考虑"崩了也能一条命令恢复"的机制（例如用 home 层 patch 而非 profile patch），再考虑功能。

8. **文档没写清的地方不要手写协议。** `dsh.client` 的 bundle 包壳、加载顺序、注册时机都缺少可运行样例；这台机器上没有任何第三方客户端插件先例，而鲸鱼挂件走的是完全不同的宿主注入路径。**没有先例的协议，应该先找官方样例。**

---

## 附：可复现的诊断资产

| 脚本 | 用途 |
|---|---|
| `scripts/cdp-console.mjs` | 连 CDP 采集 renderer console / 异常 / 失败请求（本记录的核心工具） |
| `scripts/smoke-client.mjs` | 装机前硬闸门：无 loader 环境求值不抛错 + 恰好注册一次 |
| `scripts/bench-engine.mjs` | 翻译引擎压测（延迟、格式合规、Markdown 保留、标识符保留） |
| `test/registration.test.mjs` | 注册契约回归测试（同步注册 / 全局名 / apply+inject） |
| `scripts/install-desktop.sh` | 幂等安装（含 smoke 闸门），带备份 |

复现启动失败：

```bash
# 1. 装插件（备份 + 软链 + patch 行 + package.json）
bash dsh-think-zh/scripts/install-desktop.sh
# 2. 启动带调试端口的实例
"/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  --remote-debugging-port=9222 --remote-allow-origins='*'
# 3. 另一个终端采集（需在崩溃前连上）
node dsh-think-zh/scripts/cdp-console.mjs --port 9222 --out /tmp/renderer.log
# 4. 崩溃后恢复
cp ~/.dsh/profiles/desktop/cordis.patch.yml.bak-20261002-073300 \
   ~/.dsh/profiles/desktop/cordis.patch.yml
```

**下一步的第一件事**：让 `eM()` 打印 `f.message`（3 行补丁，可还原），或找到官方第三方客户端插件样例。在此之前不要再次安装。
