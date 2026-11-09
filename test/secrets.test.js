/**
 * lib/secrets.js 的单元测试：只覆盖纯逻辑，不依赖 cordis，也不需要 dsh 进程。
 *
 * 运行：node --test test/
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_MAX_BYTES,
  collectEnvSecrets,
  compilePattern,
  describeNames,
  readOptionsFromEnv,
} from '../lib/secrets.js'

const PROBE_ENV = Object.freeze({
  PATH: '/usr/bin',
  HOME: '/Users/probe',
  GITHUB_TOKEN: 'ghp_probe_token',
  AWS_SECRET_ACCESS_KEY: 'aws_probe_secret',
  PGPASSWORD: 'pg_probe_password',
  DEEPSEEK_API_KEY: 'ds_probe_key',
  MY_APP_AUTH: 'not-sensitive-by-name',
})

test('默认正则找回被 scrub 的 KEY/TOKEN/SECRET/PASSWORD 变量', () => {
  const result = collectEnvSecrets(PROBE_ENV)
  assert.deepEqual(result.names, [
    'AWS_SECRET_ACCESS_KEY',
    'DEEPSEEK_API_KEY',
    'GITHUB_TOKEN',
    'PGPASSWORD',
  ])
  assert.equal(result.values.GITHUB_TOKEN, 'ghp_probe_token')
  // 名字不含敏感词但语义上是机密的变量不会被擅自带上：这是刻意的、可预测的边界。
  assert.equal('MY_APP_AUTH' in result.values, false)
})

test('默认正则不修剪值，也不改动非字符串项', () => {
  const result = collectEnvSecrets({ TOKEN_PADDED: '  keep  spaces  ', TOKEN_NULL: undefined })
  assert.equal(result.values.TOKEN_PADDED, '  keep  spaces  ')
  assert.deepEqual(result.names, ['TOKEN_PADDED'])
})

test('子串误伤（MONKEY / KEYBOARD_LAYOUT）默认会被命中，可用 exclude 修掉', () => {
  const env = { MONKEY: 'banana', KEYBOARD_LAYOUT: 'us', GITHUB_TOKEN: 'ghp_x' }

  const naive = collectEnvSecrets(env)
  assert.deepEqual(naive.names, ['GITHUB_TOKEN', 'KEYBOARD_LAYOUT', 'MONKEY'])

  const fixed = collectEnvSecrets(env, { exclude: ['MONKEY', 'KEYBOARD_*'] })
  assert.deepEqual(fixed.names, ['GITHUB_TOKEN'])
  assert.deepEqual(fixed.skipped.sort((left, right) => left.name.localeCompare(right.name)), [
    { name: 'KEYBOARD_LAYOUT', reason: 'excluded' },
    { name: 'MONKEY', reason: 'excluded' },
  ])
})

test('DSH_* 保留命名空间绝不回流，即使名字带 TOKEN', () => {
  const result = collectEnvSecrets({ DSH_SESSION_ID: 'session-1', DSH_EXTRA_TOKEN: 'leaked', GITHUB_TOKEN: 'ghp_x' })
  assert.deepEqual(result.names, ['GITHUB_TOKEN'])
  assert.deepEqual(result.skipped, [{ name: 'DSH_EXTRA_TOKEN', reason: 'reserved-namespace' }])
  assert.equal('DSH_SESSION_ID' in result.values, false)
})

test('显式 include 规则优先于默认正则', () => {
  const env = { GITHUB_TOKEN: 'ghp_x', AWS_ACCESS_KEY_ID: 'AKIA', MY_APP_AUTH: 'auth-value', PGPASSWORD: 'pg' }
  const result = collectEnvSecrets(env, { include: ['*_TOKEN', 'AWS_*'] })
  assert.deepEqual(result.names, ['AWS_ACCESS_KEY_ID', 'GITHUB_TOKEN'])
})

test('空值、纯空白、超长值被跳过并给出原因', () => {
  const result = collectEnvSecrets(
    { TOKEN_EMPTY: '', TOKEN_BLANK: '   ', TOKEN_HUGE: 'x'.repeat(16) },
    { maxBytes: 8 },
  )
  assert.deepEqual(result.values, {})
  assert.deepEqual(result.skipped.sort((left, right) => left.name.localeCompare(right.name)), [
    { name: 'TOKEN_BLANK', reason: 'empty' },
    { name: 'TOKEN_EMPTY', reason: 'empty' },
    { name: 'TOKEN_HUGE', reason: 'too-long' },
  ])
})

test('多行值仍然注入，但记一条提醒', () => {
  const result = collectEnvSecrets({ SSH_SECRET_BLOB: 'line1\nline2' })
  assert.equal(result.values.SSH_SECRET_BLOB, 'line1\nline2')
  assert.deepEqual(result.notes, [{ name: 'SSH_SECRET_BLOB', reason: 'multiline' }])
})

test('未命中的变量完全忽略，不制造诊断噪音', () => {
  const wide = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`PLAIN_VAR_${index}`, 'v']))
  const result = collectEnvSecrets(wide)
  assert.deepEqual(result.skipped, [])
  assert.deepEqual(result.names, [])
})

test('DSH_SHELL_SECRETS_DISABLE 让插件不注入任何东西', () => {
  const options = readOptionsFromEnv({ ...PROBE_ENV, DSH_SHELL_SECRETS_DISABLE: '1' })
  const result = collectEnvSecrets(PROBE_ENV, options)
  assert.deepEqual(result.values, {})
  assert.deepEqual(result.skipped, [{ name: '*', reason: 'disabled' }])
})

test('readOptionsFromEnv 解析 include/exclude/pattern/maxBytes', () => {
  const options = readOptionsFromEnv({
    DSH_SHELL_SECRETS_INCLUDE: ' *_TOKEN , AWS_* ,, ',
    DSH_SHELL_SECRETS_EXCLUDE: 'MONKEY',
    DSH_SHELL_SECRETS_PATTERN: '^SECRET_',
    DSH_SHELL_SECRETS_MAX_BYTES: '32',
  })
  assert.deepEqual(options.include, ['*_TOKEN', 'AWS_*'])
  assert.deepEqual(options.exclude, ['MONKEY'])
  assert.equal(options.maxBytes, 32)
  assert.equal(options.disabled, false)
  assert.equal(options.pattern.source, '^SECRET_')

  // include 规则优先于 pattern：这里 *_TOKEN 命中 GITHUB_TOKEN，SECRET_* 被 include 挡在外面。
  const included = collectEnvSecrets({ SECRET_ONE: 'a', GITHUB_TOKEN: 'b' }, options)
  assert.deepEqual(included.names, ['GITHUB_TOKEN'])

  // 只给自定义 pattern 时，它自己决定命中集合。
  const patterned = collectEnvSecrets(
    { SECRET_ONE: 'a', SECRET_TWO: 'b', GITHUB_TOKEN: 'c' },
    readOptionsFromEnv({ DSH_SHELL_SECRETS_PATTERN: '^SECRET_' }),
  )
  assert.deepEqual(patterned.names, ['SECRET_ONE', 'SECRET_TWO'])
})

test('界面 pattern（patternOverride）优先于环境 PATTERN，仍然让位给 INCLUDE', () => {
  const env = {
    DSH_SHELL_SECRETS_PATTERN: '^ENV_',
    ENV_FLAG: 'env-only',
    GITHUB_TOKEN: 'ghp_x',
    MY_APP_AUTH: 'auth',
    AWS_PROFILE: 'prod',
  }

  // 只给环境 PATTERN 时由它决定命中集合。
  assert.deepEqual(collectEnvSecrets(env, readOptionsFromEnv(env)).names, ['ENV_FLAG'])

  // 界面配置覆盖环境 PATTERN。
  assert.deepEqual(collectEnvSecrets(env, readOptionsFromEnv(env, '^MY_APP_AUTH$')).names, ['MY_APP_AUTH'])

  // 空白覆盖值等同于未配置，回退到环境 PATTERN。
  assert.deepEqual(collectEnvSecrets(env, readOptionsFromEnv(env, '   ')).names, ['ENV_FLAG'])

  // INCLUDE 存在时，界面 pattern 和 PATTERN 都不参与选择。
  const included = readOptionsFromEnv({ ...env, DSH_SHELL_SECRETS_INCLUDE: 'AWS_*' }, '^MY_APP_AUTH$')
  assert.deepEqual(collectEnvSecrets(env, included).names, ['AWS_PROFILE'])
})

test('compilePattern 校验输入，非法值在装载期大声失败', () => {
  const pattern = compilePattern('^AWS_')
  assert.equal(pattern.source, '^AWS_')
  assert.equal(pattern.flags, 'i')

  assert.throws(() => compilePattern('(['), /不是合法正则/)
  assert.throws(() => compilePattern('   '), /非空字符串/)
  assert.throws(() => readOptionsFromEnv({}, '(['), /不是合法正则/)
})

test('非法配置在装载期大声失败', () => {
  assert.throws(() => readOptionsFromEnv({ DSH_SHELL_SECRETS_PATTERN: '([' }), /不是合法正则/)
  assert.throws(() => readOptionsFromEnv({ DSH_SHELL_SECRETS_MAX_BYTES: '0' }), /必须是正整数/)
  assert.throws(() => readOptionsFromEnv({ DSH_SHELL_SECRETS_MAX_BYTES: 'huge' }), /必须是正整数/)
  assert.throws(() => collectEnvSecrets({ A_TOKEN: 'x' }, { include: ['  '] }), /非空字符串/)
})

test('默认上限是一个正数，且未配置时生效', () => {
  assert.equal(DEFAULT_MAX_BYTES, 8192)
  const result = collectEnvSecrets({ TOKEN_HUGE: 'x'.repeat(DEFAULT_MAX_BYTES + 1) })
  assert.deepEqual(result.names, [])
})

test('describeNames 只输出名字与原因，绝不包含任何值', () => {
  const sentinel = 'SENTINEL_VALUE_DO_NOT_PRINT'
  const result = collectEnvSecrets({
    GITHUB_TOKEN: sentinel,
    TOKEN_EMPTY: '',
    SSH_SECRET_BLOB: `line1\n${sentinel}`,
  })
  const text = describeNames(result)
  assert.equal(text.includes(sentinel), false)
  for (const value of Object.values(result.values)) assert.equal(text.includes(value), false)
  assert.match(text, /GITHUB_TOKEN/)
  assert.match(text, /TOKEN_EMPTY\(empty\)/)
  assert.match(text, /SSH_SECRET_BLOB\(multiline\)/)
})
