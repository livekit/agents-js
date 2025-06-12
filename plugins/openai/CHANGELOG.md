# @livekit/agents-plugin-openai

## 0.9.1

### Patch Changes

- ignore apiKey if isAzure & entraToken - [#339](https://github.com/livekit/agents-js/pull/339) ([@nbsp](https://github.com/nbsp))

- feat(openai): add new TTS model and voices, include optional instruct… - [#351](https://github.com/livekit/agents-js/pull/351) ([@tomc98](https://github.com/tomc98))

- Updated dependencies [[`d44445934cc291df987013068f5c43491634dfa1`](https://github.com/livekit/agents-js/commit/d44445934cc291df987013068f5c43491634dfa1), [`a7350c92f8968e0fd833e7679a607eaf9a1d7e7f`](https://github.com/livekit/agents-js/commit/a7350c92f8968e0fd833e7679a607eaf9a1d7e7f), [`2dcfeab76ace2e1851993771d769ebcb7c188144`](https://github.com/livekit/agents-js/commit/2dcfeab76ace2e1851993771d769ebcb7c188144), [`2bb936c55233ac0747582a5045caa595c6338651`](https://github.com/livekit/agents-js/commit/2bb936c55233ac0747582a5045caa595c6338651)]:
  - @livekit/agents@0.7.2

## 0.9.0

### Minor Changes

- Narrow tools inventory per session update - [#93](https://github.com/livekit/agents-js/pull/93) ([@tillkolter](https://github.com/tillkolter))

### Patch Changes

- Updated dependencies [[`724c02bb7a91c27d6c8daf961842fb9f0934770c`](https://github.com/livekit/agents-js/commit/724c02bb7a91c27d6c8daf961842fb9f0934770c), [`7398cffad62b17c79b5fe2f0ca4e99e548560367`](https://github.com/livekit/agents-js/commit/7398cffad62b17c79b5fe2f0ca4e99e548560367), [`6ed0c90d1bab013854c416768b10ef96f3227d68`](https://github.com/livekit/agents-js/commit/6ed0c90d1bab013854c416768b10ef96f3227d68), [`33c241960f0e8f325f534d2406f42148a4486b5a`](https://github.com/livekit/agents-js/commit/33c241960f0e8f325f534d2406f42148a4486b5a)]:
  - @livekit/agents@0.7.1

## 0.8.2

### Patch Changes

- fix feeding null LLM input - [#296](https://github.com/livekit/agents-js/pull/296) ([@nbsp](https://github.com/nbsp))

- Updated dependencies [[`4681792123ebf7eb6f75d89efe32ec11cb1ee179`](https://github.com/livekit/agents-js/commit/4681792123ebf7eb6f75d89efe32ec11cb1ee179), [`3e1b2d0fd07a5fab53bf20c151faad3fd9bfa77d`](https://github.com/livekit/agents-js/commit/3e1b2d0fd07a5fab53bf20c151faad3fd9bfa77d), [`b0fa6007372dc798e222487e87f7b80f1a64ac4e`](https://github.com/livekit/agents-js/commit/b0fa6007372dc798e222487e87f7b80f1a64ac4e), [`c2794335d5395744e9ba0c6691a4ff6bb7c28e40`](https://github.com/livekit/agents-js/commit/c2794335d5395744e9ba0c6691a4ff6bb7c28e40), [`a3d025047e62d89e935b878502735a0768076d7c`](https://github.com/livekit/agents-js/commit/a3d025047e62d89e935b878502735a0768076d7c), [`629c737098b6b6636356527bbe8a4e81d8b6f047`](https://github.com/livekit/agents-js/commit/629c737098b6b6636356527bbe8a4e81d8b6f047)]:
  - @livekit/agents@0.7.0

## 0.8.1

### Patch Changes

- update rtc-node to 0.13.2 to fix issue with e2ee - [#258](https://github.com/livekit/agents-js/pull/258) ([@nbsp](https://github.com/nbsp))

- Updated dependencies [[`dedb1cf139c8af4ce8709c86440c818157f5b475`](https://github.com/livekit/agents-js/commit/dedb1cf139c8af4ce8709c86440c818157f5b475), [`f3258b948539406213c15f8e817449b2588cde84`](https://github.com/livekit/agents-js/commit/f3258b948539406213c15f8e817449b2588cde84)]:
  - @livekit/agents@0.6.2

## 0.8.0

### Minor Changes

- Add support for OpenAI Whisper STT prompt parameter - [#239](https://github.com/livekit/agents-js/pull/239) ([@FlorDonnaSanders](https://github.com/FlorDonnaSanders))

### Patch Changes

- re-request audio response in multimodal agent when text is given - [#243](https://github.com/livekit/agents-js/pull/243) ([@nbsp](https://github.com/nbsp))

- Updated dependencies [[`4a66a82fc2fd0a25e30bdaa0bd095804c65ee101`](https://github.com/livekit/agents-js/commit/4a66a82fc2fd0a25e30bdaa0bd095804c65ee101), [`01aaa85445bbb8f30afe9c16360afb5a45c38e9e`](https://github.com/livekit/agents-js/commit/01aaa85445bbb8f30afe9c16360afb5a45c38e9e), [`4b7504654c73d9111d39e90d325d5f660b2c8ad9`](https://github.com/livekit/agents-js/commit/4b7504654c73d9111d39e90d325d5f660b2c8ad9)]:
  - @livekit/agents@0.6.1

## 0.7.3

### Patch Changes

- fix multiple function calls not firing - [#227](https://github.com/livekit/agents-js/pull/227) ([@nbsp](https://github.com/nbsp))

- fix(tts): add missing crypto import to OpenAI tts - [#227](https://github.com/livekit/agents-js/pull/227) ([@nbsp](https://github.com/nbsp))

- groq: add support for llama 3.3 70b - [#227](https://github.com/livekit/agents-js/pull/227) ([@nbsp](https://github.com/nbsp))

- add metrics monitoring - [#227](https://github.com/livekit/agents-js/pull/227) ([@nbsp](https://github.com/nbsp))

- add testutils, tests for oai, 11labs - [#227](https://github.com/livekit/agents-js/pull/227) ([@nbsp](https://github.com/nbsp))

- Updated dependencies [[`ab0b7e81b12c8fcfea35accff8fd72f5cf6c43b0`](https://github.com/livekit/agents-js/commit/ab0b7e81b12c8fcfea35accff8fd72f5cf6c43b0), [`ab0b7e81b12c8fcfea35accff8fd72f5cf6c43b0`](https://github.com/livekit/agents-js/commit/ab0b7e81b12c8fcfea35accff8fd72f5cf6c43b0), [`ab0b7e81b12c8fcfea35accff8fd72f5cf6c43b0`](https://github.com/livekit/agents-js/commit/ab0b7e81b12c8fcfea35accff8fd72f5cf6c43b0), [`ab0b7e81b12c8fcfea35accff8fd72f5cf6c43b0`](https://github.com/livekit/agents-js/commit/ab0b7e81b12c8fcfea35accff8fd72f5cf6c43b0), [`ab0b7e81b12c8fcfea35accff8fd72f5cf6c43b0`](https://github.com/livekit/agents-js/commit/ab0b7e81b12c8fcfea35accff8fd72f5cf6c43b0), [`ab0b7e81b12c8fcfea35accff8fd72f5cf6c43b0`](https://github.com/livekit/agents-js/commit/ab0b7e81b12c8fcfea35accff8fd72f5cf6c43b0), [`ab0b7e81b12c8fcfea35accff8fd72f5cf6c43b0`](https://github.com/livekit/agents-js/commit/ab0b7e81b12c8fcfea35accff8fd72f5cf6c43b0), [`ab0b7e81b12c8fcfea35accff8fd72f5cf6c43b0`](https://github.com/livekit/agents-js/commit/ab0b7e81b12c8fcfea35accff8fd72f5cf6c43b0)]:
  - @livekit/agents@0.6.0

## 0.7.2

### Patch Changes

- fix(tts): add missing crypto import to OpenAI tts - [#219](https://github.com/livekit/agents-js/pull/219) ([@nbsp](https://github.com/nbsp))

- groq: add support for llama 3.3 70b - [#219](https://github.com/livekit/agents-js/pull/219) ([@nbsp](https://github.com/nbsp))

- Updated dependencies [[`9e15430387406e59947ef19974ed71b2fc766107`](https://github.com/livekit/agents-js/commit/9e15430387406e59947ef19974ed71b2fc766107)]:
  - @livekit/agents@0.5.2

## 0.7.1

### Patch Changes

- fix multiple function calls not firing - [#206](https://github.com/livekit/agents-js/pull/206) ([@nbsp](https://github.com/nbsp))

- add testutils, tests for oai, 11labs - [#206](https://github.com/livekit/agents-js/pull/206) ([@nbsp](https://github.com/nbsp))

- Updated dependencies [[`67bad88bb59328fac03320e88c245871005ccc05`](https://github.com/livekit/agents-js/commit/67bad88bb59328fac03320e88c245871005ccc05), [`beb141f7de380d5a938347a2eda76d56f706333c`](https://github.com/livekit/agents-js/commit/beb141f7de380d5a938347a2eda76d56f706333c), [`8fa2b176bb6bdeba34430d59b23024d935f77453`](https://github.com/livekit/agents-js/commit/8fa2b176bb6bdeba34430d59b23024d935f77453)]:
  - @livekit/agents@0.5.1

## 0.7.0

### Minor Changes

- support native CommonJS - [#187](https://github.com/livekit/agents-js/pull/187) ([@nbsp](https://github.com/nbsp))

### Patch Changes

- chore(treewide): add READMEs for npmjs.com - [#187](https://github.com/livekit/agents-js/pull/187) ([@nbsp](https://github.com/nbsp))

- Updated dependencies [[`9c9b73d3b9d3ed7b8ce071470492991dcd21d546`](https://github.com/livekit/agents-js/commit/9c9b73d3b9d3ed7b8ce071470492991dcd21d546), [`9c9b73d3b9d3ed7b8ce071470492991dcd21d546`](https://github.com/livekit/agents-js/commit/9c9b73d3b9d3ed7b8ce071470492991dcd21d546), [`9c9b73d3b9d3ed7b8ce071470492991dcd21d546`](https://github.com/livekit/agents-js/commit/9c9b73d3b9d3ed7b8ce071470492991dcd21d546)]:
  - @livekit/agents@0.5.0

## 0.6.1

### Patch Changes

- Add missing package info - [#172](https://github.com/livekit/agents-js/pull/172) ([@lukasIO](https://github.com/lukasIO))

- add new OpenAI realtime voices - [#174](https://github.com/livekit/agents-js/pull/174) ([@bcherry](https://github.com/bcherry))

- Updated dependencies [[`ad3c34823fc1955a4274e912ef0587d9b7f2218d`](https://github.com/livekit/agents-js/commit/ad3c34823fc1955a4274e912ef0587d9b7f2218d), [`1d74e20a0337e548af2cb87b64e131907648cc06`](https://github.com/livekit/agents-js/commit/1d74e20a0337e548af2cb87b64e131907648cc06), [`4aaec04857c623fef75ac6800fc9a078efdd4391`](https://github.com/livekit/agents-js/commit/4aaec04857c623fef75ac6800fc9a078efdd4391), [`4aaec04857c623fef75ac6800fc9a078efdd4391`](https://github.com/livekit/agents-js/commit/4aaec04857c623fef75ac6800fc9a078efdd4391)]:
  - @livekit/agents@0.4.6

## 0.6.0

### Minor Changes

- Emit events for response text delta and done - [#160](https://github.com/livekit/agents-js/pull/160) ([@danielmahon](https://github.com/danielmahon))

### Patch Changes

- Use peer dependencies for @livekit/rtc-node and @livekit/agents - [#170](https://github.com/livekit/agents-js/pull/170) ([@lukasIO](https://github.com/lukasIO))

- chore(tsconfig): enable `noUncheckedIndexedAccess` - [#168](https://github.com/livekit/agents-js/pull/168) ([@nbsp](https://github.com/nbsp))

- feat(openai): allow raw JSON function parameters - [#146](https://github.com/livekit/agents-js/pull/146) ([@nbsp](https://github.com/nbsp))

- Updated dependencies [[`f5dc9896a9eec2ba1e703d7209936bcc22d46b33`](https://github.com/livekit/agents-js/commit/f5dc9896a9eec2ba1e703d7209936bcc22d46b33), [`141519068094ca72f0fa86c4ee829ab3746bc02f`](https://github.com/livekit/agents-js/commit/141519068094ca72f0fa86c4ee829ab3746bc02f), [`6bff3b030063b2e851946b90ad9e7d981a46e2aa`](https://github.com/livekit/agents-js/commit/6bff3b030063b2e851946b90ad9e7d981a46e2aa), [`b719e7d5ffa37b541b219cd05c631483480e2103`](https://github.com/livekit/agents-js/commit/b719e7d5ffa37b541b219cd05c631483480e2103), [`1558b9bc4ed8ddc1c6b552875549a4fb96ec3802`](https://github.com/livekit/agents-js/commit/1558b9bc4ed8ddc1c6b552875549a4fb96ec3802)]:
  - @livekit/agents@0.4.5

## 0.5.0

### Minor Changes

- add OpenAI/Groq STT - [#153](https://github.com/livekit/agents-js/pull/153) ([@nbsp](https://github.com/nbsp))

### Patch Changes

- add ChunkedStream, openai.TTS - [#155](https://github.com/livekit/agents-js/pull/155) ([@nbsp](https://github.com/nbsp))

- Updated dependencies [[`95ac1798daf846a14a4fb8b240412a7f66a897e6`](https://github.com/livekit/agents-js/commit/95ac1798daf846a14a4fb8b240412a7f66a897e6), [`cb500cb4319aab982d965c2ff118d2acbac965a8`](https://github.com/livekit/agents-js/commit/cb500cb4319aab982d965c2ff118d2acbac965a8), [`ddab1203ac56a88aa44defcc46f60b761b006292`](https://github.com/livekit/agents-js/commit/ddab1203ac56a88aa44defcc46f60b761b006292), [`cb500cb4319aab982d965c2ff118d2acbac965a8`](https://github.com/livekit/agents-js/commit/cb500cb4319aab982d965c2ff118d2acbac965a8)]:
  - @livekit/agents@0.4.4

## 0.4.3

### Patch Changes

- Updated dependencies []:
  - @livekit/agents@0.4.3

## 0.4.2

### Patch Changes

- Updated dependencies [[`38dd4c7d820de6faad512f0ac57c60f0fb1963be`](https://github.com/livekit/agents-js/commit/38dd4c7d820de6faad512f0ac57c60f0fb1963be)]:
  - @livekit/agents@0.4.2

## 0.4.1

### Patch Changes

- Updated dependencies [[`d2f1ef9f54cd7dd13892aa2ebe2f3f348b01afcb`](https://github.com/livekit/agents-js/commit/d2f1ef9f54cd7dd13892aa2ebe2f3f348b01afcb)]:
  - @livekit/agents@0.4.1

## 0.4.0

### Minor Changes

- OpenAI function calling: support arrays and optional fields in function call schema - [#140](https://github.com/livekit/agents-js/pull/140) ([@nbsp](https://github.com/nbsp))

- add OpenAI LLM - [#140](https://github.com/livekit/agents-js/pull/140) ([@nbsp](https://github.com/nbsp))

### Patch Changes

- add ChatContext - [#140](https://github.com/livekit/agents-js/pull/140) ([@nbsp](https://github.com/nbsp))

- Updated dependencies [[`d9273f27ae8df6c41e56a8258f540a4ffd9a7b7b`](https://github.com/livekit/agents-js/commit/d9273f27ae8df6c41e56a8258f540a4ffd9a7b7b), [`b4b9c1d337ff9a0212e90fb31002d4fcf58fe287`](https://github.com/livekit/agents-js/commit/b4b9c1d337ff9a0212e90fb31002d4fcf58fe287), [`4713a0490a3e4cd823aa648172c618ea924ae5d6`](https://github.com/livekit/agents-js/commit/4713a0490a3e4cd823aa648172c618ea924ae5d6), [`09782ec316590aa956d1a234dfb5594a8974dbfc`](https://github.com/livekit/agents-js/commit/09782ec316590aa956d1a234dfb5594a8974dbfc), [`d32f2470d4d1ea6786f4e13334f7251cc9823c04`](https://github.com/livekit/agents-js/commit/d32f2470d4d1ea6786f4e13334f7251cc9823c04), [`37bcf55aa75a289978af82e86332298dd7c07c73`](https://github.com/livekit/agents-js/commit/37bcf55aa75a289978af82e86332298dd7c07c73), [`35265a5b58adcbc048078d39c115412734dd4462`](https://github.com/livekit/agents-js/commit/35265a5b58adcbc048078d39c115412734dd4462), [`61899cde8c7fc19791d9d7d6a5ccabc2bb8f94dd`](https://github.com/livekit/agents-js/commit/61899cde8c7fc19791d9d7d6a5ccabc2bb8f94dd), [`644effb7c607e214e8d3ff8147afa7aec4a2496b`](https://github.com/livekit/agents-js/commit/644effb7c607e214e8d3ff8147afa7aec4a2496b), [`0e40262f3a60823d3d9cabbbd90f71c943db6c0e`](https://github.com/livekit/agents-js/commit/0e40262f3a60823d3d9cabbbd90f71c943db6c0e), [`cb788b7c37ca2297c04f5deb410a2fdab70d5c5f`](https://github.com/livekit/agents-js/commit/cb788b7c37ca2297c04f5deb410a2fdab70d5c5f), [`f844e8bb865beadbc58ea1c3a21e362aee1dce55`](https://github.com/livekit/agents-js/commit/f844e8bb865beadbc58ea1c3a21e362aee1dce55)]:
  - @livekit/agents@0.4.0

## 0.3.5

### Patch Changes

- fix(treewide): use newer rtc-node version - [#118](https://github.com/livekit/agents-js/pull/118) ([@nbsp](https://github.com/nbsp))

- Update everything to rtc 0.11.0 - [#125](https://github.com/livekit/agents-js/pull/125) ([@bcherry](https://github.com/bcherry))

- Updated dependencies [[`1697907941f6afbbfcc6385d56d0894abb8768cc`](https://github.com/livekit/agents-js/commit/1697907941f6afbbfcc6385d56d0894abb8768cc), [`99eb758e6b3e965cb842e4ba6ef95551978fd1e0`](https://github.com/livekit/agents-js/commit/99eb758e6b3e965cb842e4ba6ef95551978fd1e0), [`d8de7546566324cbb456613578c403c721481cb5`](https://github.com/livekit/agents-js/commit/d8de7546566324cbb456613578c403c721481cb5)]:
  - @livekit/agents@0.3.5

## 0.3.4

### Patch Changes

- Updated dependencies [[`2f158493ebb53df28d9941c2bd24d811cf62495a`](https://github.com/livekit/agents-js/commit/2f158493ebb53df28d9941c2bd24d811cf62495a), [`ed3d7595a8a0ab3fd1bfeb738c7d38889ceaf358`](https://github.com/livekit/agents-js/commit/ed3d7595a8a0ab3fd1bfeb738c7d38889ceaf358)]:
  - @livekit/agents@0.3.4

## 0.3.3

### Patch Changes

- Support for Azure OpenAI Realtime - [#110](https://github.com/livekit/agents-js/pull/110) ([@nbsp](https://github.com/nbsp))

- Updated dependencies [[`062935a1677a4a6f6c99f7cd52dfebae41039a85`](https://github.com/livekit/agents-js/commit/062935a1677a4a6f6c99f7cd52dfebae41039a85), [`062935a1677a4a6f6c99f7cd52dfebae41039a85`](https://github.com/livekit/agents-js/commit/062935a1677a4a6f6c99f7cd52dfebae41039a85)]:
  - @livekit/agents@0.3.3

## 0.3.2

### Patch Changes

- A few more bugs and updates - [#88](https://github.com/livekit/agents-js/pull/88) ([@bcherry](https://github.com/bcherry))

- Updated dependencies [[`56333dd89486a1a10157f57576447d3bb7cb83c3`](https://github.com/livekit/agents-js/commit/56333dd89486a1a10157f57576447d3bb7cb83c3), [`07b4d4b123955bd850a208471d651810e075f0af`](https://github.com/livekit/agents-js/commit/07b4d4b123955bd850a208471d651810e075f0af)]:
  - @livekit/agents@0.3.2

## 0.3.1

### Patch Changes

- implement session close - [#79](https://github.com/livekit/agents-js/pull/79) ([@nbsp](https://github.com/nbsp))

- make sure rejects return errors, not string - [#84](https://github.com/livekit/agents-js/pull/84) ([@nbsp](https://github.com/nbsp))

- Updated dependencies [[`d3db7cf19c696f611b5717ff8d510b2f910da712`](https://github.com/livekit/agents-js/commit/d3db7cf19c696f611b5717ff8d510b2f910da712), [`c0cce8a0f71cd8def7052917d8a6479e06178447`](https://github.com/livekit/agents-js/commit/c0cce8a0f71cd8def7052917d8a6479e06178447), [`e748aa4f7be76361c5fcafb03bdb760314b29a9f`](https://github.com/livekit/agents-js/commit/e748aa4f7be76361c5fcafb03bdb760314b29a9f), [`b35952ca243fecb087c898b670f5db0eaa1949bf`](https://github.com/livekit/agents-js/commit/b35952ca243fecb087c898b670f5db0eaa1949bf), [`4edacb8ba7dbbdd060dfedffe3116f1af4739b52`](https://github.com/livekit/agents-js/commit/4edacb8ba7dbbdd060dfedffe3116f1af4739b52)]:
  - @livekit/agents@0.3.1

## 0.3.0

### Minor Changes

- Hotfix for new API format - [#67](https://github.com/livekit/agents-js/pull/67) ([@bcherry](https://github.com/bcherry))

- Rename to MultimodalAgent, move to main package - [#74](https://github.com/livekit/agents-js/pull/74) ([@bcherry](https://github.com/bcherry))

- omniassistant overhaul - [#65](https://github.com/livekit/agents-js/pull/65) ([@nbsp](https://github.com/nbsp))

### Patch Changes

- update rtc-node to 0.9.0 - [#73](https://github.com/livekit/agents-js/pull/73) ([@nbsp](https://github.com/nbsp))

- Updated dependencies [[`9cb2313f06f9d013ca3b08980a7ade1b6b43a04a`](https://github.com/livekit/agents-js/commit/9cb2313f06f9d013ca3b08980a7ade1b6b43a04a), [`08b9a329c05a6a1369de7682f555445f669fea79`](https://github.com/livekit/agents-js/commit/08b9a329c05a6a1369de7682f555445f669fea79), [`d703265a57c4491d7799936117a8a2b8ad527653`](https://github.com/livekit/agents-js/commit/d703265a57c4491d7799936117a8a2b8ad527653), [`5cbd46c715ded05107cd78492d85551c2ce924ae`](https://github.com/livekit/agents-js/commit/5cbd46c715ded05107cd78492d85551c2ce924ae), [`eee688907aafdef8ca2856929b8eb10ba72e8dee`](https://github.com/livekit/agents-js/commit/eee688907aafdef8ca2856929b8eb10ba72e8dee), [`9cb2313f06f9d013ca3b08980a7ade1b6b43a04a`](https://github.com/livekit/agents-js/commit/9cb2313f06f9d013ca3b08980a7ade1b6b43a04a), [`856ebe2294962f64b81c8f635bd762b513b2faac`](https://github.com/livekit/agents-js/commit/856ebe2294962f64b81c8f635bd762b513b2faac), [`c509b62972892ea3945403ef0cd50c2ece3fd4f2`](https://github.com/livekit/agents-js/commit/c509b62972892ea3945403ef0cd50c2ece3fd4f2), [`45cb43f41a5d53a048eef392bb81313ad5e95121`](https://github.com/livekit/agents-js/commit/45cb43f41a5d53a048eef392bb81313ad5e95121), [`eb7e73173c46dbbcee4e728299b8fe05fb8fdc01`](https://github.com/livekit/agents-js/commit/eb7e73173c46dbbcee4e728299b8fe05fb8fdc01)]:
  - @livekit/agents@0.3.0

## 0.2.0

### Minor Changes

- mark omniassistant as alpha - [#59](https://github.com/livekit/agents-js/pull/59) ([@nbsp](https://github.com/nbsp))

### Patch Changes

- Fix assistant startup process - [#36](https://github.com/livekit/agents-js/pull/36) ([@bcherry](https://github.com/bcherry))

- Send agent transcript progressively and handle interruptions - [#40](https://github.com/livekit/agents-js/pull/40) ([@bcherry](https://github.com/bcherry))

- Add transcript support to realtime voice assistant - [`1063d2a25c4a01022948699e673d267d04c1ec05`](https://github.com/livekit/agents-js/commit/1063d2a25c4a01022948699e673d267d04c1ec05) ([@bcherry](https://github.com/bcherry))

- Updated dependencies [[`1c8caf04c148dfa57af4e844b6538d97d6be652a`](https://github.com/livekit/agents-js/commit/1c8caf04c148dfa57af4e844b6538d97d6be652a), [`5923b1a796642bec4892f41545ea1be1c6b9fb36`](https://github.com/livekit/agents-js/commit/5923b1a796642bec4892f41545ea1be1c6b9fb36), [`be7160d39ea57239a51fbf6ad2cbea1342cc1889`](https://github.com/livekit/agents-js/commit/be7160d39ea57239a51fbf6ad2cbea1342cc1889), [`24a4f58a23d4a3aad8620fcccabdab5d2e1152c7`](https://github.com/livekit/agents-js/commit/24a4f58a23d4a3aad8620fcccabdab5d2e1152c7), [`1063d2a25c4a01022948699e673d267d04c1ec05`](https://github.com/livekit/agents-js/commit/1063d2a25c4a01022948699e673d267d04c1ec05), [`36c553a60fef7621b9c4232b5c79555b2f83aad8`](https://github.com/livekit/agents-js/commit/36c553a60fef7621b9c4232b5c79555b2f83aad8)]:
  - @livekit/agents@0.2.0
