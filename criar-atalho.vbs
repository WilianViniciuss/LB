' Cria o atalho do BoletoPro na Area de Trabalho.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
Set lnk = sh.CreateShortcut(sh.SpecialFolders("Desktop") & "\BoletoPro.lnk")
lnk.TargetPath = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\wscript.exe"
lnk.Arguments = Chr(34) & pasta & "\BoletoPro.vbs" & Chr(34)
lnk.WorkingDirectory = pasta
lnk.IconLocation = pasta & "\public\icone.ico"
lnk.Description = "BoletoPro - extracao e lancamento de boletos"
lnk.Save
MsgBox "Atalho BoletoPro criado na Area de Trabalho.", 64, "BoletoPro"
