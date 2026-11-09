# 维护者笔记（NOTES.md）

本文件**不打进 npm 包**（`package.json` 的 `files` 是白名单，只含 `lib/`、`cordis.patch.yml`、
`README.md`、`LICENSE`）。这里记录开发环境、踩过的坑与发布流程，供后续维护使用。

## 开发环境（本机 / macOS）

| 项 | 值 |
| --- | --- |
| node | `/usr/local/bin/node` v26.7.0（Homebrew） |
| npm | `/usr/local/bin/npm` 11.19.0（随 Homebrew node） |
| pnpm | **只有** `~/Library/pnpm/pnpm`（垫片）→ `global/v11/10b00-19ef772006c/node_modules/pnpm` = **11.8.0** |
| pnpm 的 store | `~/Library/pnpm/store/v11`（v10 已无 pnpm 使用，v3 已删） |
| PNPM_HOME | `~/.zshrc` 里有 `pnpm setup` 写的块：`export PNPM_HOME="$HOME/Library/pnpm"` + 注入 PATH |
| profile | `~/.dsh/profiles/web`（pnpm 11 建的 node_modules → store v11） |

历史：曾同时存在 Homebrew 的 pnpm 10.17.0（`/usr/local/bin/pnpm`，store v10），与自管理的
11.8.0 冲突，`dsh plugin` 会因 **store 版本不匹配** 报 `ERR_PNPM_UNEXPECTED_STORE`。已执行
`brew uninstall pnpm` + `rm -rf ~/Library/pnpm/store/v3` 统一到 11.8.0（`brew uses --installed pnpm`
为空，无 formula 依赖）。**升级 pnpm 用 `pnpm self-update`，但会到 12.x → store 再变一轮，慎用。**

## 装/卸/刷新的正确姿势

```bash
# 安装（registry 版）
dsh plugin --profile web add @lixiangzhong/dsh-shell-secrets
# 本地源码（开发）：必须 file:，不能 link:（见下）
dsh plugin --profile web add file:~/gopath/src/github.com/lixiangzhong/dsh-shell-secrets
# 刷新本地源码拷贝（pnpm update / install --force 对目录依赖都无效，会报 Already up to date）
dsh plugin --profile web remove @lixiangzhong/dsh-shell-secrets && dsh plugin --profile web add file:<dir>
```

- **为什么不能 `link:`**：`link:` 下 realpath 落在源码目录，Node 从那里向上找不到
  `@deepseek-ai/dsh-bash-sandbox`（实测 `createRequire(...).resolve()` → `MODULE_NOT_FOUND`）；
  `file:` 落成 profile 内的真实目录，向上能命中 `~/.dsh/profiles/node_modules`（指向 npx 安装目录
  的软链），拿到的是 **harness 同一份模块实例**（hoisted 与 `.pnpm` 两种布局都实测通过）。
- 目录依赖是**硬链接**（安装后 `lib/index.js` 的 link count = 2）。原地追加改动会透传，但编辑器
  "写临时文件再 rename" 会换 inode 断链 —— 所以刷新一律用 remove + add。
- **`dsh plugin add` 失败会连带把 bundle 条目删掉**：`reconcilePlugins()` 只在 pnpm 退出码为 0 时
  执行，而 pnpm 失败前可能已经写掉了依赖。实测踩过一次（registry 404 时 profile 的
  `dependencies` 与 `bundles` 双双丢失），恢复方式就是重新 `add file:<dir>`。

## 踩过的坑（按严重程度）

1. **执行器类里不能用 `#private` 字段/私有方法（曾造成线上事故）。**
   cordis 的 `getTraceable()` 会把服务包成 Proxy，方法调用时 `this` 被替换成 shadow 代理，
   私有字段的 brand 校验必然失败：`Error: Receiver must be an instance of class SecretsBashExecutor`，
   且**每个命令**都失败。官方服务一律用普通字段/方法 —— 本插件用 `this.secrets` + `mergeSecrets()`。
2. **`patchReload: live` 会把插件热挂载进正在运行的 dsh。** 上面那个 bug 就是这样立刻把当前会话的
   bash 打挂的。另外**删掉 patch 标记段并不足以卸载已挂载的执行器**（实测移除后报错依旧，只能是
   卸载未生效或更新回滚），恢复手段只有重启 dsh。结论：改执行器代码后，先重启再挂载。
3. **ESM 模块缓存**：同一进程内换掉文件内容不会重新导入（URL 相同即命中缓存），JS 改动必须重启。
4. **`#private` 之外，`Config` 也不要自建**：本插件默认导出子类，继承 `SandboxBashExecutor` 的
   `static Config`，这样 `timeoutMs` 等原有行配置照旧校验；自建 schema 会漏掉基类默认值，
   `assertServiceableBashConfig()` 会因 undefined 抛错。
5. **npm 发布的相关坑**：
   - 本机 `npm_config_registry` 是**环境变量**（腾讯镜像，优先级高于 project/user `.npmrc`），
     所以 `npm login` 默认打到镜像 → `E409 user registration disabled`；解决：`npm login
     --registry=https://registry.npmjs.org`，或直接放 Access Token（`//registry.npmjs.org/:_authToken=...`，
     token 按 host 存，不受 registry 配置影响）。**在项目里放 `.npmrc` 改 registry 无效。**
   - `publishConfig` 里固定 `registry: https://registry.npmjs.org` 与 `access: public`，所以
     `npm publish` 本身不需要加 flag。
   - **发布后 registry 有 3~5 分钟 CDN 传播延迟**：0.1.0 发布后 16:29–16:31 反复 404，
     16:32:11 才 200（`npm access get status` 期间已显示 public）。别据此判定发布失败。
   - npm 的 `logs-max` 默认 10，后续命令的日志会把 login/publish 的 debug 日志挤掉，
     "日志里找不到 publish" 是假象。
6. **子串误伤**：默认正则与 dsh 的 scrub 同语义（子串匹配），`MONKEY`、`KEYBOARD_LAYOUT` 会命中，
   用 `DSH_SHELL_SECRETS_EXCLUDE` 排除。

## 本次发布记录

| 版本 | 时间 | 内容 |
| --- | --- | --- |
| 0.1.0 | 2026-09-11 | 首个公开版本：原名注入、启动期自检、MIT |
| 0.1.1 | 2026-09-11 | 文档更新：README 改为对公版，内部笔记移入 NOTES.md（代码与 0.1.0 一致） |
| 0.2.0 | 2026-11-09 | 插件页配置界面：行 Config 追加 volatile `pattern`，`plugins.row.config` 表单，保存后免重启生效；适配 dsh 0.2.x `execute` 接缝；npm 发布 |

> **0.2.0 发布后本机已切换到 npm 加载。** `desktop` profile 的 dependency 从 `link:` 开发挂载
> 改成 `@lixiangzhong/dsh-shell-secrets 0.2.0`（node_modules 下是真实目录，行 moduleName 为包名）。
> 运行中热切换的步骤（避免 `service "shell"` 重复）：
>
> 1. `plugin_manager set_plugin include:bash-sandbox enabled=false` 先停官方执行器；
> 2. `remove_bundle` 移除旧的 `link:` 挂载；
> 3. `install_bundle target=@lixiangzhong/dsh-shell-secrets@0.2.0 registry=https://registry.npmjs.org`；
> 4. 删掉 profile patch 里临时的 `- id: bash-sandbox / disabled: true` 覆盖——npm 包的 bundle patch
>    已经负责停用官方行。
>
> 之后本机改代码需要重新发版（或临时切回 `file:`/`link:` 调试），npm 包不会跟随仓库改动。

> **发布需要 2FA 的一次性密码。** `npm publish` 在非交互环境会直接失败：
> `EOTP This operation requires a one-time password. ... Open this URL in your browser to authenticate`。
> 两种处理：① 在自己的终端里跑 `npm publish`（npm 会打印一个 npmjs 授权 URL，浏览器确认后自动完成）；
> ② 在 npmjs 生成**勾选 Bypass 2FA** 的 Granular Access Token 放进 `~/.npmrc`，之后才能非交互发布
> （注意这类 token 等价于可发布凭据，别外泄）。
> 授权流程成功时，debug 日志里能看到 `http fetch PUT 401`（取 OTP）之后紧跟 `http fetch PUT 202`
> （服务端已接受）—— 即使 CLI 那一侧看起来没打印"成功"字样，也可据此判断发布已被受理。

> **发布后的传播延迟要做两段等。** 0.1.1 实测：元数据（`versions` / `dist-tags`）约 3 分钟出现，
> 但 **tarball blob 又晚了约 3 分钟**（`…/dsh-shell-secrets-0.1.1.tgz` 期间返回
> 21 字节的 `{"error":"Not found"}`）。所以要按"元数据 → 再等一会儿 → tarball"两段轮询，
> 不要因为 tarball 404 就判定发布失败。

> **升级 profile 必须显式带 `--registry`。** 本机 `npm_config_registry` 指向腾讯镜像，镜像同步新版本更慢，
> 于是 `dsh plugin --profile web update <pkg>` 只会打印 `added 0`、**静默停在旧版本**（实测停在 0.1.0）。
> 正确做法：
>
> ```bash
> dsh plugin --profile web add "@lixiangzhong/dsh-shell-secrets@^0.1.1" --registry=https://registry.npmjs.org
> ```

发布命令：

```bash
cd ~/gopath/src/github.com/lixiangzhong/dsh-shell-secrets
npm version patch && npm publish          # publishConfig 已固定 registry + public
```

验收清单（0.1.0 全过）：

```bash
node --test                                                  # 17/17
node deploy.mjs --check                                      # shell-secrets 行已挂载 + bash-sandbox 已禁用
echo "$MY_TEST_PASSWORD"                                     # probe-ok（原始名可用）
env | cut -d= -f1 | grep -E '_TOKEN$|PASSWORD$|SECRET$|_KEY$' # 只列名字
env | cut -d= -f1 | grep '^DSH_'                             # 仅 DSH_HOME/SHELL/SESSION_ID/WEB_URL
# 后台任务（0.2.x 与前台共用 execute 路径）里同样可见
```

当前 profile 状态：`dependencies: {"@lixiangzhong/dsh-shell-secrets": "^0.1.0"}`，
`dsh.profile.bundles: [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, @lixiangzhong/dsh-shell-secrets]`，
`cordis.patch.yml` 为空数组；`~/.dsh/profiles/web/` 下留有若干 `cordis.patch.yml.bak-*`（deploy.mjs
改动前自动备份，可删）。

## 备用部署路径：deploy.mjs

给"不能用 pnpm"的场景保留：把包拷进 `~/.dsh/profiles/<profile>/plugins/dsh-shell-secrets/`，
并在 profile 的 `cordis.patch.yml` 里写 `# >>> dsh-shell-secrets` 标记段
（`bash-sandbox` 置 `disabled: true` + 插入 `shell-secrets` 行）。

```bash
node deploy.mjs            # 拷贝 + 挂载（幂等）
node deploy.mjs --check    # dsh --profile web --dump-config 校验（两种安装方式都适用）
node deploy.mjs --remove   # 回滚；PROFILE=tui 可换 profile
```

检测到 bundle 安装时会打印双路径警告，避免两条来源并存（行 id 相同，后者覆盖前者）。

## 0.2.0：配置界面（`pattern`）

目标：不重启 dsh，在 Web 端的插件页里改 `DSH_SHELL_SECRETS_PATTERN` 的等价规则。

### 落地方式（按 harness 现有接缝）

- **宿主**：`static Config = extendConfigSchema(SandboxBashExecutor.Config, z, 'pattern')`。
  `pattern` 必须是 `.volatile()`：
  - `@deepseek-ai/dsh-settings` 的 `write()` 只允许编辑 `isVolatilePath` 命中的字段，否则报
    `Config field "pattern" is not volatile`；
  - volatile 字段写入后由 `fiber.resolveConfig()` **原地更新**，不会重挂 shell 执行器，也不需要重启。
- **浏览器半边**：`dsh.client` + `./lib/client.js`，在 `plugins.row.config` 槽注册，键为
  `@lixiangzhong/dsh-shell-secrets#shell-secrets`（`<包名>#<patch 行 id>`）。
  页面传给组件的 `form` 是 `{ state, mutate }`：
  - `state` 来自 `ConfigFormController.getSnapshot()`：`{ status, value, base, user, revision, writable }`；
  - `mutate(ops, revision)` 走 `settings.mutate` → `configEditor.edit`，成功返回 `true`。
  因此客户端**不需要**自建 HTTP 路由，也不应该自己写 profile 文件。
- **注入集**：`currentOptions()` 里按「界面 pattern > 环境 PATTERN > 内置默认」解析，用选项对象
  身份做缓存；`currentSecrets()` 只在规则变化时重算。环境变量的值仍是启动期快照。
- **热路径防御**：界面写入的正则若非法（手工改 profile 才会发生），`currentOptions()` 捕获后
  回退到最后一次可用规则并记一次 error；**绝不能抛错**，否则每条 bash 命令都会失败。客户端表单
  也会在保存前用 `new RegExp()` 预校验。

### dsh 0.2.x 的 shell 接缝变了（重要）

0.1.x 的 `SandboxBashExecutor` 有 `run()`（前台）/ `start()`（后台）；0.2.x 两者都删了，统一为：

- `resolve(request)` → 补全 `ShellExecSpec`；
- `execute(spec)` → 唯一执行入口，返回 `ShellExecution` 句柄；"前台/后台"只取决于调用方
  是否等待 `result`。

只覆写 `run`/`start` 的旧实现会**完全不生效**（不报错、也没注入）——这正是 0.2.x 上
"插件装上了但读不到变量"的原因。本版改为覆写 `execute`，自检也改为检查 `resolve` / `execute`。
`ShellExecSpec.env` 的语义没变，仍在凭证 scrub 之后合并（`{ ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv }`）。

### 踩坑记录

1. **schemastery 不能直接用 `z.intersect` 合并 Config**：与 volatile 字段组合会报
   `volatile fields require a fixed object path without an enclosing volatile field`（`$.0.cwd`）。
   正确姿势是复制基类 schema 的字段字典：`z.object({ ...Base.Config.dict, pattern: ... })`。
2. **`plugins.row.config` 的 `form` 不是 configForms 控制器**：`formFor(id)` 返回
   `{ state, mutate }`；`ConfigFormController` 的 `set/unset` 不直接暴露。保存用 `mutate`。
3. **`plugins.row.config` 的 key 用行 id，不是 entry id**：key 为 `<包名>#<row id>`；
   settings 命名空间则是 entry id（`shell-secrets`）。
4. **浏览器端不要 import `@deepseek-ai/dsh-client-ui-primitives`**（插件规范明确禁止）：
   自己写受控输入与按钮，只用 `--dsw-alias-*` 主题变量；样式挂在 `.dss-` 作用域内、随
   `ctx.effect` 清理。
5. **客户端模块只在页面加载**：安装后需要刷新页面才能看到配置入口；宿主行则随 patch 生效。

### 验证要点（desktop profile，2026-11 实测 0.2.2-rc.1）

```bash
node --test                                   # 17/17
node --check lib/index.js lib/client.js       # 语法
```

实测结果：

- `cordis_inspect_query Config.listConfigs entry=include:shell-secrets` → schema 含 volatile `pattern`；
- `Slots plugins.row.config` → occupant `@lixiangzhong/dsh-shell-secrets#shell-secrets`（active）；
- bash 子进程注入生效（只列名字确认，默认规则命中 5 个启动期变量）；
- 在 profile patch 里写 `shell-secrets.config.pattern=^DRONE_TOKEN$`（与界面 configEditor 写的同一层）
  后无需重启，下一次 bash 命令只剩 `DRONE_TOKEN`；删掉后又回到默认集合。

**热重载插件自身的宿主 JS**（0.2.x）：改完 `lib/index.js` 后，用
`plugin_manager set_plugin` 把 `include:shell-secrets` 关一次再开一次，HMR 的
`reconcileProfile` 会驱逐 linked root 的 ESM 缓存并重新导入，无需重启 dsh（实测有效）。
若模块未被驱逐，则只能重启。

### 首次安装到运行中的 dsh：HMR 会撞重复服务

本插件的 patch 同时做两件事：`disabled: true` 官方 `bash-sandbox` + insert 自己的
`shell-secrets` 行。在**运行中的**进程里首次安装时，HMR 的 `recomposeProfile` 会把这次
patch 当成一次 entry 更新；`bash-sandbox` 仍在新一代的 patch 列表里（只是变成 disabled），
不会进入 `dropped` 的"先停后建"路径，于是新行可能先注册 `shell`，撞上旧实例：

```
Error: service "shell" has been registered at <SandboxBashExecutor>
```

一旦 thus 失败，旧行已被停用、新行又没起来，本会话的 bash 工具会消失（重启 dsh 即恢复）。
两种可靠做法：

1. **关掉 dsh 再装**：用 `dsh plugin --profile desktop add <spec>`，然后启动，一次性合成；
2. **两阶段热装**（本次验证用的办法）：
   - 阶段一：把 bundle patch 临时改成只有 `- id: bash-sandbox / disabled: true`，安装；
   - 阶段二：恢复完整 patch，再 `set_bundle enabled=true`（`requiredIds` 会强制拉起新行）。
   注意第一次发布完整 patch 失败后，重新导入同一路径的 ESM 模块可能命中缓存；HMR 对
   linked profile roots 会做 eviction，但不保证——必要时重启。

## 待办 / 可做项

- `package.json` 的 `repository` / `homepage` / `bugs` 指向 `github.com/lixiangzhong/dsh-shell-secrets`；
  仓库尚未创建或名字不同的话需要改这三行。
- README 的公开版更新后，**npm 页面要等下一次 `npm version patch && npm publish`** 才会同步。
- 可选增强：Windows pwsh twin（`SandboxPwshExecutor` 同样是默认导出）、持久 PTY shell 覆盖
  （走 `ctx.terminals`，与 `ctx.shell` 不同）、装载后给模型一份"仅名字"的提示段。
- 若上游给 `ShellExecSpec` 增加插件级 env 贡献接缝，应迁移过去并删除执行器替换。
