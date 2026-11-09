/**
 * @lixiangzhong/dsh-shell-secrets 的浏览器半边。
 *
 * 职责只有一件：在「插件」页里，为本插件的 `shell-secrets` 行提供配置表单，
 * 让用户编辑 `pattern`（与启动环境变量 `DSH_SHELL_SECRETS_PATTERN` 同角色，
 * 但对它优先级更高）。
 *
 * 数据通道完全走宿主自带的配置表单：
 * - 宿主把该行的 volatile 字段投影成 `plugins.row.config` 的 `form` prop
 *   （`{ state, mutate }`），值、基线、覆盖状态与写队列都由宿主提供；
 * - 本组件只做草稿（staged edit）与保存/恢复默认，不直连 profile 文件；
 * - 保存后 harness 原地更新 volatile 配置，下一次 bash 命令即用新规则。
 *
 * 模块形态：浏览器端 `window.__ModuleLoader__.load` 工厂（无构建），React 由
 * 浏览器模块表通过 `require('react')` 提供；视觉只用官方主题变量，样式作用域
 * 收在 `.dss-` 前缀内。
 */
window.__ModuleLoader__.load({
  id: '@lixiangzhong/dsh-shell-secrets',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 本插件拥有的 locale 命名空间。 */
    const LOCALE_NS = 'dsh-shell-secrets'
    /** 配置页的槽位键：`<包名>#<bundle patch 里的行 id>`。 */
    const ROW_CONFIG_KEY = '@lixiangzhong/dsh-shell-secrets#shell-secrets'
    /** 内置默认正则（与插件宿主侧、harness 的 scrub 规则一致）。 */
    const DEFAULT_PATTERN = 'KEY|PASSWORD|SECRET|TOKEN'
    /** 样式节点 id；重复挂载时先清理旧节点。 */
    const STYLE_ID = 'dsh-shell-secrets-style'
    /** 表单输入框 id（label 关联用）。 */
    const INPUT_ID = 'dsh-shell-secrets-pattern'

    /** 简体中文文案。 */
    const ZH = {
      summary: '把启动环境里的密钥变量以原名注入 bash 子进程。',
      label: '变量名匹配正则',
      placeholder: '留空则使用启动环境 / 内置默认规则',
      hint:
        '正则忽略大小写，按子串匹配；例如 KEY|PASSWORD|SECRET|TOKEN。' +
        '留空时回退到启动环境的 DSH_SHELL_SECRETS_PATTERN，再回退到内置默认。' +
        '若启动环境设置了 DSH_SHELL_SECRETS_INCLUDE，INCLUDE 优先于本正则。',
      defaultRule: '内置默认：KEY|PASSWORD|SECRET|TOKEN',
      overridden: '已覆盖',
      reset: '恢复默认',
      save: '保存',
      saving: '保存中…',
      saved: '已保存，下一次 bash 命令生效。',
      saveFailed: '宿主没有接受这次修改，请重试。',
      invalid: '正则无效：{detail}',
      unavailable: '该插件当前未加载，暂时无法配置。',
      readOnly: '此部署的设置为只读，无法保存。',
    }

    /** English copy. */
    const EN = {
      summary: 'Re-inject credential-named variables from the launching environment into bash subprocesses.',
      label: 'Variable name pattern',
      placeholder: 'Leave empty to use the launch environment or the built-in default',
      hint:
        'Case-insensitive substring match, for example KEY|PASSWORD|SECRET|TOKEN. ' +
        'When empty it falls back to DSH_SHELL_SECRETS_PATTERN from the launch environment, then to the built-in default. ' +
        'If DSH_SHELL_SECRETS_INCLUDE is set, INCLUDE takes precedence over this pattern.',
      defaultRule: 'Built-in default: KEY|PASSWORD|SECRET|TOKEN',
      overridden: 'Overridden',
      reset: 'Reset to default',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved; the next bash command uses it.',
      saveFailed: 'The Host did not accept this change. Please retry.',
      invalid: 'Invalid regular expression: {detail}',
      unavailable: 'This plugin is not loaded and cannot be configured right now.',
      readOnly: 'This deployment stores settings read-only.',
    }

    /** 表单与控件的样式：只用官方主题变量，作用域收在 .dss- 前缀内。 */
    const STYLE_TEXT = `
.dss-form { display: flex; flex-direction: column; gap: 8px; max-width: 640px; }
.dss-label-row { display: flex; align-items: center; gap: 8px; }
.dss-label { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; line-height: 20px; }
.dss-badge { border: .5px solid var(--dsw-alias-border-l1); border-radius: 999px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 18px; padding: 0 8px; }
.dss-input { box-sizing: border-box; width: 100%; height: 36px; border: .5px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; padding: 0 10px; outline: none; }
.dss-input::placeholder { color: var(--dsw-alias-label-secondary); }
.dss-input:focus { border-color: var(--dsw-alias-brand-primary); box-shadow: inset 0 0 0 .5px var(--dsw-alias-brand-primary); }
.dss-input:disabled { opacity: .5; cursor: default; }
.dss-hint { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.dss-default-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dss-default { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); }
.dss-error { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.dss-success { margin: 0; color: var(--dsw-alias-state-success-primary); font-size: 12px; line-height: 18px; }
.dss-actions { display: flex; align-items: center; gap: 8px; }
.dss-button { height: 32px; border-radius: 8px; padding: 0 12px; font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; }
.dss-button:disabled { opacity: .5; cursor: default; }
.dss-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dss-button-primary { border: .5px solid var(--dsw-alias-brand-primary); background: transparent; color: var(--dsw-alias-brand-primary); }
.dss-button-primary:not(:disabled):hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent); }
.dss-button-ghost { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); padding: 0 4px; }
.dss-button-ghost:not(:disabled):hover { color: var(--dsw-alias-label-primary); }
`

    /**
     * 校验用户输入的正则；空值合法（表示清除覆盖）。
     * @param source - 输入框里的文本。
     * @returns 错误描述，合法时 null。
     */
    function patternError(source) {
      const trimmed = source.trim()
      if (trimmed.length === 0) return null
      try {
        // eslint-disable-next-line no-new
        new RegExp(trimmed, 'i')
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }

    /**
     * 配置表单主体。
     *
     * 草稿策略：`draft === null` 表示没有本地修改，直接显示宿主投影的生效值；
     * 只有保存成功才把草稿清空并回到宿主值。离开页面即卸载，草稿随组件丢弃。
     * @param props - `{ t, form }`，`form` 是宿主为这一行提供的 `{ state, mutate }`。
     */
    function PatternForm(props) {
      const { t, form } = props
      const state = form.state ?? {}
      const effective = typeof state.value?.pattern === 'string' ? state.value.pattern : ''
      const overridden = state.user !== null && typeof state.user === 'object' && Object.prototype.hasOwnProperty.call(state.user, 'pattern')
      const unavailable = state.status === 'unavailable'
      const disabled = unavailable || state.writable === false

      const draftState = React.useState(null)
      const draft = draftState[0]
      const setDraft = draftState[1]
      const savingState = React.useState(false)
      const saving = savingState[0]
      const setSaving = savingState[1]
      const messageState = React.useState(null)
      const message = messageState[0]
      const setMessage = messageState[1]

      const displayed = draft === null ? effective : draft
      const dirty = draft !== null && displayed.trim() !== effective.trim()

      /** 把当前草稿写回宿主；保存失败保留草稿供用户修改。 */
      async function save() {
        if (saving || disabled) return
        const source = displayed.trim()
        const invalid = patternError(source)
        if (invalid !== null) {
          setMessage({ tone: 'error', text: t('invalid', { detail: invalid }) })
          return
        }
        const ops = source.length === 0 ? [{ op: 'unset', path: ['pattern'] }] : [{ op: 'set', path: ['pattern'], value: source }]
        setSaving(true)
        setMessage(null)
        let accepted = false
        try {
          accepted = await form.mutate(ops, state.revision)
        } catch (error) {
          accepted = false
        }
        setSaving(false)
        if (accepted) {
          setDraft(null)
          setMessage({ tone: 'success', text: t('saved') })
        } else {
          setMessage({ tone: 'error', text: t('saveFailed') })
        }
      }

      if (unavailable) {
        return h('p', { className: 'dss-hint' }, t('unavailable'))
      }

      return h(
        'div',
        { className: 'dss-form' },
        h(
          'div',
          { className: 'dss-label-row' },
          h('label', { className: 'dss-label', htmlFor: INPUT_ID }, t('label')),
          overridden ? h('span', { className: 'dss-badge' }, t('overridden')) : null,
        ),
        h('input', {
          id: INPUT_ID,
          className: 'dss-input',
          type: 'text',
          value: displayed,
          placeholder: t('placeholder'),
          spellCheck: false,
          autoComplete: 'off',
          disabled: disabled || saving,
          onChange: (event) => {
            setDraft(event.target.value)
            setMessage(null)
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter' && dirty) void save()
          },
        }),
        h('p', { className: 'dss-hint' }, t('hint')),
        h(
          'div',
          { className: 'dss-default-row' },
          h('span', { className: 'dss-default' }, t('defaultRule')),
          h(
            'button',
            {
              className: 'dss-button dss-button-ghost',
              type: 'button',
              disabled: disabled || saving,
              onClick: () => {
                setDraft('')
                setMessage(null)
              },
            },
            t('reset'),
          ),
        ),
        state.writable === false ? h('p', { className: 'dss-hint' }, t('readOnly')) : null,
        message !== null
          ? h('p', { className: message.tone === 'error' ? 'dss-error' : 'dss-success' }, message.text)
          : null,
        h(
          'div',
          { className: 'dss-actions' },
          h(
            'button',
            {
              className: 'dss-button dss-button-primary',
              type: 'button',
              disabled: disabled || saving || !dirty,
              onClick: () => void save(),
            },
            saving ? t('saving') : t('save'),
          ),
        ),
      )
    }

    /**
     * 槽位入口：按页面要求的视图渲染一行摘要或完整表单。
     * @param props - `{ t, view, form? }`。
     */
    function ShellSecretsCard(props) {
      const { t, view, form } = props
      if (view === 'summary') return h('span', null, t('summary'))
      if (form === undefined || form === null) return h('p', { className: 'dss-hint' }, t('unavailable'))
      return h(PatternForm, { t, form })
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 样式只注入一次，插件卸载时移除。
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          const existing = document.getElementById(STYLE_ID)
          if (existing !== null) existing.remove()
          const style = document.createElement('style')
          style.id = STYLE_ID
          style.dataset.plugin = '@lixiangzhong/dsh-shell-secrets'
          style.textContent = STYLE_TEXT
          document.head.appendChild(style)
          return () => {
            style.remove()
          }
        }, 'dsh-shell-secrets: styles')

        ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh: ZH, en: EN }), 'dsh-shell-secrets: dictionaries')

        // 插件页里本 bundle 的 shell-secrets 行会出现「配置」入口，点开就是这张表单。
        ctx.effect(
          () =>
            ctx.slots.inject('plugins.row.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.row.config',
                  key: ROW_CONFIG_KEY,
                  locale: LOCALE_NS,
                },
                ShellSecretsCard,
              ),
            ),
          'dsh-shell-secrets: row config page',
        )
      },
    }
  },
})
