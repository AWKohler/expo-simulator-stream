// Minimal camera app that exercises the exact path a real app uses:
// device discovery → input → session → preview layer + video data output →
// startRunning. With the shim injected, frames should flow from the WS server.
// Logs each captured frame (visible via `simctl spawn booted log stream`).
import SwiftUI
import UIKit
import AVFoundation
import os

let logger = Logger(subsystem: "com.botflow.test.CamShimTest", category: "cam")

@main
struct CamShimTestApp: App {
  var body: some Scene {
    WindowGroup { CameraView().ignoresSafeArea() }
  }
}

final class CameraVC: UIViewController, AVCaptureVideoDataOutputSampleBufferDelegate {
  let session = AVCaptureSession()
  var preview: AVCaptureVideoPreviewLayer?
  var frameCount = 0

  override func viewDidLoad() {
    super.viewDidLoad()
    logger.log("CAMSHIMTEST viewDidLoad")
    view.backgroundColor = .black

    guard let device = AVCaptureDevice.default(for: .video) else {
      logger.error("CAMSHIMTEST NO DEVICE (shim not active?)")
      return
    }
    logger.log("CAMSHIMTEST device=\(String(describing: device), privacy: .public)")

    do {
      let input = try AVCaptureDeviceInput(device: device)
      if session.canAddInput(input) { session.addInput(input) }
    } catch {
      logger.error("CAMSHIMTEST input error: \(error.localizedDescription, privacy: .public)")
    }

    let output = AVCaptureVideoDataOutput()
    output.setSampleBufferDelegate(self, queue: DispatchQueue(label: "cam.queue"))
    if session.canAddOutput(output) { session.addOutput(output) }

    let preview = AVCaptureVideoPreviewLayer(session: session)
    preview.videoGravity = .resizeAspectFill
    view.layer.addSublayer(preview)
    self.preview = preview

    DispatchQueue.global().async { self.session.startRunning() }
    logger.log("CAMSHIMTEST startRunning called")
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    preview?.frame = view.bounds
  }

  func captureOutput(_ output: AVCaptureOutput,
                     didOutput sampleBuffer: CMSampleBuffer,
                     from connection: AVCaptureConnection) {
    frameCount += 1
    if frameCount == 1 || frameCount % 15 == 0 {
      let img = CMSampleBufferGetImageBuffer(sampleBuffer)
      let w = img != nil ? CVPixelBufferGetWidth(img!) : 0
      let h = img != nil ? CVPixelBufferGetHeight(img!) : 0
      logger.log("CAMSHIMTEST got frame #\(self.frameCount) \(w)x\(h)")
    }
  }
}

struct CameraView: UIViewControllerRepresentable {
  func makeUIViewController(context: Context) -> CameraVC { CameraVC() }
  func updateUIViewController(_ vc: CameraVC, context: Context) {}
}
