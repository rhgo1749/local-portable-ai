@echo off
chcp 949 > nul
SET LOCAL_ROOT=%~dp0
SET PATH=%LOCAL_ROOT%node;%LOCAL_ROOT%python;%LOCAL_ROOT%pythonScripts;%PATH%

:: System default settings
set RAM_GB=16
set PHYSICAL_CORES=6
set THREADS=4

echo 시스템 사양을 확인하고 있습니다. 잠시만 기다려 주십시오...
for /f "usebackq tokens=*" %%i in (`powershell -NoProfile -Command "[math]::round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)"`) do set RAM_GB=%%i
for /f "usebackq tokens=*" %%i in (`powershell -NoProfile -Command "(Get-CimInstance Win32_Processor).NumberOfCores"`) do set PHYSICAL_CORES=%%i

:: 다른 작업을 해도 지장 없도록 스레드 풀을 여유롭게 할당합니다.
:: 물리 코어가 5개 이상이면 코어 수 - 2, 4개 이하면 코어 수 - 1을 할당하며, 최대 6개, 최소 2개로 제한합니다.
set /a THREADS=%PHYSICAL_CORES% - 2
if %PHYSICAL_CORES% lss 5 set /a THREADS=%PHYSICAL_CORES% - 1
if %THREADS% gtr 6 set THREADS=6
if %THREADS% lss 2 set THREADS=2

:MENU
cls
echo ===================================================
echo  [NTS-Portable-AI-0.4v] 로컬 실행 메뉴
echo ===================================================
echo  [시스템 정보] 가용 RAM: %RAM_GB% GB ^| 스레드 할당 개수: %THREADS%
echo ===================================================
echo  [1] gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf c- 131072  (빠름, 긴대화길이, 낮은성능, 이미지)
echo  [2] gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf c- 131072 (중간, 긴대화길이, 중간성능, 이미지)
echo  [3] gemma-4-12B-it-qat-UD-Q4_K_XL.gguf c- 65536 (느림, 중간대화길이, 고성능, 이미지)
echo  [4] gemma-4-26B-A4B-it-UD-IQ3_S.gguf c- 16384 (중간, 짧은대화길이, 고성능)
echo  [5] 프로그램 종료
echo ===================================================
set /p USER_CHOICE="구동할 모델 번호를 입력하십시오 (1-5): "
if "%USER_CHOICE%"=="1" (
    call :CHECK_PORT_COLLISION
    if "%PORT_OCCUPIED%"=="1" goto MENU
    goto RUN_Gemma_2B
)
if "%USER_CHOICE%"=="2" (
    call :CHECK_PORT_COLLISION
    if "%PORT_OCCUPIED%"=="1" goto MENU
    goto RUN_Gemma_4B
)
if "%USER_CHOICE%"=="3" (
    call :CHECK_PORT_COLLISION
    if "%PORT_OCCUPIED%"=="1" goto MENU
    goto RUN_Gemma_12B
)
if "%USER_CHOICE%"=="4" (
    call :CHECK_PORT_COLLISION
    if "%PORT_OCCUPIED%"=="1" goto MENU
    goto RUN_Gemma_26B
)
if "%USER_CHOICE%"=="5" exit
goto MENU

:RUN_Gemma_2B
set IS_VISION_MODEL=1
set CONTEXT_SIZE=131072
set MODEL_NAME=gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf
set MODEL_DIR=gemma-4-E2B-it-qat-UD-Q4_K_XL
set MODEL_PATH=%LOCAL_ROOT%models\%MODEL_DIR%\%MODEL_NAME%
if not exist "%MODEL_PATH%" (
    call :MODEL_NOT_FOUND "%MODEL_NAME%" "%MODEL_DIR%" "%MODEL_PATH%"
    goto MENU
)
if %RAM_GB% lss 4 (
    call :RAM_WARNING "%MODEL_NAME%" "4"
)
echo.
echo ===================================================
echo  gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf 모델을 실행합니다...
echo ===================================================
CD /D "%LOCAL_ROOT%llama.cpp(cpu)"
start "gemma-2b Backend" /b /min llama-server.exe ^
  -m "..\models\gemma-4-E2B-it-qat-UD-Q4_K_XL\gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf" ^
  --mmproj "..\models\gemma-4-E2B-it-qat-UD-Q4_K_XL\mmproj-F16.gguf" ^
  --jinja ^
  --host 127.0.0.1 ^
  --port 8081 ^
  --ui-config-file "..\default_settings.json" ^
  -np 1 ^
  -c %CONTEXT_SIZE% ^
  --kv-unified ^
  -t %THREADS% ^
  -tb %THREADS% ^
  -b 512 ^
  -ub 512 ^
  --temp 1 ^
  --top_k 64 ^
  --top_p 0.95 ^
  --min_p 0.0 ^
  --sleep-idle-seconds 300 ^
  -fa on ^
  --no-mmap ^
  --poll 0 ^
  --cache-type-k q4_0 ^
  --cache-type-v q4_0
goto PORT_CHECK

:RUN_Gemma_4B
set IS_VISION_MODEL=1
set CONTEXT_SIZE=131072
set MODEL_NAME=gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf
set MODEL_DIR=gemma-4-E4B-it-qat-UD-Q4_K_XL
set MODEL_PATH=%LOCAL_ROOT%models\%MODEL_DIR%\%MODEL_NAME%
if not exist "%MODEL_PATH%" (
    call :MODEL_NOT_FOUND "%MODEL_NAME%" "%MODEL_DIR%" "%MODEL_PATH%"
    goto MENU
)
if %RAM_GB% lss 8 (
    call :RAM_WARNING "%MODEL_NAME%" "8"
)
echo.
echo ===================================================
echo  gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf 모델을 실행합니다...
echo ===================================================
CD /D "%LOCAL_ROOT%llama.cpp(cpu)"
start "gemma-4b Backend" /b /min llama-server.exe ^
  -m "..\models\gemma-4-E4B-it-qat-UD-Q4_K_XL\gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf" ^
  --mmproj "..\models\gemma-4-E4B-it-qat-UD-Q4_K_XL\mmproj-F16.gguf" ^
  --jinja ^
  --host 127.0.0.1 ^
  --port 8081 ^
  --ui-config-file "..\default_settings.json" ^
  -np 1 ^
  -c %CONTEXT_SIZE% ^
  --kv-unified ^
  -t %THREADS% ^
  -tb %THREADS% ^
  -b 512 ^
  -ub 512 ^
  --temp 1 ^
  --top_k 64 ^
  --top_p 0.95 ^
  --min_p 0.0 ^
  --sleep-idle-seconds 300 ^
  -fa on ^
  --no-mmap ^
  --poll 0 ^
  --cache-type-k q4_0 ^
  --cache-type-v q4_0
goto PORT_CHECK

:RUN_Gemma_12B
set IS_VISION_MODEL=1
set CONTEXT_SIZE=65536
set MODEL_NAME=gemma-4-12B-it-qat-UD-Q4_K_XL.gguf
set MODEL_DIR=gemma-4-12B-it-qat-UD-Q4_K_XL
set MODEL_PATH=%LOCAL_ROOT%models\%MODEL_DIR%\%MODEL_NAME%
if not exist "%MODEL_PATH%" (
    call :MODEL_NOT_FOUND "%MODEL_NAME%" "%MODEL_DIR%" "%MODEL_PATH%"
    goto MENU
)
if %RAM_GB% lss 16 (
    call :RAM_WARNING "%MODEL_NAME%" "16"
)
echo.
echo ===================================================
echo  gemma-4-12B-it-qat-UD-Q4_K_XL.gguf 모델을 실행합니다...
echo ===================================================
CD /D "%LOCAL_ROOT%llama.cpp(cpu)"
start "gemma-12b Backend" /b /min llama-server.exe ^
  -m "..\models\gemma-4-12B-it-qat-UD-Q4_K_XL\gemma-4-12B-it-qat-UD-Q4_K_XL.gguf" ^
  --mmproj "..\models\gemma-4-12B-it-qat-UD-Q4_K_XL\mmproj-F16.gguf" ^
  --jinja ^
  --host 127.0.0.1 ^
  --port 8081 ^
  --ui-config-file "..\default_settings.json" ^
  -np 1 ^
  -c %CONTEXT_SIZE% ^
  --kv-unified ^
  -t %THREADS% ^
  -tb %THREADS% ^
  -b 512 ^
  -ub 512 ^
  --temp 1 ^
  --top_k 64 ^
  --top_p 0.95 ^
  --min_p 0.0 ^
  --sleep-idle-seconds 300 ^
  -fa on ^
  --no-mmap ^
  --poll 0 ^
  --cache-type-k q4_0 ^
  --cache-type-v q4_0
goto PORT_CHECK

:RUN_Gemma_26B
set IS_VISION_MODEL=0
set CONTEXT_SIZE=16384
set MODEL_NAME=gemma-4-26B-A4B-it-UD-IQ3_S.gguf
set MODEL_DIR=gemma-4-26B-A4B-it-UD-IQ3_S
set MODEL_PATH=%LOCAL_ROOT%models\%MODEL_DIR%\%MODEL_NAME%
if not exist "%MODEL_PATH%" (
    call :MODEL_NOT_FOUND "%MODEL_NAME%" "%MODEL_DIR%" "%MODEL_PATH%"
    goto MENU
)
if %RAM_GB% lss 24 (
    call :RAM_WARNING "%MODEL_NAME%" "24"
)
echo.
echo ===================================================
echo  gemma-4-26B-A4B-it-UD-IQ3_S.gguf 모델을 실행합니다...
echo ===================================================
CD /D "%LOCAL_ROOT%llama.cpp(cpu)"
start "gemma-26b Backend" /b /min llama-server.exe ^
  -m "..\models\gemma-4-26B-A4B-it-UD-IQ3_S\gemma-4-26B-A4B-it-UD-IQ3_S.gguf" ^
  --jinja ^
  --host 127.0.0.1 ^
  --port 8081 ^
  --ui-config-file "..\default_settings.json" ^
  -np 1 ^
  -c %CONTEXT_SIZE% ^
  --kv-unified ^
  -t %THREADS% ^
  -tb %THREADS% ^
  -b 512 ^
  -ub 512 ^
  --temp 1 ^
  --top_k 64 ^
  --top_p 0.95 ^
  --min_p 0.0 ^
  --sleep-idle-seconds 300 ^
  -fa on ^
  --no-mmap ^
  --poll 0 ^
  --cache-type-k q4_0 ^
  --cache-type-v q4_0
goto PORT_CHECK

:PORT_CHECK
start msedge http://127.0.0.1:8080
timeout /t 1 /nobreak > nul
netstat -ano | findstr "127.0.0.1:8081" | findstr "LISTENING" > nul
if errorlevel 1 (
    goto PORT_CHECK
)

CD /D "%LOCAL_ROOT%"
node\node.exe mcp-bridge.js --open

:QUIT
taskkill /f /im llama-server.exe >nul 2>&1
echo 프로그램이 종료되었습니다.
pause
exit /b

:MODEL_NOT_FOUND
echo.
echo ===================================================
echo  [오류] 해당 모델 파일이 존재하지 않습니다!
echo ===================================================
echo  모델명: %~1
echo  확인된 경로: %~3
echo.
echo  설치 안내:
echo  1. models 폴더 아래에 모델명 폴더를 생성하고 GGUF 파일을 넣어주십시오.
echo  2. 올바른 경로 예시:
echo     [프로젝트 루트]\models\%~2 (폴더)
echo        ㄴ %~1 (GGUF 파일)
echo ===================================================
echo  아무 키나 누르면 메뉴로 돌아갑니다...
pause > nul
exit /b

:RAM_WARNING
echo.
echo ===================================================
echo  [경고] 시스템 RAM 용량이 이 모델을 실행하기에 부족합니다!
echo ===================================================
echo  선택한 모델: %~1
echo  요구 RAM: %~2 GB 이상 (현재 시스템 RAM: %RAM_GB% GB)
echo.
echo  RAM이 부족하면 과도한 가상 메모리(페이징 파일)를 사용하게 되어
echo  속도가 매우 느려지거나 PC가 멈출 수 있습니다.
echo  그래도 실행하시겠습니까? (Y/N)
echo ===================================================
set /p RAM_CONFIRM="입력하십시오 (Y/N): "
if /i "%RAM_CONFIRM%"=="Y" exit /b
goto MENU

:CHECK_PORT_COLLISION
set PORT_OCCUPIED=0
netstat -ano | findstr "127.0.0.1:8080" | findstr "LISTENING" > nul
if not errorlevel 1 (
    call :PORT_COLLISION "8080"
    set PORT_OCCUPIED=1
    exit /b
)
netstat -ano | findstr "127.0.0.1:8081" | findstr "LISTENING" > nul
if not errorlevel 1 (
    call :PORT_COLLISION "8081"
    set PORT_OCCUPIED=1
    exit /b
)
exit /b

:PORT_COLLISION
echo.
echo ===================================================
echo  [오류] %~1 포트가 이미 다른 프로그램에 의해 사용 중입니다!
echo ===================================================
echo  포트 %~1을 점유 중인 다른 프로그램(예: 메신저, 웹 서버 등)을
echo  종료하신 후 다시 시도해 주시기 바랍니다.
echo ===================================================
echo  아무 키나 누르면 메뉴로 돌아갑니다...
pause > nul
exit /b
