@echo off
rem Starts SD.Next for DreamForge's Local Image Generation, on this computer only.
rem
rem   --use-openvino   runs on the Intel graphics through OpenVINO
rem   --api-only       no web interface, which saves memory; DreamForge drives it
rem   (no --listen)    SD.Next answers only on 127.0.0.1, so nothing else on the network can use it
rem
rem Use "start-sdnext.bat --browser" when you run DreamForge in a browser with "npm run dev":
rem that page lives at http://localhost:5173 and needs permission (CORS) to call the generator.
rem The desktop app sends its requests itself and needs none.
rem
rem Never add --listen or --share: they open the generator to other devices or the internet.

setlocal
if not defined SDNEXT_DIR set "SDNEXT_DIR=%USERPROFILE%\sdnext"
if not exist "%SDNEXT_DIR%\webui.bat" (
  echo SD.Next was not found in %SDNEXT_DIR%.
  echo Run install-sdnext.ps1 first, or set SDNEXT_DIR to where it is.
  pause
  exit /b 1
)

set "MODEL=%SDNEXT_DIR%\models\Stable-diffusion\anything-v3-fp16-pruned.safetensors"
set "CORS="
if /I "%~1"=="--browser" set "CORS=--cors-origins http://localhost:5173"

cd /d "%SDNEXT_DIR%"
if exist "%MODEL%" (
  call webui.bat --use-openvino --api-only --port 7860 --ckpt "%MODEL%" %CORS%
) else (
  call webui.bat --use-openvino --api-only --port 7860 %CORS%
)
