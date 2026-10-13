# Google Drive 백업 설정

백업은 선택 기능이며 기본은 꺼짐입니다. Google 연결 없이도 HTML 다운로드를 사용할 수 있습니다.

## 설치본을 준비하는 개발자: 최초 한 번

1. [Google Cloud Console](https://console.cloud.google.com/)에서 klasnote용 프로젝트를 선택하거나 만듭니다.
2. API 라이브러리에서 **Google Drive API**를 사용 설정합니다.
3. Google Auth Platform에서 앱 이름·지원 이메일·대상 사용자를 설정합니다. 개인 시험용이면 테스트 사용자에 연결할 Google 계정을 추가합니다.
4. 데이터 액세스에 `https://www.googleapis.com/auth/drive.file` 범위를 추가합니다. Drive 전체 읽기·쓰기 권한은 필요하지 않습니다.
5. OAuth 클라이언트를 **Chrome 확장 프로그램** 유형으로 만들고 항목 ID에 `klihhclhnhhmldcbnkpampimkjafmbdm`을 넣습니다. 로드된 확장의 ID가 같은지 먼저 확인합니다. 기존 manifest의 `key`는 유지합니다.
6. 받은 클라이언트 ID로 저장소 루트에서 실행합니다.

   ```powershell
   node scripts/configure-drive.mjs '실제클라이언트ID.apps.googleusercontent.com'
   ```

   ID는 공개 설정값입니다. 비밀번호·클라이언트 시크릿·서비스 계정 키는 사용하지 않습니다. 명령은 `extension/manifest.json`의 `oauth2`만 설정합니다.
7. 개발용 확장은 `chrome://extensions`에서 다시 로드합니다. 배포본은 설정된 manifest로 다시 패키징합니다. 기존 배포 ZIP에는 이 기능이 들어 있지 않습니다.

사용자는 OAuth 클라이언트를 직접 만들 필요가 없습니다. 개발자가 준비한 설치본에서 본인 계정만 연결합니다. 공개 배포 시 Google Auth Platform에서 대상 사용자와 앱 게시 상태를 확인합니다.

공식 참고: [Chrome 확장 OAuth](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth), [Drive 권한 범위](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

## 사용하는 사람

1. klasnote **설정 → Google Drive 백업(선택)** 에서 **Google 계정 연결**을 누릅니다.
2. Google API 사이트 접근과 Google 로그인·Drive 파일 권한을 허용합니다. Chrome에 로그인한 계정과 연결할 계정을 확인합니다.
3. **HTML 다운로드 시 자동 백업**을 켭니다. 이 스위치는 즉시 저장되며 다른 설정의 저장 버튼과 별개입니다. 연결만 한 상태에서는 업로드하지 않습니다.
4. 다음 HTML 다운로드부터 PC 다운로드가 **완료**된 뒤 같은 HTML을 내 Drive의 `KLAS요약/과목명`에 백업합니다. 원문·요약본은 별도 파일이며 같은 종류의 재저장은 기존 파일을 갱신합니다. 공유 권한이나 공개 링크는 만들지 않습니다.

강의 목록·패널·내 강의 기록에 작은 구름 표시가 나옵니다. `Drive`는 백업 확인, `백업 중`은 진행 중, `백업 실패`는 클릭하여 재시도, `이전 백업`은 현재 내용보다 오래된 백업, `백업 없음`은 파일 삭제·휴지통 상태, `확인 필요`는 인증·통신 등으로 현재 존재를 확인하지 못한 상태입니다. 표시 위에 마우스를 올리면 종류·상태·마지막 확인 시간을 볼 수 있습니다.

화면을 열 때 최대 1분 간격으로 이 앱의 파일 목록을 확인합니다. 설정의 **백업 상태 확인**으로 바로 갱신할 수 있습니다. 이미 Drive에 직접 올린 다른 HTML 전체를 검색하지는 않습니다.

백업 실패는 로컬 HTML과 AI 결과를 지우지 않습니다. 실패한 HTML은 브라우저 안에 재시도용으로 남고 성공하면 해제됩니다. Chrome이 다시 시작돼도 대기 중인 백업을 이어서 처리합니다. 백업 끄기는 업로드를 중지하고, 연결 해제는 대기 파일도 해제합니다. 로컬 강의 기록 삭제는 해당 강의의 대기 백업을 취소하며 Drive 파일은 남깁니다.

## 실제 연결 검증

OAuth ID를 설정하기 전에는 실제 로그인·업로드를 검증할 수 없습니다. 설정 후에는 원문 다운로드와 요약 다운로드 각각에서 로컬 파일과 Drive 파일의 내용을 비교하고, 재저장 시 파일 수가 늘지 않는지 확인합니다. 업로드 중 연결 해제, 인증 만료, 네트워크 중단, Drive 파일을 휴지통으로 이동한 뒤 상태 확인도 검증합니다. 자동 테스트는 외부 API 모의 응답으로 동작을 검증하며 실제 Google 연결 성공을 의미하지 않습니다.
