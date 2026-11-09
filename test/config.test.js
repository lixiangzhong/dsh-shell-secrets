/**
 * lib/config.js 的单测：验证「在基类 Config schema 上追加 volatile pattern」的做法。
 *
 * 这里刻意从当前 dsh profile 借用真实的 `@deepseek-ai/schemastery`，因为仓库本身
 * 零依赖（schemastery 是 harness 的 peer）。不在 dsh 环境（或解析不到）时跳过，
 * 保证 `node --test` 在纯仓库里也能通过。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'

import { extendConfigSchema } from '../lib/config.js'

/**
 * 从 dsh profile 解析 schemastery。
 * @returns z 命名空间；不可用时 undefined。
 */
function loadSchemastery() {
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir !== 'string' || profileDir.length === 0) return undefined
  try {
    const requireFromProfile = createRequire(join(profileDir, 'probe.js'))
    const loaded = requireFromProfile('@deepseek-ai/schemastery')
    return loaded.default ?? loaded
  } catch {
    return undefined
  }
}

const z = loadSchemastery()
const skip = z === undefined ? '需要 dsh profile 里的 @deepseek-ai/schemastery' : false

/** 模拟 LocalBashExecutor 基类的 Config：全部 volatile。 */
function baseSchema() {
  return z.object({
    cwd: z.string().volatile(),
    timeoutMs: z.number().default(120000).volatile(),
    maxOutputBytes: z.number().default(64000).volatile(),
  })
}

test('extendConfigSchema 保留基类字段与默认值，并追加 volatile pattern', { skip }, () => {
  const base = baseSchema()
  const extended = extendConfigSchema(base, z)

  assert.notEqual(extended, base)
  assert.deepEqual(Object.keys(extended.dict).sort(), ['cwd', 'maxOutputBytes', 'pattern', 'timeoutMs'])
  assert.equal(extended.dict.pattern.meta.volatile, true)

  // 行配置里带 pattern：基类默认值照旧补齐。
  const value = extended({ timeoutMs: 60000, pattern: '^AWS_' })
  assert.equal(value.timeoutMs.get(), 60000)
  assert.equal(value.maxOutputBytes.get(), 64000)
  assert.equal(value.pattern.get(), '^AWS_')

  // 未配置 pattern 时是 undefined，仍然可读且不抛错。
  assert.equal(extended({ timeoutMs: 60000 }).pattern.get(), undefined)

  // 类型错误照旧被 schema 拒绝。
  assert.throws(() => extended({ timeoutMs: 60000, pattern: 123 }), /expect.*string|string.*expected/i)
})

test('extendConfigSchema 在基类 schema 不可读时原样返回', { skip }, () => {
  const unreadable = { notASchema: true }
  assert.equal(extendConfigSchema(unreadable, z), unreadable)
  assert.equal(extendConfigSchema(undefined, z), undefined)
})
