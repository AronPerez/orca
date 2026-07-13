import { describe, expect, it } from 'vitest'
import { buildShellCommandFromArgv, quoteStartupArg } from './tui-agent-startup-shell'

describe('quoteStartupArg', () => {
  describe('cmd', () => {
    it('passes the neutral metacharacters & | < > ( ) through unmodified inside quotes', () => {
      // Regression: the old quoter caret-escaped inside double quotes, where a
      // caret is literal, so "C:\Foo & Bar" reached the program as C:\Foo ^& Bar.
      expect(quoteStartupArg('C:\\Foo & Bar', 'cmd')).toBe('"C:\\Foo & Bar"')
      expect(quoteStartupArg('a|b<c>d(e)f', 'cmd')).toBe('"a|b<c>d(e)f"')
    })

    it('keeps Windows backslashes literal', () => {
      expect(quoteStartupArg('C:\\Users\\me\\bin\\codex.exe', 'cmd')).toBe(
        '"C:\\Users\\me\\bin\\codex.exe"'
      )
    })
  })

  describe('powershell', () => {
    it('doubles ASCII single quotes', () => {
      expect(quoteStartupArg("it's", 'powershell')).toBe("'it''s'")
    })

    it('doubles the U+2018-U+201B delimiter class PowerShell also treats as quotes', () => {
      expect(quoteStartupArg('a‘b', 'powershell')).toBe("'a‘‘b'")
      expect(quoteStartupArg('a’b', 'powershell')).toBe("'a’’b'")
      expect(quoteStartupArg('a‚b', 'powershell')).toBe("'a‚‚b'")
      expect(quoteStartupArg('a‛b', 'powershell')).toBe("'a‛‛b'")
    })

    it('keeps backslashes and other metacharacters literal', () => {
      expect(quoteStartupArg('C:\\Users\\me', 'powershell')).toBe("'C:\\Users\\me'")
      expect(quoteStartupArg('$env:PATH;&|', 'powershell')).toBe("'$env:PATH;&|'")
    })
  })

  describe('posix', () => {
    it('single-quotes with the standard quote-splice escape', () => {
      expect(quoteStartupArg("it's", 'posix')).toBe(`'it'\\''s'`)
      expect(quoteStartupArg('a $VAR `cmd` "x"', 'posix')).toBe(`'a $VAR \`cmd\` "x"'`)
    })
  })
})

describe('buildShellCommandFromArgv', () => {
  it('quotes each element exactly once per target shell', () => {
    expect(buildShellCommandFromArgv(['/opt/my tools/codex', '--model', 'x y'], 'posix')).toBe(
      `'/opt/my tools/codex' '--model' 'x y'`
    )
    expect(buildShellCommandFromArgv(['codex', '--flag'], 'powershell')).toBe(`& 'codex' '--flag'`)
    expect(buildShellCommandFromArgv(['C:\\a & b\\codex.exe', '--flag'], 'cmd')).toBe(
      '"C:\\a & b\\codex.exe" "--flag"'
    )
  })
})
