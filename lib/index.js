/**
 * dsh-shell-secrets：把启动环境里 KEY/PASSWORD/SECRET/TOKEN 类变量带回 bash 子进程。
 *
 * 为什么用"替换执行器"而不是官方 shellEnv 接缝：官方 `ctx.shellEnv` 只允许注册
 * `DSH_*` 键，命令里就得写 `$DSH_GITHUB_TOKEN`，`gh`/`mysql`/`aws` 这类自己读环境变量
 * 的 CLI 无法直接使用。这里改为接管 `ctx.shell`（服务名 `shell`），在文档化的
 * `ShellExecSpec.env` 上注入原始变量名：
 *
 *   ShellExecSpec.env —— "Ordinary environment entries for the command, merged after
 *   the credential scrub"（@deepseek-ai/dsh-shell 类型文档）
 *
 * 合并顺序（dsh-bash-local 的 spawnSpec）：
 *   { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv }
 * 因此本插件的值在 scrub 之后生效，同时又顶不掉 harness 自己的 `DSH_*`（那是 dshEnv）。
 *
 * 配置来源：
 * - 启动环境里的 `DSH_SHELL_SECRETS_*`（include/exclude/maxBytes/disable 与 PATTERN）；
 * - 插件行的 `pattern` 配置（界面写入，volatile，运行期原地更新，优先于环境 PATTERN）。
 *
 * 装载方式：profile 用户层先 `disabled: true` 掉官方 bash-sandbox 行（否则两个实现争
 * 同一个 `shell` 服务，cordis 会报重复服务），再 insert 本模块。详见 README.md。
 *
 * @module dsh-shell-secrets
 */
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'

import z from '@deepseek-ai/schemastery'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'

import { extendConfigSchema } from './config.js'
import { collectEnvSecrets, compilePattern, describeNames, readOptionsFromEnv } from './secrets.js'

/** 配置前缀说明：本插件的开关都从启动环境读取，不需要额外 schema。 */
export const OPTION_PREFIX = 'DSH_SHELL_SECRETS_'

/** 本插件绑定的 harness 包：既做 peer 声明，也做下面的同源自检。 */
export const HARNESS_PACKAGE = '@deepseek-ai/dsh-bash-sandbox'

/** 插件行里可由界面实时编辑的字段名（与 `DSH_SHELL_SECRETS_PATTERN` 同角色）。 */
export const PATTERN_FIELD = 'pattern'

/**
 * 从某个模块/入口出发解析 harness 包的真实路径。
 * @param from - 模块 URL 或文件路径。
 * @returns 真实路径；解析不到时 undefined。
 */
function resolveHarnessPackage(from) {
  try {
    return realpathSync(createRequire(from).resolve(HARNESS_PACKAGE))
  } catch {
    return undefined
  }
}

/** 本模块解析到的 harness 包路径。 */
const OWN_HARNESS_PATH = resolveHarnessPackage(import.meta.url)

/**
 * 装载期兼容性自检。
 *
 * 发布出去的包会装到版本各异的 dsh 上，而本插件绑的是 harness 内部接口：
 * `SandboxBashExecutor` 的 `resolve/run/start`、以及 `ShellExecSpec.env` 的
 * "在凭证 scrub 之后再合并"约定。这里只检查**可检测**的部分：
 *
 * 1. 基类是否还提供 `resolve/run/start`；
 * 2. harness 自己用的包与本插件解析到的是不是同一份（profile 若没有
 *    `autoInstallPeers: false`，pnpm 可能装出第二份 harness 包 → 两个 cordis 实例）。
 *
 * 刻意**只报错不抛异常**：自检失败时宁可让 dsh 正常启动、日志里醒目报错，也不要
 * 因为误报把用户的 dsh 弄成起不来。真正致命的问题（导出的不是类）在 import 期就会炸。
 * @param base - 导入到的基类。
 * @returns 问题描述数组，空数组表示通过。
 */
function compatibilityIssues(base) {
  const issues = []
  if (typeof base !== 'function') return [`${HARNESS_PACKAGE} 的导出不是类`]
  for (const method of ['resolve', 'execute']) {
    if (typeof base.prototype?.[method] !== 'function') {
      issues.push(`基类缺少 ${method}()，harness 内部接口可能已变`)
    }
  }
  const entry = process.argv[1]
  if (entry !== undefined && OWN_HARNESS_PATH !== undefined) {
    const harnessPath = resolveHarnessPackage(entry)
    if (harnessPath !== undefined && harnessPath !== OWN_HARNESS_PATH) {
      issues.push(`本插件解析到 ${OWN_HARNESS_PATH}，harness 自己是 ${harnessPath}，即装了两份 ${HARNESS_PACKAGE}`)
    }
  }
  return issues
}

/** 自检结果（模块级算一次）。 */
const COMPATIBILITY_ISSUES = compatibilityIssues(SandboxBashExecutor)

/**
 * 带密钥注入的 bash 执行器。
 *
 * 只覆写 `execute`（0.2.x harness 的唯一执行入口：前台/后台由调用方是否等待
 * `result` 决定，不再是 `run` / `start` 两个方法），其余行为（`resolve` 的
 * workdir/超时/策略、沙箱收敛、onProcessDone 的沙箱事实、sandboxMode getter）
 * 全部继承官方实现；`static Config` 在基类 volatile 字段之后追加 `pattern`，
 * profile 行的原有配置项照旧校验。
 *
 * 注意（踩过的坑）：**不要在这个类里用 `#private` 字段或私有方法**。cordis 的
 * `getTraceable()` 会把服务包成 Proxy，方法调用时 `this` 被替换成 shadow 代理，
 * 私有字段的 brand 校验会直接失败（报 "Receiver must be an instance of class ..."，
 * 而且是每个命令都失败）。官方服务一律用普通字段/方法，照做即可。
 */
export class SecretsBashExecutor extends SandboxBashExecutor {
  /**
   * 基类 Config（`timeoutMs` 等 volatile 字段）+ 界面可编辑的 `pattern`。
   *
   * volatile 是硬要求：harness 只允许通过 settings/configForms 编辑 volatile 字段，
   * 且写入后原地更新，不会重挂 shell 执行器。
   */
  static Config = extendConfigSchema(SandboxBashExecutor.Config, z, PATTERN_FIELD)

  /**
   * 启动环境快照。
   *
   * 密钥来源是"启动 dsh 的那个环境"，它在进程生命周期内不再变化；快照让每次
   * 重算都基于同一份输入，也避免每个命令都去遍历 `process.env`。
   */
  envSnapshot

  /** 启动环境解析出的选项（include/exclude/maxBytes/disabled 与环境 PATTERN）。 */
  baseOptions

  /** 当前注入集，与 `secretsOptions` 配对缓存。 */
  secrets
  secretsOptions

  /** 界面 pattern 的编译结果与来源，避免每条命令都重新 `new RegExp`。 */
  patternSource
  patternOptions
  patternError

  /**
   * @param ctx - cordis 上下文。
   * @param config - profile 行配置（继承 LocalBashExecutor 的 schema + pattern）。
   * @throws 当启动环境的 DSH_SHELL_SECRETS_* 配置非法时：宁可启动失败，也不要静默不注入。
   */
  constructor(ctx, config) {
    super(ctx, config)

    this.envSnapshot = { ...process.env }
    try {
      this.baseOptions = readOptionsFromEnv(this.envSnapshot)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`dsh-shell-secrets: ${detail}`)
    }

    // 首次装载日志：只记名字与原因，绝不记值。
    const initial = this.currentSecrets()
    for (const issue of COMPATIBILITY_ISSUES) {
      this.ctx.logger.error(`dsh-shell-secrets: 兼容性自检未通过 —— ${issue}；注入可能失效，请核对 README 的「已测版本」表`)
    }
    if (initial.names.length === 0) {
      this.ctx.logger.warn(
        `dsh-shell-secrets: 没有可注入的密钥变量（检查启动环境里的敏感名变量，或 ${OPTION_PREFIX}INCLUDE / ${OPTION_PREFIX}PATTERN / 界面 pattern 配置）`,
      )
    }
    if (typeof this.config?.[PATTERN_FIELD]?.get !== 'function') {
      this.ctx.logger.warn(
        `dsh-shell-secrets: 当前 harness 的 shell 配置不支持 ${PATTERN_FIELD} 字段，界面配置不可用（注入逻辑本身不受影响）`,
      )
    }
  }

  /**
   * 读取插件行 `pattern` 字段的当前值。
   *
   * volatile 字段在配置对象上是 `.get()` 访问器；这里兼容普通字符串值，
   * 并吞掉任何异常——热路径绝不允许因为读配置而让命令失败。
   * @returns 正则源码；未配置时 undefined。
   */
  configuredPattern() {
    const field = this.config?.[PATTERN_FIELD]
    if (field === undefined || field === null) return undefined
    if (typeof field === 'string') return field
    if (typeof field.get === 'function') return field.get()
    return undefined
  }

  /**
   * 解析当前生效的选项：界面 `pattern` > 启动环境 `DSH_SHELL_SECRETS_PATTERN` > 默认。
   *
   * 非法正则**不抛错**：这一层在每条命令上都会走到，抛错会让每条命令都失败。
   * 维持上一次可用的规则（或回退到启动环境/默认规则），并只记一次错误日志。
   * @returns 当前选项对象。
   */
  currentOptions() {
    const configured = this.configuredPattern()
    const source = typeof configured === 'string' ? configured.trim() : ''
    if (source.length === 0) return this.baseOptions
    if (source !== this.patternSource) {
      this.patternSource = source
      try {
        this.patternOptions = { ...this.baseOptions, pattern: compilePattern(source) }
        this.patternError = undefined
      } catch (error) {
        // 保留上一次可用的编译结果：手工把配置改坏时不要让注入集合突然变脸。
        this.patternError = error instanceof Error ? error.message : String(error)
        this.ctx.logger.error(`dsh-shell-secrets: ${this.patternError}，已回退到最后一次可用的匹配规则`)
      }
    }
    return this.patternOptions ?? this.baseOptions
  }

  /**
   * 计算当前注入集，并在选项变化时重新挑变量。
   *
   * 环境值在进程生命周期内不变，变化只可能来自界面 `pattern`；用选项对象身份
   * 作为缓存键，未变化时零分配。
   * @returns `{ values, names, skipped, notes }`。
   */
  currentSecrets() {
    const options = this.currentOptions()
    if (this.secrets !== undefined && this.secretsOptions === options) return this.secrets
    const secrets = collectEnvSecrets(this.envSnapshot, options)
    this.secrets = secrets
    this.secretsOptions = options
    this.ctx.logger.info(`dsh-shell-secrets: ${describeNames(secrets)}`)
    return secrets
  }

  /**
   * 把密钥并入一次执行的显式环境。
   * @param spec - 已解析的执行规格。
   * @returns 新的规格；无密钥时原样返回，保持热路径零分配。
   */
  mergeSecrets(spec) {
    const secrets = this.currentSecrets()
    if (secrets.names.length === 0) return spec
    return { ...spec, env: { ...spec.env, ...secrets.values } }
  }

  /**
   * 执行一条命令（前台与后台任务共用这一个入口）。
   * @param spec - 已解析的执行规格。
   * @returns 执行句柄（与官方实现同形）。
   */
  execute(spec) {
    return super.execute(this.mergeSecrets(spec))
  }
}

export default SecretsBashExecutor
