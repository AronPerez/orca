// Read adapter for the legacy built-in command-prefix override (settings
// `agentCmdOverrides` values). At HEAD nothing tokenizes this raw string:
// `resolveBaseCommand` in tui-agent-startup.ts concatenates it as shell text and
// the target shell splits it. This adapter reproduces each installed override's
// CURRENT per-target-shell meaning so launch and the built-in duplication
// equivalence gate can read it as structured argv instead of raw text.
//
// Per-shell grammar (grouping only — no expansion, substitution, or globbing):
// - posix: whitespace splits; single quotes literal-group; double quotes group
//   with `\" \\ \$ \`` backslash escapes; backslash outside quotes escapes the
//   next char.
// - powershell: whitespace splits with double- AND single-quote grouping;
//   backslashes are literal; the U+2018-U+201B smart-quote class groups like '.
// - cmd: whitespace splits with double-quote grouping only; backslashes literal;
//   single quotes are ordinary characters.
// All shells reject NUL/control chars and unquoted shell operators so these
// overrides stay visible for Settings repair rather than being reinterpreted.

import type { AgentStartupShell } from './tui-agent-startup-shell'

export type LegacyAgentPrefixTokenizeResult =
  | { ok: true; tokens: string[] }
  | { ok: false; reason: 'unterminated_quote' | 'shell_operator' | 'control_char' }

const SEPARATORS = new Set([' ', '\t', '\r', '\n'])

// Unquoted occurrences of these route the override to Settings repair rather
// than being executed or split (launch maps this to invalid_command_override).
const OPERATOR_CHARS = new Set(['&', '|', ';', '<', '>'])

// PowerShell groups the ASCII apostrophe and the U+2018-U+201B smart-quote class
// as one interchangeable single-quote delimiter class.
const POWERSHELL_SINGLE_QUOTES = new Set(["'", '‘', '’', '‚', '‛'])

function isDisallowedControl(char: string): boolean {
  const code = char.charCodeAt(0)
  // NUL, C0 (minus tab/CR/LF which act as separators), DEL, C1.
  if (code === 0x00 || code === 0x7f) {
    return true
  }
  if (code < 0x20) {
    return char !== '\t' && char !== '\r' && char !== '\n'
  }
  return code >= 0x80 && code <= 0x9f
}

type QuoteScan =
  | { ok: true; value: string; nextIndex: number }
  | { ok: false; reason: 'unterminated_quote' | 'control_char' }

/** Literal-group scan until any closing delimiter in `closers`; no escapes. */
function scanLiteralQuote(input: string, openIndex: number, closers: Set<string>): QuoteScan {
  let value = ''
  let i = openIndex + 1
  while (i < input.length) {
    const inner = input[i]
    if (closers.has(inner)) {
      return { ok: true, value, nextIndex: i + 1 }
    }
    if (isDisallowedControl(inner)) {
      return { ok: false, reason: 'control_char' }
    }
    value += inner
    i += 1
  }
  return { ok: false, reason: 'unterminated_quote' }
}

/** POSIX double-quote scan: only `\" \\ \$ \`` drop the backslash; any other
 *  backslash stays literal alongside the following character. */
function scanPosixDoubleQuote(input: string, openIndex: number): QuoteScan {
  let value = ''
  let i = openIndex + 1
  while (i < input.length) {
    const inner = input[i]
    if (inner === '"') {
      return { ok: true, value, nextIndex: i + 1 }
    }
    if (isDisallowedControl(inner)) {
      return { ok: false, reason: 'control_char' }
    }
    if (inner === '\\' && i + 1 < input.length) {
      const next = input[i + 1]
      if (next === '"' || next === '\\' || next === '$' || next === '`') {
        value += next
        i += 2
        continue
      }
    }
    value += inner
    i += 1
  }
  return { ok: false, reason: 'unterminated_quote' }
}

type ShellGrammar = {
  /** Chars that open a literal single-quote group, mapped to their closer set. */
  singleQuoteOpeners: Map<string, Set<string>>
  /** Double quotes group; posix additionally decodes backslash escapes inside. */
  posixDoubleQuoteEscapes: boolean
  /** Outside quotes, backslash escapes the next char (posix only). */
  backslashEscapesOutsideQuotes: boolean
}

const DOUBLE_QUOTE_CLOSERS = new Set(['"'])

function grammarFor(shell: AgentStartupShell): ShellGrammar {
  if (shell === 'posix') {
    return {
      singleQuoteOpeners: new Map([["'", new Set(["'"])]]),
      posixDoubleQuoteEscapes: true,
      backslashEscapesOutsideQuotes: true
    }
  }
  if (shell === 'powershell') {
    const openers = new Map<string, Set<string>>()
    for (const opener of POWERSHELL_SINGLE_QUOTES) {
      openers.set(opener, POWERSHELL_SINGLE_QUOTES)
    }
    return {
      singleQuoteOpeners: openers,
      posixDoubleQuoteEscapes: false,
      backslashEscapesOutsideQuotes: false
    }
  }
  // cmd: double-quote grouping only; single quotes and backslashes are literal.
  return {
    singleQuoteOpeners: new Map(),
    posixDoubleQuoteEscapes: false,
    backslashEscapesOutsideQuotes: false
  }
}

export function tokenizeLegacyAgentPrefix(
  prefix: string,
  shell: AgentStartupShell
): LegacyAgentPrefixTokenizeResult {
  const grammar = grammarFor(shell)
  const tokens: string[] = []
  let current = ''
  let hasCurrent = false
  let i = 0

  while (i < prefix.length) {
    const char = prefix[i]

    if (SEPARATORS.has(char)) {
      if (hasCurrent) {
        tokens.push(current)
        current = ''
        hasCurrent = false
      }
      i += 1
      continue
    }

    if (isDisallowedControl(char)) {
      return { ok: false, reason: 'control_char' }
    }

    if (OPERATOR_CHARS.has(char)) {
      return { ok: false, reason: 'shell_operator' }
    }

    if (char === '"') {
      const scan = grammar.posixDoubleQuoteEscapes
        ? scanPosixDoubleQuote(prefix, i)
        : scanLiteralQuote(prefix, i, DOUBLE_QUOTE_CLOSERS)
      if (!scan.ok) {
        return scan
      }
      current += scan.value
      hasCurrent = true
      i = scan.nextIndex
      continue
    }

    const singleCloser = grammar.singleQuoteOpeners.get(char)
    if (singleCloser) {
      const scan = scanLiteralQuote(prefix, i, singleCloser)
      if (!scan.ok) {
        return scan
      }
      current += scan.value
      hasCurrent = true
      i = scan.nextIndex
      continue
    }

    if (char === '\\' && grammar.backslashEscapesOutsideQuotes && i + 1 < prefix.length) {
      const next = prefix[i + 1]
      if (isDisallowedControl(next)) {
        return { ok: false, reason: 'control_char' }
      }
      current += next
      hasCurrent = true
      i += 2
      continue
    }

    current += char
    hasCurrent = true
    i += 1
  }

  if (hasCurrent) {
    tokens.push(current)
  }
  return { ok: true, tokens }
}

const ALL_SHELLS: readonly AgentStartupShell[] = ['posix', 'powershell', 'cmd']

function tokensEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  return a.every((token, index) => token === b[index])
}

/** True when the prefix does not read to identical argv under all three shell
 *  grammars — the built-in duplication equivalence gate. Uniform failures (same
 *  reason under every grammar) are not ambiguous; the caller's tokenize catches
 *  them. Any ok/error mix or divergent argv is ambiguous. */
export function isLegacyAgentPrefixPlatformAmbiguous(prefix: string): boolean {
  const results = ALL_SHELLS.map((shell) => tokenizeLegacyAgentPrefix(prefix, shell))
  const [first, ...rest] = results
  if (first.ok) {
    return !rest.every((other) => other.ok && tokensEqual(first.tokens, other.tokens))
  }
  return !rest.every((other) => !other.ok && other.reason === first.reason)
}
