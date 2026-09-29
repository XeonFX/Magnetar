import AppKit
import CoreGraphics

// MediaDownloader icon: a violet tile with a white play triangle turned downwards over a tray —
// media and download in one shape. Renders the macOS iconset, the Windows tray icon sizes, the
// web icons (favicon, apple-touch, PWA and maskable) and monochrome menu-bar template images.
// The same shape lives as SVG in apps/web/public/icon.svg and apps/web/src/ui/BrandMark.tsx.
//
//   swift makeicon.swift <out dir>

let args = CommandLine.arguments
let outDir = args.count > 1 ? args[1] : "."

func makeContext(_ size: Int) -> CGContext {
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    return CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                     bytesPerRow: 0, space: cs,
                     bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}

func savePNG(_ ctx: CGContext, _ path: String) {
    let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
}

/// The glyph in a 100-unit square (y down, like the SVG), placed into `rect`.
func drawGlyph(_ c: CGContext, in rect: CGRect, color: CGColor) {
    let u = rect.width / 100
    let p = { (x: CGFloat, y: CGFloat) in CGPoint(x: rect.minX + x * u, y: rect.maxY - y * u) }
    c.setFillColor(color)
    c.setStrokeColor(color)
    c.setLineJoin(.round)
    c.setLineCap(.round)
    c.setLineWidth(9 * u)
    c.move(to: p(31, 30))
    c.addLine(to: p(69, 30))
    c.addLine(to: p(50, 58))
    c.closePath()
    c.drawPath(using: .fillStroke)
    c.move(to: p(29, 76))
    c.addLine(to: p(71, 76))
    c.strokePath()
}

/// The violet tile. `inset` leaves the margin macOS icons keep; `radius` is a fraction of the side.
func drawTile(_ c: CGContext, _ rect: CGRect, radius: CGFloat, shadow: Bool) {
    let path = CGPath(roundedRect: rect, cornerWidth: rect.width * radius, cornerHeight: rect.width * radius, transform: nil)
    if shadow {
        c.saveGState()
        c.setShadow(offset: CGSize(width: 0, height: -rect.width * 0.01), blur: rect.width * 0.03, color: rgb(0x000000, 0.3))
        c.addPath(path)
        c.setFillColor(rgb(0x6d3df2))
        c.fillPath()
        c.restoreGState()
    }
    c.saveGState()
    c.addPath(path)
    c.clip()
    let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                              colors: [rgb(0x8057ff), rgb(0x6d3df2), rgb(0x5a2be0)] as CFArray, locations: [0, 0.55, 1])!
    c.drawLinearGradient(gradient, start: CGPoint(x: rect.midX, y: rect.maxY), end: CGPoint(x: rect.midX, y: rect.minY), options: [])
    c.restoreGState()
}

/// App and web icons. `bleed` fills the whole canvas (apple-touch, maskable, Windows); otherwise
/// the tile keeps macOS's ~10% margin and casts a small shadow.
func drawIcon(_ size: Int, bleed: Bool = false, glyphScale: CGFloat = 1) -> CGContext {
    let c = makeContext(size)
    let side = CGFloat(size)
    let tile = bleed ? CGRect(x: 0, y: 0, width: side, height: side) : CGRect(x: 0, y: 0, width: side, height: side).insetBy(dx: side * 0.0742, dy: side * 0.0742)
    drawTile(c, tile, radius: bleed ? 0 : 0.225, shadow: !bleed && size >= 64)
    let glyph = tile.insetBy(dx: tile.width * (1 - glyphScale) / 2, dy: tile.height * (1 - glyphScale) / 2)
    drawGlyph(c, in: glyph, color: rgb(0xffffff))
    return c
}

/// Windows tray and taskbar: the tile edge to edge with rounded corners, no margin.
func drawTray(_ size: Int) -> CGContext {
    let c = makeContext(size)
    let rect = CGRect(x: 0, y: 0, width: CGFloat(size), height: CGFloat(size))
    drawTile(c, rect, radius: 0.225, shadow: false)
    drawGlyph(c, in: rect, color: rgb(0xffffff))
    return c
}

/// Menu-bar template image: the glyph alone in black, enlarged to fill the small canvas.
func drawTemplate(_ size: Int) -> CGContext {
    let c = makeContext(size)
    let side = CGFloat(size) * 1.45
    let rect = CGRect(x: (CGFloat(size) - side) / 2, y: (CGFloat(size) - side) / 2 - CGFloat(size) * 0.02, width: side, height: side)
    drawGlyph(c, in: rect, color: rgb(0x000000))
    return c
}

let fm = FileManager.default
let iconset = "\(outDir)/AppIcon.iconset"
try? fm.createDirectory(atPath: iconset, withIntermediateDirectories: true)
for (name, size) in [("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64),
                     ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512),
                     ("icon_512x512", 512), ("icon_512x512@2x", 1024)] {
    savePNG(drawIcon(size), "\(iconset)/\(name).png")
}
let web = "\(outDir)/web"
try? fm.createDirectory(atPath: web, withIntermediateDirectories: true)
savePNG(drawIcon(256), "\(web)/favicon.png")
savePNG(drawIcon(180, bleed: true, glyphScale: 0.86), "\(web)/apple-touch-icon.png")
savePNG(drawIcon(192), "\(web)/icon-192.png")
savePNG(drawIcon(512), "\(web)/icon-512.png")
// Maskable: launchers crop to a circle or squircle, so the glyph stays inside the central 80%.
savePNG(drawIcon(512, bleed: true, glyphScale: 0.72), "\(web)/icon-maskable-512.png")
let tray = "\(outDir)/tray"
try? fm.createDirectory(atPath: tray, withIntermediateDirectories: true)
for size in [16, 20, 24, 32, 40, 48, 64, 256] {
    savePNG(drawTray(size), "\(tray)/\(size).png")
}
savePNG(drawTemplate(18), "\(outDir)/MenuBarIcon.png")
savePNG(drawTemplate(36), "\(outDir)/MenuBarIcon@2x.png")
print("done")
