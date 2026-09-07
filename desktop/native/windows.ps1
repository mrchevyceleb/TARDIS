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
  public static void Release() { Mouse(4,0); Mouse(16,0); foreach (ushort k in new ushort[]{16,17,18,91}) Key(k,true); }
}
'@
[DesktopInput]::EnableDpi()
Add-Type -AssemblyName System.Windows.Forms
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
  @{ error=$_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
