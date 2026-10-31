' Abre o BoletoPro como aplicativo (sem janela de console).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = pasta
If sh.Run("cmd /c where node", 0, True) <> 0 Then
  MsgBox "Node.js nao encontrado. Instale em https://nodejs.org e tente novamente.", 16, "BoletoPro"
  WScript.Quit 1
End If
If Not fso.FolderExists(pasta & "\node_modules") Then sh.Run "cmd /c npm install --omit=dev", 0, True
sh.Run "cmd /c node src\servidor.js > servidor.log 2>&1", 0, False
