# Fixed native adapter. JSON arrives on stdin, never interpolated into code.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class DesktopInput {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(System.Drawing.Point point, uint flags);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
  public static void EnableDpi() {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) throw new Exception("Per-monitor V2 DPI awareness is unavailable.");
  }
  public static double ScaleAt(int x, int y) {
    uint dx,dy; var monitor=MonitorFromPoint(new System.Drawing.Point(x,y),2);
    if (GetDpiForMonitor(monitor,0,out dx,out dy)!=0) throw new Exception("Monitor DPI unavailable.");
    return dx/96.0;
  }
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder name, uint length, out uint needed);
  [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] input, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int count);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSE { public int x,y; public uint data, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEY { public ushort vk, scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSE mouse; [FieldOffset(0)] public KEY key; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  static void Send(INPUT i) { if (SendInput(1, new INPUT[]{ i }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new Exception("Windows refused input (permissions or secure desktop)."); }
  public static void CheckDesktop() {
    IntPtr h = OpenInputDesktop(0, false, 1);
    if (h == IntPtr.Zero) throw new Exception("Desktop locked or secure desktop active.");
    try {
      var s = new StringBuilder(256); uint needed;
      if (!GetUserObjectInformation(h, 2, s, 512, out needed) || s.ToString() != "Default") throw new Exception("Only the unlocked user desktop is controllable.");
    } finally { CloseDesktop(h); }
  }
  public static void Mouse(uint flags, int data) { INPUT i = new INPUT(); i.u.mouse.flags = flags; i.u.mouse.data = unchecked((uint)data); Send(i); }
  public static void Key(ushort vk, bool up) { INPUT i = new INPUT(); i.type=1; i.u.key.vk=vk; i.u.key.flags=up ? 2u : 0u; Send(i); }
  public static void Type(string text) {
    foreach (char c in text) {
      if (c == '\n' || c == '\t') { ushort vk = (ushort)(c == '\n' ? 13 : 9); Key(vk,false); Key(vk,true); continue; }
      INPUT i = new INPUT(); i.type=1; i.u.key.scan=c; i.u.key.flags=4; Send(i); i.u.key.flags=6; Send(i);
    }
  }
  public static long Foreground() { return GetForegroundWindow().ToInt64(); }
  public static int[] Bounds(long id) {
    RECT r; if (!GetWindowRect(new IntPtr(id),out r)) throw new Exception("Window geometry is unavailable.");
    return new int[]{r.left,r.top,r.right-r.left,r.bottom-r.top};
  }
  public static void Focus(long id) {
    var h=new IntPtr(id); if (IsIconic(h)) ShowWindow(h,9);
    if (GetForegroundWindow()==h) return;
    SetForegroundWindow(h);
    if (GetForegroundWindow()!=h) {
      // A background helper has no recent input entitlement. A bounded Alt
      // event uses the same approved SendInput path as ordinary hotkeys.
      try { Key(18,false); } finally { Key(18,true); }
      SetForegroundWindow(h);
    }
    if (GetForegroundWindow()!=h) throw new Exception("Windows refused foreground activation; select the window manually.");
  }
  public static object[] Windows() {
    var result = new List<object>();
    EnumWindows((h,p) => { if (!IsWindowVisible(h)) return true; var s=new StringBuilder(512); GetWindowText(h,s,512); RECT r;
      if (s.Length>0 && GetWindowRect(h,out r)) result.Add(new { id=h.ToInt64().ToString(), title=s.ToString(), bounds=new { x=r.left,y=r.top,width=r.right-r.left,height=r.bottom-r.top } }); return true; }, IntPtr.Zero);
    return result.ToArray();
  }

  // --- Background window control: never SetForegroundWindow, never SendInput,
  // --- never SetCursorPos. PrintWindow + posted messages + UIA only.
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern ushort MapVirtualKey(ushort vk, uint type);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder s, ref uint size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static string ProcessImage(long id) {
    uint pid; GetWindowThreadProcessId(new IntPtr(id), out pid);
    if (pid == 0) return "";
    IntPtr h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (h == IntPtr.Zero) return "";
    try { var s = new StringBuilder(1024); uint size = 1024; return QueryFullProcessImageName(h, 0, s, ref size) ? System.IO.Path.GetFileName(s.ToString()) : ""; }
    finally { CloseHandle(h); }
  }
  public static byte[] PrintWindowBytes(long id) {
    IntPtr h = new IntPtr(id);
    if (!IsWindow(h)) throw new Exception("The window no longer exists. Inspect windows again.");
    if (IsIconic(h)) throw new Exception("The window is minimized. Background capture needs it restored; ask the person at the machine.");
    RECT r; if (!GetWindowRect(h, out r)) throw new Exception("Window geometry is unavailable.");
    int w = r.right - r.left, ht = r.bottom - r.top;
    if (w < 1 || ht < 1 || w > 8000 || ht > 8000) throw new Exception("The window has no capturable background size.");
    using (var bmp = new System.Drawing.Bitmap(w, ht)) {
      using (var g = System.Drawing.Graphics.FromImage(bmp)) {
        g.Clear(System.Drawing.Color.White); // rounded window corners render transparent otherwise
        IntPtr dc = g.GetHdc();
        try { if (!PrintWindow(h, dc, 2)) throw new Exception("The window refused a background capture; it may only render in the foreground."); }
        finally { g.ReleaseHdc(dc); }
      }
      using (var ms = new System.IO.MemoryStream()) { bmp.Save(ms, System.Drawing.Imaging.ImageFormat.Png); return ms.ToArray(); }
    }
  }
  static void Post(IntPtr h, uint msg, IntPtr w, IntPtr l) { if (!PostMessage(h, msg, w, l)) throw new Exception("The window refused a posted message (queue full or gone)."); }
  // Arrows, Delete, Home/End, PageUp/Down and friends need the extended-key
  // bit in lParam, or Win32 controls read them as their numpad duplicates.
  static bool IsExtendedKey(ushort vk) {
    return vk == 0x21 || vk == 0x22 || vk == 0x23 || vk == 0x24 || vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28
      || vk == 0x2D || vk == 0x2E || vk == 0x6A;
  }
  public static void PostKey(long id, ushort vk) {
    IntPtr h = new IntPtr(id);
    ushort scan = MapVirtualKey(vk, 0);
    uint ext = IsExtendedKey(vk) ? 0x01000000u : 0u;
    Post(h, 0x100, (IntPtr)vk, (IntPtr)(1u | ((uint)scan << 16) | ext));                     // WM_KEYDOWN
    if (vk == 13 || vk == 9 || vk == 27 || vk == 32 || vk == 8) Post(h, 0x102, (IntPtr)vk, IntPtr.Zero); // WM_CHAR for producing keys
    else if (vk >= 0x30 && vk <= 0x39) Post(h, 0x102, (IntPtr)vk, IntPtr.Zero);              // digits
    else if (vk >= 0x41 && vk <= 0x5A) Post(h, 0x102, (IntPtr)(vk + 32), IntPtr.Zero);        // lowercase letter
    Post(h, 0x101, (IntPtr)vk, (IntPtr)(ext | ((uint)scan << 16) | (1u << 30) | (1u << 31))); // WM_KEYUP
  }
  public static void PostText(long id, string text) {
    IntPtr h = new IntPtr(id);
    foreach (char c in text) {
      if (c == '\r') continue;
      if (c == '\n' || c == '\t') { PostKey(id, (ushort)(c == '\n' ? 13 : 9)); continue; }
      Post(h, 0x102, (IntPtr)(int)c, IntPtr.Zero);                                            // WM_CHAR
    }
  }
  public static void Release() { Mouse(4,0); Mouse(16,0); foreach (ushort k in new ushort[]{16,17,18,91}) Key(k,true); }
}
'@
[DesktopInput]::EnableDpi()
Add-Type -AssemblyName System.Windows.Forms

# Background window control uses UI Automation. Optional at runtime: if this
# compile ever fails on a machine, only the uia ops refuse; every other op keeps
# working. No op below may SetForegroundWindow, SendInput or SetCursorPos.
$script:InputAttempted = $false
$script:UiaReady = $false
$script:UiaError = ''
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -ReferencedAssemblies @('UIAutomationClient.dll','UIAutomationTypes.dll','System.dll') -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Windows.Automation;
public static class UiaWindow {
  static readonly TreeWalker Walker = TreeWalker.ControlViewWalker;
  static string Trim(string s, int max) {
    if (string.IsNullOrEmpty(s)) return "";
    s = s.Replace('\n', ' ').Replace('\r', ' ').Replace('\t', ' ');
    return s.Length <= max ? s : s.Substring(0, max);
  }
  static AutomationElement Root(long hwnd) {
    AutomationElement el = null;
    try { el = AutomationElement.FromHandle(new IntPtr(hwnd)); }
    catch { throw new Exception("The window no longer exists. Inspect windows again."); }
    if (el == null) throw new Exception("The window no longer exists. Inspect windows again.");
    try { var t = el.Current.ControlType; }
    catch (ElementNotAvailableException) { throw new Exception("The window closed before its elements could be read. Inspect windows again."); }
    return el;
  }
  static string[] PatternNames(AutomationElement el) {
    AutomationPattern[] pats;
    try { pats = el.GetSupportedPatterns(); } catch { return new string[0]; }
    var names = new List<string>();
    foreach (var p in pats) {
      if (p == ValuePattern.Pattern) names.Add("value");
      else if (p == InvokePattern.Pattern) names.Add("invoke");
      else if (p == TogglePattern.Pattern) names.Add("toggle");
      else if (p == ExpandCollapsePattern.Pattern) names.Add("expand");
      else if (p == SelectionItemPattern.Pattern) names.Add("select");
      else if (p == TextPattern.Pattern) names.Add("text");
    }
    return names.ToArray();
  }
  static object Row(AutomationElement el, string path) {
    var cur = el.Current;
    string name = Trim(cur.Name, 140);
    string ct = cur.ControlType == null ? "" : cur.ControlType.ProgrammaticName;
    if (ct.StartsWith("ControlType.")) ct = ct.Substring("ControlType.".Length);
    string[] pats = PatternNames(el);
    bool focusable = cur.IsKeyboardFocusable, focused = cur.HasKeyboardFocus;
    if (name.Length == 0 && pats.Length == 0 && !focusable && !focused) return null; // silent layout node
    var rect = cur.BoundingRectangle;
    object bounds = null;
    if (!rect.IsEmpty) bounds = new {
      x = (int)Math.Round(rect.X), y = (int)Math.Round(rect.Y),
      width = (int)Math.Round(rect.Width), height = (int)Math.Round(rect.Height),
    };
    return new {
      path, name, controlType = ct, automationId = Trim(cur.AutomationId, 80),
      patterns = pats, focusable, focused, bounds,
    };
  }
  public static object Snapshot(long hwnd, int maxElements, int maxDepth, int budgetMs) {
    var root = Root(hwnd);
    var rows = new List<object>();
    var state = new WalkState();
    var sw = System.Diagnostics.Stopwatch.StartNew();
    Walk(root, "0", 0, maxElements, maxDepth, budgetMs, sw, rows, state);
    bool truncated = rows.Count >= maxElements || sw.ElapsedMilliseconds > budgetMs || state.DepthHit;
    return new { elements = rows.ToArray(), truncated };
  }
  class WalkState { public bool DepthHit; }
  static void Walk(AutomationElement el, string path, int depth, int maxElements, int maxDepth, int budgetMs, System.Diagnostics.Stopwatch sw, List<object> rows, WalkState state) {
    if (depth >= maxDepth) {
      // A depth-capped tree must not read as complete just because the
      // element budget was not reached.
      if (sw.ElapsedMilliseconds <= budgetMs) { try { if (Walker.GetFirstChildElement(el) != null) state.DepthHit = true; } catch { } }
      return;
    }
    if (rows.Count >= maxElements || sw.ElapsedMilliseconds > budgetMs) return;
    AutomationElement child;
    try { child = Walker.GetFirstChildElement(el); } catch { return; }
    int index = 0;
    while (child != null) {
      if (rows.Count >= maxElements || sw.ElapsedMilliseconds > budgetMs) return;
      var current = child;
      string nextPath = path + "/" + index;
      try { var row = Row(current, nextPath); if (row != null) rows.Add(row); } catch { }
      Walk(current, nextPath, depth + 1, maxElements, maxDepth, budgetMs, sw, rows, state);
      try { child = Walker.GetNextSiblingElement(current); } catch { return; }
      index++;
    }
  }
  public static object Resolve(long hwnd, string path, string expectName) {
    var el = Root(hwnd);
    if (string.IsNullOrEmpty(path) || path == "0") throw new Exception("The window root is not an element ref. Use a snapshot ref like \"0/3/2\".");
    var parts = path.Split('/');
    // Refs name the window root first ("0/3/2" = root, child 3, child 2).
    // Descending into segment 0 as a child index would resolve refs to the
    // wrong element entirely.
    if (parts[0] != "0") throw new Exception("Invalid element ref: refs start at the window root (\"0\"). Snapshot the window again with computer_uia.");
    for (int p = 1; p < parts.Length; p++) {
      int i;
      if (!int.TryParse(parts[p], out i) || i < 0) throw new Exception("Invalid element ref. Snapshot the window again with computer_uia.");
      var next = Nth(el, i);
      if (next == null) throw new Exception("Element not found at ref " + path + ": the window changed. Snapshot it again.");
      el = next;
    }
    string name = "";
    try { name = el.Current.Name; } catch (ElementNotAvailableException) { throw new Exception("The element closed before the action. Snapshot the window again."); }
    // Compare the SAME canonicalized name the snapshot emitted (capped and
    // newline/tab-flattened), so a long or multiline accessible name never
    // reads as a stale ref.
    string shown = Trim(name, 140);
    string expected = Trim(expectName, 140);
    if (!string.IsNullOrEmpty(expected) && shown != expected)
      throw new Exception("The element at that ref changed (expected '" + Trim(expected, 80) + "', found '" + Trim(shown, 80) + "'). Snapshot the window again and use the fresh ref.");
    return new { Name = name, Element = el };
  }
  /** The focused element's own native window handle, when it has one, so
   *  posted messages reach the element that holds keyboard focus rather than
   *  only the top-level window. Returns 0 when it cannot be resolved. */
  public static long FocusedHandle(long hwnd, int budgetMs) {
    var root = Root(hwnd);
    var sw = System.Diagnostics.Stopwatch.StartNew();
    var el = FindFocused(root, sw, budgetMs);
    if (el == null) return 0;
    try { return el.Current.NativeWindowHandle; } catch { return 0; }
  }
  static AutomationElement FindFocused(AutomationElement el, System.Diagnostics.Stopwatch sw, int budgetMs) {
    if (sw.ElapsedMilliseconds > budgetMs) return null;
    try { if (el.Current.HasKeyboardFocus) return el; } catch { }
    AutomationElement child;
    try { child = Walker.GetFirstChildElement(el); } catch { return null; }
    while (child != null) {
      var hit = FindFocused(child, sw, budgetMs);
      if (hit != null) return hit;
      var current = child;
      try { child = Walker.GetNextSiblingElement(current); } catch { return null; }
    }
    return null;
  }
  static AutomationElement Nth(AutomationElement parent, int index) {
    try {
      var child = Walker.GetFirstChildElement(parent);
      int i = 0;
      while (child != null) {
        if (i == index) return child;
        var current = child;
        try { child = Walker.GetNextSiblingElement(current); } catch { return null; }
        i++;
      }
    } catch { }
    return null;
  }
}
'@
  $script:UiaReady = $true
} catch {
  $script:UiaError = $_.Exception.Message
}

# Background keyboard focus via UIA only. SetFocus can, on some providers,
# activate the element's window and steal the person's real foreground: that
# is exactly what background control must never do, so verify the foreground
# window is unchanged and refuse when it is not.
function Assert-BackgroundSetFocus([object]$element, [long]$hwnd) {
  $before = [DesktopInput]::Foreground()
  if ($before -eq $hwnd) {
    throw 'needs foreground: the person is actively using this window (it is the foreground window), so background focus would redirect their live typing. Wait for them to leave the window, or use real input with their knowledge.'
  }
  try { $element.SetFocus() } catch {
    throw "needs foreground: the element refused background keyboard focus ($($_.Exception.Message)). Real input is required to focus it."
  }
  # Sample immediately (a provider that activates persists through at least
  # one pump cycle) and again after the settle: either mismatch refuses.
  $rightAfter = [DesktopInput]::Foreground()
  Start-Sleep -Milliseconds 200
  $after = [DesktopInput]::Foreground()
  if ($rightAfter -ne $before -or $after -ne $before) {
    throw 'needs foreground: the OS foreground changed while giving the element background focus (the app may have activated its window, or the person switched apps in that instant). Stop; do not retry this element, verify what is focused now, and prefer real input for it.'
  }
}

function Assert-TargetWindow([object]$request, [bool]$afterInput) {
  if (!$request.window) { return }
  if ([DesktopInput]::Foreground() -ne [long]$request.window) {
    if ($afterInput) { throw 'The active window changed during input. Input may have run; inspect the current desktop before continuing.' }
    throw 'The active window changed before input. No input was sent; inspect and focus the window again.'
  }
  if ($request.windowBounds) {
    $bounds=[DesktopInput]::Bounds([long]$request.window)
    if ($bounds[0] -ne [int]$request.windowBounds.x -or $bounds[1] -ne [int]$request.windowBounds.y -or $bounds[2] -ne [int]$request.windowBounds.width -or $bounds[3] -ne [int]$request.windowBounds.height) {
      if ($afterInput) { throw 'The target window moved or resized during input. Input may have run; inspect before continuing.' }
      throw 'Window moved or resized before input. No input was sent; capture that window again.'
    }
  }
}
try {
  $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
  [DesktopInput]::CheckDesktop()
  $result = @{}
  switch ($p.op) {
    'inspect' {
      $displays = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
        @{ id=$_.DeviceName; bounds=@{ x=$_.Bounds.X; y=$_.Bounds.Y; width=$_.Bounds.Width; height=$_.Bounds.Height }; scaleFactor=[DesktopInput]::ScaleAt($_.Bounds.X,$_.Bounds.Y) }
      })
      $result = @{ displays=$displays; windows=@([DesktopInput]::Windows()); activeWindow=[string][DesktopInput]::Foreground() }
    }
    'capture' {
      $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $bitmap = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
      $g = [System.Drawing.Graphics]::FromImage($bitmap)
      $stream = New-Object System.IO.MemoryStream
      try {
        $g.CopyFromScreen($b.X, $b.Y, 0, 0, $b.Size)
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $result = @{ png=[Convert]::ToBase64String($stream.ToArray()); bounds=@{ x=$b.X; y=$b.Y; width=$b.Width; height=$b.Height } }
      } finally { $g.Dispose(); $bitmap.Dispose(); $stream.Dispose() }
    }
    'release' { [DesktopInput]::Release() }
    'window_capture' {
      if (!$p.window) { throw 'window_capture requires a window id.' }
      $hwnd = [long]$p.window
      $bytes = [DesktopInput]::PrintWindowBytes($hwnd)
      $b = [DesktopInput]::Bounds($hwnd)
      $result = @{ png=[Convert]::ToBase64String($bytes); bounds=@{ x=$b[0]; y=$b[1]; width=$b[2]; height=$b[3] }; process=[DesktopInput]::ProcessImage($hwnd) }
    }
    'uia' {
      if (!$script:UiaReady) { throw "UI Automation is unavailable on this machine: $script:UiaError" }
      if (!$p.window) { throw 'uia requires a window id.' }
      $hwnd = [long]$p.window
      $snap = [UiaWindow]::Snapshot($hwnd, 300, 40, 8000)
      # Chromium apps build their accessibility tree only when they notice a
      # UIA client, so the very first snapshot can come back sparse even
      # though the window is fine. Walk once more and keep the fuller result.
      # Both walk budgets must fit the adapter's process timeout with room for
      # PowerShell startup, UIA init and serialization.
      if (@($snap.elements).Count -lt 8 -and -not [bool]$snap.truncated) {
        Start-Sleep -Milliseconds 700
        $snap2 = [UiaWindow]::Snapshot($hwnd, 300, 40, 8000)
        if (@($snap2.elements).Count -gt @($snap.elements).Count) { $snap = $snap2 }
      }
      $result = @{ process=[DesktopInput]::ProcessImage($hwnd); elements=@($snap.elements); truncated=[bool]$snap.truncated }
    }
    'uia_value' {
      if (!$script:UiaReady) { throw "UI Automation is unavailable on this machine: $script:UiaError" }
      if (!$p.window -or !$p.element) { throw 'uia_value requires a window id and an element ref from computer_uia.' }
      $hwnd = [long]$p.window
      $resolved = [UiaWindow]::Resolve($hwnd, [string]$p.element, [string]$p.name)
      $el = $resolved.Element
      if ([string]::IsNullOrWhiteSpace([string]$p.name) -and -not [string]::IsNullOrWhiteSpace($resolved.Name)) {
        throw ("the element at that ref is named '{0}'; pass that name from the snapshot so the action can verify the ref is still current" -f $resolved.Name)
      }
      $valuePattern = $null
      try { $valuePattern = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) -as [System.Windows.Automation.ValuePattern] } catch { $valuePattern = $null }
      $postedTo = 0
      $post = [bool]$p.post
      $append = [bool]$p.append
      if (-not $post -and -not $append -and $valuePattern -and -not $valuePattern.Current.IsReadOnly) {
        $script:InputAttempted = $true
        $valuePattern.SetValue([string]$p.text)
      } else {
        # Rich editors can render SetValue text while their own input handling
        # never sees it (a Send button stays disabled), so the posted-characters
        # path is the reliable one for them. Characters only land on an element
        # that holds keyboard focus: give it background keyboard focus via UIA
        # SetFocus first (not real input, and verified not to change the OS
        # foreground).
        if ([regex]::IsMatch([string]$p.text, '[\r\n\t]')) {
          throw 'posted characters cannot carry newlines or tabs: a posted ENTER would submit and a posted TAB would move focus. Send single-line text only.'
        }
        $focused = $false
        try { $focused = [bool]$el.Current.HasKeyboardFocus } catch { $focused = $false }
        if (-not $focused) {
          Assert-BackgroundSetFocus $el $hwnd
          try { $focused = [bool]$el.Current.HasKeyboardFocus } catch { $focused = $false }
        }
        if (-not $focused) {
          $why = if ($post) { 'the element did not take background keyboard focus (UIA SetFocus refused or did not stick)'
          } elseif ($valuePattern) { 'the element is read-only and did not take background keyboard focus'
          } else { 'the element exposes no ValuePattern and did not take background keyboard focus' }
          throw "needs foreground: $why, so background text cannot land on it. Try computer_uia_focus on the element first, focus the window and use computer_type, or have the person click into the field."
        }
        # Replacement semantics: posted characters APPEND, so measure the
        # field's current text through ValuePattern and clear it first (END,
        # then one BACKSPACE per character). Append mode skips the clear.
        $current = ''
        $canMeasure = $false
        if ($valuePattern) {
          try { $current = [string]$valuePattern.Current.Value; $canMeasure = $true } catch { $canMeasure = $false }
        }
        if (-not $append -and -not $canMeasure) {
          throw 'needs foreground: the element''s current text cannot be read (no usable ValuePattern), so a posted replacement cannot clear what is already there. Use append only when the field is known empty, or have the person clear it.'
        }
        # Backspace-clearing counts text units: values with multi-unit
        # characters (surrogate pairs, combining marks) or beyond the size cap
        # cannot be cleared exactly, so refuse rather than over-delete.
        if (-not $append -and $current.Length -gt 8000) {
          throw 'needs foreground: the field holds more than 8000 characters, more than background clearing can replace exactly. Have the person clear it, or append into an empty field.'
        }
        if (-not $append -and [regex]::IsMatch($current, '[\uD800-\uDFFF\p{M}]')) {
          throw 'needs foreground: the field holds multi-unit characters (emoji, accents) that background backspace-clearing cannot count exactly. Have the person clear it, or append into an empty field.'
        }
        if (-not $append -and [regex]::IsMatch($current, '[\r\n\t]')) {
          throw 'needs foreground: the field holds multiline text, which background END+backspace clearing cannot replace exactly (END only reaches the end of one line). Have the person clear it, or append into an empty field.'
        }
        # Post to the focused element's own native window handle when it has
        # one: classic Win32 controls never receive characters posted to their
        # top-level parent.
        $target = 0
        try { $target = [long]$el.Current.NativeWindowHandle } catch { $target = 0 }
        if ($target -eq 0) { $target = $hwnd }
        $postedTo = $target
        $script:InputAttempted = $true
        if (-not $append -and $current.Length -gt 0) {
          [DesktopInput]::PostKey($target, 35)
          for ($i = 0; $i -lt [Math]::Min($current.Length, 8000); $i++) { [DesktopInput]::PostKey($target, 8) }
        }
        [DesktopInput]::PostText($target, [string]$p.text)
      }
      Start-Sleep -Milliseconds 250
      $bytes = [DesktopInput]::PrintWindowBytes($hwnd)
      $b = [DesktopInput]::Bounds($hwnd)
      $result = @{ png=[Convert]::ToBase64String($bytes); bounds=@{ x=$b[0]; y=$b[1]; width=$b[2]; height=$b[3] }; postedTo=$postedTo }
    }
    'uia_focus' {
      if (!$script:UiaReady) { throw "UI Automation is unavailable on this machine: $script:UiaError" }
      if (!$p.window -or !$p.element) { throw 'uia_focus requires a window id and an element ref from computer_uia.' }
      $hwnd = [long]$p.window
      $resolved = [UiaWindow]::Resolve($hwnd, [string]$p.element, [string]$p.name)
      $el = $resolved.Element
      if ([string]::IsNullOrWhiteSpace([string]$p.name) -and -not [string]::IsNullOrWhiteSpace($resolved.Name)) {
        throw ("the element at that ref is named '{0}'; pass that name from the snapshot so the action can verify the ref is still current" -f $resolved.Name)
      }
      # UIA SetFocus is not real input: no keystrokes, no cursor move, and
      # Assert-BackgroundSetFocus verifies it did not change the OS
      # foreground. It fails cleanly when the provider refuses it.
      Assert-BackgroundSetFocus $el $hwnd
      $focused = $false
      try { $focused = [bool]$el.Current.HasKeyboardFocus } catch { $focused = $false }
      if (-not $focused) {
        throw "needs foreground: the element did not take background keyboard focus. The person must click into it, or use computer_focus on the whole window."
      }
      Start-Sleep -Milliseconds 100
      $bytes = [DesktopInput]::PrintWindowBytes($hwnd)
      $b = [DesktopInput]::Bounds($hwnd)
      $result = @{ png=[Convert]::ToBase64String($bytes); bounds=@{ x=$b[0]; y=$b[1]; width=$b[2]; height=$b[3] } }
    }
    'uia_invoke' {
      if (!$script:UiaReady) { throw "UI Automation is unavailable on this machine: $script:UiaError" }
      if (!$p.window -or !$p.element) { throw 'uia_invoke requires a window id and an element ref from computer_uia.' }
      $hwnd = [long]$p.window
      $resolved = [UiaWindow]::Resolve($hwnd, [string]$p.element, [string]$p.name)
      $el = $resolved.Element
      if ([string]::IsNullOrWhiteSpace([string]$p.name) -and -not [string]::IsNullOrWhiteSpace($resolved.Name)) {
        throw ("the element at that ref is named '{0}'; pass that name from the snapshot so the action can verify the ref is still current" -f $resolved.Name)
      }
      $invokePattern = $null
      try { $invokePattern = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern) -as [System.Windows.Automation.InvokePattern] } catch { $invokePattern = $null }
      if (-not $invokePattern) {
        $ct = 'unknown'
        try { $ct = ([string]$el.Current.ControlType.ProgrammaticName) -replace '^ControlType\.', '' } catch { $ct = 'unknown' }
        throw "needs foreground: the element at that ref ($ct) exposes no InvokePattern, so it cannot be activated in the background. Only real input can activate it; focus the window and use computer_act."
      }
      $script:InputAttempted = $true
      $invokePattern.Invoke()
      Start-Sleep -Milliseconds 300
      $bytes = [DesktopInput]::PrintWindowBytes($hwnd)
      $b = [DesktopInput]::Bounds($hwnd)
      $result = @{ png=[Convert]::ToBase64String($bytes); bounds=@{ x=$b[0]; y=$b[1]; width=$b[2]; height=$b[3] } }
    }
    'uia_key' {
      if (!$script:UiaReady) { throw "UI Automation is unavailable on this machine: $script:UiaError" }
      if (!$p.window -or !$p.keys) { throw 'uia_key requires a window id and one key.' }
      $keys = @($p.keys)
      if ($keys.Count -ne 1) { throw 'uia_key posts exactly one key. Modifier chords need the real keyboard; focus the window and use computer_key.' }
      $names=@{ ENTER=13; TAB=9; ESC=27; SPACE=32; BACKSPACE=8; DELETE=46; UP=38; DOWN=40; LEFT=37; RIGHT=39; HOME=36; END=35; PAGEUP=33; PAGEDOWN=34 }
      $k = [string]$keys[0]
      $vk = 0
      if ($names.ContainsKey($k)) { $vk = [int]$names[$k] }
      elseif ($k -match '^F([1-9]|1[0-2])$') { $vk = 111 + [int]$Matches[1] }
      elseif ($k -match '^[A-Z0-9]$') { $vk = [int][char]$k }
      else { throw "needs foreground: uia_key cannot post '$k': single non-modifier keys only (ENTER, TAB, ESC, SPACE, BACKSPACE, DELETE, arrows, HOME, END, PAGEUP, PAGEDOWN, A-Z, 0-9, F1-F12). Modifier chords need the real keyboard; focus the window and use computer_key." }
      $hwnd = [long]$p.window
      # Posted keys target the window's focused element: prefer that
      # element's own native window handle over the top-level parent.
      $target = [UiaWindow]::FocusedHandle($hwnd, 8000)
      if ($target -eq 0) { $target = $hwnd }
      $script:InputAttempted = $true
      [DesktopInput]::PostKey($target, [uint16]$vk)
      Start-Sleep -Milliseconds 250
      $bytes = [DesktopInput]::PrintWindowBytes($hwnd)
      $b = [DesktopInput]::Bounds($hwnd)
      $result = @{ png=[Convert]::ToBase64String($bytes); bounds=@{ x=$b[0]; y=$b[1]; width=$b[2]; height=$b[3] }; postedTo=$target }
    }
    'act' {
      if ($p.window -and $p.action -ne 'focus') {
        [DesktopInput]::Focus([long]$p.window)
        if ($p.windowBounds) {
          $b=[DesktopInput]::Bounds([long]$p.window)
          if ($b[0] -ne [int]$p.windowBounds.x -or $b[1] -ne [int]$p.windowBounds.y -or $b[2] -ne [int]$p.windowBounds.width -or $b[3] -ne [int]$p.windowBounds.height) { throw 'Window moved or resized while it was being focused. No mouse input was sent; capture that window again.' }
        }
      }
      $mouseAction = $p.action -in @('move','click','double_click','right_click','drag','scroll')
      if ($mouseAction) {
        if (![DesktopInput]::SetCursorPos([int]$p.x, [int]$p.y)) { throw 'Cursor movement refused.' }
        Assert-TargetWindow $p $false
      }
      switch ($p.action) {
        'move' {}
        'click' { [DesktopInput]::Mouse(2,0); [DesktopInput]::Mouse(4,0) }
        'right_click' { [DesktopInput]::Mouse(8,0); [DesktopInput]::Mouse(16,0) }
        'double_click' { 1..2 | ForEach-Object { [DesktopInput]::Mouse(2,0); [DesktopInput]::Mouse(4,0); Start-Sleep -Milliseconds 80 } }
        'drag' { try { [DesktopInput]::Mouse(2,0); Start-Sleep -Milliseconds 80; [void][DesktopInput]::SetCursorPos([int]$p.toX,[int]$p.toY); Start-Sleep -Milliseconds 80 } finally { [DesktopInput]::Mouse(4,0) } }
        'scroll' { $flags=2048; $sign=1; if ($p.direction -in @('left','right')) { $flags=4096 }; if ($p.direction -in @('down','left')) { $sign=-1 }; [DesktopInput]::Mouse($flags, 120*[int]$p.amount*$sign) }
        'type' {
          if (!$p.window) { throw 'Targeted typing requires a window id. Use computer_type.' }
          [DesktopInput]::Type([string]$p.text)
          Start-Sleep -Milliseconds 100
          if ([DesktopInput]::Foreground() -ne [long]$p.window) { throw 'The active window changed while typing. Input may be incomplete; inspect before continuing.' }
        }
        'focus' { [DesktopInput]::Focus([long]$p.window) }
        'key' {
          if (!$p.window) { throw 'Targeted keys require a window id. Use computer_key.' }
          $names=@{ CTRL=17; ALT=18; SHIFT=16; META=91; ENTER=13; TAB=9; ESC=27; BACKSPACE=8; DELETE=46; SPACE=32; UP=38; DOWN=40; LEFT=37; RIGHT=39; HOME=36; END=35; PAGEUP=33; PAGEDOWN=34 }
          $held = New-Object 'System.Collections.Generic.List[UInt16]'
          try {
            foreach ($k in $p.keys) {
              if ($names.ContainsKey($k)) { $vk=$names[$k] } elseif ($k -match '^F(\d+)$') { $vk=111+[int]$Matches[1] } elseif ($k -match '^[A-Z0-9]$') { $vk=[int][char]$k } else { throw 'Invalid key.' }
              [DesktopInput]::Key([uint16]$vk,$false); $held.Add([uint16]$vk)
            }
          } finally { for ($i=$held.Count-1; $i -ge 0; $i--) { [DesktopInput]::Key($held[$i],$true) } }
          Start-Sleep -Milliseconds 100
          if ([DesktopInput]::Foreground() -ne [long]$p.window) { throw 'The active window changed after the key chord. Input may have run; inspect the current desktop before continuing.' }
        }
        default { throw 'Unknown action.' }
      }
      if ($mouseAction -and $p.action -ne 'move') { Start-Sleep -Milliseconds 100; Assert-TargetWindow $p $true }
    }
    default { throw 'Unknown operation.' }
  }
  $result | ConvertTo-Json -Depth 8 -Compress
} catch {
  @{ error=$_.Exception.Message; inputAttempted=([bool]$script:InputAttempted) } | ConvertTo-Json -Compress
  exit 1
}
