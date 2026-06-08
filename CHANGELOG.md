# CHANGELOG

## [0.5] - 2026-06-08

### Added
- express 의존성 명시적 추가 (package.json 누락 보완)

### Changed
- mcp-bridge.js를 src/ 하위 9개 모듈로 분할 (모듈화 아키텍처 도입)
- 시스템 감지 로직에서 PowerShell 의존성 제거 — wmic→systeminfo 폴백 방식으로 전환
- CORS 정책과 샌드박스 검증 강화
- 캐시 정리 프로세스 비동기화 (서버 기동 시간 단축)

### Fixed
- Tesseract Worker 종료 시 메모리/프로세스 누수 문제 해결
- Unhandled Promise Rejection 방지 (visionQueue/tesseractQueue 체인 연결)
- 심볼릭 링크 우회 취약점 패치
- pdfjs-dist 문서 객체 메모리 해제 누락 수정

## [0.4.1] - 2026-06-07

### Fixed

- **스캔 PDF 페이지 수 오인식 버그 수정:** kordoc이 텍스트 레이어를 읽지 못해 파싱에 실패한 스캔 기반 PDF에서, 페이지 수가 항상 1로 고정되어 첫 번째 페이지만 처리되던 버그 수정. pdfjs 문서 로드 직후 `doc.numPages`로 실제 페이지 수를 재확인하여 전체 페이지를 올바르게 처리.

- **하이브리드 PDF 파이프라인 도입 (디지털 PDF 본문 텍스트 유실 방지):** 비전 모드 활성화 시 전체 페이지를 이미지로 렌더링하고 Tesseract OCR로 텍스트를 읽던 방식에서, PDF의 종류를 자동 감지하는 `parsePdfHybrid` 엔진으로 전환.
  - **디지털 PDF**: kordoc 텍스트 레이어 추출(원본 100% 보존) + pdfjs 렌더링 이미지를 비전 모델로 시각 분석하여 결합 출력.
  - **스캔 PDF**: 기존 전체 OCR + 비전 파이프라인 유지.
  - pdfjs-dist의 Node.js 환경에서 웹 폰트 렌더링 불가로 인한 Tesseract 글자 깨짐 현상 근본 해결.

- **`run_server.bat` 인코딩 깨짐 수정:** 한국어 환경 Windows 시스템에서 UTF-8 BOM 인코딩으로 작성된 배치 파일이 `cmd.exe` 실행 시 `ï»¿` 등의 문자로 깨지는 문제 해결. CP949(EUC-KR) 인코딩으로 재작성하고 `chcp 949`를 적용.

---

## [0.4.0-hotfix] - 2026-06-06

### Fixed

- **비전 API 엔드포인트 전환:** `localVisionAnalyze` 함수가 구식 `/completion` API를 호출하여 이미지 전달이 안 되던 문제를 OpenAI 호환 표준인 `/v1/chat/completions` 엔드포인트로 전환. 이미지 오브젝트 전달 및 응답 파싱 구조 수정으로 비전 인식 정확도 향상.
- **MCP 서버 타임아웃 증가:** 멀티페이지 PDF 분석 시 5분 초과 시 발생하던 강제 종료 에러(`-32001: Request timed out`)를 해결하기 위해 `requestTimeoutSeconds` 설정을 300초(5분)에서 1200초(20분)로 상향 조정.
- **Node-Canvas 기반 픽셀 복사 오류 수정:** 흐릿한 PDF 페이지 렌더링 시 내부 Buffer 유실로 인한 `Invalid argument` 차단. 캔버스 요소 진입 시 `global.ImageData`를 경유해 진짜 `node-canvas` 인스턴스로 자동 치환 및 렌더링되도록 조치하여 2페이지 OCR 분석 실패 문제 완벽 해결.

---

## [0.3.0]

### Added

- **초고속 로컬 문서 분석 캐싱 (Cache Mechanism) 도입:** 문서 파싱 결과를 프로젝트 루트 하위의 `.mcp_cache/` 폴더에 파일 크기 및 수정일시 기반 MD5 해시로 캐싱. 동일 문서 분석 성능을 74ms에서 3ms로 95.9% 단축하여 CPU-ONLY 환경에서 속도 대폭 개선.
- **원본 문서 수정 감지:** 사용자가 문서를 수정하고 저장하면 파일 크기와 수정 시간을 스스로 감지해 캐시를 즉시 파기하고 최신 내용으로 자동 무효화(Invalidation) 및 갱신 적용.
- **바이너리 파일 안전 가이드 추가:** 엑셀, PDF, HWPX 등의 형식을 일반 텍스트 읽기 툴로 열어 문자가 깨지는 오작동을 방지하기 위해, 문서 파싱 전용 도구를 사용하도록 AI 동작을 강제로 교정하는 안전 가드 작동.

---

## [0.2.0]

### Added

- **LFM2.5 모델 추가:** 실험적 모델 적용.
- **관용적 인자 맵핑 (Argument Normalization) 추가:** 로컬 LLM 툴 호출 안정화를 위해 AI가 파라미터를 잘못 매핑하더라도 자동 보정하는 기능 도입 (`file_path` ↔ `path`, `old_path` ↔ `file_path_a` 등).

### Changed

- **모델 최적화:** Qwen 3.5 모델을 제거하고 로컬 전용 최적화 수행.
- **구동 아키텍처 전환:** 기존 `execSync` 래퍼 방식을 kordoc 모듈의 ESM Dynamic Import로 변경하여 외부 프로세스 생성 오버헤드 완벽 제거.

### Fixed

- **오타 및 윈도우 경로 이스케이프 버그 수정:** 경로 검사기(`validatePath`)에서 실제 존재 여부를 확인하여, 오타 입력 시 사용자가 확인할 수 있는 한글 에러 안내 제공.

---

## [0.1.0]

### Added

- **Initial commit:** 로컬 환경 기반 자립형 AI 비서 프로토타입 구축.
