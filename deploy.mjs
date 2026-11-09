#!/usr/bin/env node
/**
 * dsh-shell-secrets 的部署/回滚/校验工具。
 *
 * 为什么需要"拷贝 + 改 profile patch"而不是 `dsh plugin add`：
 * 插件要 `extends SandboxBashExecutor`，必须让 `@deepseek-ai/dsh-bash-sandbox` 解析到
 * harness 自己那份模块（`~/.dsh/profiles/node_modules/@deepseek-ai/*` 是指向 npx 安装
 * 目录的符号链接）。若用 `link:` 把工作区目录链进 profile，Node 会按 realpath 从工作区
 * 向上找包而解析不到，两个模块实例混用是隐患。所以：**拷贝**到 profile 内，让 realpath
 * 落在 profile 里；再用相对路径挂载，连 pnpm 都不需要。
 *
 * 用法：
 *   node deploy.mjs                     # 拷贝插件 + 挂载行（幂等）
 *   node deploy.mjs --remove            # 移除挂载行 + 删除插件目录
 *   node deploy.mjs --check             # 跑 dsh --dump-config 校验挂载结果
 *   node deploy.mjs --profile tui       # 指定 profile（默认 web，或读 $PROFILE）
 *   node deploy.mjs --home /path/.dsh   # 指定 dsh home（默认 $DSH_HOME 或 ~/.dsh）
 *
 * @module dsh-shell-secrets/deploy
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 插件目录名（deploy 拷贝路径用），也是无 scope 的包名。 */
const PLUGIN_NAME = 'dsh-shell-secrets'
/**
 * 可能出现在 `dsh.profile.bundles` 里的包名。
 * 发布到 npm 后包名带 scope，bundle 层里记的也是带 scope 的名字。
 */
const BUNDLE_NAMES = [PLUGIN_NAME, '@lixiangzhong/dsh-shell-secrets']
/** 标记段：deploy 只在自己维护的这两行之间增删内容，绝不碰用户其它 patch。 */
const BEGIN_MARK = '# >>> dsh-shell-secrets'
const END_MARK = '# <<< dsh-shell-secrets'

/** 解析命令行参数。 */
function parseArgs(argv) {
  const options = {
    remove: false,
    check: false,
    profile: process.env.PROFILE ?? 'web',
    home: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--remove') options.remove = true
    else if (argument === '--check') options.check = true
    else if (argument === '--profile' || argument === '--home') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${argument} 需要一个值`)
      options[argument === '--profile' ? 'profile' : 'home'] = value
      index += 1
    } else if (argument === '--help' || argument === '-h') options.help = true
    else throw new Error(`未知参数: ${argument}`)
  }
  return options
}

/** 打印用法。 */
function usage() {
  process.stdout.write(
    [
      '用法: node deploy.mjs [--remove | --check] [--profile <name>] [--home <dsh-home>]',
      '',
      '  (无参数)    拷贝插件到 profile 并挂载执行器替换行（幂等）',
      '  --remove    移除挂载行并删除 profile 内的插件目录',
      '  --check     运行 dsh --profile <name> --dump-config，打印相关行的合成结果',
      '',
    ].join('\n'),
  )
}

/**
 * 生成要写进 profile patch 的标记段。
 * @returns 带首尾换行的 YAML 片段。
 */
function patchBlock() {
  return [
    `${BEGIN_MARK} (由 deploy.mjs 维护，请勿手改这一段)`,
    '# 关掉官方 bash-sandbox：两个实现会争同一个 `shell` 服务，cordis 会大声报重复服务。',
    '- id: bash-sandbox',
    '  disabled: true',
    '',
    '- insert:',
    '    - id: shell-secrets',
    `      name: ./plugins/${PLUGIN_NAME}/lib/index.js`,
    '      # 与官方 bash-sandbox 行同值，替换后行为不变。',
    '      config:',
    '        timeoutMs: 60000',
    '      # 本期只覆盖 bash；Windows 的 pwsh 走 SandboxPwshExecutor，可同构补充。',
    "      disabled: !!js process.platform === 'win32'",
    END_MARK,
    '',
  ].join('\n')
}

/**
 * 从 patch 文本里移除标记段。
 * @param text - 原文。
 * @returns 移除后的文本。
 */
function stripBlock(text) {
  const lines = text.split('\n')
  const kept = []
  let inside = false
  for (const line of lines) {
    if (line.startsWith(BEGIN_MARK)) {
      inside = true
      continue
    }
    if (line.startsWith(END_MARK)) {
      inside = false
      continue
    }
    if (!inside) kept.push(line)
  }
  return kept.join('\n')
}

/**
 * 判断 YAML 文档里是否还有顶层 entry。
 * @param text - patch 文本。
 * @returns 是否存在形如 `- ...` 的顶层项。
 */
function hasTopLevelEntry(text) {
  return text.split('\n').some((line) => line.startsWith('- '))
}

/**
 * 往 patch 文件里写入标记段（幂等）。
 * @param patchFile - profile 的 cordis.patch.yml 路径。
 * @returns 是否发生了改动。
 */
function mountPatch(patchFile) {
  if (!existsSync(patchFile)) {
    throw new Error(`找不到 ${patchFile}；先用 dsh 启动一次该 profile 以完成初始化`)
  }
  const original = readFileSync(patchFile, 'utf8')
  let text = stripBlock(original)
  // 空文档占位符 `[]` 必须去掉，否则后面追加 entry 会得到非法 YAML。
  text = text
    .split('\n')
    .filter((line) => line.trim() !== '[]')
    .join('\n')
  text = `${text.replace(/\s*$/, '')}\n\n${patchBlock()}`
  if (text === original) {
    process.stdout.write(`patch 已是目标状态，未改动: ${patchFile}\n`)
    return false
  }
  backup(patchFile, original)
  writeFileSync(patchFile, text, 'utf8')
  process.stdout.write(`已写入挂载行: ${patchFile}\n`)
  return true
}

/**
 * 从 patch 文件里移除标记段。
 * @param patchFile - profile 的 cordis.patch.yml 路径。
 * @returns 是否发生了改动。
 */
function unmountPatch(patchFile) {
  if (!existsSync(patchFile)) throw new Error(`找不到 ${patchFile}`)
  const original = readFileSync(patchFile, 'utf8')
  if (!original.includes(BEGIN_MARK)) {
    process.stdout.write(`patch 里没有本插件的标记段，未改动: ${patchFile}\n`)
    return false
  }
  let text = stripBlock(original)
  if (!hasTopLevelEntry(text)) {
    // 顶层空文档必须留 `[]` 占位，否则 dsh 会因"不是数组"而拒绝启动。
    const hasEmptyMarker = text.split('\n').some((line) => line.trim() === '[]')
    if (!hasEmptyMarker) text = `${text.replace(/\s*$/, '')}\n[]\n`
  }
  backup(patchFile, original)
  writeFileSync(patchFile, text.replace(/\s*$/, '') + '\n', 'utf8')
  process.stdout.write(`已移除挂载行: ${patchFile}\n`)
  return true
}

/**
 * 改动前留一份带时间戳的备份。
 * @param file - 被改动的文件。
 * @param content - 改动前的内容。
 */
function backup(file, content) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${file}.bak-${stamp}`
  writeFileSync(target, content, 'utf8')
  process.stdout.write(`已备份: ${target}\n`)
}

/**
 * 把插件源码拷进 profile。
 * @param sourceDir - 源码目录。
 * @param pluginDir - profile 内的目标目录。
 * @returns 目标目录路径。
 */
function copyPlugin(sourceDir, pluginDir) {
  if (existsSync(pluginDir)) rmSync(pluginDir, { recursive: true, force: true })
  mkdirSync(dirname(pluginDir), { recursive: true })
  cpSync(sourceDir, pluginDir, {
    recursive: true,
    filter: (source) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(source) && !source.endsWith('.bak'),
  })
  process.stdout.write(`已拷贝插件: ${pluginDir}\n`)
  return pluginDir
}

/**
 * 在合成结果里查找一行（返回行号）。
 * @param lines - dump-config 输出的行。
 * @param predicate - 判定函数，入参为 trim 后的行文本。
 * @returns 行号，未找到为 -1。
 */
function findLine(lines, predicate) {
  return lines.findIndex((line) => predicate(line.trim()))
}

/**
 * 判断某个 entry 行之后若干行内是否出现 `disabled: true`。
 * @param lines - dump-config 输出的行。
 * @param header - entry 的 `- id: xxx` 行文本。
 * @returns 该行是否被禁用。
 */
function isRowDisabled(lines, header) {
  const start = findLine(lines, (line) => line === header)
  if (start === -1) return false
  for (let index = start + 1; index < Math.min(start + 8, lines.length); index += 1) {
    const line = lines[index].trim()
    if (line.startsWith('- id: ')) break
    if (line === 'disabled: true') return true
  }
  return false
}

/**
 * 跑 `dsh --profile <name> --dump-config` 并打印相关行。
 * @param profile - profile 名。
 * @returns 退出码。
 */
function check(profile) {
  process.stdout.write(`校验: dsh --profile ${profile} --dump-config（该命令会重写 profile 的 cordis.yml，属官方行为）\n`)
  const result = spawnSync('dsh', ['--profile', profile, '--dump-config'], { encoding: 'utf8' })
  if (result.error !== undefined) {
    process.stderr.write(`无法执行 dsh: ${String(result.error.message ?? result.error)}\n`)
    return 127
  }
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  if (result.status !== 0) {
    process.stderr.write(`dump-config 失败（exit ${String(result.status)}）:\n${stderr.trim()}\n`)
    return result.status ?? 1
  }

  const lines = stdout.split('\n')
  const hits = new Set()
  const interesting = (line) =>
    line.includes('shell-secrets') || line.includes('id: bash-sandbox') || line.includes('dsh-bash-sandbox')
  lines.forEach((line, index) => {
    if (!interesting(line)) return
    for (let offset = -3; offset <= 5; offset += 1) {
      const target = index + offset
      if (target >= 0 && target < lines.length) hits.add(target)
    }
  })
  if (hits.size === 0) {
    process.stderr.write('未在合成结果里找到相关行：挂载可能没生效\n')
    return 1
  }
  for (const index of [...hits].sort((left, right) => left - right)) {
    process.stdout.write(`${String(index + 1).padStart(4, ' ')} | ${lines[index]}\n`)
  }

  // 相对 name 会被 anchorInsertedPluginNames 锚定成 file URL；bundle 安装则是
  // node_modules/dsh-shell-secrets/lib/index.js。两种来源都算挂载成功。
  const mounted =
    findLine(lines, (line) => line === '- id: shell-secrets') !== -1 &&
    lines.some((line) => line.trim().endsWith(`/${PLUGIN_NAME}/lib/index.js`))
  const disabled = isRowDisabled(lines, '- id: bash-sandbox')
  process.stdout.write(
    `\n结论: shell-secrets 行=${mounted ? '已挂载' : '缺失'}；bash-sandbox 已禁用=${disabled ? '是' : '否'}\n`,
  )
  return mounted && disabled ? 0 : 1
}

/**
 * 读取 profile 的 bundle 层列表（`dsh.profile.bundles`）。
 * @param profileDir - profile 目录。
 * @returns bundle 名数组；读不到时为空数组。
 */
function readProfileBundles(profileDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const bundles = manifest?.dsh?.profile?.bundles
    return Array.isArray(bundles) ? bundles : []
  } catch {
    return []
  }
}

/**
 * 两条安装路径同时存在时的提示。
 * @param profile - profile 名。
 * @param profileDir - profile 目录。
 * @param command - 当前执行的动作（install/remove）。
 */
function warnBundlePath(profile, profileDir, command) {
  const installedName = readProfileBundles(profileDir).find((name) => BUNDLE_NAMES.includes(name))
  if (installedName === undefined) return
  process.stdout.write(
    [
      '',
      `注意: ${installedName} 已经作为 bundle 安装在 dsh.profile.bundles 里，也就是说它现在有两条来源：`,
      `  A) bundle 层（package.json 的 dsh.profile.bundles，由 dsh plugin 管理）`,
      `  B) 本脚本往 profile cordis.patch.yml 写的手工挂载段`,
      `  两条来源的行 id 相同（bash-sandbox / shell-secrets），后者按 id 覆盖前者，不会报重复服务，但容易混淆。`,
      command === 'remove'
        ? `  本次只移除了 B；要卸干净请再执行: dsh plugin --profile ${profile} remove ${installedName}`
        : `  建议二选一：想用 bundle 形式就先跑 dsh plugin --profile ${profile} remove ${installedName} 再执行本脚本 --remove。`,
      '',
    ].join('\n'),
  )
}

/** 主流程。 */
function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    usage()
    return 0
  }
  if (options.check) return check(options.profile)

  const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)))
  const profileDir = join(resolve(options.home), 'profiles', options.profile)
  const pluginDir = join(profileDir, 'plugins', PLUGIN_NAME)
  const patchFile = join(profileDir, 'cordis.patch.yml')

  if (options.remove) {
    unmountPatch(patchFile)
    if (existsSync(pluginDir)) {
      rmSync(pluginDir, { recursive: true, force: true })
      process.stdout.write(`已删除插件目录: ${pluginDir}\n`)
    }
    warnBundlePath(options.profile, profileDir, 'remove')
    process.stdout.write('回滚完成：重启 dsh 即恢复官方 bash 执行器。\n')
    return 0
  }

  if (!existsSync(profileDir)) throw new Error(`找不到 profile 目录 ${profileDir}；先用 dsh 启动一次该 profile`)
  warnBundlePath(options.profile, profileDir, 'install')
  copyPlugin(sourceDir, pluginDir)
  mountPatch(patchFile)
  process.stdout.write(
    [
      '',
      '下一步：',
      `  1) 在启动 dsh 的 shell 里 export 需要的密钥变量（例如 MY_TEST_PASSWORD），然后重启 dsh。`,
      `  2) 校验挂载: node deploy.mjs --profile ${options.profile} --check`,
      '  3) 插件 JS 改动需要重启 dsh 才生效（ESM 缓存）；YAML 改动在该 profile 下热生效。',
      '',
    ].join('\n'),
  )
  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  process.stderr.write(`deploy: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
