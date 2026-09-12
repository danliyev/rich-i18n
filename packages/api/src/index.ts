import {
    Parser,
    Resolver,
    type Diagnostic,
    type Node,
    type PlaceholderValue,
    type Registries,
    type Renderer
} from '@rich-i18n/core'

export * from './builtins.js'

export interface RichI18nOptions<TOutput> {
    locale: string
    strings: RichI18nStrings
    renderer?: RichI18nRenderer<TOutput>
    registries?: RichI18nRegistries<TOutput>
    onMissingStringKey?: RichI18nOnMissingStringKey
    onDiagnostics?: RichI18nOnDiagnostics
}

export type RichI18nStrings = Record<string, DeepRecord<string, string>>

export interface RichI18nRenderer<TOutput> extends Partial<Renderer<TOutput>> {}
export interface RichI18nRegistries<TOutput> extends Partial<Registries<TOutput>> {}

export type RichI18nOnMissingStringKey = (key: string, locale: string) => any
export type RichI18nOnDiagnostics = (diagnostics: Diagnostic[], key: string, locale: string) => any

export class RichI18n<TOutput> {
    public locale: string

    private readonly strings: Record<string, string>
    private renderer: Renderer<TOutput>
    private registries: Registries<TOutput>
    private onMissingStringKey: RichI18nOnMissingStringKey
    private onDiagnostics: RichI18nOnDiagnostics

    private stringASTCache = new Map<string, Node[]>()

    public constructor(options: RichI18nOptions<TOutput>) {
        this.locale = options.locale
        this.strings = this.flattenStrings(options.strings)

        if (!options.renderer) options.renderer = {}
        if (!options.renderer.renderText) options.renderer.renderText = value => value as TOutput
        if (!options.renderer.renderFragment) options.renderer.renderFragment = children => children.join('') as TOutput

        if (typeof options.renderer.renderText !== 'function')
            throw new TypeError(`"options.renderer.renderText" must be a function.`)
        if (typeof options.renderer.renderFragment !== 'function')
            throw new TypeError(`"options.renderer.renderFragment" must be a function.`)

        this.renderer = {
            renderText: options.renderer.renderText,
            renderFragment: options.renderer.renderFragment
        }

        if (!options.registries) options.registries = {}
        if (!options.registries.tags) options.registries.tags = {}
        if (!options.registries.functions) options.registries.functions = {}
        if (!options.registries.placeholders) options.registries.placeholders = (name, ctx) => (ctx.params ?? {})[name]

        this.registries = {
            tags: options.registries.tags,
            functions: options.registries.functions,
            placeholders: options.registries.placeholders
        }

        this.onMissingStringKey = options.onMissingStringKey ?? (key => key)
        this.onDiagnostics = options.onDiagnostics ?? (() => {})
    }

    public t(key: string, params: Record<string, PlaceholderValue> = {}): TOutput {
        let string = this.resolveStringKey(key)

        if (typeof string === 'undefined') {
            const missingValue = this.onMissingStringKey(key, this.locale)
            string = typeof missingValue === 'string' ? missingValue : key
        }

        const diagnostics: Diagnostic[] = []
        let stringAST: Node[]
        const cachedAST = this.stringASTCache.get(`${this.locale}.${key}`)

        if (cachedAST) {
            stringAST = cachedAST
        } else {
            const parser = new Parser(string),
                { ast, diagnostics: pDiagnostics } = parser.parse()

            stringAST = ast
            diagnostics.push(...pDiagnostics)
            this.stringASTCache.set(`${this.locale}.${key}`, ast)
        }

        const resolver = new Resolver<TOutput>({
            ctx: { locale: this.locale, params },
            renderer: this.renderer,
            registries: this.registries
        })

        const { result, diagnostics: rDiagnostics } = resolver.resolve(stringAST)

        diagnostics.push(...rDiagnostics)
        if (diagnostics.length) this.onDiagnostics(diagnostics, key, this.locale)

        return result
    }

    public setLocale(locale: string, clearCache = false): void {
        this.locale = locale
        if (clearCache) this.clearCache()
    }

    public clearCache(): void {
        return this.stringASTCache.clear()
    }

    private resolveStringKey(key: string): string | undefined {
        return this.strings[`${this.locale}.${key}`]
    }

    private flattenStrings(obj: DeepRecord<string, string>, prefix = '', separator = '.') {
        const result: Record<string, string> = {}
        const dupKeyError = (key: string) => new Error(`Duplicate string key after flattening: "${key}"`)

        for (const key in obj) {
            if (!Object.hasOwn(obj, key)) continue

            const newKey = prefix ? `${prefix}${separator}${key}` : key,
                value = obj[key]!

            if (typeof value === 'object' && value !== null) {
                const nested = this.flattenStrings(value, newKey, separator)

                for (const nestedKey in nested) {
                    if (nestedKey in result) throw dupKeyError(nestedKey)
                    result[nestedKey] = nested[nestedKey]!
                }
            } else {
                if (newKey in result) throw dupKeyError(newKey)
                result[newKey] = value
            }
        }

        return result
    }
}

type DeepRecord<K extends keyof any, T> = {
    [P in K]: T | DeepRecord<K, T>
}
