; HendyTools installer scaffold.
; Merge or replace with the existing installer script before a production release.
#define MyAppName "Hendy Tools Pro"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Hendy"
#define MyAppExeName "HendyTools.exe"

[Setup]
AppId={{B40D7EE4-C055-4C2C-9F6B-9D947A98DC41}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\HendyTools
DefaultGroupName={#MyAppName}
OutputDir=..\dist-installer
OutputBaseFilename=HendyTools-Setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64

[Files]
; Add the actual packaged desktop executable here before building the installer.
; Source: "..\dist-desktop\HendyTools.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; Name: "{group}\Hendy Tools Pro"; Filename: "{app}\{#MyAppExeName}"
