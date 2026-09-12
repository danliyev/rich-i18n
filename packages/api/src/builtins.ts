import { type FunctionHandler, type TextRenderer } from '@rich-i18n/core'

export function createPluralFunction<TOutput>(renderText: TextRenderer<TOutput>): FunctionHandler<TOutput> {
    const CANONICAL_CATEGORY_ORDER = ['zero', 'one', 'two', 'few', 'many', 'other'] as const

    function getOrderedCategories(rules: Intl.PluralRules): string[] {
        const supported = new Set(rules.resolvedOptions().pluralCategories)
        return CANONICAL_CATEGORY_ORDER.filter(category => supported.has(category))
    }

    return (ctx, args) => {
        const [n, ...forms] = args

        if (typeof n !== 'number' || Number.isNaN(n)) {
            throw new Error(`first argument must resolve to a number, got ${JSON.stringify(n)}`)
        }

        const pluralRules = new Intl.PluralRules(ctx.locale)
        const category = pluralRules.select(n)
        const order = getOrderedCategories(pluralRules)
        const form = forms[order.indexOf(category)] ?? forms.at(-1)

        if (form === undefined) {
            throw new Error(
                `expected ${order.length} form(s) for locale "${ctx.locale}" (${order.join('/')}), got ${forms.length}`
            )
        }

        return renderText(String(form))
    }
}

export function createCurrencyFunction<TOutput>(renderText: TextRenderer<TOutput>): FunctionHandler<TOutput> {
    return (ctx, args) => {
        const [amount, code = 'USD'] = args
        if (typeof amount !== 'number') {
            throw new Error(`expected a number, got ${JSON.stringify(amount)}`)
        }

        const numberFormat = new Intl.NumberFormat(ctx.locale, { style: 'currency', currency: String(code) })
        return renderText(numberFormat.format(amount))
    }
}
