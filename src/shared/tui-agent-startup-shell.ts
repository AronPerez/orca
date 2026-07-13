import { tokenizeCustomCommandTemplate } from './commit-message-prompt'

export type AgentStartupShell = 'posix' | 'powershell' | 'cmd'

export type StartupCommandTokens = { ok: true; tokens: string[] } | { ok: false; error: string }

function tokenizeWindowsStartupCommand(
  value: string,
  shell: Exclude<AgentStartupShell, 'posix'>
): StartupCommandTokens {
  const tokens: string[] = []
  let token = ''
  let quote: "'" | '"' | null = null
  let tokenStarted = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    const escape = shell === 'cmd' ? '^' : '`'
    if (char === escape && index + 1 < value.length) {
      token += value[index + 1]
      tokenStarted = true
      index += 1
      continue
    }
    if (quote) {
      if (char === quote) {
        if (shell === 'powershell' && quote === "'" && value[index + 1] === "'") {
          token += "'"
          index += 1
        } else {
          quote = null
        }
      } else {
        token += char
      }
      tokenStarted = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      tokenStarted = true
    } else if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(token)
        token = ''
        tokenStarted = false
      }
    } else {
      token += char
      tokenStarted = true
    }
  }
  if (quote) {
    return { ok: false, error: 'Unclosed quote in command template.' }
  }
  if (tokenStarted) {
    tokens.push(token)
  }
  return { ok: true, tokens }
}

export function tokenizeStartupCommand(
  value: string,
  shell: AgentStartupShell
): StartupCommandTokens {
  return shell === 'posix'
    ? tokenizeCustomCommandTemplate(value)
    : tokenizeWindowsStartupCommand(value, shell)
}

export function resolveStartupShell(
  platform: NodeJS.Platform,
  shell?: AgentStartupShell
): AgentStartupShell {
  return shell ?? (platform === 'win32' ? 'powershell' : 'posix')
}

export function quoteStartupArg(value: string, shell: AgentStartupShell): string {
  if (shell === 'powershell') {
    // Why: PowerShell treats the Unicode quotation marks U+2018-U+201B as
    // single-quote string delimiters exactly like ASCII ' — all five must be
    // doubled or a smart quote in a path/prompt terminates the string early.
    return `'${value.replace(/(['‘’‚‛])/g, '$1$1')}'`
  }
  if (shell === 'cmd') {
    // Why: inside cmd double quotes a caret is a LITERAL character, so the old
    // caret-escaping corrupted data ("C:\Foo & Bar" reached the program as
    // C:\Foo ^& Bar). & | < > ( ) are neutral inside the quotes and must pass
    // through unchanged. %…%/delayed-! expansion and embedded " still apply
    // inside cmd quotes and cannot be encoded faithfully — resolver-managed
    // launches reject custom-supplied elements containing % ! " ^ before any
    // writer runs (cmd_metachar); this quoter passes them through as-is.
    return `"${value}"`
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Characters cmd cannot faithfully deliver inside a double-quoted argv element:
 *  %…% / delayed-! expansion still applies and embedded quotes re-split the
 *  line. Custom-supplied elements containing one of these fail closed when the
 *  target shell is cmd. */
export const CMD_UNENCODABLE_CHAR_RE = /[%!^"]/

export function buildShellCommandFromArgv(
  args: readonly string[],
  shell: AgentStartupShell
): string {
  const command = args.map((arg) => quoteStartupArg(arg, shell)).join(' ')
  if (shell === 'powershell' && command) {
    return `& ${command}`
  }
  return command
}

export function clearEnvCommand(name: string, shell: AgentStartupShell): string {
  if (shell === 'powershell') {
    return `Remove-Item Env:${name} -ErrorAction SilentlyContinue`
  }
  if (shell === 'cmd') {
    return `set "${name}="`
  }
  return `unset ${name}`
}

export function commandSeparator(shell: AgentStartupShell): string {
  return shell === 'cmd' ? ' & ' : '; '
}

export type AgentCliArgsPlan = { ok: true; suffix: string } | { ok: false; error: string }

export function planAgentCliArgsSuffix(
  agentArgs: string | null | undefined,
  shell: AgentStartupShell
): AgentCliArgsPlan {
  const trimmed = agentArgs?.trim()
  if (!trimmed) {
    return { ok: true, suffix: '' }
  }
  // Shell-aware tokenization (#7862): posix keeps the shared grammar, Windows
  // shells keep backslashes literal (same grammar the resolver's built-in
  // args band uses).
  const tokenized = tokenizeStartupCommand(trimmed, shell)
  if (!tokenized.ok) {
    return { ok: false, error: `CLI arguments are invalid: ${tokenized.error}` }
  }
  return {
    ok: true,
    suffix: tokenized.tokens.map((token) => quoteStartupArg(token, shell)).join(' ')
  }
}
