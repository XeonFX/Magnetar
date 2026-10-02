/** The word for `n` things in `language`'s plural rules (`one`, `few`, `many`, `other`…); `other` when it has no form of its own. */
export function plural(language: string, n: number, forms: Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }): string {
  return forms[new Intl.PluralRules(language).select(n)] ?? forms.other
}
