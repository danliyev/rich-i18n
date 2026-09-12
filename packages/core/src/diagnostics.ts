export enum DiagnosticCode {
    UnclosedPlaceholder = 'UnclosedPlaceholder',
    UnclosedTag = 'UnclosedTag',
    UnmatchedClosingTag = 'UnmatchedClosingTag',
    ImplicitlyClosedTag = 'ImplicitlyClosedTag',
    EmptyPlaceholder = 'EmptyPlaceholder',
    InvalidPlaceholderContent = 'InvalidPlaceholderContent',
    InvalidArgument = 'InvalidArgument',
    UnknownTag = 'UnknownTag',
    UnknownFunction = 'UnknownFunction',
    UnresolvedVariable = 'UnresolvedVariable',
    FunctionArgumentError = 'FunctionArgumentError'
}

export enum DiagnosticSeverity {
    Error = 'error',
    Warning = 'warning'
}

export interface Diagnostic {
    code: DiagnosticCode
    message: string
    position: number
    severity: DiagnosticSeverity
}

export interface LineColumn {
    line: number
    column: number
}

export class Diagnostics {
    public entries: Diagnostic[] = []

    public constructor() {}

    public get sortedByPosition(): Diagnostic[] {
        return [...this.entries].sort((a, b) => a.position - b.position)
    }

    private createEntry(
        severity: DiagnosticSeverity,
        data: Pick<Diagnostic, 'code' | 'message' | 'position'>
    ): Diagnostic {
        const diagnostic = { severity, code: data.code, message: data.message, position: data.position }
        this.entries.push(diagnostic)
        return diagnostic
    }

    public error(code: DiagnosticCode, message: string, position: number): Diagnostic {
        return this.createEntry(DiagnosticSeverity.Error, { code, message, position })
    }

    public warning(code: DiagnosticCode, message: string, position: number): Diagnostic {
        return this.createEntry(DiagnosticSeverity.Warning, { code, message, position })
    }

    public positionToLineColumn(source: string, position: number): LineColumn {
        const end = Math.max(0, Math.min(position, source.length))

        let line = 1
        let lineStart = 0

        for (let i = 0; i < end; i++) {
            if (source[i] === '\n') {
                line++
                lineStart = i + 1
            }
        }

        return { line, column: end - lineStart + 1 }
    }

    /**
     * Formats a single diagnostic as a compiler-style message with a source
     * frame and a caret pointing at the exact offending column.
     */
    public formatDiagnostic(diagnostic: Diagnostic, source: string): string {
        const { line, column } = this.positionToLineColumn(source, diagnostic.position)
        const sourceLine = source.split('\n')[line - 1] ?? ''
        const caretLine = ' '.repeat(Math.max(0, column - 1)) + '^'

        return [
            `${diagnostic.severity} [${diagnostic.code}] ${line}:${column}: ${diagnostic.message}`,
            sourceLine,
            caretLine
        ].join('\n')
    }

    public formatDiagnostics(source: string): string {
        return this.sortedByPosition.map(v => this.formatDiagnostic(v, source)).join('\n\n')
    }
}
