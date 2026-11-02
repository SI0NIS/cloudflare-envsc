' run-node-hidden.vbs - run Node.js without a console window.
' Usage: wscript.exe run-node-hidden.vbs <node.exe> <script.js> [args...]
Option Explicit
Dim shell, cmd, i, arg, nodeExe
If WScript.Arguments.Count < 2 Then WScript.Quit 2
nodeExe = WScript.Arguments(0)
cmd = Chr(34) & nodeExe & Chr(34)
For i = 1 To WScript.Arguments.Count - 1
  arg = Replace(WScript.Arguments(i), Chr(34), Chr(34) & Chr(34))
  cmd = cmd & " " & Chr(34) & arg & Chr(34)
Next
Set shell = CreateObject("WScript.Shell")
WScript.Quit shell.Run(cmd, 0, True)