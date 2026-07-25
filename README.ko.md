# Ask Inbox

[English](README.md) ｜ [한국어](README.ko.md)

`cdragon.ask-inbox`는 Claude 에이전트가 `AskUserQuestion`으로 답을 기다릴 때, herdr 전체에서 하나의 FIFO 팝업으로 모아 그 자리에서 처리하는 플러그인입니다. 선택한 답변은 원래 에이전트에만 전달되며, 자동 승인은 하지 않습니다.

![Ask Inbox 팝업에서 다른 워크스페이스의 Claude 질문에 답하는 화면](docs/popup-question.png)

여러 워크스페이스에서 멈춰 있던 질문이 하나의 큐로 모입니다. 헤더의 `1/2`는 지금 보고 있는 질문이 대기 2건 중 첫 번째라는 뜻이고, 답을 고르면 곧바로 다음 질문이 같은 자리에 나타납니다. 질문을 찾아 pane을 돌아다닐 필요가 없습니다.

## 동작 방식

에이전트가 `AskUserQuestion`을 호출하면 PreToolUse hook이 요청을 큐에 넣고 **직접 팝업을 엽니다.** 팝업에서 답을 고르면 hook 응답으로 정확한 답이 원래 에이전트에 전달됩니다.

핵심은 **팝업이 살아있는 동안에만 기다린다**는 점입니다. 팝업이 뜨지 못하거나(예: 플러그인이 비활성) 도중에 닫히면, hook은 몇 초 안에 아무 결정도 반환하지 않고 종료하여 에이전트의 **네이티브 질문 UI로 돌려보냅니다.** 즉 이 플러그인 때문에 질문이 무한정 멈추는 일은 없습니다.

## 지원 범위

| 에이전트 | 대기 원인 | 처리 방식 |
| --- | --- | --- |
| Claude | `AskUserQuestion` | 팝업에서 원래 질문·선택지를 표시하고 hook 응답으로 정확한 답을 반환 |

Claude 권한 요청(`PermissionRequest`)과 Codex는 이 버전에서 다루지 않습니다. 권한 승인은 네이티브 UI에 맡겨 오배송 위험을 없앴습니다. 확신이 서지 않는 모든 경우(팝업 부재·닫힘·오류)는 원래 에이전트 UI로 되돌립니다.

## 설치

Node.js 22 이상과 herdr 0.7.5 이상이 필요합니다.

```bash
herdr plugin install speardragon/herdr-ask-inbox --yes
```

로컬에서 개발·수정하려면 클론한 뒤 로컬 링크로 설치합니다.

```bash
git clone https://github.com/speardragon/herdr-ask-inbox.git
herdr plugin link ./herdr-ask-inbox --enabled
```

설치(link/install) 과정의 build 단계는 Node 버전 확인과 전체 테스트를 실행한 뒤, Claude hook을 **자동으로 설치 또는 복구**합니다. 기존 설정 파일을 바꾸기 전에는 같은 디렉터리에 타임스탬프가 붙은 `.ask-inbox.bak` 백업을 만들며, 플러그인이 소유하지 않은 hook은 유지합니다. 설치되는 hook은 `AskUserQuestion` 하나뿐입니다.

설치 상태는 다음 명령으로 확인합니다.

```bash
herdr plugin action invoke hook-status --plugin cdragon.ask-inbox
```

대기열을 수동으로 열려면 다음 액션을 실행합니다.

```bash
herdr plugin action invoke open --plugin cdragon.ask-inbox
```

## 팝업 조작

- `↑`/`↓`, 숫자 키, `Space`, `Enter`: 항목을 선택하고 답변을 전달합니다. 여러 질문·다중 선택·자유 입력(Custom)을 지원합니다.
- `g`: 답변을 보내지 않습니다. 팝업을 닫고 해당 요청의 원래 에이전트 pane으로 포커스를 이동해 네이티브 UI에서 계속 처리합니다.
- `Esc`: 답변을 보내지 않고 팝업만 닫습니다. 에이전트는 네이티브 UI로 넘어가지만, 포커스는 이동하지 않아 지금 보던 화면에 그대로 머무릅니다.

다중 선택 질문에서는 `Space`로 여러 항목을 켜고 끈 뒤 `Enter`로 한 번에 보냅니다. 커서 아래 줄에는 항상 지금 선택지의 설명이 표시됩니다.

![다중 선택 질문에서 Space로 두 항목을 선택한 팝업 화면](docs/popup-multi-select.png)

선택지에 없는 답을 주고 싶으면 마지막 `Custom answer…`에서 `Enter`를 누르고 직접 입력합니다. 입력한 문장이 그대로 에이전트의 답변이 됩니다.

![Custom answer 항목에서 자유 입력 중인 팝업 화면](docs/popup-custom-answer.png)

팝업은 전 워크스페이스에서 하나만 열리고, 요청은 생성 순서대로 처리됩니다.

## 진단 및 복구

큐는 플러그인별 config directory 아래에 있습니다. 실제 경로는 다음으로 확인합니다.

```bash
herdr plugin config-dir cdragon.ask-inbox
```

대기 요청·팝업이 기대대로 보이지 않으면 먼저 `hook-status`로 `installed`/`missing`/`duplicate`/`changed` 상태를 확인하세요. `changed`는 사용자가 수정한 소유 hook일 수 있으므로 자동으로 덮어쓰지 말고 백업과 설정 내용을 검토한 뒤 `install-hooks`를 다시 실행합니다.

```bash
herdr plugin action invoke install-hooks --plugin cdragon.ask-inbox
```

플러그인이 비활성(`disabled`)이면 launcher가 즉시 종료하여 hook이 네이티브 UI로 fail-open 하므로, 비활성 상태에서도 질문이 멈추지 않습니다.

## 안전한 제거

다음 순서로 제거합니다.

```bash
herdr plugin action invoke uninstall-hooks --plugin cdragon.ask-inbox
herdr plugin action invoke hook-status --plugin cdragon.ask-inbox
herdr plugin unlink cdragon.ask-inbox
```

`uninstall-hooks`는 정확히 일치하는 플러그인 소유 hook만 제거합니다. 변경되었거나 중복된 marker hook은 보존하고 상태에 보고하므로, 해당 경우에는 설정과 `.ask-inbox.bak` 파일을 검토한 후 사람이 정리해야 합니다.
