#define AppName "清墨"
#define AppEnglishName "CleanMark"
#ifndef AppVersion
  #define AppVersion "0.3.3"
#endif
#define AppPublisher "ZuoXing-0504"
#define AppURL "https://github.com/ZuoXing-0504/MarkDown-Free"
#define AppSupportURL "https://github.com/ZuoXing-0504/MarkDown-Free/issues"
#define AppExeName "清墨.exe"

[Setup]
AppId={{BE74A327-9464-4FE0-9C90-7D07FF40F13E}
AppName={#AppName}
AppVerName={#AppName} {#AppVersion}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppSupportURL}
AppUpdatesURL={#AppURL}
AppCopyright=Copyright © 2026 {#AppPublisher}
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
OutputDir=..\release\installer
OutputBaseFilename=清墨-{#AppVersion}-安装程序
SetupIconFile=..\assets\icon\cleanmark.ico
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
ChangesAssociations=yes
VersionInfoVersion={#AppVersion}.0
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppName} 安装程序
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}
VersionInfoCopyright=Copyright © 2026 {#AppPublisher}
MinVersion=10.0.17763

[Languages]
Name: "chinesesimplified"; MessagesFile: "languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Flags: unchecked
Name: "fileassoc"; Description: "将清墨添加到 .md 和 .markdown 的“打开方式”列表"; GroupDescription: "文件关联："; Flags: unchecked

[Files]
Source: "..\release\清墨-win32-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{group}\卸载 {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
Root: HKA; Subkey: "Software\Classes\CleanMark.Markdown"; ValueType: string; ValueName: ""; ValueData: "Markdown 文档"; Flags: uninsdeletekey; Tasks: fileassoc
Root: HKA; Subkey: "Software\Classes\CleanMark.Markdown\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#AppExeName},0"; Tasks: fileassoc
Root: HKA; Subkey: "Software\Classes\CleanMark.Markdown\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExeName}"" ""%1"""; Tasks: fileassoc
Root: HKA; Subkey: "Software\Classes\.md\OpenWithProgids"; ValueType: string; ValueName: "CleanMark.Markdown"; ValueData: ""; Flags: uninsdeletevalue; Tasks: fileassoc
Root: HKA; Subkey: "Software\Classes\.markdown\OpenWithProgids"; ValueType: string; ValueName: "CleanMark.Markdown"; ValueData: ""; Flags: uninsdeletevalue; Tasks: fileassoc

[Run]
Filename: "{app}\{#AppExeName}"; Description: "启动 {#AppName}"; Flags: nowait postinstall skipifsilent

[Code]
function InitializeSetup(): Boolean;
begin
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and (not UninstallSilent) then
  begin
    if MsgBox('是否同时删除清墨的本地设置和崩溃恢复草稿？' + #13#10 +
      '选择“是”会永久删除用户数据；选择“否”可在重新安装后继续使用。',
      mbConfirmation, MB_YESNO) = IDYES then
    begin
      DelTree(ExpandConstant('{userappdata}\清墨'), True, True, True);
      DelTree(ExpandConstant('{userappdata}\cleanmark'), True, True, True);
    end;
  end;
end;
