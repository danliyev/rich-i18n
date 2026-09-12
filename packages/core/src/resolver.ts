import { DiagnosticCode, Diagnostics, type Diagnostic } from './diagnostics.js'
import { NodeType, type CallArgument, type CallNode, type Node } from './parser.js'
import { type PlaceholderValue, type Registries, type Renderer, type ResolveContext } from './registry.js'

export interface ResolverOutput<TOutput> {
    result: TOutput
    diagnostics: Diagnostic[]
}

export interface ResolverOptions<TOutput> {
    ctx: ResolveContext
    renderer: Renderer<TOutput>
    registries: Registries<TOutput>
}

export class Resolver<TOutput> {
    private diagnostics: Diagnostics

    private ctx: ResolveContext
    private renderer: Renderer<TOutput>
    private registries: Registries<TOutput>

    public constructor(options: ResolverOptions<TOutput>) {
        this.diagnostics = new Diagnostics()

        this.ctx = options.ctx
        this.renderer = options.renderer
        this.registries = options.registries
    }

    /**
     * Walks a parsed AST and produces a single `TOutput`, using the given
     * registries to render tags, evaluate functions, and look up variables.
     */
    public resolve(ast: Node[]): ResolverOutput<TOutput> {
        const parts = ast.map(node => this.resolveNode(node))
        return { result: this.renderer.renderFragment(parts), diagnostics: [...this.diagnostics.entries] }
    }

    private resolveNode(node: Node): TOutput {
        switch (node.type) {
            case NodeType.Text:
                return this.renderer.renderText(node.value)

            case NodeType.Tag: {
                const children = node.children.map(child => this.resolveNode(child))
                const tagRenderer = this.registries.tags[node.name]

                if (!tagRenderer) {
                    this.diagnostics.warning(DiagnosticCode.UnknownTag, `Unknown tag <${node.name}>`, node.start)
                    // Graceful fallback: drop the tag itself but keep its content visible.
                    return this.renderer.renderFragment(children)
                }

                return tagRenderer(children, node.attrs, this.ctx)
            }

            case NodeType.Variable:
                return this.resolveVariable(node.name, node.start)

            case NodeType.Call:
                return this.resolveCall(node)
        }
    }

    private resolveVariable(name: string, position: number): TOutput {
        const value = this.resolvePlaceholder(name)

        if (value === undefined) {
            this.diagnostics.warning(DiagnosticCode.UnresolvedVariable, `Variable "${name}" has no value`, position)
            return this.renderer.renderText(`{{${name}}}`)
        }

        return this.renderer.renderText(String(value))
    }

    private resolvePlaceholder(name: string): PlaceholderValue | undefined {
        const override = this.ctx.params?.[name]
        return override !== undefined ? override : this.registries.placeholders(name, this.ctx)
    }

    /**
     * Resolves one function-call argument to a plain value, recursing into
     * nested calls where needed.
     */
    private resolveCall(node: CallNode): TOutput {
        const handler = this.registries.functions[node.fn]
        if (!handler) {
            this.diagnostics.error(DiagnosticCode.UnknownFunction, `Unknown function "${node.fn}"`, node.start)
            return this.renderer.renderText(describeCall(node))
        }

        const args = node.args.map(arg => this.resolveCallArgument(arg))
        try {
            return handler(this.ctx, args, node.start)
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            this.diagnostics.error(
                DiagnosticCode.FunctionArgumentError,
                `Error in "${node.fn}()": ${message}`,
                node.start
            )
            return this.renderer.renderText(describeCall(node))
        }
    }

    private resolveCallArgument(arg: CallArgument): PlaceholderValue | undefined {
        switch (arg.type) {
            case NodeType.Literal:
                return arg.value

            case NodeType.Number:
                return arg.value

            case NodeType.Variable: {
                const value = this.resolvePlaceholder(arg.name)
                if (value === undefined) {
                    this.diagnostics.warning(
                        DiagnosticCode.UnresolvedVariable,
                        `Variable "${arg.name}" has no value`,
                        arg.start
                    )
                }

                return value
            }

            case NodeType.Call:
                return this.resolveCall(arg) as unknown as PlaceholderValue
        }
    }
}

/** Reconstructs a readable `fn(arg, "literal", ...)` string for fallback text. */
function describeCall(node: CallNode): string {
    const parts = node.args.map(describeArg).join(', ')
    return `{{${node.fn}(${parts})}}`
}

function describeArg(arg: CallArgument): string {
    switch (arg.type) {
        case NodeType.Literal:
            return `"${arg.value}"`
        case NodeType.Number:
            return String(arg.value)
        case NodeType.Variable:
            return arg.name
        case NodeType.Call:
            return `${arg.fn}(${arg.args.map(describeArg).join(', ')})`
    }
}
