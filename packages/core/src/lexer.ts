import { DiagnosticCode, Diagnostics, type Diagnostic } from './diagnostics.js'

export type TagAttrs = Record<string, string>

export enum TokenType {
    Text = 'text',
    TagOpen = 'tag-open',
    TagClose = 'tag-close',
    Placeholder = 'placeholder'
}

export interface TextToken {
    type: TokenType.Text
    value: string
    start: number
    end: number
}

export interface TagOpenToken {
    type: TokenType.TagOpen
    name: string
    attrs: TagAttrs
    start: number
    end: number
}

export interface TagCloseToken {
    type: TokenType.TagClose
    name: string
    start: number
    end: number
}

export interface PlaceholderToken {
    type: TokenType.Placeholder
    /** Raw, unparsed content between `{{` and `}}`. */
    raw: string
    start: number
    end: number
}

export type Token = TextToken | TagOpenToken | TagCloseToken | PlaceholderToken

export interface LexerOutput {
    tokens: Token[]
    diagnostics: Diagnostic[]
}

export interface LexerOptions {
    identifierStart?: RegExp
    identifierPart?: RegExp
}

class Cursor {
    private pos = 0

    public constructor(private readonly input: string) {}

    public get position(): number {
        return this.pos
    }

    public get eof(): boolean {
        return this.pos >= this.input.length
    }

    public peek(offset = 0): string | undefined {
        return this.input[this.pos + offset]
    }

    public advance(count = 1): void {
        this.pos += count
    }

    /** Rewinds the cursor to a previously saved position (used for backtracking). */
    public reset(pos: number): void {
        this.pos = pos
    }
}

export class Lexer {
    private cursor: Cursor
    private diagnostics: Diagnostics

    private identifierStart: RegExp
    private identifierPart: RegExp

    public constructor(input: string, options: LexerOptions = {}) {
        this.cursor = new Cursor(input)
        this.diagnostics = new Diagnostics()

        this.identifierStart = options.identifierStart ?? /[a-zA-Z_]/
        this.identifierPart = options.identifierPart ?? /[a-zA-Z0-9_]/
    }

    private isIdentifierStart(ch: string | undefined): boolean {
        return ch !== undefined && this.identifierStart.test(ch)
    }

    private isIdentifierPart(ch: string | undefined): boolean {
        return ch !== undefined && this.identifierPart.test(ch)
    }

    private isEscapable(ch: string | undefined): boolean {
        return ch === '{' || ch === '}' || ch === '<' || ch === '>' || ch === '\\'
    }

    /**
     * Tokenizes a raw localization string into a flat stream of tokens.
     */
    public tokenize(): LexerOutput {
        const tokens: Token[] = []

        let textStart = 0
        let textBuffer = ''

        function flushText(end: number): void {
            if (textBuffer.length > 0) {
                tokens.push({ type: TokenType.Text, value: textBuffer, start: textStart, end })
                textBuffer = ''
            }
        }

        while (!this.cursor.eof) {
            const ch = this.cursor.peek()!
            const start = this.cursor.position

            // Escaping: \{, \}, \<, \>, \\ are always treated as literal characters
            if (ch === '\\' && this.isEscapable(this.cursor.peek(1))) {
                textBuffer += this.cursor.peek(1)
                this.cursor.advance(2)
                continue
            }

            // Placeholder: {{ ... }}
            if (ch === '{' && this.cursor.peek(1) === '{') {
                flushText(start)
                tokens.push(this.readPlaceholder())
                textStart = this.cursor.position
                continue
            }

            // Tag close: </name>
            if (ch === '<' && this.cursor.peek(1) === '/') {
                const tagClose = this.tryReadTagClose()
                if (tagClose) {
                    flushText(start)
                    tokens.push(tagClose)
                    textStart = this.cursor.position
                    continue
                }
            }

            // Tag open: <name attr="value" ...>
            if (ch === '<' && this.isIdentifierStart(this.cursor.peek(1))) {
                const tagOpen = this.tryReadTagOpen()
                if (tagOpen) {
                    flushText(start)
                    tokens.push(tagOpen)
                    textStart = this.cursor.position
                    continue
                }
            }

            // Anything else (including a lone '<' or '{' that isn't part of a
            // valid construct) is just plain text
            textBuffer += ch
            this.cursor.advance()
        }

        flushText(this.cursor.position)
        return { tokens, diagnostics: [...this.diagnostics.entries] }
    }

    /**
     * Reads a `{{ ... }}` placeholder starting at the current cursor position.
     */
    private readPlaceholder(): PlaceholderToken {
        const start = this.cursor.position
        this.cursor.advance(2) // consume '{{'

        let raw = ''
        let parenDepth = 0

        while (!this.cursor.eof) {
            const ch = this.cursor.peek()!

            if (ch === '(') parenDepth++
            if (ch === ')') parenDepth = Math.max(0, parenDepth - 1)

            if (ch === '}' && this.cursor.peek(1) === '}' && parenDepth === 0) {
                this.cursor.advance(2) // consume '}}'
                return { type: TokenType.Placeholder, raw: raw.trim(), start, end: this.cursor.position }
            }

            raw += ch
            this.cursor.advance()
        }

        this.diagnostics.error(
            DiagnosticCode.UnclosedPlaceholder,
            `Unclosed placeholder starting at position ${start}`,
            start
        )
        return { type: TokenType.Placeholder, raw: raw.trim(), start, end: this.cursor.position }
    }

    /**
     * Attempts to read an opening tag `<name attr="value" ...>`. Returns null
     * and leaves the cursor untouched if the input doesn't resolve to a
     * well-formed tag.
     */
    private tryReadTagOpen(): TagOpenToken | null {
        const start = this.cursor.position
        this.cursor.advance() // consume '<'

        const name = this.readIdentifier()
        if (!name) {
            this.cursor.reset(start)
            return null
        }

        const attrs: TagAttrs = {}

        while (true) {
            this.skipWhitespace()
            const ch = this.cursor.peek()

            if (ch === '>') {
                this.cursor.advance()
                return { type: TokenType.TagOpen, name, attrs, start, end: this.cursor.position }
            }

            if (ch === undefined) {
                this.diagnostics.error(
                    DiagnosticCode.UnclosedTag,
                    `Unclosed tag <${name}> starting at position ${start}`,
                    start
                )
                return { type: TokenType.TagOpen, name, attrs, start, end: this.cursor.position }
            }

            const attrName = this.readIdentifier()
            if (!attrName) {
                // Not '>' and not a valid attribute name - this wasn't a real tag
                // (e.g. the user wrote a literal "<3" in their text).
                this.cursor.reset(start)
                return null
            }

            this.skipWhitespace()

            if (this.cursor.peek() === '=') {
                this.cursor.advance()
                this.skipWhitespace()

                const value = this.readQuotedValue()
                if (value === null) {
                    this.cursor.reset(start)
                    return null
                }
                attrs[attrName] = value
            } else {
                // Boolean-style attribute, e.g. <link external>
                attrs[attrName] = 'true'
            }
        }
    }

    /**
     * Attempts to read a closing tag `</name>`. Returns null and leaves the
     * cursor untouched if what follows `</` doesn't resolve to a valid tag -
     * the caller then falls back to treating '<' as a literal character.
     */
    private tryReadTagClose(): TagCloseToken | null {
        const start = this.cursor.position
        this.cursor.advance(2) // consume '</'

        const name = this.readIdentifier()
        if (!name) {
            this.cursor.reset(start)
            return null
        }

        this.skipWhitespace()

        if (this.cursor.peek() !== '>') {
            this.cursor.reset(start)
            return null
        }

        this.cursor.advance() // consume '>'

        return { type: TokenType.TagClose, name, start, end: this.cursor.position }
    }

    private readIdentifier(): string | null {
        if (!this.isIdentifierStart(this.cursor.peek())) return null

        let value = ''
        while (this.isIdentifierPart(this.cursor.peek())) {
            value += this.cursor.peek()
            this.cursor.advance()
        }

        return value
    }

    private readQuotedValue(): string | null {
        const quote = this.cursor.peek()
        if (quote !== '"' && quote !== "'") return null
        this.cursor.advance()

        let value = ''
        while (!this.cursor.eof && this.cursor.peek() !== quote) {
            if (this.cursor.peek() === '\\' && this.cursor.peek(1) === quote) {
                value += quote
                this.cursor.advance(2)
                continue
            }

            value += this.cursor.peek()
            this.cursor.advance()
        }

        if (this.cursor.eof) return null // unterminated string literal
        this.cursor.advance() // consume closing quote
        return value
    }

    private skipWhitespace(): void {
        while (this.cursor.peek() === ' ' || this.cursor.peek() === '\t') {
            this.cursor.advance()
        }
    }
}
