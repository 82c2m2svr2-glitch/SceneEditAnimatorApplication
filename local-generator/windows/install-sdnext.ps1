# Installs SD.Next (the local image generator DreamForge uses) and one lightweight SD 1.5 anime
# checkpoint. Nothing here needs an account, an API key or a paid service.
#
# Run from PowerShell:
#   powershell -ExecutionPolicy Bypass -File install-sdnext.ps1
# Options:
#   -Dir C:\path\to\sdnext   where to install (default: your user folder\sdnext)
#   -SkipModel               do not download the checkpoint

param(
  [string]$Dir = (Join-Path $env:USERPROFILE 'sdnext'),
  [switch]$SkipModel
)
$ErrorActionPreference = 'Stop'

function Stop-WithMessage($text) {
  Write-Host ''
  Write-Host $text -ForegroundColor Red
  Write-Host ''
  exit 1
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Stop-WithMessage 'Git is not installed. Install Git for Windows from https://git-scm.com/download/win and choose "Git from the command line and also from 3rd-party software", then run this again.'
}
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  Stop-WithMessage 'Python is not installed. Install Python 3.12 from https://www.python.org/downloads/windows/ and tick "Add python.exe to PATH", then run this again.'
}
$py = (& python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')").Trim()
if (@('3.10', '3.11', '3.12', '3.13') -notcontains $py) {
  Stop-WithMessage "Python $py was found. SD.Next supports Python 3.10 to 3.13; 3.12 is recommended."
}
# SD.Next's installer warns against these locations.
if ($Dir -match '\s') { Stop-WithMessage "The folder '$Dir' has a space in it. Choose one without spaces with -Dir." }
if ($Dir -match 'OneDrive') { Stop-WithMessage "The folder '$Dir' is inside OneDrive. Choose a local folder with -Dir." }

Write-Host "Python $py and Git found. Installing SD.Next in $Dir" -ForegroundColor Cyan
if (Test-Path (Join-Path $Dir '.git')) {
  git -C $Dir pull --ff-only
} else {
  git clone https://github.com/vladmandic/sdnext $Dir
}

if (-not $SkipModel) {
  # Anything V3, fp16 pruned: an SD 1.5 anime checkpoint of about 2.1 GB (CreativeML OpenRAIL-M licence).
  $models = Join-Path $Dir 'models\Stable-diffusion'
  New-Item -ItemType Directory -Force -Path $models | Out-Null
  $file = Join-Path $models 'anything-v3-fp16-pruned.safetensors'
  $url = 'https://huggingface.co/Linaqruf/anything-v3.0/resolve/main/anything-v3-fp16-pruned.safetensors'
  if (Test-Path $file) {
    Write-Host 'The checkpoint is already downloaded.' -ForegroundColor Cyan
  } else {
    Write-Host 'Downloading the checkpoint (about 2.1 GB)...' -ForegroundColor Cyan
    # curl.exe ships with Windows 10 and 11; -C - resumes an interrupted download.
    & curl.exe -L --fail -C - -o "$file.part" $url
    if ($LASTEXITCODE -ne 0) { Stop-WithMessage "The download failed. Run this again to resume it, or download $url into $models yourself." }
    Move-Item -Force "$file.part" $file
  }
}

Write-Host ''
Write-Host 'Done. Start the generator with start-sdnext.bat (in this folder).' -ForegroundColor Green
Write-Host 'The first start installs OpenVINO and the other libraries, which takes a while.'
