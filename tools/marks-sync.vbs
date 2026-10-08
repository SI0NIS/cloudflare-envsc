' Silent launcher for marks sync (invoked by Task Scheduler, no console window).
' Uses Chr(34) to build quotes.
' Runs detached (wait=False) so Task Scheduler returns immediately and never
' holds/terminates the node process (direct node.exe action died with 0xC000013A).
Dim sh, q, prog, script, logf, cmd
q = Chr(34)
prog   = "C:\Users\Sionis\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
script = "C:\Users\Sionis\WorkBuddy\2026-09-16-21-43-51\cloudflare-envsc\tools\marks-sync.mjs"
logf   = "C:\Users\Sionis\WorkBuddy\2026-09-16-21-43-51\cloudflare-envsc\tools\marks-sync.log"

Set sh = CreateObject("WScript.Shell")
cmd = "cmd /c " & q & _
      q & prog & q & " " & q & script & q & " --days 2 >> " & q & logf & q & " 2>&1" & _
      q
sh.Run cmd, 0, False
