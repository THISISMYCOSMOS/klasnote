[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
if (-not [IO.Path]::IsPathRooted($nodePath) -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw 'node.exe의 절대 경로를 확인할 수 없습니다.' }
$installRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'KlasSummarizer'))
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'KlasSummarizer'))
if ($installRoot -ne $expectedRoot) { throw '설치 대상 경로 오류' }
$markerPath = Join-Path $installRoot '.klas-summarizer-host'
if ((Test-Path -LiteralPath $installRoot) -and -not (Test-Path -LiteralPath $markerPath)) { throw '기존 폴더의 소유권을 확인할 수 없습니다. 설치를 중단합니다.' }
if ((Test-Path -LiteralPath $markerPath) -and (Get-Content -LiteralPath $markerPath -Raw).Trim() -ne 'com.klas_summarizer.host') { throw '기존 폴더의 소유권 표시가 다릅니다.' }
$manifestPath = Join-Path $installRoot 'com.klas_summarizer.host.json'
$registryPath='HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.klas_summarizer.host'
if (Test-Path -LiteralPath $registryPath) {
  $existing=(Get-Item -LiteralPath $registryPath).GetValue('')
  if ($existing -and $existing -ne $manifestPath) { throw '다른 네이티브 호스트가 등록되어 있습니다. 기존 등록을 보존합니다.' }
}
if ($nodePath.Contains('%') -or $installRoot.Contains('%') -or $nodePath.Contains('"') -or $installRoot.Contains('"')) { throw '지원하지 않는 경로 문자' }
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'native-host\host.mjs') -Destination (Join-Path $installRoot 'host.mjs') -Force
$launcherPath = Join-Path $installRoot 'host.bat'
$launcher = '@echo off' + "`r`n" + '"' + $nodePath + '" "' + (Join-Path $installRoot 'host.mjs') + '"' + "`r`n"
[IO.File]::WriteAllText($launcherPath, $launcher, [Text.Encoding]::Default)
$manifest = @{name='com.klas_summarizer.host';description='Personal KLAS lecture summaries';path=$launcherPath;type='stdio';allowed_origins=@('chrome-extension://klihhclhnhhmldcbnkpampimkjafmbdm/')}
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllText($markerPath, 'com.klas_summarizer.host', (New-Object Text.UTF8Encoding($false)))
New-Item -Path $registryPath -Force | Out-Null
Set-Item -LiteralPath $registryPath -Value $manifestPath
Write-Output ('현재 사용자용 호스트 설치 완료: ' + $installRoot)
Write-Output 'Chrome에서 개발자 모드를 켜고 이 프로젝트의 extension 폴더를 압축해제된 확장으로 로드하세요.'
