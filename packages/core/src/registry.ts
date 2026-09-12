import { type TagAttrs } from './lexer.js'

/** Raw values a placeholder/variable can resolve to before rendering. */
export type PlaceholderValue = string | number | boolean | Date

export interface ResolveContext {
    locale: string
    /**
     * Per-call overrides. Take precedence over whatever the global
     * `PlaceholderResolver` would otherwise return for the same name.
     */
    params?: Record<string, PlaceholderValue>
}

/** Renders one tag's already-resolved children into a single output node. */
export type TagRenderer<TOutput> = (children: TOutput[], attrs: TagAttrs, ctx: ResolveContext) => TOutput

/**
 * Handles one function call, e.g. `plural(count, "form1", "form2")`.
 */
export type FunctionHandler<TOutput> = (
    ctx: ResolveContext,
    args: Array<PlaceholderValue | undefined>,
    /** Character offset of the call in the original string, for diagnostics. */
    position: number
) => TOutput

/**
 * Resolves a single variable/placeholder name to a raw value.
 */
export type PlaceholderResolver = (name: string, ctx: ResolveContext) => PlaceholderValue | undefined

export type TextRenderer<TOutput> = (value: string) => TOutput
export type FragmentRenderer<TOutput> = (children: TOutput[]) => TOutput

export interface Renderer<TOutput> {
    /** Wraps a plain string (literal text, or a stringified variable) into an output node. */
    renderText: TextRenderer<TOutput>
    /**
     * Combines sibling output nodes into one, with no wrapping element -
     * used both for the top-level result and as a fallback when a tag or
     * function isn't found in the registry.
     */
    renderFragment: FragmentRenderer<TOutput>
}

export interface Registries<TOutput> {
    tags: Record<string, TagRenderer<TOutput>>
    functions: Record<string, FunctionHandler<TOutput>>
    placeholders: PlaceholderResolver
}
