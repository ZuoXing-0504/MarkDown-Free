param(
  [Parameter(Mandatory = $true)][ValidateSet('word-to-pdf', 'word-to-docx', 'word-to-html', 'ppt-to-pdf', 'ppt-to-pptx', 'ppt-to-images')][string]$Action,
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [string]$ProcessIdPath = ''
)

$ErrorActionPreference = 'Stop'

function Release-ComObject($Object) {
  if ($null -ne $Object) {
    try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($Object) } catch {}
  }
}

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CleanMarkNativeMethods {
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@

function Save-ApplicationProcessId($Application, [string]$ProcessName, [int[]]$ExistingProcessIds) {
  if ([string]::IsNullOrWhiteSpace($ProcessIdPath) -or $null -eq $Application) { return }
  $officeProcessId = [uint32]0
  try {
    $windowHandle = [IntPtr]$Application.Hwnd
    if ($windowHandle -ne [IntPtr]::Zero) {
      [void][CleanMarkNativeMethods]::GetWindowThreadProcessId($windowHandle, [ref]$officeProcessId)
    }
  } catch {}
  if ($officeProcessId -eq 0) {
    for ($attempt = 0; $attempt -lt 30 -and $officeProcessId -eq 0; $attempt++) {
      $candidate = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
        Where-Object { $ExistingProcessIds -notcontains $_.Id } |
        Sort-Object Id -Descending |
        Select-Object -First 1
      if ($null -ne $candidate) { $officeProcessId = [uint32]$candidate.Id }
      if ($officeProcessId -eq 0) { Start-Sleep -Milliseconds 100 }
    }
  }
  if ($officeProcessId -gt 0) {
    try { [System.IO.File]::WriteAllText($ProcessIdPath, $officeProcessId.ToString(), [System.Text.Encoding]::ASCII) } catch {}
  }
}

if ($Action.StartsWith('word-')) {
  $word = $null
  $document = $null
  $existingWordProcessIds = @(Get-Process -Name 'WINWORD' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  try {
    $word = New-Object -ComObject Word.Application
    Save-ApplicationProcessId $word 'WINWORD' $existingWordProcessIds
    $word.Visible = $false
    $word.DisplayAlerts = 0
    try { $word.AutomationSecurity = 3 } catch {}
    try { $word.Options.UpdateLinksAtOpen = $false } catch {}
    try { $word.Options.ConfirmConversions = $false } catch {}
    $document = $word.Documents.Open($InputPath, $false, $true, $false)
    if ($Action -eq 'word-to-pdf') {
      $document.SaveAs2($OutputPath, 17)
    } elseif ($Action -eq 'word-to-docx') {
      $document.SaveAs2($OutputPath, 16)
    } else {
      $document.SaveAs2($OutputPath, 10)
    }
  } finally {
    if ($null -ne $document) { try { $document.Close(0) } catch {} }
    if ($null -ne $word) { try { $word.Quit() } catch {} }
    Release-ComObject $document
    Release-ComObject $word
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
  }
  exit 0
}

$powerPoint = $null
$presentation = $null
$existingPowerPointProcessIds = @(Get-Process -Name 'POWERPNT' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
try {
  $powerPoint = New-Object -ComObject PowerPoint.Application
  Save-ApplicationProcessId $powerPoint 'POWERPNT' $existingPowerPointProcessIds
  try { $powerPoint.DisplayAlerts = 1 } catch {}
  try { $powerPoint.ShowStartupDialog = $false } catch {}
  try { $powerPoint.AutomationSecurity = 3 } catch {}
  $presentation = $powerPoint.Presentations.Open($InputPath, $true, $true, $false)
  if ($Action -eq 'ppt-to-pdf') {
    $presentation.SaveAs($OutputPath, 32)
  } elseif ($Action -eq 'ppt-to-pptx') {
    $presentation.SaveAs($OutputPath, 24)
  } else {
    if (-not (Test-Path -LiteralPath $OutputPath)) { New-Item -ItemType Directory -Path $OutputPath | Out-Null }
    $presentation.Export($OutputPath, 'PNG', 1920, 1080)
  }
} finally {
  if ($null -ne $presentation) { try { $presentation.Close() } catch {} }
  if ($null -ne $powerPoint) { try { $powerPoint.Quit() } catch {} }
  Release-ComObject $presentation
  Release-ComObject $powerPoint
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
