# 来源说明 · PROVENANCE

## 本项目代码

全部为原创实现，围绕 DeepSeek Harness 的**公开机制**编写：

| 机制 | 用途 |
|---|---|
| `package.json` 的 `dsh.bundle.patch` / `dsh.client` | 声明插件包与客户端产物 |
| `cordis.patch.yml` 的 `insert` 行 | 声明插件条目 |
| `window.__ModuleLoader__.load({...})` | 客户端 bundle 注册（**与官方 57 个 bundle 同形**） |
| `ctx.slots.register({ priority })` | 插槽遮蔽，包裹内置渲染器 |
| `assistant/live-chunk` 事件的 `reasoning-delta` | 读取推理增量 |

## 参考过的东西

- **官方包的中文文档与产物**：为确认接口形态，读过 `app.asar` 里官方包的
  `README.zh.md` 与 `lib/client.js`（例如 `dsh-client-ui-goal` 的导出尾部）。
  **没有复制任何官方代码**，只用于确认调用契约。
- **`dsh-whale-widget` 的包结构**：`package.json` 字段布局、
  `files` 白名单、`PROVENANCE.md` 这个文件本身的存在形式，参照了它。
- **本地模型实测数据**：翻译模型选型所用的延迟/质量数据来自本机
  `Ollama` 实测（300+ 次），不是抄来的榜单。

## 产物与源码的关系

`lib/client.js` **是构建产物，也纳入版本管理**：

- 源码：`client.source.js`（唯一需要手改的文件）
- 构建：`node scripts/build-client.mjs` → `lib/client.js`
- 为什么入库：宿主直接加载 `exports["./client"]` 指向的产物，
  且产物与源码**逐行对应**（构建器只做模块包壳，不做压缩/混淆），
  `diff` 可读。入库让使用者无需构建即可安装。

**改了 `client.source.js` 必须重新构建**，否则改动不生效。

## 第三方依赖

运行时**无须任何第三方 npm 依赖**：

- 宿主半区只用 Node 内置模块
- 客户端半区通过宿主提供的 `require` 取 `react` / `react-dom/client` /
  `@deepseek-ai/dsh-client-ui-primitives`（**由宿主注入，不随包分发**）

开发期依赖：无（测试用 Node 内置 `node:test` 断言风格的手写断言，无测试框架）。

## 外部服务

| 服务 | 是否必需 | 说明 |
|---|---|---|
| Ollama（`http://127.0.0.1:11434`） | 可选 | 选「Ollama 本地」引擎时需要；默认模型 `qwen2.5:1.5b` |
| DSH 已配置模型 | 可选 | 选「DSH 已配置模型」引擎时使用账号额度 |
| OpenAI 兼容端点 | 可选 | 自填地址与 Key |

宿主路由**只监听回环地址**；配置与翻译缓存写在 `$DSH_HOME/dsh-think-zh/`。
选 Ollama 引擎时，推理内容**不出本机**。

## 无关联声明

本项目与 DeepSeek 官方无隶属或背书关系，是第三方插件。
「DeepSeek」「DeepSeek Harness」为其各自权利人的商标。
