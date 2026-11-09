/**
 * 插件 Config 的扩展逻辑。
 *
 * 本插件默认导出 `SandboxBashExecutor` 的子类，行的 `config` 由基类的 Config
 * schema 校验（`timeoutMs` 等）。界面需要额外可实时编辑的 `pattern` 字段，
 * 因此把基类 schema 的字段字典复制出来，再追加一个 volatile 字段。
 *
 * volatile 是硬要求：harness 的 settings/configForms 只允许编辑 volatile 字段，
 * 且 volatile 字段在 profile 配置写入后原地更新（不会重挂 shell 执行器）。
 *
 * 这里刻意不 import schemastery：schema 工厂由调用方传入，纯逻辑便于单测。
 * @module dsh-shell-secrets/config
 */

/**
 * 在基类 Config schema 之上追加 `pattern` 字段。
 *
 * 兼容性策略：基类不是可读的 object schema 时原样返回，让插件仍能启动
 * （只是界面配置不可用），避免为了一个 UI 字段把 shell 执行器弄挂。
 * @param base - 基类的 Config schema（`SandboxBashExecutor.Config`）。
 * @param schema - schemastery 的 z 命名空间（`@deepseek-ai/schemastery` 默认导出）。
 * @param field - 追加的字段名，默认 `pattern`。
 * @returns 扩展后的 schema；无法扩展时返回 `base`。
 */
export function extendConfigSchema(base, schema, field = 'pattern') {
  const dict = base?.dict
  if (schema === undefined || dict === undefined || typeof dict !== 'object') return base
  return schema.object({ ...dict, [field]: schema.string().volatile() })
}
