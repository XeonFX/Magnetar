import { commitUrl } from '../lib/updates.ts'

/** A commit, short, linking to its page on GitHub when it is one (not a `dev` build's). */
export function CommitLink({ commit }: { commit: string }) {
  const url = commitUrl(commit)
  return url
    ? <a className="link link-hover font-mono" href={url} target="_blank" rel="noreferrer noopener" title={commit}>{commit}</a>
    : <span className="font-mono">{commit}</span>
}

/**
 * A build as people quote it in a bug report: `v1.2.0 · abc1234`, the commit linking to its page on GitHub. A
 * development build (`1.2.0+dev`) shows its version as it is.
 */
export function BuildVersion({ version, commit, className = '' }: { version: string; commit?: string | null; className?: string }) {
  // `v1.2.0`, but a build outside a release is just `dev`.
  const shown = /^\d/.test(version) ? `v${version}` : version
  return <span className={`tabular-nums ${className}`}>{shown}{commit && <>{' · '}<CommitLink commit={commit} /></>}</span>
}
