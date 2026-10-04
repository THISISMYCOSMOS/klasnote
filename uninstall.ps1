[CmdletBinding(SupportsShouldProcess=$true)]
param()
$ErrorActionPreference='Stop'
$installRoot=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'KlasSummarizer'))
$expectedRoot=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'KlasSummarizer'))
if ($installRoot -ne $expectedRoot -or -not $installRoot.StartsWith([IO.Path]::GetFullPath($env:LOCALAPPDATA)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw '삭제 대상 경로가 설치 폴더를 벗어납니다.' }
$marker=Join-Path $installRoot '.klas-summarizer-host'
if (-not (Test-Path -LiteralPath $marker) -or (Get-Content -LiteralPath $marker -Raw).Trim() -ne 'com.klas_summarizer.host') { throw '호스트 설치 확인 파일이 없습니다. 삭제하지 않습니다.' }
$registryPath='HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.klas_summarizer.host'
$manifestPath=Join-Path $installRoot 'com.klas_summarizer.host.json'
if (Test-Path -LiteralPath $registryPath) {
  if ((Get-Item -LiteralPath $registryPath).GetValue('') -ne $manifestPath) { throw '다른 호스트 등록이므로 삭제하지 않습니다.' }
  if ($PSCmdlet.ShouldProcess($registryPath,'네이티브 호스트 등록 해제')) { Remove-Item -LiteralPath $registryPath }
}
if ($PSCmdlet.ShouldProcess($installRoot,'확인된 KLAS 호스트 폴더 삭제')) { Remove-Item -LiteralPath $installRoot -Recurse -Force }
Write-Output '브라우저 로컬 강의 데이터는 확장의 로컬 기록에서 별도로 삭제하세요.'
