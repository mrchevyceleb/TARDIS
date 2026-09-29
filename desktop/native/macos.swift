// TARDIS macOS computer-control helper. One request as JSON on stdin, one JSON
// object on stdout. Exit 0 on success; on failure exit 1 with
// {"error": "...", "inputAttempted": bool}. It plays the role windows.ps1 plays
// on Windows: the Electron app owns the grant and serialises requests, this
// only touches the machine.
//
// It runs as a child of TARDIS.app, so macOS attributes Screen Recording and
// Accessibility to TARDIS. Coordinates are global display points (origin at the
// top-left of the main display), the same space screenshots are mapped back to;
// captures are resampled to that space so one screenshot pixel is one point.
//
// Build: swiftc -O -swift-version 5 -target arm64-apple-macos14 macos.swift -o macos-helper
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import IOKit.pwr_mgt
import UniformTypeIdentifiers

struct Failure: Error {
  let message: String
  var inputAttempted = false
}

func finish(_ object: [String: Any], code: Int32 = 0) -> Never {
  // Sorted keys: the controller compares JSON.stringify of displays and window
  // bounds between calls, so the key order must not change from run to run.
  var data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data(#"{"error":"The helper could not encode its result."}"#.utf8)
  data.append(0x0a)
  FileHandle.standardOutput.write(data)
  exit(code)
}

func rounded(_ value: CGFloat) -> Int { Int(value.rounded()) }
func boundsJSON(_ rect: CGRect) -> [String: Any] {
  ["x": rounded(rect.minX), "y": rounded(rect.minY), "width": rounded(rect.width), "height": rounded(rect.height)]
}

// MARK: permissions and session state

enum Need { case screen, accessibility }

func requirePermissions(_ needs: [Need]) throws {
  var missing: [String] = []
  if needs.contains(.screen) && !CGPreflightScreenCaptureAccess() { missing.append("Screen Recording") }
  if needs.contains(.accessibility) && !AXIsProcessTrusted() { missing.append("Accessibility") }
  if missing.isEmpty { return }
  throw Failure(message: "TARDIS is not allowed to control this Mac yet: it needs \(missing.joined(separator: " and ")). Nothing was done. Someone at the Mac must choose TARDIS > Ship > Set Up Computer Control on This Mac, then switch TARDIS on under System Settings > Privacy & Security. Do not retry or work around this.")
}

/// Every operation that touches the screen or the input devices starts here.
func preflight(_ needs: [Need]) throws {
  try requirePermissions(needs)
  try ensureDisplayAwake()
  try requireUnlocked()
}

func sessionValue(_ key: String) -> Bool? {
  guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return nil }
  if let flag = session[key] as? Bool { return flag }
  if let number = session[key] as? Int { return number != 0 }
  return nil
}

/// Fails closed: a session that cannot be read is treated like a locked one.
func requireUnlocked() throws {
  guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else {
    throw Failure(message: "This Mac's lock state is unavailable (no desktop session). Nothing was done.")
  }
  let flag = session["CGSSessionScreenIsLocked"]
  if (flag as? Bool) == true || (flag as? Int).map({ $0 != 0 }) == true {
    throw Failure(message: "This Mac is locked. TARDIS never unlocks it. Nothing was done.")
  }
}

func ensureDisplayAwake() throws {
  guard CGDisplayIsAsleep(CGMainDisplayID()) != 0 else { return }
  // Declaring user activity is what wakes a sleeping display; it holds no
  // assertion afterwards, the app keeps the display awake while it has a grant.
  var assertion: IOPMAssertionID = 0
  IOPMAssertionDeclareUserActivity("TARDIS computer control" as CFString, kIOPMUserActiveLocal, &assertion)
  for _ in 0..<40 {
    usleep(100_000)
    if CGDisplayIsAsleep(CGMainDisplayID()) == 0 { return }
  }
  throw Failure(message: "The display is asleep and did not wake. Nothing was done.")
}

// MARK: displays and windows

struct Win {
  let id: Int
  let pid: pid_t
  let owner: String
  let name: String
  let bounds: CGRect
}

func activeDisplays() -> [CGDirectDisplayID] {
  var count: UInt32 = 0
  CGGetActiveDisplayList(0, nil, &count)
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  CGGetActiveDisplayList(count, &ids, &count)
  let main = CGMainDisplayID()
  // screencapture numbers displays with the main display first.
  return ids.prefix(Int(count)).sorted { a, b in a == main ? true : (b == main ? false : a < b) }
}

/// Ordinary windows on screen, front to back. Menu bar, Dock and floating
/// panels (the control indicator among them) sit on other layers and stay out.
func onScreenWindows() -> [Win] {
  guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
  var rows: [Win] = []
  for entry in raw {
    guard let id = entry[kCGWindowNumber as String] as? Int,
          let pid = entry[kCGWindowOwnerPID as String] as? Int,
          (entry[kCGWindowLayer as String] as? Int) == 0,
          let dictionary = entry[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary) else { continue }
    if ((entry[kCGWindowAlpha as String] as? Double) ?? 1) < 0.01 || bounds.width < 16 || bounds.height < 16 { continue }
    rows.append(Win(id: id, pid: pid_t(pid), owner: (entry[kCGWindowOwnerName as String] as? String) ?? "", name: (entry[kCGWindowName as String] as? String) ?? "", bounds: bounds))
  }
  return rows
}

func focusedPID() -> pid_t? {
  var ref: CFTypeRef?
  if AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &ref) == .success, let app = ref {
    var pid: pid_t = 0
    // The focused-application attribute always holds an AXUIElement.
    if AXUIElementGetPid(app as! AXUIElement, &pid) == .success { return pid }
  }
  return NSWorkspace.shared.frontmostApplication?.processIdentifier
}

func activeWindowID() -> Int? {
  guard let pid = focusedPID() else { return nil }
  return onScreenWindows().first { $0.pid == pid }?.id
}

func inspect() throws -> [String: Any] {
  try preflight([.screen, .accessibility])
  let displays: [[String: Any]] = activeDisplays().map { id in
    let bounds = CGDisplayBounds(id)
    var scale = 1.0
    if let mode = CGDisplayCopyDisplayMode(id), mode.width > 0 { scale = Double(mode.pixelWidth) / Double(mode.width) }
    return ["id": String(id), "bounds": boundsJSON(bounds), "scaleFactor": scale]
  }
  if displays.isEmpty { throw Failure(message: "No displays found. Is a monitor connected and awake?") }
  let windows: [[String: Any]] = onScreenWindows().prefix(100).map { win in
    let label = win.name.isEmpty ? win.owner : "\(win.owner): \(win.name)"
    return ["id": String(win.id), "title": String(label.prefix(300)), "app": win.owner, "bounds": boundsJSON(win.bounds)]
  }
  var result: [String: Any] = ["displays": displays, "windows": windows]
  if let active = activeWindowID() { result["activeWindow"] = String(active) }
  return result
}

// MARK: capture

func pngData(_ image: CGImage) -> Data? {
  let data = NSMutableData()
  guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { return nil }
  CGImageDestinationAddImage(destination, image, nil)
  return CGImageDestinationFinalize(destination) ? data as Data : nil
}

func runScreencapture(_ arguments: [String]) throws -> CGImage {
  let file = FileManager.default.temporaryDirectory.appendingPathComponent("tardis-\(UUID().uuidString).png")
  defer { try? FileManager.default.removeItem(at: file) }
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  process.arguments = arguments + [file.path]
  process.standardError = FileHandle.nullDevice
  do { try process.run() } catch { throw Failure(message: "Could not start screencapture: \(error.localizedDescription)") }
  process.waitUntilExit()
  // Read the bytes before the file goes away: an image created from the URL
  // decodes lazily, and would draw black once the file is deleted.
  guard process.terminationStatus == 0,
        let bytes = try? Data(contentsOf: file),
        let source = CGImageSourceCreateWithData(bytes as CFData, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    throw Failure(message: "screencapture returned no image (status \(process.terminationStatus)). Screen Recording may have been revoked, or the display is off.")
  }
  return image
}

/// Draw images into one top-left-origin bitmap that is `size` points wide, so
/// Retina pixels become points and a screenshot pixel is a coordinate.
func composite(size: CGSize, _ pieces: [(CGImage, CGRect)]) throws -> CGImage {
  let width = max(1, rounded(size.width)), height = max(1, rounded(size.height))
  guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else {
    throw Failure(message: "Could not allocate the screenshot bitmap.")
  }
  context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
  context.fill(CGRect(x: 0, y: 0, width: width, height: height))
  context.interpolationQuality = .high
  for (image, rect) in pieces {
    context.draw(image, in: CGRect(x: rect.minX, y: CGFloat(height) - rect.minY - rect.height, width: rect.width, height: rect.height))
  }
  guard let result = context.makeImage() else { throw Failure(message: "Could not build the screenshot.") }
  return result
}

/// One display, by identity. With a single display screencapture's "-D 1" is
/// unambiguous; with several, screencapture's numbering is not derivable from
/// display ids, so capture each by id instead of guessing which is which.
func displayImage(_ id: CGDirectDisplayID, only: Bool) throws -> CGImage {
  if only { return try runScreencapture(["-x", "-t", "png", "-D", "1"]) }
  guard let image = CGDisplayCreateImage(id) else { throw Failure(message: "Could not capture display \(id).") }
  return image
}

func capture() throws -> [String: Any] {
  try preflight([.screen])
  let ids = activeDisplays()
  if ids.isEmpty { throw Failure(message: "No displays found. Is a monitor connected and awake?") }
  var union = CGRect.null
  for id in ids { union = union.union(CGDisplayBounds(id)) }
  var pieces: [(CGImage, CGRect)] = []
  for id in ids {
    let bounds = CGDisplayBounds(id)
    pieces.append((try displayImage(id, only: ids.count == 1), CGRect(x: bounds.minX - union.minX, y: bounds.minY - union.minY, width: bounds.width, height: bounds.height)))
  }
  guard let png = pngData(try composite(size: union.size, pieces)) else { throw Failure(message: "Could not encode the screenshot.") }
  return ["png": png.base64EncodedString(), "bounds": boundsJSON(union)]
}

/// One window, straight from the compositor: it need not be in front, so this
/// never raises anything or moves the cursor.
func windowCapture(_ request: [String: Any]) throws -> [String: Any] {
  try preflight([.screen])
  guard let id = (request["window"] as? String).flatMap(Int.init), let win = onScreenWindows().first(where: { $0.id == id }) else {
    throw Failure(message: "Window is no longer available. Inspect windows again; do not guess its id.")
  }
  let image = try runScreencapture(["-x", "-o", "-t", "png", "-l", String(id)])
  guard let png = pngData(try composite(size: win.bounds.size, [(image, CGRect(origin: .zero, size: win.bounds.size))])) else {
    throw Failure(message: "Could not encode the window screenshot.")
  }
  return ["png": png.base64EncodedString(), "bounds": boundsJSON(win.bounds), "process": win.owner]
}

// MARK: focus

func axPoint(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
  var ref: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &ref) == .success, let value = ref, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
  var point = CGPoint.zero
  return AXValueGetValue(value as! AXValue, .cgPoint, &point) ? point : nil
}

func axSize(_ element: AXUIElement, _ attribute: String) -> CGSize? {
  var ref: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &ref) == .success, let value = ref, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
  var size = CGSize.zero
  return AXValueGetValue(value as! AXValue, .cgSize, &size) ? size : nil
}

/// The Accessibility window that is the given CoreGraphics window: same frame.
func axWindow(for win: Win, in app: AXUIElement) -> AXUIElement? {
  var ref: CFTypeRef?
  guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &ref) == .success, let list = ref as? [AXUIElement] else { return nil }
  var best: AXUIElement?
  var bestGap = CGFloat.greatestFiniteMagnitude
  for element in list {
    guard let origin = axPoint(element, kAXPositionAttribute), let size = axSize(element, kAXSizeAttribute) else { continue }
    let gap = abs(origin.x - win.bounds.minX) + abs(origin.y - win.bounds.minY) + abs(size.width - win.bounds.width) + abs(size.height - win.bounds.height)
    if gap < bestGap { bestGap = gap; best = element }
  }
  return bestGap <= 8 ? best : nil
}

func waitForActive(_ id: Int, polls: Int) -> Bool {
  for _ in 0..<polls {
    if activeWindowID() == id { return true }
    usleep(50_000)
  }
  return activeWindowID() == id
}

func focus(windowID: Int) throws {
  try requirePermissions([.accessibility])
  guard let win = onScreenWindows().first(where: { $0.id == windowID }) else {
    throw Failure(message: "Window is no longer available. Inspect windows again; do not guess its id.")
  }
  if activeWindowID() == windowID { return }
  let app = AXUIElementCreateApplication(win.pid)
  AXUIElementSetMessagingTimeout(app, 2)
  AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
  if let element = axWindow(for: win, in: app) {
    AXUIElementPerformAction(element, kAXRaiseAction as CFString)
    AXUIElementSetAttributeValue(element, kAXMainAttribute as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(app, kAXFocusedWindowAttribute as CFString, element)
  }
  if waitForActive(windowID, polls: 16) { return }
  NSRunningApplication(processIdentifier: win.pid)?.activate(options: [.activateAllWindows])
  if waitForActive(windowID, polls: 16) { return }
  let active = activeWindowID().map(String.init) ?? "none"
  throw Failure(message: "Window focus verification failed: expected \(windowID), active window is \(active). No keyboard input was sent.")
}

// MARK: input

let source = CGEventSource(stateID: .hidSystemState)

func post(_ event: CGEvent?) { event?.post(tap: .cghidEventTap) }

let keyCodes: [String: CGKeyCode] = [
  "A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7, "C": 8, "V": 9, "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15, "Y": 16, "T": 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "O": 31, "U": 32, "I": 34, "P": 35, "L": 37, "J": 38,
  "K": 40, "N": 45, "M": 46, "ENTER": 36, "TAB": 48, "SPACE": 49, "BACKSPACE": 51, "ESC": 53, "DELETE": 117, "HOME": 115, "END": 119,
  "PAGEUP": 116, "PAGEDOWN": 121, "LEFT": 123, "RIGHT": 124, "DOWN": 125, "UP": 126,
  "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97, "F7": 98, "F8": 100, "F9": 101, "F10": 109, "F11": 103, "F12": 111,
]
let modifierFlags: [String: CGEventFlags] = ["CTRL": .maskControl, "ALT": .maskAlternate, "SHIFT": .maskShift, "META": .maskCommand]
let modifierCodes: [CGKeyCode] = [54, 55, 56, 58, 59, 60, 61, 62, 63]

func pressKeys(_ names: [String]) throws {
  var flags: CGEventFlags = []
  var mains: [CGKeyCode] = []
  for name in names {
    if let flag = modifierFlags[name] { flags.insert(flag) }
    else if let code = keyCodes[name] { mains.append(code) }
    else { throw Failure(message: "Unsupported key \(name).") }
  }
  if mains.isEmpty {
    // A lone modifier press is a flags change, not a key.
    let down = CGEvent(source: source); down?.type = .flagsChanged; down?.flags = flags; post(down)
    usleep(30_000)
    let up = CGEvent(source: source); up?.type = .flagsChanged; up?.flags = []; post(up)
    return
  }
  for code in mains {
    let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true); down?.flags = flags; post(down)
    usleep(15_000)
    let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false); up?.flags = flags; post(up)
    usleep(15_000)
  }
}

func typeText(_ text: String) {
  let units = Array(text.utf16)
  var index = 0
  while index < units.count {
    // 20 UTF-16 units per event is the documented limit; never split a pair.
    var count = min(20, units.count - index)
    if count < units.count - index, UTF16.isLeadSurrogate(units[index + count - 1]) { count -= 1 }
    let chunk = Array(units[index..<(index + count)])
    for down in [true, false] {
      let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
      event?.flags = []
      event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
      post(event)
    }
    usleep(5_000)
    index += count
  }
}

func mouse(_ type: CGEventType, _ point: CGPoint, button: CGMouseButton = .left, clickState: Int64 = 1) {
  let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button)
  event?.setIntegerValueField(.mouseEventClickState, value: clickState)
  post(event)
}

func moveCursor(_ point: CGPoint) {
  CGWarpMouseCursorPosition(point)
  mouse(.mouseMoved, point)
}

func assertWindow(_ id: Int, _ expected: [String: Any]?, afterInput: Bool) throws {
  let changed = afterInput
    ? "The active window changed during input. Input may have run; inspect the current desktop before continuing."
    : "The active window changed before input. No input was sent; inspect and focus the window again."
  if activeWindowID() != id { throw Failure(message: changed, inputAttempted: afterInput) }
  guard let expected = expected, let win = onScreenWindows().first(where: { $0.id == id }) else { return }
  let same = ["x": rounded(win.bounds.minX), "y": rounded(win.bounds.minY), "width": rounded(win.bounds.width), "height": rounded(win.bounds.height)]
    .allSatisfy { key, value in (expected[key] as? NSNumber)?.intValue == value }
  if !same {
    throw Failure(message: afterInput
      ? "The target window moved or resized during input. Input may have run; inspect before continuing."
      : "Window moved or resized while it was being focused. No input was sent; capture that window again.", inputAttempted: afterInput)
  }
}

let mouseActions = ["move", "click", "right_click", "double_click", "scroll", "drag"]

/// Everything a request asks for, checked before anything happens: no focus
/// change, cursor move or key press for a request that cannot complete.
struct Action {
  let name: String
  let target: Int?
  let expected: [String: Any]?
  var point = CGPoint.zero
  var dragTo = CGPoint.zero
  var direction = ""
  var amount = 0
  var text = ""
  var keys: [String] = []
}

func parseAction(_ request: [String: Any]) throws -> Action {
  let name = request["action"] as? String ?? ""
  guard name == "focus" || name == "type" || name == "key" || mouseActions.contains(name) else { throw Failure(message: "Unsupported action.") }
  let target = (request["window"] as? String).flatMap(Int.init)
  if request["window"] != nil && target == nil { throw Failure(message: "Invalid window id. Inspect windows again; do not guess.") }
  var action = Action(name: name, target: target, expected: request["windowBounds"] as? [String: Any])
  if name == "focus" && target == nil { throw Failure(message: "Focus needs a window id.") }
  if name == "type" || name == "key" {
    guard target != nil else { throw Failure(message: name == "type" ? "Targeted typing requires a window id. Use computer_type." : "Targeted keys require a window id. Use computer_key.") }
  }
  if name == "type" {
    guard let text = request["text"] as? String, !text.isEmpty, text.utf16.count <= 2000 else { throw Failure(message: "Type needs 1 to 2000 characters.") }
    action.text = text
  }
  if name == "key" {
    guard let keys = request["keys"] as? [String], !keys.isEmpty, keys.count <= 5, keys.allSatisfy({ modifierFlags[$0] != nil || keyCodes[$0] != nil }) else {
      throw Failure(message: "Key needs 1 to 5 known key names.")
    }
    action.keys = keys
  }
  if mouseActions.contains(name) {
    guard let x = (request["x"] as? NSNumber)?.doubleValue, let y = (request["y"] as? NSNumber)?.doubleValue, x.isFinite, y.isFinite else {
      throw Failure(message: "Mouse actions need x and y.")
    }
    action.point = CGPoint(x: x, y: y)
    if name == "scroll" {
      guard let direction = request["direction"] as? String, ["up", "down", "left", "right"].contains(direction),
            let amount = (request["amount"] as? NSNumber)?.intValue, (1...10).contains(amount) else {
        throw Failure(message: "Scroll needs a direction (up, down, left, right) and an amount from 1 to 10.")
      }
      action.direction = direction
      action.amount = amount
    }
    if name == "drag" {
      guard let toX = (request["toX"] as? NSNumber)?.doubleValue, let toY = (request["toY"] as? NSNumber)?.doubleValue, toX.isFinite, toY.isFinite else {
        throw Failure(message: "Drag needs toX and toY.")
      }
      action.dragTo = CGPoint(x: toX, y: toY)
    }
    // A targeted action stays inside the window it was aimed at. The
    // controller already maps coordinates within the screenshot; this keeps a
    // stale, incomplete or hand-built request from clicking another application.
    if target != nil {
      guard let frame = action.expected,
            let left = (frame["x"] as? NSNumber)?.doubleValue, let top = (frame["y"] as? NSNumber)?.doubleValue,
            let width = (frame["width"] as? NSNumber)?.doubleValue, let height = (frame["height"] as? NSNumber)?.doubleValue,
            left.isFinite, top.isFinite, width.isFinite, height.isFinite, width > 0, height > 0 else {
        throw Failure(message: "A targeted mouse action needs the window's bounds. No input was sent; capture the window again.")
      }
      let box = CGRect(x: left, y: top, width: width, height: height)
      if !box.contains(action.point) || (name == "drag" && !box.contains(action.dragTo)) {
        throw Failure(message: "That point is outside the target window. No input was sent; capture the window again.")
      }
    }
  }
  return action
}

func act(_ request: [String: Any]) throws {
  let action = try parseAction(request)
  try preflight([.accessibility])
  if let target = action.target {
    try focus(windowID: target)
    try assertWindow(target, action.expected, afterInput: false)
  }
  if action.name == "focus" { return }

  if mouseActions.contains(action.name) {
    let point = action.point
    moveCursor(point)
    usleep(40_000)
    // Right before the button or wheel goes down: nothing may have moved.
    if let target = action.target { try assertWindow(target, action.expected, afterInput: false) }
    if action.name == "move" { return }
    switch action.name {
    case "click":
      mouse(.leftMouseDown, point); usleep(30_000); mouse(.leftMouseUp, point)
    case "right_click":
      mouse(.rightMouseDown, point, button: .right); usleep(30_000); mouse(.rightMouseUp, point, button: .right)
    case "double_click":
      mouse(.leftMouseDown, point); usleep(25_000); mouse(.leftMouseUp, point)
      usleep(60_000)
      mouse(.leftMouseDown, point, clickState: 2); usleep(25_000); mouse(.leftMouseUp, point, clickState: 2)
    case "scroll":
      let lines = Int32(3)
      // Positive vertical scrolls up; positive horizontal scrolls left.
      let vertical: Int32 = action.direction == "up" ? lines : action.direction == "down" ? -lines : 0
      let horizontal: Int32 = action.direction == "left" ? lines : action.direction == "right" ? -lines : 0
      for _ in 0..<action.amount {
        post(CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: vertical, wheel2: horizontal, wheel3: 0))
        usleep(40_000)
      }
    default: // drag
      mouse(.leftMouseDown, point)
      let steps = 12
      for step in 1...steps {
        let t = Double(step) / Double(steps)
        mouse(.leftMouseDragged, CGPoint(x: point.x + (action.dragTo.x - point.x) * t, y: point.y + (action.dragTo.y - point.y) * t))
        usleep(12_000)
      }
      mouse(.leftMouseUp, action.dragTo)
    }
    usleep(80_000)
    if let target = action.target { try assertWindow(target, action.expected, afterInput: true) }
    return
  }

  // parseAction guarantees a target for type and key.
  if action.name == "type" { typeText(action.text) } else { try pressKeys(action.keys) }
  usleep(80_000)
  if let target = action.target { try assertWindow(target, nil, afterInput: true) }
}

/// Let go of anything an interrupted action left down.
func release() {
  let here = CGEvent(source: nil)?.location ?? .zero
  for (button, up) in [(CGMouseButton.left, CGEventType.leftMouseUp), (CGMouseButton.right, CGEventType.rightMouseUp)]
  where CGEventSource.buttonState(.hidSystemState, button: button) {
    mouse(up, here, button: button)
  }
  for code in modifierCodes where CGEventSource.keyState(.hidSystemState, key: code) {
    let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
    up?.flags = []
    post(up)
  }
}

// MARK: permissions ops

func statusJSON() -> [String: Any] {
  [
    "screenRecording": CGPreflightScreenCaptureAccess(),
    "accessibility": AXIsProcessTrusted(),
    "locked": sessionValue("CGSSessionScreenIsLocked") ?? false,
    "displayAsleep": CGDisplayIsAsleep(CGMainDisplayID()) != 0,
    "displays": activeDisplays().count,
  ]
}

/// Raises the two system prompts on purpose. Only ever run from the Ship menu
/// item or the setup launch flag, never from an agent request.
func requestPermissions() -> [String: Any] {
  _ = CGRequestScreenCaptureAccess()
  let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
  _ = AXIsProcessTrustedWithOptions(options)
  return statusJSON()
}

// MARK: main

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let request = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any], let op = request["op"] as? String else {
  finish(["error": "The helper needs a JSON request with an op."], code: 1)
}

do {
  switch op {
  case "status": finish(statusJSON())
  case "request_permissions": finish(requestPermissions())
  case "inspect": finish(try inspect())
  case "capture": finish(try capture())
  case "window_capture": finish(try windowCapture(request))
  case "act": try act(request); finish(["ok": true])
  case "release": release(); finish(["ok": true])
  default: finish(["error": "Unknown helper op \(op)."], code: 1)
  }
} catch let failure as Failure {
  finish(["error": failure.message, "inputAttempted": failure.inputAttempted], code: 1)
} catch {
  finish(["error": "\(error)"], code: 1)
}
