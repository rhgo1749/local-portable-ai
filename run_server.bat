@echo off
chcp 65001 > nul
:: ==============================================================================
:: [에이전트 지침 / AGENT INSTRUCTION]
:: 이 파일 내의 한글 내용과 주석(메뉴 설명, 메시지 등)은 사용자의 명시적인 요청이 없는 한 절대로 임의로 수정하거나 번역/변경하지 마십시오.
:: DO NOT modify, translate, or rewrite any Korean text, comments, or menu descriptions in this file unless explicitly requested by the user.
::
:: [주의] 이 파일은 반드시 UTF-8 (BOM 없음) 인코딩으로 저장되어야 합니다.
:: 메모장이나 에디터로 수정 시 UTF-8 (BOM 없음) 포맷을 유지해 주십시오.
:: 윈도두 cmd.exe는 UTF-8 (BOM 없음) + CRLF 줄바꿈 상태에서만 한글 포함 배치 파일이 오류 없이 정상 작동합니다.
:: ==============================================================================

SET LOCAL_ROOT=%~dp0
SET PATH=%LOCAL_ROOT%node;%LOCAL_ROOT%python;%LOCAL_ROOT%pythonScripts;%PATH%

:: System default settings
set RAM_GB=16
set PHYSICAL_CORES=6
set THREADS=4

echo 시스템 사양을 확인하고 있습니다. 잠시만 기다려 주십시오...
:: 1. RAM 감지: wmic 시도 -> 실패하면 systeminfo 시도 -> 그래도 실패하면 기본값 8GB
set "RAW_RAM="
for /f "tokens=*" %%i in ('wmic ComputerSystem get TotalPhysicalMemory 2^>nul ^| findstr [0-9]') do set "RAW_RAM=%%i"
if not "%RAW_RAM%"=="" goto PROCESS_WMIC
goto TRY_SYSTEMINFO

:PROCESS_WMIC
set "RAW_RAM=%RAW_RAM: =%"
set "RAW_RAM_MB=%RAW_RAM:~0,-6%"
if "%RAW_RAM_MB%"=="" goto TRY_SYSTEMINFO
set /a RAM_GB=%RAW_RAM_MB% / 1024
if %RAM_GB% gtr 0 goto CORE_DETECTION
goto TRY_SYSTEMINFO

:TRY_SYSTEMINFO
set "SYS_RAM="
for /f "tokens=2 delims=:" %%a in ('systeminfo 2^>nul ^| findstr /i /c:"Total Physical Memory" /c:"총 실제 메모리"') do set "SYS_RAM=%%a"
if not "%SYS_RAM%"=="" goto PROCESS_SYSTEMINFO
goto RAM_FALLBACK

:PROCESS_SYSTEMINFO
set "SYS_RAM=%SYS_RAM: =%"
set "SYS_RAM=%SYS_RAM:MB=%"
set "SYS_RAM=%SYS_RAM:,=%"
if "%SYS_RAM%"=="" goto RAM_FALLBACK
set /a RAM_GB=%SYS_RAM% / 1024
if %RAM_GB% gtr 0 goto CORE_DETECTION
goto RAM_FALLBACK

:RAM_FALLBACK
set RAM_GB=8

:CORE_DETECTION
:: 2. 코어 수 감지: wmic 시도 -> 실패하면 환경변수 %NUMBER_OF_PROCESSORS% 사용 -> 기본값 6
set "RAW_CORES="
for /f "tokens=*" %%i in ('wmic CPU get NumberOfCores 2^>nul ^| findstr [0-9]') do set "RAW_CORES=%%i"
if not "%RAW_CORES%"=="" goto PROCESS_CORES
goto TRY_ENV_CORES

:PROCESS_CORES
set "RAW_CORES=%RAW_CORES: =%"
if "%RAW_CORES%"=="" goto TRY_ENV_CORES
set /a PHYSICAL_CORES=%RAW_CORES%
if %PHYSICAL_CORES% gtr 0 goto CORE_END
goto TRY_ENV_CORES

:TRY_ENV_CORES
if not "%NUMBER_OF_PROCESSORS%"=="" (
    set /a PHYSICAL_CORES=%NUMBER_OF_PROCESSORS%
    if %PHYSICAL_CORES% gtr 0 goto CORE_END
)
goto CORES_FALLBACK

:CORES_FALLBACK
set PHYSICAL_CORES=6

:CORE_END

:: 다른 작업을 해도 지장 없도록 스레드 풀을 여유롭게 할당합니다.
:: 물리 코어가 5개 이상이면 코어 수 - 2, 4개 이하면 코어 수 - 1을 할당하며, 최대 6개, 최소 2개로 제한합니다.
set /a THREADS=%PHYSICAL_CORES% - 2
if %PHYSICAL_CORES% lss 5 set /a THREADS=%PHYSICAL_CORES% - 1
if %THREADS% gtr 6 set THREADS=6
if %THREADS% lss 2 set THREADS=2

:MENU
cls
echo ===================================================
echo  [NTS-Portable-AI-0.5v] 로컬 실행 메뉴
echo ===================================================
echo  [시스템 정보] 가용 RAM: %RAM_GB% GB ^| 스레드 할당 개수: %THREADS%
echo ===================================================
echo  [1] gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf c- 131072  (권장 4G RAM, 빠름, 긴대화길이, 낮은성능, 이미지)
echo  [2] gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf c- 131072 (권장 8G RAM, 중간, 긴대화길이, 중간성능, 이미지)
echo  [3] gemma-4-12B-it-qat-UD-Q4_K_XL.gguf c- 65536 (권장 16G RAM, 느림, 중간대화길이, 고성능, 이미지)
echo  [4] gemma-4-26B-A4B-it-UD-IQ3_S.gguf c- 16384 (권장 16G RAM, 중간, 짧은대화길이, 고성능)
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
if %RAM_GB% lss 16 (
    call :RAM_WARNING "%MODEL_NAME%" "16"
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
echo.
echo 백엔드 서버(Port 8081)의 응답을 대기하고 있습니다...
echo (모델 로딩은 시스템 사양에 따라 수십 초에서 수 분이 걸릴 수 있습니다.)
set /a WAIT_SEC=0

:PORT_CHECK_LOOP
ping 127.0.0.1 -n 2 > nul
netstat -ano | findstr "127.0.0.1:8081" | findstr "LISTENING" > nul
if not errorlevel 1 (
    goto PORT_CHECK_SUCCESS
)

set /a WAIT_SEC+=1
echo  [%WAIT_SEC%초] 대기 중...

if %WAIT_SEC% geq 60 (
    echo.
    echo ===================================================
    echo  [오류] 백엔드 서버(8081 포트)가 60초 동안 응답하지 않습니다.
    echo  모델이 너무 크거나 llama-server.exe 구동 중 오류가 발생했을 수 있습니다.
    echo ===================================================
    pause
    goto MENU
)
goto PORT_CHECK_LOOP

:PORT_CHECK_SUCCESS
CD /D "%LOCAL_ROOT%"
start /b cmd /c "ping 127.0.0.1 -n 3 >nul 2>&1 && start msedge http://127.0.0.1:8080"
node\node.exe mcp-bridge.js

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

:: ==============================================================================
:: PORT COLLISION
:: ==============================================================================
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
