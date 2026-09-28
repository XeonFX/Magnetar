import type { BunPlugin } from 'bun'

/**
 * WebTorrent pulls in node-datachannel (a native WebRTC addon) for browser peers. The app only
 * talks to regular TCP peers, so the addon is replaced with an empty module: no native code has to
 * ship inside the single executable.
 */
export const stubWebrtc: BunPlugin = {
  name: 'stub-webrtc',
  setup(build) {
    const stub = 'export default {}; export const RTCPeerConnection = undefined; export const RTCSessionDescription = undefined; export const RTCIceCandidate = undefined;'
    build.onLoad({ filter: /[\\/]node_modules[\\/](\.bun[\\/][^\\/]+[\\/]node_modules[\\/])?(node-datachannel|webrtc-polyfill)[\\/].*\.[cm]?js$/ }, () => ({ contents: stub, loader: 'js' }))
  },
}
