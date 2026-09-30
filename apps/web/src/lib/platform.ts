/** An iPhone or iPad, including an iPad that says it is a Mac. */
export function isIosDevice(): boolean {
  const ua = navigator.userAgent
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1)
}
