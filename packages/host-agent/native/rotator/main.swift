// BotflowRotator — a tiny signed .app helper that rotates a specific iOS
// Simulator device window by one quarter-turn (⌘→). It runs the GUI-automation
// (Accessibility) APIs that the host-agent's `node` process is not allowed to —
// because macOS lets you grant Accessibility to an .app bundle, but not to a
// raw binary. The host launches this once per quarter-turn and polls the
// device's screenshot aspect to know when the target orientation is reached.
//
// Usage: BotflowRotator <device-name-substring>   (e.g. "PoC-Sim-0")
// Exit codes: 0 ok · 2 Simulator not running · 3 Accessibility not granted · 4 event failure
import Cocoa
import ApplicationServices

let logPath = "/tmp/botflow_rotator.log"
func dlog(_ s: String) {
  FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
  if let h = FileHandle(forWritingAtPath: logPath) ?? { FileManager.default.createFile(atPath: logPath, contents: nil); return FileHandle(forWritingAtPath: logPath) }() {
    h.seekToEndOfFile(); h.write((s + "\n").data(using: .utf8)!); h.closeFile()
  }
}
func err(_ s: String) { dlog(s) }

let nameMatch = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
dlog("rotator: start, nameMatch='\(nameMatch)'")

guard let sim = NSWorkspace.shared.runningApplications.first(where: {
  $0.bundleIdentifier == "com.apple.iphonesimulator"
}) else {
  err("rotator: Simulator.app not running")
  exit(2)
}
sim.activate(options: [])
usleep(200_000)

// Raise the matching device window (needs Accessibility). If AX is unavailable
// the permission hasn't been granted yet — signal that distinctly.
let axApp = AXUIElementCreateApplication(sim.processIdentifier)
var windowsRef: CFTypeRef?
let axStatus = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsRef)
if axStatus == .apiDisabled || axStatus == .notImplemented {
  err("rotator: Accessibility not granted (AX status \(axStatus.rawValue))")
  exit(3)
}
dlog("rotator: AX status=\(axStatus.rawValue), simPid=\(sim.processIdentifier), frontmost=\(sim.isActive)")
var raised = false
if let windows = windowsRef as? [AXUIElement] {
  dlog("rotator: \(windows.count) windows")
  for w in windows {
    var titleRef: CFTypeRef?
    AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &titleRef)
    let title = (titleRef as? String) ?? ""
    dlog("rotator:   window title='\(title)'")
    if nameMatch.isEmpty || title.contains(nameMatch) {
      AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
      let r1 = AXUIElementPerformAction(w, kAXRaiseAction as CFString)
      dlog("rotator:   raised '\(title)' status=\(r1.rawValue)")
      raised = true
      break
    }
  }
}
dlog("rotator: raised=\(raised)")
usleep(250_000)

// Send ⌘→ (key code 0x7C = Right Arrow) → Simulator "Rotate Right".
let src = CGEventSource(stateID: .hidSystemState)
guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0x7C, keyDown: true),
      let up = CGEvent(keyboardEventSource: src, virtualKey: 0x7C, keyDown: false) else {
  err("rotator: failed to create key events")
  exit(4)
}
down.flags = .maskCommand
up.flags = .maskCommand
down.post(tap: .cghidEventTap)
usleep(50_000)
up.post(tap: .cghidEventTap)
usleep(150_000)
dlog("rotator: posted Cmd+Right; done")
