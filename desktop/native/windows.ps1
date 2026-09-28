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

  // --- Background window control: never RAISE a window, never SendInput,
  // --- never SetCursorPos. PrintWindow + posted messages + UIA only. (The
  // --- one sanctioned exception: RestoreForeground puts the person's own
  // --- foreground window BACK after a provider raised it on a background
  // --- action — restoring is the opposite of raising.)
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
  public static bool IsMinimized(long id) { return IsIconic(new IntPtr(id)); }
  public static bool SameProcess(long a, long b) {
    uint pa, pb;
    GetWindowThreadProcessId(new IntPtr(a), out pa);
    GetWindowThreadProcessId(new IntPtr(b), out pb);
    return pa != 0 && pa == pb;
  }
  // --- Foreground restore + human-activity idle guard -----------------------
  // Verified live (0.3.9, instrumented run): Chromium apps RAISE their window
  // on background UIA actions (SetValue on the composer, Invoke on Send),
  // stealing the person's foreground over whatever they were working in. The
  // Windows foreground lock normally denies a background process the right to
  // set the foreground window; attaching our thread's input queue to the
  // foreground thread's queue grants exactly that right for the duration of
  // the attach, which is the classic recipe for putting a window back.
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
  /** True while the person is physically holding any key or mouse button.
   *  AttachThreadInput merges key state across the attached queues, so
   *  attaching while they hold ANY key could drop or misread it, not just
   *  modifiers: scan the full relevant virtual-key range (mouse buttons,
   *  navigation/edit keys, digits, letters, Win keys, numpad, F-keys, OEM
   *  punctuation). The high bit is the physically-down state; toggle-key
   *  lock states live in the low bit and are ignored. */
  static bool AnyPhysicalKeyDown() {
    Func<int, bool> down = vk => (GetAsyncKeyState(vk) & 0x8000) != 0;
    for (int vk = 0x01; vk <= 0x06; vk++) if (down(vk)) return true;   // mouse buttons
    for (int vk = 0x08; vk <= 0x12; vk++) if (down(vk)) return true;   // backspace/tab/enter/caps/shift/ctrl/alt
    for (int vk = 0x14; vk <= 0x28; vk++) if (down(vk)) return true;  // caps/esc/space..pgdn + arrows
    for (int vk = 0x30; vk <= 0x39; vk++) if (down(vk)) return true;  // digits
    for (int vk = 0x41; vk <= 0x5A; vk++) if (down(vk)) return true;  // letters
    for (int vk = 0x5B; vk <= 0x5C; vk++) if (down(vk)) return true;  // LWIN/RWIN
    for (int vk = 0x60; vk <= 0x87; vk++) if (down(vk)) return true;  // numpad + F1-F12
    for (int vk = 0xBA; vk <= 0xC2; vk++) if (down(vk)) return true; // OEM punctuation ; = ,
    for (int vk = 0xDB; vk <= 0xE2; vk++) if (down(vk)) return true; // OEM brackets/backslash/quote/102
    return false;
  }
  /** Milliseconds since the last input event anywhere on this desktop
   *  (keyboard or mouse, any process — the screensaver idle API). -1 when
   *  unavailable, in which case the activity guard fails open. */
  public static long LastInputMs() {
    var lii = new LASTINPUTINFO(); lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    if (!GetLastInputInfo(ref lii)) return -1;
    // Tick counts wrap every 49.7 days; unchecked uint subtraction still works.
    return (long)unchecked((uint)System.Environment.TickCount - lii.dwTime);
  }
  /** Put the person's previous foreground window back after a provider raised
   *  raisedTarget on a background action. True when the final foreground is
   *  acceptable: the previous window again, or any window the person took
   *  over themselves (aborting the restore when they moved off the raised
   *  target mid-restore — restoring on top of THEIR switch would be a new
   *  steal). False when the raised window still holds the foreground. */
  public static string LastRestoreDetail = "";
  public static string LastRestoreOutcome = "";
  public static bool RestoreForeground(long prev, long raisedTarget) {
    // Detail carries every attempt's attach results, SetForegroundWindow
    // return and settled foreground handle; Outcome is one of restored /
    // personMoved / holdingKey / noForeground / noPrev / osDenied /
    // appReAsserted / exception. A restore that fails on a real machine
    // (the 18:13 live round was unattributable) is diagnosable from the op
    // result alone instead of live guessing.
    LastRestoreDetail = ""; LastRestoreOutcome = "";
    try {
      var prevH = new IntPtr(prev);
      if (prevH == IntPtr.Zero) { LastRestoreOutcome = "noPrev"; return false; }
      bool everSwitched = false;
      // Up to three bounded attempts: Chromium surfaces that activate on
      // background actions (a palette opening, a focused composer) often
      // assert their window again within ~100ms of losing the foreground,
      // and the OS foreground lock can briefly deny a switch right after a
      // raise; a short gap and a retry outlasts both.
      for (int attempt = 1; attempt <= 3; attempt++) {
        var now = GetForegroundWindow();
        if (now == prevH) { LastRestoreOutcome = "restored"; return true; } // already back (a race we accept)
        // The person took the foreground off the raised target themselves:
        // leave their choice alone (restoring would steal from THEM).
        if (now != IntPtr.Zero && now.ToInt64() != raisedTarget && !SameProcess(now.ToInt64(), raisedTarget)) { LastRestoreOutcome = "personMoved"; return true; }
        if (now == IntPtr.Zero) { LastRestoreOutcome = "noForeground"; return false; }
        if (AnyPhysicalKeyDown()) { LastRestoreOutcome = "holdingKey"; return false; } // never break a live chord mid-restore
        uint nowPid; var nowThread = GetWindowThreadProcessId(now, out nowPid);
        uint prevPid; var prevThread = GetWindowThreadProcessId(prevH, out prevPid);
        var ourThread = GetCurrentThreadId();
        bool nowAttached = false, prevAttached = false;
        try {
          if (nowThread != 0 && nowThread != ourThread) nowAttached = AttachThreadInput(ourThread, nowThread, true);
          if (prevThread != 0 && prevThread != ourThread) prevAttached = AttachThreadInput(ourThread, prevThread, true);
          LastRestoreDetail += "attempt " + attempt + ": attachNow=" + (nowAttached ? 1 : 0) + " attachPrev=" + (prevAttached ? 1 : 0);
          // Abort if the person moved the foreground between the snapshot above
          // and the attach: same rule as the pre-attach check.
          var latest = GetForegroundWindow();
          if (latest != IntPtr.Zero && latest != now && latest.ToInt64() != raisedTarget && !SameProcess(latest.ToInt64(), raisedTarget)) { LastRestoreDetail += " personMovedDuringAttach"; LastRestoreOutcome = "personMoved"; return true; }
          var switched = SetForegroundWindow(prevH);
          if (switched) everSwitched = true;
          LastRestoreDetail += " setFg=" + (switched ? 1 : 0) + ";";
        } finally {
          if (prevAttached) AttachThreadInput(ourThread, prevThread, false);
          if (nowAttached) AttachThreadInput(ourThread, nowThread, false);
        }
        System.Threading.Thread.Sleep(80); // focus changes settle asynchronously
        var settled = GetForegroundWindow();
        if (settled == prevH) { LastRestoreDetail += " settled=prev;"; LastRestoreOutcome = "restored"; return true; }
        LastRestoreDetail += " settled=" + settled.ToInt64() + ";";
        if (settled != IntPtr.Zero && settled.ToInt64() != raisedTarget && !SameProcess(settled.ToInt64(), raisedTarget)) { LastRestoreOutcome = "personMoved"; return true; }
        if (attempt < 3) System.Threading.Thread.Sleep(60);
      }
      // The two honest failures: the OS refused every switch (the foreground
      // lock; nothing ever moved), or the app re-asserted its window after a
      // switch that did land. Three is the cap: a longer raise war only adds
      // flashes over the person's work, so the honest end is the loud warning
      // plus this evidence.
      LastRestoreOutcome = everSwitched ? "appReAsserted" : "osDenied";
      return false;
    } catch (Exception e) { LastRestoreDetail += " exception=" + e.Message; LastRestoreOutcome = "exception"; return false; }
  }
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumProc callback, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int count);
  /** Chromium takes keyboard messages on its Chrome_RenderWidgetHostHWND
   *  child, not on the top-level window: posted keys aimed at a focused
   *  element with no HWND of its own must hop through that child. Verified
   *  live: ENTER posted to the top-level HWND of the Claude app did nothing
   *  while the composer held keyboard focus. A window can hold several such
   *  children (webviews, popups, DevTools); prefer visible ones and take the
   *  largest by area, which is the main content surface. The heuristic is
   *  honest: the verification capture shows whether the key landed. */
  public static long ChromiumInputChild(long id) {
    long best = 0; long bestArea = 0;
    EnumChildWindows(new IntPtr(id), (h, p) => {
      var s = new StringBuilder(256);
      if (GetClassName(h, s, 256) > 0 && s.ToString() == "Chrome_RenderWidgetHostHWND") {
        RECT r;
        if (IsWindowVisible(h) && GetWindowRect(h, out r)) {
          long area = (long)(r.right - r.left) * (r.bottom - r.top);
          if (area > bestArea) { bestArea = area; best = h.ToInt64(); }
        }
      }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
'@
[DesktopInput]::EnableDpi()
Add-Type -AssemblyName System.Windows.Forms

# Background window control uses UI Automation. Optional at runtime: if this
# compile ever fails on a machine, only the uia ops refuse; every other op keeps
# working. No op below may SetForegroundWindow, SendInput or SetCursorPos.
$script:InputAttempted = $false
$script:OpForegroundBefore = 0
$script:OpStolenAtInput = $false
$script:OpRestoredAtInput = $false
$script:OpPersonTookOver = $false
# Background ops never inject user input (UIA and posted messages do not
# register with GetLastInputInfo), so any input event younger than this
# process is the PERSON's: a foreground change then is their switch, even onto
# another window of the target's process (Chromium apps host several), and
# restoring over it would be stealing from THEM.
$script:StartedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$script:UiaReady = $false
$script:UiaError = ''
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  # Add-Type's compiler cannot resolve the UIA assemblies by simple name:
  # they live in the WPF subdirectory of the .NET runtime directory, not at
  # the framework root (System.Drawing resolves only because it sits at the
  # root). Pass the full paths instead, or every uia op refuses with a
  # "Metadata file 'UIAutomationClient.dll' could not be found" compile
  # error, as it did on the first 0.3.6 run. WindowsBase supplies the
  # System.Windows.Rect that BoundingRectangle (and every bounds row) needs.
  $rt = [System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
  $uiaRefs = @(
    (Join-Path $rt 'WPF\UIAutomationClient.dll'),
    (Join-Path $rt 'WPF\UIAutomationTypes.dll'),
    (Join-Path $rt 'WPF\WindowsBase.dll'),
    (Join-Path $rt 'System.dll')
  )
  $missing = @($uiaRefs | Where-Object { -not (Test-Path -LiteralPath $_) })
  if ($missing.Count -gt 0) {
    throw "UI Automation assemblies not found: $($missing -join ', ')."
  }
  Add-Type -ReferencedAssemblies $uiaRefs -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Windows.Automation;
public static class UiaWindow {
  // Named row/bounds classes instead of anonymous types. Windows PowerShell
  // compiles every Add-Type -TypeDefinition into its own assembly, and the C#
  // compiler numbers anonymous types per compilation, so the second block's
  // 4-member bounds shape collides on load with the first block's identical
  // shape: "Cannot add type. The type name '<>f__AnonymousType0`4' already
  // exists." DesktopInput above owns that shape; UiaWindow names its own.
  public class UiaBounds { public int x { get; set; } public int y { get; set; } public int width { get; set; } public int height { get; set; } }
  public class UiaRow {
    public string path { get; set; }
    public string name { get; set; }
    public string controlType { get; set; }
    public string automationId { get; set; }
    public string[] patterns { get; set; }
    public bool focusable { get; set; }
    public bool focused { get; set; }
    public UiaBounds bounds { get; set; }
  }
  public class UiaSnapshot { public UiaRow[] elements { get; set; } public bool truncated { get; set; } public int pruned { get; set; } }
  public class UiaResolved { public string Name { get; set; } public AutomationElement Element { get; set; } }
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
  static bool HasActionablePattern(string[] pats) {
    foreach (var p in pats) {
      if (p == "value" || p == "invoke" || p == "toggle" || p == "expand" || p == "select") return true;
    }
    return false;
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
  static UiaRow Row(AutomationElement el, string path, System.Windows.Rect windowRect, bool focusMode) {
    var cur = el.Current;
    string name = Trim(cur.Name, 140);
    string ct = cur.ControlType == null ? "" : cur.ControlType.ProgrammaticName;
    if (ct.StartsWith("ControlType.")) ct = ct.Substring("ControlType.".Length);
    string[] pats = PatternNames(el);
    bool focusable = cur.IsKeyboardFocusable, focused = cur.HasKeyboardFocus;
    // Only actionable patterns count as interactive: static Chromium text can
    // expose Text or Scroll patterns, which would still crowd the budget.
    if (focusMode && !HasActionablePattern(pats) && !focusable && !focused) return null; // plain text row
    if (name.Length == 0 && pats.Length == 0 && !focusable && !focused) return null; // silent layout node
    var rect = cur.BoundingRectangle;
    // Scrolled-away rows sit far outside the window rect (measured y around
    // -16115 on a real chat window): their bounds are not actionable and they
    // crowd the element budget so the composer and buttons never appear in
    // the snapshot. Skip rows entirely outside the window; their raw index
    // path stays addressable, and uia reads work while minimized anyway.
    if (!windowRect.IsEmpty && !rect.IsEmpty
      && (rect.X + rect.Width <= windowRect.X || rect.X >= windowRect.X + windowRect.Width
       || rect.Y + rect.Height <= windowRect.Y || rect.Y >= windowRect.Y + windowRect.Height)) return null;
    UiaBounds bounds = null;
    if (!rect.IsEmpty) bounds = new UiaBounds {
      x = (int)Math.Round(rect.X), y = (int)Math.Round(rect.Y),
      width = (int)Math.Round(rect.Width), height = (int)Math.Round(rect.Height),
    };
    return new UiaRow {
      path = path, name = name, controlType = ct, automationId = Trim(cur.AutomationId, 80),
      patterns = pats, focusable = focusable, focused = focused, bounds = bounds,
    };
  }
  public static object Snapshot(long hwnd, int maxElements, int maxDepth, int budgetMs, bool focusMode, bool skipRectFilter) {
    var root = Root(hwnd);
    var windowRect = new System.Windows.Rect();
    // A minimized window reports sentinel or empty coordinates, which would
    // silently discard every useful row; reads while minimized stay unfiltered.
    if (!skipRectFilter) { try { windowRect = root.Current.BoundingRectangle; } catch { } }
    var rows = new List<UiaRow>();
    var state = new WalkState();
    var sw = System.Diagnostics.Stopwatch.StartNew();
    Walk(root, "0", 0, maxElements, maxDepth, budgetMs, sw, rows, state, windowRect, focusMode);
    bool truncated = rows.Count >= maxElements || sw.ElapsedMilliseconds > budgetMs || state.DepthHit;
    return new UiaSnapshot { elements = rows.ToArray(), truncated = truncated, pruned = state.Pruned };
  }
  class WalkState { public bool DepthHit; public int Pruned; }
  static void Walk(AutomationElement el, string path, int depth, int maxElements, int maxDepth, int budgetMs, System.Diagnostics.Stopwatch sw, List<UiaRow> rows, WalkState state, System.Windows.Rect windowRect, bool focusMode) {
    if (depth >= maxDepth) {
      // A depth-capped tree must not read as complete just because the
      // element budget was not reached.
      if (sw.ElapsedMilliseconds <= budgetMs) { try { if (Walker.GetFirstChild(el) != null) state.DepthHit = true; } catch { } }
      return;
    }
    if (rows.Count >= maxElements || sw.ElapsedMilliseconds > budgetMs) return;
    AutomationElement child;
    try { child = Walker.GetFirstChild(el); } catch { return; }
    int index = 0;
    while (child != null) {
      if (rows.Count >= maxElements || sw.ElapsedMilliseconds > budgetMs) return;
      var current = child;
      string nextPath = path + "/" + index;
      try { var row = Row(current, nextPath, windowRect, focusMode); if (row != null) rows.Add(row); } catch { }
      // Prune subtrees entirely outside the window rect: a positioned element
      // fully off-screen carries only off-screen descendants, and walking
      // every scrolled-away message can burn the whole time budget before the
      // composer ever appears. Nodes with no geometry stay traversed.
      bool prune = false;
      try {
        var childRect = current.Current.BoundingRectangle;
        prune = !windowRect.IsEmpty && !childRect.IsEmpty
          && (childRect.X + childRect.Width <= windowRect.X || childRect.X >= windowRect.X + windowRect.Width
           || childRect.Y + childRect.Height <= windowRect.Y || childRect.Y >= windowRect.Y + windowRect.Height);
        if (prune) state.Pruned++;
      } catch { }
      if (!prune) Walk(current, nextPath, depth + 1, maxElements, maxDepth, budgetMs, sw, rows, state, windowRect, focusMode);
      try { child = Walker.GetNextSibling(current); } catch { return; }
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
    return new UiaResolved { Name = name, Element = el };
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
    try { child = Walker.GetFirstChild(el); } catch { return null; }
    while (child != null) {
      var hit = FindFocused(child, sw, budgetMs);
      if (hit != null) return hit;
      var current = child;
      try { child = Walker.GetNextSibling(current); } catch { return null; }
    }
    return null;
  }
  static AutomationElement Nth(AutomationElement parent, int index) {
    try {
      var child = Walker.GetFirstChild(parent);
      int i = 0;
      while (child != null) {
        if (i == index) return child;
        var current = child;
        try { child = Walker.GetNextSibling(current); } catch { return null; }
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
  # Reaching this element can take seconds of walking; the person may have
  # resumed typing during it, so the idle guard re-checks right before the
  # irreversible SetFocus (the top-of-op check is fail-fast, not final).
  Assert-PersonIdleForBackgroundInput
  try { $element.SetFocus() } catch {
    throw "needs foreground: the element refused background keyboard focus ($($_.Exception.Message)). Real input is required to focus it."
  }
  # Sample immediately (a provider that activates persists through at least
  # one pump cycle) and again after the settle: either mismatch refuses.
  $rightAfter = [DesktopInput]::Foreground()
  Start-Sleep -Milliseconds 200
  $after = [DesktopInput]::Foreground()
  if ($rightAfter -ne $before -or $after -ne $before) {
    # A provider that activates on SetFocus raised the window: try to put the
    # person's foreground back before refusing (a refusal that leaves the
    # raise standing defeats the whole point of background control), and
    # record the evidence so the error response reports it.
    $script:OpForegroundBefore = $before
    if (Test-ForegroundRaisedTarget $before $hwnd) {
      Restore-IfStolen $before $hwnd
      $restored = if ($script:OpRestoredAtInput) { 'their foreground window was restored.' } else { 'the raise could NOT be restored: tell the person to click back into their work.' }
      throw "needs foreground: the OS foreground changed while giving the element background focus (the app activated its window; $restored) Stop; do not retry this element, verify what is focused now, and prefer real input for it."
    }
    throw 'needs foreground: the OS foreground changed while giving the element background focus (the person switched apps in that instant). Stop; do not retry this element, verify what is focused now, and prefer real input for it.'
  }
}

# Verified live (0.3.9, instrumented): Chromium apps raise their window on
# background UIA actions (SetValue on the composer, Invoke on Send) even
# while the person works in another window. The steal is instantaneous, so
# the restore must be too: this runs IMMEDIATELY after each background input,
# before the settle sleep and the verification capture, putting the person's
# foreground window back so the steal lasts milliseconds, not the whole op
# tail. Flags carry into Add-ForegroundEvidence and the error path.
function Restore-IfStolen([long]$Before, [long]$Target) {
  if (-not (Test-ForegroundRaisedTarget $Before $Target)) { return }
  # Person input during this op (any input event newer than the op's start,
  # plus clock-skew slack — background ops never inject user input, so every
  # such event is the person's): the foreground change is their switch, and
  # this is the only path onto a same-process sibling window that is NOT our
  # raise. Their choice stands; report it as a change, never a steal.
  $elapsed = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $script:StartedAt
  if ([DesktopInput]::LastInputMs() -lt ($elapsed + 1500)) {
    $script:OpPersonTookOver = $true
    return
  }
  $script:OpStolenAtInput = $true
  $ok = [DesktopInput]::RestoreForeground($Before, $Target)
  $priorDetail = [string][DesktopInput]::LastRestoreDetail
  $reAsserted = $false
  if ($ok) {
    Start-Sleep -Milliseconds 120
    # A late re-assert (the app activates its window again once the restore
    # settles, e.g. a palette taking focus) lands exactly here, after the
    # in-call retries: one more bounded pass closes the common case.
    if (([DesktopInput]::Foreground() -ne $Before) -and (Test-ForegroundRaisedTarget $Before $Target)) {
      $reAsserted = $true
      $ok = [DesktopInput]::RestoreForeground($Before, $Target)
      if ($ok) { Start-Sleep -Milliseconds 120 }
    }
    # Acceptable outcomes: the person's window is back, or THEY moved the
    # foreground off the raised target themselves (RestoreForeground aborts
    # on that rather than stealing from them again).
    if (([DesktopInput]::Foreground() -eq $Before) -or (-not (Test-ForegroundRaisedTarget $Before $Target))) { $script:OpRestoredAtInput = $true }
  }
  # Evidence comes from the LAST call, but a second pass resets the C#
  # fields: when it only ran because the app re-asserted a restore that DID
  # land, "restored, re-asserted, denied again" is appReAsserted, never plain
  # osDenied, and the first pass's evidence must survive.
  $lastOutcome = [string][DesktopInput]::LastRestoreOutcome
  $lastDetail = [string][DesktopInput]::LastRestoreDetail
  if ($reAsserted -and $lastOutcome -eq 'osDenied') {
    $lastOutcome = 'appReAsserted'
    $lastDetail = $priorDetail + ' then re-asserted; second pass: ' + $lastDetail
  }
  $script:OpRestoreOutcome = $lastOutcome
  $script:OpRestoreDetail = $lastDetail
}

# The loud-path twin of the safe notes: the op raised the person's foreground
# and the restore could not hold it. The outcome says WHY (Windows denied
# every switch outright vs the app re-asserting its window after a switch
# that landed), and the detail string carries every attempt's evidence so
# a failed restore on a real machine is diagnosable from the op result
# alone. foregroundRestored is set false explicitly: its absence at 18:13
# left the failure state ambiguous.
function Add-RestoreFailureEvidence([hashtable]$Result, [long]$Before) {
  $Result.foregroundRestored = $false
  $Result.foregroundRestoreOutcome = [string]$script:OpRestoreOutcome
  $Result.foregroundRestoreDetail = [string]$script:OpRestoreDetail
  if ($script:OpRestoreOutcome -eq 'osDenied') {
    $Result.warning = "This op raised the target window over the person's work and Windows DENIED every restore attempt (the foreground lock; no switch ever landed: $($script:OpRestoreDetail)). Tell the person to click back into their work and report which op did this: background use of it is unsafe until fixed."
  } elseif ($script:OpRestoreOutcome -eq 'appReAsserted') {
    $Result.warning = "This op raised the target window over the person's work; restores did switch back but the app re-asserted its window after each (raise war stopped at the retry cap: $($script:OpRestoreDetail)). Tell the person to click back into their work and report which op did this: background use of it is unsafe until fixed."
  } else {
    $Result.warning = "This op raised the target window (or another window of its app) over the person's work and could NOT restore it (foreground went from $Before to $($Result.foregroundAfter); restore outcome: $($script:OpRestoreOutcome), $($script:OpRestoreDetail)). Tell the person to click back into their work, and report which op did this: background use of it is unsafe until fixed."
  }
}

# Every background op records the OS foreground before and after it ran: the
# whole point of background control is never raising a window over the
# person's work, and a live round proved some providers (Chromium) do it on
# background actions. When the op raised the window, the adapter restores the
# person's foreground immediately (Restore-IfStolen above) and the evidence
# says whether the restore held. A restore that could not be verified is the
# loud warning case: the agent must tell the person and avoid the raising op.
function Add-ForegroundEvidence([hashtable]$Result, [long]$Before, [long]$Target) {
  $Result.foregroundBefore = $Before
  $Result.foregroundAfter = [DesktopInput]::Foreground()
  if ($script:OpPersonTookOver) {
    # The person input during this op and the foreground moved onto the
    # target's process: their own switch (Chromium apps host several
    # top-level windows per process), not our raise. Their choice stands.
    $Result.foregroundChanged = $true
    $Result.note = "The person switched windows during this op (their input landed during it), including possibly onto another window of the target app. Their foreground choice stands; nothing was restored. Capture before the next op to see the current state."
    return
  }
  if ($script:OpStolenAtInput) {
    $Result.foregroundStolen = $true
    if ($script:OpRestoredAtInput) {
      # The app can raise the target AGAIN after the restore (during the settle
      # sleep or the verification capture): only report the safe note when the
      # final foreground is back on the person's window or off the target app
      # entirely (their own switch); a re-raised target gets one more restore
      # attempt and then the loud warning.
      if (($Result.foregroundAfter -eq $Before) -or (-not (Test-ForegroundRaisedTarget $Before $Target))) {
        $Result.foregroundRestored = $true
        $Result.note = "This op raised the target window over the person's work (the app activates on background actions) and immediately restored their foreground window. Safe to continue; the person may notice a brief flash."
        if ($Result.foregroundAfter -ne $Before) {
          # Not back on the target app: the person switched after the restore.
          $Result.foregroundChanged = $true
          $Result.note += " The foreground moved again after the restore, not to the target app: most likely the person switched apps during the op."
        }
        return
      }
      if ([DesktopInput]::RestoreForeground($Before, $Target)) {
        Start-Sleep -Milliseconds 120
        $Result.foregroundAfter = [DesktopInput]::Foreground()
      }
      $script:OpRestoreOutcome = [string][DesktopInput]::LastRestoreOutcome
      $script:OpRestoreDetail = [string][DesktopInput]::LastRestoreDetail
      # This branch only runs after a VERIFIED restore got re-stolen, so a
      # denied second pass is still the app re-asserting, never plain osDenied.
      if ($script:OpRestoreOutcome -eq 'osDenied') { $script:OpRestoreOutcome = 'appReAsserted' }
      if (($Result.foregroundAfter -eq $Before) -or (-not (Test-ForegroundRaisedTarget $Before $Target))) {
        $Result.foregroundRestored = $true
        $Result.note = "This op raised the target window over the person's work, the adapter restored their foreground, and the app raised it once more before being restored again. Safe to continue; the person may notice a brief flash."
      } else {
        Add-RestoreFailureEvidence $Result $Before
      }
      return
    }
    if ($Result.foregroundAfter -eq $Before) {
      # The restore did not verify at restore time, but the person's foreground
      # window is back by evidence time (they clicked back, or a late settle).
      # Report the honest final state.
      $Result.foregroundRestored = $true
      $Result.note = "This op raised the target window over the person's work; the immediate restore did not verify, but their foreground window is back by the end of the op. Safe to continue."
      return
    }
    Add-RestoreFailureEvidence $Result $Before
    return
  }
  if ($Result.foregroundAfter -ne $Before) {
    if ($Result.foregroundAfter -eq $Target -or [DesktopInput]::SameProcess($Result.foregroundAfter, $Target)) {
      # A LATE raise (the provider activated after the immediate check, e.g.
      # during the settle sleep): still try the restore before reporting.
      # Accept the same outcomes as the immediate branch: the person's window
      # back, or the person having moved the foreground off the target app
      # themselves (RestoreForeground aborts on that instead of stealing from
      # them again).
      $Result.foregroundStolen = $true
      if ([DesktopInput]::RestoreForeground($Before, $Target)) {
        Start-Sleep -Milliseconds 120
        $Result.foregroundAfter = [DesktopInput]::Foreground()
      }
      $script:OpRestoreOutcome = [string][DesktopInput]::LastRestoreOutcome
      $script:OpRestoreDetail = [string][DesktopInput]::LastRestoreDetail
      # Same rule as the verified branch: a switch already landed here, so a
      # denied second pass is still the app re-asserting, never plain osDenied.
      if ($script:OpRestoreOutcome -eq 'osDenied') { $script:OpRestoreOutcome = 'appReAsserted' }
      if (($Result.foregroundAfter -eq $Before) -or (-not (Test-ForegroundRaisedTarget $Before $Target))) {
        $Result.foregroundRestored = $true
        if ($Result.foregroundAfter -ne $Before) {
          $Result.foregroundChanged = $true
          $Result.note = "This op raised the target window late (after its input); the person moved their foreground off it themselves. Safe to continue."
        } else {
          $Result.note = "This op raised the target window late (after its input) and the adapter restored the person's foreground window. Safe to continue; the person may notice a brief flash."
        }
      } else {
        Add-RestoreFailureEvidence $Result $Before
      }
    } else {
      # A switch to an unrelated window is most likely the person alt-tabbing
      # during the op, not this op raising anything.
      $Result.foregroundChanged = $true
      $Result.note = "The OS foreground changed during the op (from $Before to $($Result.foregroundAfter)), but not to the target app: most likely the person switched apps. Capture before the next op to see the current state."
    }
  }
}

# True when the OS foreground moved onto the target window or another window
# of the same process (a raise our op caused). A move to an unrelated window
# is most likely the person switching apps mid-op, which background ops are
# built to tolerate, so it returns false and work proceeds.
function Test-ForegroundRaisedTarget([long]$Before, [long]$Target) {
  $after = [DesktopInput]::Foreground()
  if ($after -eq $Before) { return $false }
  if ($after -eq $Target) { return $true }
  return [DesktopInput]::SameProcess($after, $Target)
}

# Background INPUT ops (uia_value, uia_focus, uia_invoke, uia_key) can raise
# the target app's window over the person's work (Chromium activates on
# background UIA actions, verified live on the Claude app), and while the
# person is actively using the desktop even a millisecond flash can swallow
# a keystroke mid-typing. Until the restore is proven to hold on a live
# app, every background input op refuses while the person had input within
# the last 60s, exactly like the foreground tools. Read-only ops (uia
# snapshot, window_capture) stay open: verified live never to raise.
# Background ops never inject input, so unlike the act path there is no
# TARDIS-own-input case to discriminate here. Fails open when the idle
# query itself is unavailable.
function Assert-PersonIdleForBackgroundInput {
  $idleMs = [DesktopInput]::LastInputMs()
  if ($idleMs -ge 0 -and $idleMs -lt 60000) {
    $idleSecs = [int][math]::Floor($idleMs / 1000)
    throw "needs foreground: the person used this desktop ${idleSecs}s ago (within the 60s activity guard). Background input can still raise the target app's window over their work (the restore is not yet proven to hold on a live app), so it refuses by design until the restore is verified. Read-only background ops (computer_uia, computer_window_capture) still work. Wait until the person has been idle for a minute, then retry (with a fresh operationId where the tool takes one)."
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
      $fg = [DesktopInput]::Foreground()
      $script:OpForegroundBefore = $fg
      $bytes = [DesktopInput]::PrintWindowBytes($hwnd)
      $b = [DesktopInput]::Bounds($hwnd)
      $result = @{ png=[Convert]::ToBase64String($bytes); bounds=@{ x=$b[0]; y=$b[1]; width=$b[2]; height=$b[3] }; process=[DesktopInput]::ProcessImage($hwnd) }
      Add-ForegroundEvidence $result $fg $hwnd
    }
    'uia' {
      if (!$script:UiaReady) { throw "UI Automation is unavailable on this machine: $script:UiaError" }
      if (!$p.window) { throw 'uia requires a window id.' }
      $hwnd = [long]$p.window
      $fg = [DesktopInput]::Foreground()
      $script:OpForegroundBefore = $fg
      # focus=interactive drops plain text rows, so the composer and buttons
      # fit the element budget even in text-heavy chat windows.
      $focusMode = ([string]$p.focus -eq 'interactive')
      # A minimized window reports sentinel coordinates, so keep its reads
      # unfiltered (actions already refuse up front on minimized windows).
      $skipRectFilter = [DesktopInput]::IsMinimized($hwnd)
      $snap = [UiaWindow]::Snapshot($hwnd, 300, 40, 8000, $focusMode, $skipRectFilter)
      # Chromium apps build their accessibility tree only when they notice a
      # UIA client, so the very first snapshot can come back sparse even
      # though the window is fine. Walk once more and keep the fuller result
      # (interactive-only trees are legitimately small, so no retry there).
      # Both walk budgets must fit the adapter's process timeout with room for
      # PowerShell startup, UIA init and serialization.
      if (-not $focusMode -and @($snap.elements).Count -lt 8 -and -not [bool]$snap.truncated) {
        Start-Sleep -Milliseconds 700
        $snap2 = [UiaWindow]::Snapshot($hwnd, 300, 40, 8000, $focusMode, $skipRectFilter)
        if (@($snap2.elements).Count -gt @($snap.elements).Count) { $snap = $snap2 }
      }
      $result = @{ process=[DesktopInput]::ProcessImage($hwnd); elements=@($snap.elements); truncated=[bool]$snap.truncated; focus=[bool]$focusMode; pruned=[int]$snap.pruned }
      Add-ForegroundEvidence $result $fg $hwnd
    }
    'uia_value' {
      if (!$script:UiaReady) { throw "UI Automation is unavailable on this machine: $script:UiaError" }
      if (!$p.window -or !$p.element) { throw 'uia_value requires a window id and an element ref from computer_uia.' }
      $hwnd = [long]$p.window
      if ([DesktopInput]::IsMinimized($hwnd)) { throw 'needs foreground: the window is minimized. Background actions are unreliable on a minimized window and cannot be visually verified (a live sidebar invoke did nothing). Have the person restore the window; covered is fine.' }
      Assert-PersonIdleForBackgroundInput
      $fg = [DesktopInput]::Foreground()
      $script:OpForegroundBefore = $fg
      $resolved = [UiaWindow]::Resolve($hwnd, [string]$p.element, [string]$p.name)
      $el = $resolved.Element
      if ([string]::IsNullOrWhiteSpace([string]$p.name) -and -not [string]::IsNullOrWhiteSpace($resolved.Name)) {
        throw ("the element at that ref is named '{0}'; pass that name from the snapshot so the action can verify the ref is still current" -f $resolved.Name)
      }
      if (Test-ForegroundRaisedTarget $fg $hwnd) {
        throw 'needs foreground: preparing this action raised a window (the OS foreground changed). No text was sent. Inspect the current desktop and report which step did this.'
      }
      $valuePattern = $null
      try { $valuePattern = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) -as [System.Windows.Automation.ValuePattern] } catch { $valuePattern = $null }
      # Writes go into EMPTY fields only. The Claude composer's SetValue
      # inserts at the caret rather than replacing, and the posted
      # END+backspace clear did not clear a leftover draft either (both
      # verified live on a real chat), so any readable non-empty field
      # refuses rather than corrupting a person's draft.
      $fieldText = ''
      if ($valuePattern) {
        try { $fieldText = [string]$valuePattern.Current.Value } catch { $fieldText = '' }
        if (-not [string]::IsNullOrWhiteSpace($fieldText)) {
          throw "needs foreground: the field already holds $($fieldText.Length) characters (a draft). Background text cannot replace it safely on this composer: SetValue inserts at the caret (verified live) and the posted clear did not clear it either. Use an empty field or composer, or have the person clear the draft."
        }
      }
      $postedTo = 0
      $post = [bool]$p.post
      $append = [bool]$p.append
      if (-not $post -and -not $append -and $valuePattern -and -not $valuePattern.Current.IsReadOnly) {
        if (Test-ForegroundRaisedTarget $fg $hwnd) {
          throw 'needs foreground: preparing this action raised a window (the OS foreground changed). No text was sent. Inspect the current desktop and report which step did this.'
        }
        Assert-PersonIdleForBackgroundInput
        $script:InputAttempted = $true
        $valuePattern.SetValue([string]$p.text)
        # Chromium activates its window on SetValue (verified live): restore
        # the person's foreground immediately, before the settle and capture.
        Restore-IfStolen $fg $hwnd
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
        # The empty-field contract is enforced before either path above, so
        # there is nothing to clear here: posted characters land at the caret
        # of an empty (or append-acknowledged, unreadable) field.
        # Post to the focused element's own native window handle when it has
        # one: classic Win32 controls never receive characters posted to their
        # top-level parent.
        $target = 0
        try { $target = [long]$el.Current.NativeWindowHandle } catch { $target = 0 }
        if ($target -eq 0) { $target = [DesktopInput]::ChromiumInputChild($hwnd) }
        if ($target -eq 0) { $target = $hwnd }
        $postedTo = $target
        if (Test-ForegroundRaisedTarget $fg $hwnd) {
          throw 'needs foreground: preparing this action raised a window (the OS foreground changed). No text was sent. Inspect the current desktop and report which step did this.'
        }
        Assert-PersonIdleForBackgroundInput
        $script:InputAttempted = $true
        [DesktopInput]::PostText($target, [string]$p.text)
        Restore-IfStolen $fg $hwnd
      }
      Start-Sleep -Milliseconds 250
      $bytes = [DesktopInput]::PrintWindowBytes($hwnd)
      $b = [DesktopInput]::Bounds($hwnd)
      $result = @{ png=[Convert]::ToBase64String($bytes); bounds=@{ x=$b[0]; y=$b[1]; width=$b[2]; height=$b[3] }; postedTo=$postedTo }
      Add-ForegroundEvidence $result $fg $hwnd
    }
    'uia_focus' {
      if (!$script:UiaReady) { throw "UI Automation is unavailable on this machine: $script:UiaError" }
      if (!$p.window -or !$p.element) { throw 'uia_focus requires a window id and an element ref from computer_uia.' }
      $hwnd = [long]$p.window
      Assert-PersonIdleForBackgroundInput
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
      if ([DesktopInput]::IsMinimized($hwnd)) { throw 'needs foreground: the window is minimized. Background actions are unreliable on a minimized window and cannot be visually verified (a live sidebar invoke did nothing). Have the person restore the window; covered is fine.' }
      Assert-PersonIdleForBackgroundInput
      $fg = [DesktopInput]::Foreground()
      $script:OpForegroundBefore = $fg
      $resolved = [UiaWindow]::Resolve($hwnd, [string]$p.element, [string]$p.name)
      $el = $resolved.Element
      if ([string]::IsNullOrWhiteSpace([string]$p.name) -and -not [string]::IsNullOrWhiteSpace($resolved.Name)) {
        throw ("the element at that ref is named '{0}'; pass that name from the snapshot so the action can verify the ref is still current" -f $resolved.Name)
      }
      if (Test-ForegroundRaisedTarget $fg $hwnd) {
        throw 'needs foreground: preparing this action raised a window (the OS foreground changed). No click was sent. Inspect the current desktop and report which step did this.'
      }
      $invokePattern = $null
      try { $invokePattern = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern) -as [System.Windows.Automation.InvokePattern] } catch { $invokePattern = $null }
      if (-not $invokePattern) {
        $ct = 'unknown'
        try { $ct = ([string]$el.Current.ControlType.ProgrammaticName) -replace '^ControlType\.', '' } catch { $ct = 'unknown' }
        throw "needs foreground: the element at that ref ($ct) exposes no InvokePattern, so it cannot be activated in the background. Only real input can activate it; focus the window and use computer_act."
      }
      if (Test-ForegroundRaisedTarget $fg $hwnd) {
        throw 'needs foreground: preparing this action raised a window (the OS foreground changed). No click was sent. Inspect the current desktop and report which step did this.'
      }
      Assert-PersonIdleForBackgroundInput
      $script:InputAttempted = $true
      $invokePattern.Invoke()
      # Invoke raises Chromium windows too (verified live on the Send
      # button): restore the person's foreground immediately.
      Restore-IfStolen $fg $hwnd
      Start-Sleep -Milliseconds 300
      $bytes = [DesktopInput]::PrintWindowBytes($hwnd)
      $b = [DesktopInput]::Bounds($hwnd)
      $result = @{ png=[Convert]::ToBase64String($bytes); bounds=@{ x=$b[0]; y=$b[1]; width=$b[2]; height=$b[3] } }
      Add-ForegroundEvidence $result $fg $hwnd
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
      if ([DesktopInput]::IsMinimized($hwnd)) { throw 'needs foreground: the window is minimized. Background actions are unreliable on a minimized window and cannot be visually verified. Have the person restore the window; covered is fine.' }
      Assert-PersonIdleForBackgroundInput
      $fg = [DesktopInput]::Foreground()
      $script:OpForegroundBefore = $fg
      # Posted keys target the window's focused element: prefer that
      # element's own native window handle, then Chromium's render-widget
      # child (Chromium ignores key messages posted to the top-level window),
      # then the top-level parent.
      $target = [UiaWindow]::FocusedHandle($hwnd, 8000)
      if ($target -eq 0) { $target = [DesktopInput]::ChromiumInputChild($hwnd) }
      if ($target -eq 0) { $target = $hwnd }
      if (Test-ForegroundRaisedTarget $fg $hwnd) {
        throw 'needs foreground: preparing this key raised a window (the OS foreground changed). No key was posted. Inspect the current desktop and report which step did this.'
      }
      Assert-PersonIdleForBackgroundInput
      $script:InputAttempted = $true
      [DesktopInput]::PostKey($target, [uint16]$vk)
      Restore-IfStolen $fg $hwnd
      Start-Sleep -Milliseconds 250
      $bytes = [DesktopInput]::PrintWindowBytes($hwnd)
      $b = [DesktopInput]::Bounds($hwnd)
      $result = @{ png=[Convert]::ToBase64String($bytes); bounds=@{ x=$b[0]; y=$b[1]; width=$b[2]; height=$b[3] }; postedTo=$target }
      Add-ForegroundEvidence $result $fg $hwnd
    }
    'act' {
      # The foreground tools (focus/type/key/act) raise the target window and
      # move the real cursor BY DESIGN. While the person is actively using
      # the desktop (input within the last 60s — the screensaver idle query),
      # that steals their foreground out from under them, which is the exact
      # complaint that started background control. Refuse while they work;
      # the background tools (uia_value into an empty field + uia_invoke) are
      # the path while the person is present. Allowed again once they are
      # idle; the guard fails open if the idle query itself is unavailable.
      $idleMs = [DesktopInput]::LastInputMs()
      # GetLastInputInfo counts TARDIS's own SendInput too, so a foreground
      # sequence (type -> Enter, multiple clicks) would refuse ITSELF
      # mid-sequence. The adapter passes agentInputAt (epoch ms when its own
      # last injecting op ended): a last-input event at-or-before that moment
      # is OURS, not the person's, and the guard treats the desktop as
      # person-idle. The 1500ms slack absorbs epoch-vs-tick clock skew.
      $agentAgeMs = -1
      if ($p.agentInputAt) {
        try { $agentAgeMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$p.agentInputAt } catch { $agentAgeMs = -1 }
      }
      $ours = ($agentAgeMs -ge 0) -and (($idleMs + 1500) -ge $agentAgeMs)
      if ($idleMs -ge 0 -and $idleMs -lt 60000 -and -not $ours) {
        $idleSecs = [int][math]::Floor($idleMs / 1000)
        throw "needs foreground: the person used this desktop ${idleSecs}s ago (within the 60s activity guard). The foreground tools (including a window-scoped computer_capture, which raises its window) refuse by design while the person is present; use the background path instead: computer_window_capture to see one window, computer_uia_value into an EMPTY field, computer_uia_invoke on the Send button, then a capture to verify. Or wait until they have been idle for a minute."
      }
      # Everything past the guard is input territory (window focus, cursor,
      # keys): mark input attempted BEFORE the first irreversible call, so a
      # post-input failure reports attempted=true and never reads as a
      # pre-input refusal that permits replay.
      $script:InputAttempted = $true
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
  $err = @{ error=$_.Exception.Message; inputAttempted=([bool]$script:InputAttempted) }
  # Post-input failures are exactly when the raise evidence matters most
  # (the action ran, then the verification capture failed): keep the same
  # evidence and attribution on the error response as on success.
  if ($script:OpForegroundBefore -ne 0 -and $hwnd) {
    Add-ForegroundEvidence $err $script:OpForegroundBefore ([long]$hwnd)
  }
  $err | ConvertTo-Json -Compress
  exit 1
}
