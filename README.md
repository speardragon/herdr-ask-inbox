# Herdr Question

`ray.herdr-question`은 Claude·Codex 에이전트가 질문 또는 권한 승인을 기다릴 때, herdr 전체에서 하나의 FIFO 팝업으로 모아 처리하는 플러그인입니다. 선택한 답변은 원래 에이전트에만 전달됩니다.

## 설치

Node.js 22 이상과 herdr 0.7.5 이상이 필요합니다.

```bash
herdr plugin link ./speardragon/herdr-question --enabled
```

링크 과정의 build 단계는 Node 버전 확인과 전체 테스트를 실행한 뒤, Claude/Codex hook을 **자동으로 설치 또는 복구**합니다. 기존 설정 파일을 바꾸기 전에는 같은 디렉터리에 타임스탬프가 붙은 `.herdr-question.bak` 백업을 만들며, 플러그인이 소유하지 않은 hook은 유지합니다.

Codex는 설치 후 `/hooks`에서 trust review를 완료해야 hook이 동작합니다. 이 플러그인은 trust 상태를 읽거나 바꾸지 않습니다.

설치 상태는 다음 명령으로 확인합니다.

```bash
herdr plugin action invoke hook-status --plugin ray.herdr-question
```

대기열을 수동으로 열려면 다음 액션을 실행합니다.

```bash
herdr plugin action invoke open --plugin ray.herdr-question
```

## 지원 범위

| 에이전트 | 대기 원인 | 처리 방식 |
| --- | --- | --- |
| Claude | `AskUserQuestion` | 팝업에서 원래 질문·선택지를 표시하고 hook 응답으로 정확한 답을 반환 |
| Claude | 권한 요청 | upstream이 제공한 선택지만 그대로 반환 |
| Codex | `request_user_input` | 검증된 화면·지원 버전에서만 named key를 전송 |
| Codex | 권한 요청 | `allow`/`deny`만 hook 응답으로 반환; 지속 권한 선택은 원래 UI로 handoff |

Codex 화면 버전을 알 수 없거나, 화면 내용이 캡처한 요청과 다르거나, 선택이 애매하면 어떤 키도 전송하지 않습니다. 모든 malformed·stale 요청과 알 수 없는 버전은 원래 에이전트 UI로 되돌립니다.

## 팝업 조작

- `↑`/`↓`, 숫자 키, `Space`, `Enter`: 항목을 선택하고 답변/승인을 전달합니다.
- `g` 또는 `Esc`: 답변을 보내지 않습니다. 팝업을 닫고 해당 요청의 원래 에이전트 pane으로 포커스를 이동해 네이티브 UI에서 계속 처리합니다.

팝업은 전 워크스페이스에서 하나만 열리고, 요청은 생성 순서대로 처리됩니다. 플러그인은 자동 승인하지 않으며, 권한 규칙을 임의로 만들지 않습니다.

## 진단 및 복구

큐는 플러그인별 config directory 아래에 있습니다. 실제 경로는 다음으로 확인합니다.

```bash
herdr plugin config-dir ray.herdr-question
```

대기 요청·팝업이 기대대로 보이지 않으면 먼저 `hook-status`로 `installed`/`missing`/`duplicate`/`changed` 상태를 확인하고, Codex의 `/hooks` trust review도 확인하세요. `changed`는 사용자가 수정한 소유 hook일 수 있으므로 자동으로 덮어쓰지 말고 백업과 설정 내용을 검토한 뒤 `install-hooks`를 다시 실행합니다.

```bash
herdr plugin action invoke install-hooks --plugin ray.herdr-question
```

로컬 스모크 명령은 기본적으로 읽기 전용입니다.

```bash
node speardragon/herdr-question/bin/smoke.mjs
```

아래 명령은 **의도적으로 blocked 상태로 만든 테스트 Claude pane**의 pane/session을 반드시 명시해야 합니다. 먼저 fresh herdr snapshot에서 해당 pane, Claude agent, session, `blocked` 상태가 정확히 일치하는지 확인한 뒤 synthetic 요청을 queue에 넣고 실제 popup을 엽니다. popup에서 `g` 또는 `Esc`를 누르면 native UI handoff와 원래 pane 포커스를 검증한 뒤 synthetic queue 상태를 정리합니다. agent key 전송과 hook 설정 변경은 하지 않습니다.

```bash
node speardragon/herdr-question/bin/smoke.mjs --confirm-local \
  --pane-id '<blocked-pane-id>' --session-id '<agent-session-id>'
```

스모크 실행 중 열린 popup에서는 `g` 또는 `Esc`만 눌러 원래 pane으로 돌아가는지만 확인하세요. 실제 에이전트 요청을 선택하거나 승인하지 마세요. 오류·SIGINT·SIGTERM에는 synthetic 요청을 취소합니다.

## 안전한 제거

다음 순서로 제거합니다.

```bash
herdr plugin action invoke uninstall-hooks --plugin ray.herdr-question
herdr plugin action invoke hook-status --plugin ray.herdr-question
herdr plugin unlink ray.herdr-question
```

`uninstall-hooks`는 정확히 일치하는 플러그인 소유 hook만 제거합니다. 변경되었거나 중복된 marker hook은 보존하고 상태에 보고하므로, 해당 경우에는 설정과 `.herdr-question.bak` 파일을 검토한 후 사람이 정리해야 합니다.
