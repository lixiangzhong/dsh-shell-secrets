# @lixiangzhong/dsh-shell-secrets

[![npm version](https://img.shields.io/npm/v/@lixiangzhong/dsh-shell-secrets.svg)](https://www.npmjs.com/package/@lixiangzhong/dsh-shell-secrets)
[![license](https://img.shields.io/npm/l/@lixiangzhong/dsh-shell-secrets.svg)](./LICENSE)

一个 [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（DeepSeek Harness）插件：把**启动 dsh 时环境里**
名字匹配 `KEY` / `PASSWORD` / `SECRET` / `TOKEN` 的变量，以**原始变量名**注入 bash 工具的子进程。
匹配正则可以在**插件页的配置界面**里修改（实时生效，优先于启动环境变量）。

```bash
export GITHUB_TOKEN=ghp_xxx PGPASSWORD=secret
dsh web
```

之后模型通过 bash 工具执行命令时，`gh`、`psql`、`aws`、`curl` 这类自己读环境变量的 CLI **无需改写**：

```bash
gh auth status              # 直接读 $GITHUB_TOKEN
psql -h db -U app           # 直接读 $PGPASSWORD
```

---

## ⚠️ 安全须知

> 这个插件**有意绕过** dsh 的凭证隔离机制。启用之后，匹配到的变量会进入**每一个** bash 子进程 ——
> 包括 `npm install` 的 postinstall 脚本，以及模型运行的任意第三方二进制。
>
> 只要模型执行 `env`，这些值就会出现在工具结果里，也就是**会话日志与模型上下文**里。插件无法对
> 输出做脱敏，也无法撤回已经写进日志的值。
>
> 建议：
>
> - 只在**受信的 workspace 和会话**里使用；
> - 验证时只列变量名，不要打印值：`env | cut -d= -f1 | grep -E '_TOKEN$|PASSWORD$|_KEY$'`；
> - 一旦有值进了日志又不想留，**直接轮换该密钥**。

---

## 为什么需要它

dsh 在启动子进程前会做一次固定的凭证清理：名字匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的变量、
以及所有 `DSH_*`，都不会传给 bash 子进程。因此即使用户在自己的 shell 里 `export GITHUB_TOKEN=...`，
模型执行的命令里也读不到它。

dsh 官方提供的插件接缝 `ctx.shellEnv` 只能注册 `DSH_*` 前缀的变量，命令里得写成
`$DSH_GITHUB_TOKEN`，对 `gh`、`psql` 这类直接读 `GITHUB_TOKEN` / `PGPASSWORD` 的 CLI 没用。

本插件改为接管 shell 执行器，把同一批变量以**原始名字**放回子进程环境 —— 走的仍是 dsh
文档化的落点（`ShellExecSpec.env`，语义是"在凭证清理之后合并"）。

## 安装

**环境要求**：已安装 `dsh` CLI（本插件在 dsh 进程内运行，Node 版本要求 ≥ 22）；用 `dsh plugin`
管理插件时需要 `pnpm`（dsh 自身用 pnpm 管理 profile 依赖）。

### 从 npm 安装（推荐）

```bash
dsh plugin --profile web add @lixiangzhong/dsh-shell-secrets
```

`dsh plugin` 会把包装进 `~/.dsh/profiles/<profile>/node_modules`，并把包名追加到
`dsh.profile.bundles` 层（因为包里声明了 `dsh.bundle.patch`），**不需要手改任何 YAML**。

`--profile` 按需替换（`web` / `tui` / `headless` …）。装好后**重启 dsh** 才会生效。

### 从源码或离线 tarball 安装

```bash
# 目录形式
dsh plugin --profile web add file:/path/to/dsh-shell-secrets

# tarball 形式（npm pack 产物）
dsh plugin --profile web add file:./lixiangzhong-dsh-shell-secrets-0.1.0.tgz
```

本地安装必须使用 `file:`（会落成真实目录），**不要用 `link:`**：软链会让 Node 按真实路径去
源码目录解析 dsh 自身的包，从而加载到**两份** harness 模块实例，服务注册会出问题。

### 升级与卸载

```bash
dsh plugin --profile web update @lixiangzhong/dsh-shell-secrets    # 升级到最新版
dsh plugin --profile web add @lixiangzhong/dsh-shell-secrets@0.1.0 # 或指定版本
dsh plugin --profile web remove @lixiangzhong/dsh-shell-secrets    # 卸载（依赖 + bundle 层一起移除）
```

升级/卸载后同样**需要重启 dsh**。

### 生效时机

| 改动 | 生效方式 |
| --- | --- |
| 启动环境里的密钥变量 | 重启 dsh |
| `DSH_SHELL_SECRETS_*` 配置 | 重启 dsh |
| 界面里的匹配正则（`pattern`） | 保存后立即生效，下一次 bash 命令即使用新规则 |
| 插件版本（安装 / 升级 / 卸载） | 重启 dsh |

变量与启动期环境配置都来自 **dsh 启动时的那个环境**，进程启动后不再变化；界面配置写在
profile 的配置层里，重启后保留。

## 配置

### 配置界面（推荐）

安装并启用插件后，从**左侧栏的「插件」(Plugins) 面板**进入（注意：不是「设置」里的插件
清单，那里是只读的），切到 **已安装**，点开本插件（标题为 **Shell 密钥注入**），在 **行**
列表里点 `shell-secrets` 这一行（标题带 `›`，点开即配置页），即可编辑变量名匹配正则：

- 输入框留空表示**清除覆盖**，回退到启动环境的 `DSH_SHELL_SECRETS_PATTERN`，
  再回退到内置默认 `KEY|PASSWORD|SECRET|TOKEN`；
- 表单会显示是否处于「已覆盖」状态，并校验正则语法（非法正则不会被保存）；
- 保存后 harness 原地更新该 volatile 配置，**不需要重启 dsh**，下一次 bash 命令生效；
- 启动环境里的其它开关（`INCLUDE` / `EXCLUDE` / `MAX_BYTES` / `DISABLE`）仍然有效，
  其中 `INCLUDE` 一旦设置就优先于界面正则。

### 环境变量

全部通过环境变量（在**启动 dsh 之前**设置）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_SHELL_SECRETS_PATTERN` | `KEY\|PASSWORD\|SECRET\|TOKEN`（忽略大小写） | 自定义匹配正则。默认值与 dsh 自身的凭证清理规则一致，保证"被清掉的正好被补回来"。界面配置的正则优先于它 |
| `DSH_SHELL_SECRETS_INCLUDE` | 空 | 逗号分隔的 glob（`*` / `?`），**优先于** `PATTERN` 与界面正则，例如 `*_TOKEN,AWS_*` |
| `DSH_SHELL_SECRETS_EXCLUDE` | 空 | 逗号分隔的 glob 排除项，例如 `MONKEY,KEYBOARD_*`（修掉子串误伤） |
| `DSH_SHELL_SECRETS_MAX_BYTES` | `8192` | 单个值的长度上限，超长跳过 |
| `DSH_SHELL_SECRETS_DISABLE` | 空 | 设为任意非空值即停用注入（不必卸载插件） |

规则细节：

- **`DSH_*` 永不注入**：保持 dsh "外部传入的 `DSH_*` 会被丢弃" 的既有约定，避免伪造框架自身的事实。
- 默认规则是**子串匹配**，因此 `MONKEY`、`KEYBOARD_LAYOUT` 这类名字也会命中 —— 用 `EXCLUDE` 排除即可。
- 空值、纯空白、超长值会被跳过；含换行的值仍会注入（保真优先），但会在装载日志里提示。
- 启动期配置非法（正则写错、上限非正整数）会让**插件装载失败并报错**：宁可启动时报错，也不要静默不注入；
  界面写入的正则非法时不会被保存，若被手工改坏则由宿主回退到最后一次可用规则并在日志里报错。
- 装载日志只打印**变量名与原因，绝不打印值**。

## 快速验证

```bash
# 1) 在启动 dsh 的 shell 里设置一个测试变量，然后启动 dsh
export MY_TEST_PASSWORD=probe-ok
dsh web
```

```bash
# 2) 在 dsh 的 bash 工具里执行
echo "${MY_TEST_PASSWORD-unset}"        # → probe-ok（原始名字可用）

# 只列名字，不要打印值
env | cut -d= -f1 | grep -E '_TOKEN$|PASSWORD$|SECRET$|_KEY$' | sort
env | cut -d= -f1 | grep '^DSH_'        # 应只有 DSH_HOME / DSH_SHELL / DSH_SESSION_ID / DSH_WEB_URL
```

界面配置验证（无需重启）：

1. 打开**左侧栏「插件」面板 → 已安装**，进入本插件，点开 **行** 列表里的 `shell-secrets`
   （标题带 `›`，点开即配置页）；
2. 输入 `^MY_TEST_PASSWORD$` 并保存（表单应显示「已覆盖」）；
3. 再次执行 `echo "${MY_TEST_PASSWORD-unset}"`，仍然得到 `probe-ok`，说明新规则已生效；
4. 点 **恢复默认** 保存，清除覆盖。

## 已知限制

- **只处理 bash 执行器**。使用持久 PTY shell 的场景（`minimal` agent preset、`sdk-minimal` profile）
  走的是另一套 `terminals` 服务，不在覆盖范围内。
- **Windows 的 pwsh 未覆盖**（机制上可同构补充，尚未实现）。
- **密钥值只从启动环境读取**，不读文件；dsh 启动之后才 export 的变量不会生效。
  启动环境的值在进程生命周期内固定；界面里的 `pattern` 保存后会立即重算注入集合。
- 界面只编辑匹配正则；`INCLUDE` / `EXCLUDE` / `MAX_BYTES` / `DISABLE` 仍由启动环境变量控制。

## 兼容性

本插件通过覆写 shell 执行器实现，因此绑定了 dsh 的内部接口：

- `@deepseek-ai/dsh-bash-sandbox` 导出的 `SandboxBashExecutor`，及其 `resolve` / `execute` 方法
  （0.2.x 的接缝：前台/后台统一走 `execute`，由调用方是否等待结果区分）；
- `ShellExecSpec.env` 的合并语义（在凭证清理之后合并）；
- `ctx.shell` 服务名与 `bash-sandbox` 配置行。

配置界面同样绑定 dsh 的插件配置接口：

- 插件行 `Config` 在基类 volatile 字段之后追加 `pattern`（`@deepseek-ai/schemastery`）；
- 浏览器半边通过 `plugins.row.config` 槽注册（键为 `<包名>#shell-secrets`），表单数据由
  harness 的 `settings` / `configForms` 提供，不直连 profile 文件。

为了尽早暴露不兼容，插件装载时会做一次自检，并在 dsh 日志里以 `error` 级别报告（**不阻断启动**，
以免误报导致 dsh 起不来）：

- 基类是否仍提供 `resolve` / `execute`；
- 插件解析到的 harness 包与 dsh 自身使用的是否是**同一份**（避免 profile 里装出第二份 harness 包）。

如果 harness 不再把 shell 行的 `pattern` 当作可编辑的 volatile 字段，插件仍会正常启动并注入
（只是界面配置不可用），日志里会给出警告。

**已测试环境**

| dsh | Node | 平台 | 结果 |
| --- | --- | --- | --- |
| 0.2.2-rc.1 | 26.x | macOS | 前台与后台任务路径均注入成功；插件页配置界面；单元测试 17/17 |

其它版本/平台（尤其 Windows）尚未验证，欢迎反馈。dsh 升级后建议确认一次：

```bash
echo "${GITHUB_TOKEN-unset}"                                     # 或任一敏感变量
env | cut -d= -f1 | grep -E '_TOKEN$|PASSWORD$|SECRET$|_KEY$'    # 只列名字
```

## 常见问题

**装了但命令里读不到变量**

1. 变量是在**启动 dsh 的那个 shell** 里 export 的吗？（`.zshrc` 里 export 也可以，但要重启 dsh）
2. 装/改配置之后**重启 dsh** 了吗？
3. 用 `env | cut -d= -f1 | grep '^DSH_'` 之外的方式确认名字是否在注入清单里；装载日志会打印
   `可注入密钥变量 N 个: ...`，若为 0 并伴随警告，说明启动环境里没有匹配项或 `PATTERN` 写错了。

**插件页里没有「配置」入口，或界面显示「该插件当前未加载」**

1. 入口在**左侧栏的「插件」(Plugins) 面板 → 已安装**；「设置」里的插件清单是只读的，没有
   配置表单；
2. 确认本插件在当前 profile 里已安装并启用，且 `shell-secrets` 这一行处于启用状态；
3. 如果插件页在安装之前就已经打开，**刷新一次页面**（或切走再切回插件面板），让新的
   bundle、行和客户端模块进入列表；必要时重启 dsh；
4. 确认 `cordis.patch.yml` 里的 `shell-secrets` 行没有被其它层覆盖成 `disabled: true`。

**界面上改了 pattern，但命令里还是读不到变量**

1. 保存后表单是否显示「已覆盖」？保存失败会显示错误信息（例如正则语法错误）；
2. 如果启动环境设置了 `DSH_SHELL_SECRETS_INCLUDE`，它优先于界面正则；
3. 如果设置了 `DSH_SHELL_SECRETS_DISABLE`，注入整体停用；
4. 密钥变量的**值**仍只来自启动环境，改 pattern 不会凭空产生变量。

**安装时报 `service "shell" has been registered` / 装完 bash 工具不见了**

本插件的 patch 要"停用官方 `bash-sandbox` + 插入自己的执行器"。在**运行中的** dsh 上首次
热安装时，harness 的 HMR 可能先挂新行、再拆旧行，撞上重复服务；失败后本会话的 shell 服务
会缺失，bash 工具不可用。处理：

1. **重启 dsh**（推荐）：重启后一次性合成 patch，插件正常生效，bash 工具恢复；
2. 或者关掉 dsh，用 `dsh plugin --profile <profile> add <spec>` 安装后再启动；
3. 需要在运行中热装时，可分两阶段：先只发布"停用 `bash-sandbox`"的 patch，等旧行释放后
   再发布完整 patch（插件管理器里对 bundle 重新执行一次启用）。

**`dsh plugin add` 报 `ERR_PNPM_UNEXPECTED_STORE`**

profile 的 `node_modules` 与当前 `pnpm` 的大版本不一致（store 版本不同）。两种处理：使用与
profile 一致的 pnpm 版本重建一次（`cd ~/.dsh/profiles/<profile> && pnpm install`），或者统一
本机的 pnpm 版本。

**`dsh plugin add` 报 404 / 找不到包**

使用了企业或国内镜像，而镜像尚未同步新包。显式指定官方 registry：

```bash
dsh plugin --profile web add @lixiangzhong/dsh-shell-secrets --registry=https://registry.npmjs.org
```

**误把值打印出来了**

无法撤回，请轮换该密钥；后续验证只列名字。

## 工作原理（简述）

1. 插件在装载时读一次启动环境，按配置挑出需要注入的变量（纯函数逻辑，见 `lib/secrets.js`）；
2. 用 `SecretsBashExecutor` 接管 dsh 的 shell 执行器（覆写唯一的 `execute` 入口）；
3. 每次执行前把这些变量并入 `ShellExecSpec.env` —— 该字段由 dsh 在凭证清理**之后**合并，
   因此原始变量名能进入子进程环境，同时不会覆盖 dsh 自己注入的 `DSH_*`（那些走另一个字段）；
4. 配置界面写入的 `pattern` 是插件行 Config 里的 volatile 字段：保存时由 harness 原地更新，
   下一次命令按新规则重算注入集合，不重启、不重挂执行器。

插件只做"把已有变量放回去"，不读文件、不访问网络、不做持久化（配置由 harness 的
profile 配置层保存）。

## 开发

```bash
node --test               # 单元测试（纯逻辑；schema 测试会借用当前 dsh profile 的 schemastery，缺失时跳过）
npm pack --dry-run        # 查看发布产物
```

本地联调：把仓库目录以 `file:` 方式装进 profile（见上文），改完代码后重新
`dsh plugin remove && add` 并重启 dsh。仓库内的 `deploy.mjs` 提供了不依赖 pnpm 的
备用部署方式（拷贝 + 手写挂载行），适用于无法使用 pnpm 的环境。

维护者笔记（本机环境、踩过的坑、发布流程）见 [`NOTES.md`](./NOTES.md)。

## 许可证

[MIT](./LICENSE)
