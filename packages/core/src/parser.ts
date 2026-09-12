import { DiagnosticCode, Diagnostics, type Diagnostic } from './diagnostics.js'
import { Lexer, TokenType, type LexerOptions, type TagAttrs, type TagCloseToken, type Token } from './lexer.js'

export enum NodeType {
    Text = 'text',
    Tag = 'tag',
    Variable = 'variable',
    Number = 'number',
    Literal = 'literal',
    Call = 'call'
}

export interface TextNode {
    type: NodeType.Text
    value: string
    start: number
    end: number
}

export interface TagNode {
    type: NodeType.Tag
    name: string
    attrs: TagAttrs
    children: Node[]
    start: number
    end: number
}

export interface VariableNode {
    type: NodeType.Variable
    /** Supports dotted paths, e.g. "user.name". */
    name: string
    start: number
    end: number
}

/** A bare, unquoted numeric argument inside a function call. */
export interface NumberNode {
    type: NodeType.Number
    value: number
    start: number
    end: number
}

/**
 * A quoted string argument inside a function call.
 */
export interface LiteralNode {
    type: NodeType.Literal
    value: string
    start: number
    end: number
}

export interface CallNode {
    type: NodeType.Call
    fn: string
    /**
     * Each argument is unambiguous by construction: quoted text is always a
     * `LiteralNode`, and anything unquoted must parse as a number, a variable
     * reference, or (recursively) another function call.
     */
    args: CallArgument[]
    start: number
    end: number
}

export type CallArgument = LiteralNode | NumberNode | VariableNode | CallNode

export type Node = TextNode | TagNode | VariableNode | CallNode

export interface ParserOutput {
    ast: Node[]
    diagnostics: Diagnostic[]
}

export interface ParserOptions {
    lexer?: LexerOptions
    callPattern?: RegExp
    variablePattern?: RegExp
    numberPattern?: RegExp
}

export class Parser {
    private lexer: Lexer
    private diagnostics: Diagnostics

    private callPattern: RegExp
    private variablePattern: RegExp
    private numberPattern: RegExp

    public constructor(input: string, options: ParserOptions = {}) {
        this.lexer = new Lexer(input, options.lexer)
        this.diagnostics = new Diagnostics()

        this.callPattern = options.callPattern ?? /^([a-zA-Z_][a-zA-Z0-9_]*)\((.*)\)$/s
        this.variablePattern = options.variablePattern ?? /^[a-zA-Z_][a-zA-Z0-9_.]*$/
        this.numberPattern = options.numberPattern ?? /^-?\d+(\.\d+)?$/
    }

    /**
     * Parses a raw localization string into an AST.
     */
    public parse(): ParserOutput {
        const lexResult = this.lexer.tokenize()
        const ast = this.buildTree(lexResult.tokens)
        return { ast, diagnostics: [...this.diagnostics.entries] }
    }

    private buildTree(tokens: Token[]): Node[] {
        const root: Node[] = []
        const stack: StackFrame[] = []

        const currentChildren = (): Node[] => (stack.length > 0 ? stack.at(-1)!.children : root)

        for (const token of tokens) {
            switch (token.type) {
                case TokenType.Text:
                    currentChildren().push({
                        type: NodeType.Text,
                        value: token.value,
                        start: token.start,
                        end: token.end
                    })
                    break

                case TokenType.TagOpen:
                    stack.push({ name: token.name, attrs: token.attrs, children: [], start: token.start })
                    break

                case TokenType.TagClose:
                    this.handleTagClose(token, stack, root)
                    break

                case TokenType.Placeholder: {
                    const node = this.parsePlaceholderContent(token.raw, token.start, token.end)
                    if (node) currentChildren().push(node)
                    break
                }
            }
        }

        // Anything still open at end of input never got a closing tag.
        while (stack.length > 0) {
            const frame = stack.pop()!
            this.diagnostics.error(
                DiagnosticCode.UnclosedTag,
                `Unclosed tag <${frame.name}> starting at position ${frame.start}`,
                frame.start
            )

            const end = frame.children.length > 0 ? frame.children.at(-1)!.end : frame.start
            this.attachTagNode(frame, stack, root, frame.start, end)
        }

        return root
    }

    /**
     * Resolves a `</name>` token against the open-tag stack.
     */
    private handleTagClose(token: TagCloseToken, stack: StackFrame[], root: Node[]): void {
        const matchIndex = stack.findLastIndex(frame => frame.name === token.name)

        if (matchIndex === -1) {
            this.diagnostics.warning(
                DiagnosticCode.UnmatchedClosingTag,
                `Closing tag </${token.name}> has no matching opening tag`,
                token.start
            )
            return
        }

        while (stack.length - 1 > matchIndex) {
            const frame = stack.pop()!
            this.diagnostics.warning(
                DiagnosticCode.ImplicitlyClosedTag,
                `Tag <${frame.name}> was implicitly closed by </${token.name}>`,
                token.start
            )
            this.attachTagNode(frame, stack, root, frame.start, token.start)
        }

        const closed = stack.pop()!
        this.attachTagNode(closed, stack, root, closed.start, token.end)
    }

    private attachTagNode(frame: StackFrame, stack: StackFrame[], root: Node[], start: number, end: number): void {
        const parent = stack.length > 0 ? stack.at(-1)!.children : root
        parent.push({
            type: NodeType.Tag,
            name: frame.name,
            attrs: frame.attrs,
            children: frame.children,
            start,
            end
        })
    }

    private parsePlaceholderContent(raw: string, start: number, end: number): VariableNode | CallNode | null {
        const trimmed = raw.trim()

        if (trimmed.length === 0) {
            this.diagnostics.error(DiagnosticCode.EmptyPlaceholder, 'Empty placeholder {{}}', start)
            return null
        }

        const callMatch = this.callPattern.exec(trimmed)
        if (callMatch) {
            const [, fn, fnArgs] = callMatch
            const args = this.splitArgs(fnArgs!).map(raw => this.parseCallArgument(raw, start))
            return { type: NodeType.Call, fn: fn!, args, start, end }
        }

        if (!this.variablePattern.test(trimmed)) {
            this.diagnostics.error(
                DiagnosticCode.InvalidPlaceholderContent,
                `Invalid placeholder content: "${trimmed}"`,
                start
            )
            return null
        }

        return { type: NodeType.Variable, name: trimmed, start, end }
    }

    /**
     * Turns one raw, already-split argument into a typed `CallArgument`.
     */
    private parseCallArgument(raw: RawArgument, position: number): CallArgument {
        if (raw.quoted) {
            return { type: NodeType.Literal, value: raw.text, start: position, end: position }
        }

        if (this.numberPattern.test(raw.text)) {
            return { type: NodeType.Number, value: Number(raw.text), start: position, end: position }
        }

        const callMatch = this.callPattern.exec(raw.text)
        if (callMatch) {
            const [, fn, fnArgs] = callMatch
            const args = this.splitArgs(fnArgs!).map(nested => this.parseCallArgument(nested, position))
            return { type: NodeType.Call, fn: fn!, args, start: position, end: position }
        }

        if (this.variablePattern.test(raw.text)) {
            return { type: NodeType.Variable, name: raw.text, start: position, end: position }
        }

        this.diagnostics.error(
            DiagnosticCode.InvalidArgument,
            `Argument "${raw.text}" must be a number, a variable, a function call, or wrapped in quotes as a literal`,
            position
        )

        // Recovery: treat the malformed token as a literal so resolve() still
        // has something to render instead of dropping it silently.
        return { type: NodeType.Literal, value: raw.text, start: position, end: position }
    }

    /**
     * Splits a function call's argument list on top-level commas.
     */
    private splitArgs(raw: string): RawArgument[] {
        const args: RawArgument[] = []
        let current = ''
        let depth = 0
        let quoteChar: string | null = null
        let quoted = false

        for (let i = 0; i < raw.length; i++) {
            const ch = raw[i]

            if (quoteChar) {
                if (ch === '\\' && raw[i + 1] === quoteChar) {
                    current += quoteChar
                    i++
                    continue
                }
                if (ch === quoteChar) {
                    quoteChar = null
                    continue
                }
                current += ch
                continue
            }

            // Only the first non-whitespace character of an argument can open a
            // quoted literal - this rejects malformed input like `a"b"`.
            if ((ch === '"' || ch === "'") && current.trim().length === 0) {
                quoteChar = ch
                quoted = true
                continue
            }

            if (ch === '(') depth++
            if (ch === ')') depth = Math.max(0, depth - 1)

            if (ch === ',' && depth === 0) {
                args.push({ text: current.trim(), quoted })
                current = ''
                quoted = false
                continue
            }

            current += ch
        }

        const last = current.trim()
        if (last.length > 0 || quoted) {
            args.push({ text: last, quoted })
        }

        return args
    }
}

interface StackFrame {
    name: string
    attrs: TagAttrs
    children: Node[]
    start: number
}

interface RawArgument {
    text: string
    /** Whether this argument was written in quotes (a literal) or bare. */
    quoted: boolean
}
