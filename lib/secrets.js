/**
 * dsh-shell-secrets 的密钥选择逻辑。
 *
 * 只做一件事：从一个环境变量快照里挑出"应当注入 bash 子进程"的密钥变量，并保持
 * 原始变量名。纯函数、零依赖，可直接用 `node --test` 覆盖。
 *
 * 背景（为什么需要它）：harness 的 subprocess 层会用 `scrubbedParentEnv()` 从子进程
 * 环境里剔除名字匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的变量，以及所有 `DSH_*`；而
 * `ShellExecSpec.env` 是在那次 scrub **之后**才合并进子进程环境的。所以本插件只要把
 * 同一批变量重新放进 `spec.env`，命令里就能继续用原来的名字（$GITHUB_TOKEN 等）。
 *
 * @module dsh-shell-secrets/secrets
 */

/** 默认匹配：与 harness 凭证 scrub 完全同一语义，保证"被剥掉的正好被补回来"。 */
export const DEFAULT_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/** harness 托管命名空间前缀：ambient `DSH_*` 一律不回流，维持既有不变量。 */
export const RESERVED_PREFIX = 'DSH_'

/** 单个密钥值的默认长度上限（字节），超过则跳过，避免把整份证书塞进环境变量。 */
export const DEFAULT_MAX_BYTES = 8192

/** 实际未注入的原因码。 */
export const SKIP_REASONS = Object.freeze({
  disabled: 'disabled',
  excluded: 'excluded',
  reserved: 'reserved-namespace',
  empty: 'empty',
  tooLong: 'too-long',
})

/** 已注入但值得提醒的原因码。 */
export const NOTE_REASONS = Object.freeze({ multiline: 'multiline' })

/**
 * 把一条正则源码编译成大小写不敏感的匹配器。
 *
 * 启动环境变量与界面配置共用这一段：界面写入的值非法时，宿主侧会捕获并在
 * 热路径回退，绝不让每次命令都失败。
 * @param source - 正则源码，例如 `KEY|TOKEN`、`^AWS_PROFILE$`。
 * @returns 大小写不敏感的正则。
 * @throws 当源码不是非空字符串或不是合法正则时。
 */
export function compilePattern(source) {
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new Error('匹配规则必须是非空字符串')
  }
  try {
    return new RegExp(source, 'i')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`匹配规则不是合法正则: ${detail}`)
  }
}

/**
 * 把 `*`/`?` 形式的名字匹配规则编译成正则。
 * @param glob - 例如 `*_TOKEN`、`AWS_*`、`KEYBOARD_*`。
 * @returns 大小写不敏感、整体匹配的正则。
 * @throws 当规则不是非空字符串时。
 */
function compileGlob(glob) {
  if (typeof glob !== 'string' || glob.trim().length === 0) {
    throw new Error('名字匹配规则必须是非空字符串')
  }
  const source = glob
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === '*' || char === '?' ? char : `\\${char}`))
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${source}$`, 'i')
}

/**
 * 拆分逗号分隔的规则列表。
 * @param raw - 环境变量原始值。
 * @returns 去掉空白项后的规则数组。
 */
function splitList(raw) {
  if (typeof raw !== 'string') return []
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

/**
 * 读取布尔开关：非空即视为开启（与 harness 对 `DSH_TELEMETRY_DISABLED` 的约定一致）。
 * @param raw - 环境变量原始值。
 * @returns 是否开启。
 */
function isEnabled(raw) {
  return typeof raw === 'string' && raw.length > 0
}

/**
 * 从启动环境解析插件配置。
 *
 * 配置默认来自启动环境（与"密钥只来自启动环境"一致），所有非法值在装载期抛错，
 * 避免"静默不注入"这种最难排查的失败模式。`patternOverride` 来自插件行的
 * `pattern` 配置（界面写入），与 `DSH_SHELL_SECRETS_PATTERN` 同角色且优先级更高。
 * @param env - 启动环境快照。
 * @param patternOverride - 界面配置的正则源码；空/缺省时沿用环境变量与默认值。
 * @returns 规格化的选项对象。
 * @throws 当正则非法或长度上限非法时。
 */
export function readOptionsFromEnv(env = process.env, patternOverride) {
  const patternSource = env.DSH_SHELL_SECRETS_PATTERN
  let pattern = DEFAULT_PATTERN
  if (typeof patternSource === 'string' && patternSource.trim().length > 0) {
    try {
      pattern = compilePattern(patternSource)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`DSH_SHELL_SECRETS_PATTERN 不是合法正则: ${detail}`)
    }
  }

  if (typeof patternOverride === 'string' && patternOverride.trim().length > 0) {
    pattern = compilePattern(patternOverride.trim())
  }

  let maxBytes = DEFAULT_MAX_BYTES
  const maxBytesSource = env.DSH_SHELL_SECRETS_MAX_BYTES
  if (typeof maxBytesSource === 'string' && maxBytesSource.trim().length > 0) {
    maxBytes = Number.parseInt(maxBytesSource, 10)
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error(`DSH_SHELL_SECRETS_MAX_BYTES 必须是正整数: ${maxBytesSource}`)
    }
  }

  return {
    pattern,
    include: splitList(env.DSH_SHELL_SECRETS_INCLUDE),
    exclude: splitList(env.DSH_SHELL_SECRETS_EXCLUDE),
    maxBytes,
    disabled: isEnabled(env.DSH_SHELL_SECRETS_DISABLE),
  }
}

/**
 * 从环境快照里挑出要注入的密钥变量。
 *
 * 选择顺序：显式 `include` 规则优先于默认正则；随后剔除 `DSH_*` 保留命名空间、
 * `exclude` 规则、空值、超长值。未命中的变量完全忽略（不进 `skipped`，否则会把
 * 整个环境变量表都变成诊断噪音）。
 * @param env - 环境变量快照。
 * @param options - {@link readOptionsFromEnv} 的结果或等价对象。
 * @returns `{ values, names, skipped, notes }`；`values` 保持原始值不做任何修剪。
 */
export function collectEnvSecrets(env, options = {}) {
  const {
    pattern = DEFAULT_PATTERN,
    include = [],
    exclude = [],
    maxBytes = DEFAULT_MAX_BYTES,
    disabled = false,
  } = options

  if (disabled) {
    return { values: {}, names: [], skipped: [{ name: '*', reason: SKIP_REASONS.disabled }], notes: [] }
  }

  const includeRules = include.map(compileGlob)
  const excludeRules = exclude.map(compileGlob)
  const selected = []

  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue

    // 未命中者直接忽略：只有"本可以被注入"的名字才值得出现在诊断里。
    const matched = includeRules.length > 0 ? includeRules.some((rule) => rule.test(name)) : pattern.test(name)
    if (!matched) continue
    selected.push([name, value])
  }

  const skipped = []
  const notes = []
  const entries = []

  for (const [name, value] of selected) {
    if (name.toUpperCase().startsWith(RESERVED_PREFIX)) {
      skipped.push({ name, reason: SKIP_REASONS.reserved })
      continue
    }
    if (excludeRules.some((rule) => rule.test(name))) {
      skipped.push({ name, reason: SKIP_REASONS.excluded })
      continue
    }
    if (value.trim().length === 0) {
      skipped.push({ name, reason: SKIP_REASONS.empty })
      continue
    }
    if (Buffer.byteLength(value, 'utf8') > maxBytes) {
      skipped.push({ name, reason: SKIP_REASONS.tooLong })
      continue
    }
    // 换行值仍然注入（保真优先），但记一条提醒：shell 里直接展开时可能被截断。
    if (value.includes('\n')) notes.push({ name, reason: NOTE_REASONS.multiline })
    entries.push([name, value])
  }

  entries.sort(([left], [right]) => left.localeCompare(right))
  return {
    values: Object.fromEntries(entries),
    names: entries.map(([name]) => name),
    skipped,
    notes,
  }
}

/**
 * 生成只含名字与原因的装载说明。
 *
 * 存在的意义就是"绝不打印值"：调用方只需把它的返回值交给日志。
 * @param result - {@link collectEnvSecrets} 的结果。
 * @returns 单行说明文本。
 */
export function describeNames(result) {
  const parts = [`可注入密钥变量 ${result.names.length} 个: ${result.names.join(', ') || '(无)'}`]
  if (result.skipped.length > 0) {
    parts.push(`已跳过: ${result.skipped.map((item) => `${item.name}(${item.reason})`).join(', ')}`)
  }
  if (result.notes.length > 0) {
    parts.push(`提醒: ${result.notes.map((item) => `${item.name}(${item.reason})`).join(', ')}`)
  }
  return parts.join(' | ')
}
