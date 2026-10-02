/**
 * The features page's words in each language: English is in the bundle, the others load when someone opens the
 * page in them, as the dashboard's catalogs do (lib/i18n.tsx).
 */
import type { FeatureGroup } from '@codefusion-cc/features-page'
import type { IconComponent } from '@codefusion-cc/features-page/react'
import { OUTLINE, type ShotName } from '../outline.ts'
import { en } from './en.ts'
import type { FeaturesContent, FeatureText } from './types.ts'

const loaders = Object.fromEntries(
  Object.entries(import.meta.glob<FeaturesContent>(['./[a-z][a-z].ts', '!./en.ts'], { import: 'content' }))
    .map(([path, load]) => [path.match(/([a-z]{2})\.ts$/)![1]!, load]),
) as Record<string, () => Promise<FeaturesContent>>

const loaded: Record<string, FeaturesContent> = { en }

/** The languages the page is written in. */
export const FEATURE_LANGUAGES: readonly string[] = ['en', ...Object.keys(loaders)]

/** The page's words in `language`, loaded once, and the language they are in: English when they fail to load. */
export async function loadContent(language: string): Promise<{ language: string; content: FeaturesContent }> {
  const ready = loaded[language]
  if (ready) return { language, content: ready }
  const load = loaders[language]
  if (!load) return { language: 'en', content: en }
  try {
    return { language, content: (loaded[language] = await load()) }
  } catch {
    return { language: 'en', content: en }
  }
}

/** The content already loaded for `language`, if it is. */
export function loadedContent(language: string): FeaturesContent | undefined {
  return loaded[language]
}

/** The outline's groups in the words of one language, as the page shows them. */
export function featureGroups(content: FeaturesContent): FeatureGroup<IconComponent, ShotName>[] {
  return OUTLINE.map(group => {
    const words = content.groups[group.id]
    return {
      id: group.id,
      title: words.title,
      label: words.label,
      lead: words.lead,
      icon: group.icon,
      features: group.features.map(feature => ({
        id: feature.id,
        icon: feature.icon,
        ...(words.features as Record<string, FeatureText>)[feature.id]!,
        shots: feature.shots.map(src => ({ src, alt: content.shots[src] })),
      })),
    }
  })
}
