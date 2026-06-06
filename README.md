# 📘 Local-Portable-AI 사용자 가이드

본 프로그램은 로컬 내부 업무 및 행정 문서(HWP, HWPX, PDF, XLSX, DOCX)의 AI 기반 자동화 분석을 지원하는 **무설치(Portable) 자립형 AI 비서**입니다. 사용자 컴퓨터에 별도의 프로그램 설치 없이 즉시 구동됩니다.

> [!IMPORTANT]
> **🛡️ 100% 완전 오프라인 보안**
> 외부 인터넷망이나 클라우드 AI 서버를 일체 거치지 않고, 사용자 PC의 내부 자원(CPU/RAM)만 사용하여 연산합니다. 입력한 모든 문서 데이터는 외부로 절대 유출되지 않습니다.
> * **권장 사양**: RAM 16GB 이상

---

## 1. 설치 및 구동 절차

### 🛠️ 설치 방법
1. **`VC_redist.x64.exe`** 파일을 실행하여 설치한 후 PC를 재부팅합니다.
2. **`Local-Portable-AI\models`** 폴더에 호환되는 모델 폴더를 넣어줍니다.
   * **v0.4 버전 기준 지원 모델 예시**:
     * `gemma-4-E2B-it-qat-UD-Q4_K_XL` (빠름, 긴 대화 길이, 낮은 성능, 이미지 지원)
     * `gemma-4-E4B-it-qat-UD-Q4_K_XL` (중간, 긴 대화 길이, 중간 성능, 이미지 지원)
     * `gemma-4-12B-it-qat-UD-Q4_K_XL` (느림, 중간 대화 길이, 고성능, 이미지 지원)
     * `gemma-4-26B-A4B-it-UD-IQ3_S` (느림, 짧은 대화 길이, 최고 성능, 이미지 미지원)

### 🚀 서버 가동 및 접속
1. 배포받은 **`Local-Portable-AI`** 폴더를 엽니다.
2. 폴더 내에 있는 **`run_server.bat`** 파일을 원하는 설정대로 더블 클릭하여 실행합니다.
3. 콘솔 창의 안내에 따라 구동할 모델 번호를 입력합니다.
4. AI 엔진 초기화가 완료되면 웹 브라우저가 자동으로 실행되면서 대화창 화면([http://127.0.0.1:8080](http://127.0.0.1:8080))이 나타납니다. (PC 사양에 따라 5초~20초 소요)

> [!WARNING]
> 프로그램 사용 중에는 백그라운드에서 구동 중인 검은색 콘솔 창을 절대로 닫으면 안 됩니다.

### ⏹️ 프로그램 종료 방법
실행 중인 웹 브라우저 탭을 닫고, 검은색 콘솔 창에서 창을 닫거나 아무 키나 누르면 백엔드 프로세스가 안전하게 자동 강제 종료됩니다.

---

## 2. 문서 분석 방법 & 파일 보관 규칙

문서를 분석하기 위해서는 AI가 안전하게 읽을 수 있도록 지정된 허용 경로에 문서를 배치해야 합니다.

### 📂 허용 디렉토리 (보안 샌드박스)
보안 상 AI는 **프로젝트 루트 폴더 및 하위 폴더**에 위치한 파일만 읽을 수 있습니다.
* **추천 보관 장소**: 프로젝트 폴더 내의 **`./작업공간`** 폴더
* 외부 바탕화면이나 다른 드라이브에 있는 파일을 지정하면 보안 수칙에 의해 접근이 차단됩니다. 분석할 파일은 반드시 `./작업공간` 내부로 복사하여 이동시켜 주세요.

### ✍️ 대화창 요청 예시
분석할 파일을 `./작업공간`에 넣은 후 AI 대화창에 다음과 같이 요청합니다.
* *"./작업공간에 있는 더미데이터.xlsx 파일을 요약해줘"*
* *"./작업공간/로컬통계보고서.hwpx 에서 올해 세수 실적 테이블만 표로 뽑아줘"*

---

## 3. PDF 문서 분석 파이프라인 (v0.4.1 기준)

v0.4.1부터 PDF 분석 시 **하이브리드 파이프라인**이 자동으로 동작합니다. PDF의 종류에 따라 최적 경로를 선택합니다.

### 📄 디지털 PDF (텍스트 레이어 내장)

일반적인 워드프로세서로 생성된 PDF입니다. 텍스트 레이어에서 원본 본문을 100% 정확하게 추출하며, 이미지 분석 모델(비전 모드)이 활성화된 경우 각 페이지 이미지를 렌더링하여 삽화·사진·도표 등 시각 요소에 대한 설명을 본문 아래에 함께 제공합니다.

```
📄 텍스트 레이어 추출 (kordoc, 100% 원본 보존)
    +
🖼️ 페이지 이미지 렌더링 → 비전 모델 시각 분석 (이미지/삽화 묘사)
    ↓
최종 결합 마크다운 (본문 텍스트 + 📷 시각 자료 명세)
```

### 🖼️ 스캔 PDF (이미지 기반, 텍스트 레이어 없음)

스캐너로 촬영되거나 이미지를 PDF로 변환한 문서입니다. 각 페이지를 고해상도 이미지로 렌더링한 뒤 OCR과 비전 분석을 병행 수행합니다.

```
🖼️ 전체 페이지 고해상도 렌더링 (pdfjs, 실제 페이지 수 자동 감지)
    ↓
🔤 Tesseract OCR (한국어+영어 텍스트 추출)
    +
👁️ 비전 모델 시각 분석 (이미지·도표 묘사, 비전 모드 시)
    ↓
페이지별 OCR 텍스트 + 📷 시각 자료 명세
```

### ⏱️ 문서 분석 소요 시간 안내

| 문서 유형 | 분석 방식 | 예상 소요 시간 |
|---|---|---|
| 텍스트 기반 PDF | 텍스트 레이어 추출 (즉시) + 비전 분석 (페이지당) | 수 초 ~ 페이지당 수 분 |
| 스캔 기반 PDF | 전 페이지 OCR + 비전 분석 | 페이지당 수 분 |
| HWPX / XLSX / DOCX | kordoc 직접 파싱 | 수 초 이내 |
| PNG / JPG 단일 이미지 | Tesseract OCR + 비전 분석 | 수 초 ~ 수 분 |

> [!NOTE]
> **비전 모드란?** `run_server.bat`에서 이미지 인식을 지원하는 모델(gemma-4 시리즈 E2B·E4B·12B)을 선택했을 때 활성화됩니다. 시각 요소 분석에 추가 시간이 소요되지만, 이미지나 삽화가 포함된 문서를 훨씬 정확하게 이해합니다.

> [!TIP]
> **분석 속도를 높이려면?**
> - 이미지 페이지 분석이 필요 없다면 `gemma-4-26B` 모델(이미지 미지원)을 선택하면 텍스트 파싱만 수행하여 훨씬 빠릅니다.
> - 이미 분석한 문서는 `.mcp_cache/` 폴더에 자동 캐싱되어 두 번째 요청부터 즉시 응답합니다.

### 🛡️ 자동 폴백 (Fallback) 시스템

비전 API가 응답하지 않거나 타임아웃이 발생하면 시스템이 **자동으로 더 빠른 방법으로 전환**합니다. 별도의 조작 없이도 분석이 완료됩니다.

```
1️⃣ 비전 모델 (이미지 시각 분석, 페이지당 최대 20분 대기)
     ↓ 타임아웃 또는 연결 실패 시 자동 전환
2️⃣ Tesseract OCR (이미지 내 텍스트 추출)
```

---

## 4. 자동 캐시 시스템

동일한 문서를 다시 분석 요청하면 `.mcp_cache/` 폴더에 저장된 결과를 즉시 반환합니다. 파일을 수정하고 저장하면 파일 크기·수정 시간이 변경됨을 감지하여 캐시를 자동 무효화하고 최신 내용으로 재분석합니다.

---

## 5. 사용된 기술 (Powered By)

> [!NOTE]
> 아래 라이브러리들은 모두 프로그램 내부에 포함되어 있습니다. 사용자가 별도로 설치할 필요가 없습니다.

[![kordoc](https://img.shields.io/badge/kordoc-v2.9.0-blue?style=for-the-badge&logo=npm)](https://www.npmjs.com/package/kordoc)
[![pdfjs-dist](https://img.shields.io/badge/pdfjs--dist-v4.10-orange?style=for-the-badge&logo=mozilla)](https://github.com/mozilla/pdf.js)
[![tesseract.js](https://img.shields.io/badge/tesseract.js-v7.0-green?style=for-the-badge&logo=npm)](https://github.com/naptha/tesseract.js)
[![canvas](https://img.shields.io/badge/node--canvas-v3.2-yellow?style=for-the-badge&logo=npm)](https://github.com/Automattic/node-canvas)
[![llama.cpp](https://img.shields.io/badge/llama.cpp-latest-red?style=for-the-badge&logo=github)](https://github.com/ggml-org/llama.cpp)

| 라이브러리 | 역할 |
|---|---|
| **[kordoc](https://www.npmjs.com/package/kordoc)** | HWP·HWPX·PDF·XLSX·DOCX 파싱 및 마크다운 변환 |
| **[Mozilla PDF.js](https://github.com/mozilla/pdf.js)** | PDF 페이지 고해상도 캔버스 렌더링 (스캔 PDF OCR용) |
| **[Tesseract.js](https://github.com/naptha/tesseract.js)** | 한국어·영어 OCR 텍스트 추출 (스캔 문서 처리) |
| **[node-canvas](https://github.com/Automattic/node-canvas)** | Node.js 환경에서 PDF 렌더링을 위한 Canvas API 구현 |
| **[llama.cpp](https://github.com/ggml-org/llama.cpp)** | 로컬 LLM·비전 모델 추론 서버 (llama-server) |
