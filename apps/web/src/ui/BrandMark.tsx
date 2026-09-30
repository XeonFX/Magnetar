/** The app icon (a play triangle turned into a download over a tray), as in public/icon.svg. */
export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden className="shrink-0">
      <rect width="100" height="100" rx="22.5" className="fill-[#6d3df2]" />
      <path d="M31 30H69L50 58Z" fill="#fff" stroke="#fff" strokeWidth="9" strokeLinejoin="round" />
      <path d="M29 76H71" stroke="#fff" strokeWidth="9" strokeLinecap="round" />
    </svg>
  )
}
