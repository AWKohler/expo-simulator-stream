// Generate test JPEG frames (a moving white box on a shifting background) so the
// frame server has animated content to push to the shim. Run: swift gen-frames.swift [outDir]
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let W = 640, H = 480, N = 30
let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "frames"
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
let cs = CGColorSpaceCreateDeviceRGB()

for i in 0..<N {
  guard let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8,
                            bytesPerRow: 0, space: cs,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { continue }
  let t = CGFloat(i) / CGFloat(N)
  ctx.setFillColor(red: t, green: 0.3, blue: 1.0 - t, alpha: 1)
  ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
  let x = t * CGFloat(W - 120)
  ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
  ctx.fill(CGRect(x: x, y: CGFloat(H / 2 - 60), width: 120, height: 120))
  guard let img = ctx.makeImage() else { continue }
  let url = URL(fileURLWithPath: "\(outDir)/frame_\(String(format: "%03d", i)).jpg")
  guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { continue }
  CGImageDestinationAddImage(dest, img, nil)
  CGImageDestinationFinalize(dest)
}
print("wrote \(N) frames to \(outDir)")
