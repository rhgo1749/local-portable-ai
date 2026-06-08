@echo off
chcp 949 > nul
SET LOCAL_ROOT=%~dp0
SET PATH=%LOCAL_ROOT%node;%LOCAL_ROOT%python;%LOCAL_ROOT%pythonScripts;%PATH%

:: System default settings
set RAM_GB=16
set PHYSICAL_CORES=6
set THREADS=4

echo �ý��� ����� Ȯ���ϰ� �ֽ��ϴ�. ��ø� ��ٷ� �ֽʽÿ�...
:: 1. RAM ����: wmic �õ� -> �����ϸ� systeminfo ���� -> �� �� �� �Ǹ� ������ 8GB
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
for /f "tokens=2 delims=:" %%a in ('systeminfo 2^>nul ^| findstr /i /c:"Total Physical Memory" /c:"�� ���� �޸�"') do set "SYS_RAM=%%a"
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
:: 2. �ھ� �� ����: wmic �õ� -> �����ϸ� ȯ�溯�� %NUMBER_OF_PROCESSORS% ���� -> ������ 6
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

:: �ٸ� �۾��� �ص� ���� ������ ������ Ǯ�� �����Ӱ� �Ҵ��մϴ�.
:: ���� �ھ 5�� �̻��̸� �ھ� �� - 2, 4�� ���ϸ� �ھ� �� - 1�� �Ҵ��ϸ�, �ִ� 6��, �ּ� 2���� �����մϴ�.
set /a THREADS=%PHYSICAL_CORES% - 2
if %PHYSICAL_CORES% lss 5 set /a THREADS=%PHYSICAL_CORES% - 1
if %THREADS% gtr 6 set THREADS=6
if %THREADS% lss 2 set THREADS=2

:MENU
cls
echo ===================================================
echo  [NTS-Portable-AI-0.4v] ���� ���� �޴�
echo ===================================================
echo  [�ý��� ����] ���� RAM: %RAM_GB% GB ^| ������ �Ҵ� ����: %THREADS%
echo ===================================================
echo  [1] gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf c- 131072  (���� 4G ram, ����, ���ȭ����, ��������, �̹���)
echo  [2] gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf c- 131072 (���� 8G ram, �߰�, ���ȭ����, �߰�����, �̹���)
echo  [3] gemma-4-12B-it-qat-UD-Q4_K_XL.gguf c- 65536 (���� 16G ram, ����, �߰���ȭ����, ������, �̹���)
echo  [4] gemma-4-26B-A4B-it-UD-IQ3_S.gguf c- 16384 (���� 16G ram, �߰�, ª����ȭ����, ������)
echo  [5] ���α׷� ����
echo ===================================================
set /p USER_CHOICE="������ �� ��ȣ�� �Է��Ͻʽÿ� (1-5): "
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
echo  gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf ���� �����մϴ�...
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
echo  gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf ���� �����մϴ�...
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
echo  gemma-4-12B-it-qat-UD-Q4_K_XL.gguf ���� �����մϴ�...
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
echo  gemma-4-26B-A4B-it-UD-IQ3_S.gguf ���� �����մϴ�...
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
node\node.exe mcp-bridge.js

:QUIT
taskkill /f /im llama-server.exe >nul 2>&1
echo ���α׷��� ����Ǿ����ϴ�.
pause
exit /b

:MODEL_NOT_FOUND
echo.
echo ===================================================
echo  [����] �ش� �� ������ �������� �ʽ��ϴ�!
echo ===================================================
echo  �𵨸�: %~1
echo  Ȯ�ε� ���: %~3
echo.
echo  ��ġ �ȳ�:
echo  1. models ���� �Ʒ��� �𵨸� ������ �����ϰ� GGUF ������ �־��ֽʽÿ�.
echo  2. �ùٸ� ��� ����:
echo     [������Ʈ ��Ʈ]\models\%~2 (����)
echo        �� %~1 (GGUF ����)
echo ===================================================
echo  �ƹ� Ű�� ������ �޴��� ���ư��ϴ�...
pause > nul
exit /b

:RAM_WARNING
echo.
echo ===================================================
echo  [���] �ý��� RAM �뷮�� �� ���� �����ϱ⿡ �����մϴ�!
echo ===================================================
echo  ������ ��: %~1
echo  �䱸 RAM: %~2 GB �̻� (���� �ý��� RAM: %RAM_GB% GB)
echo.
echo  RAM�� �����ϸ� ������ ���� �޸�(����¡ ����)�� ����ϰ� �Ǿ�
echo  �ӵ��� �ſ� �������ų� PC�� ���� �� �ֽ��ϴ�.
echo  �׷��� �����Ͻðڽ��ϱ�? (Y/N)
echo ===================================================
set /p RAM_CONFIRM="�Է��Ͻʽÿ� (Y/N): "
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
echo  [����] %~1 ��Ʈ�� �̹� �ٸ� ���α׷��� ���� ��� ���Դϴ�!
echo ===================================================
echo  ��Ʈ %~1�� ���� ���� �ٸ� ���α׷�(��: �޽���, �� ���� ��)��
echo  �����Ͻ� �� �ٽ� �õ��� �ֽñ� �ٶ��ϴ�.
echo ===================================================
echo  �ƹ� Ű�� ������ �޴��� ���ư��ϴ�...
pause > nul
exit /b
