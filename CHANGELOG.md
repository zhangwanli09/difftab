# Changelog

## [0.10.0](https://github.com/zhangwanli09/difftab/compare/v0.9.0...v0.10.0) (2026-10-20)


### Features

* **web:** open all working tree changes in one tab ([#139](https://github.com/zhangwanli09/difftab/issues/139)) ([d1de7c5](https://github.com/zhangwanli09/difftab/commit/d1de7c532277aab61950a1f121a8d2c543ef1850))
* **web:** split the editor panel into two groups by dragging tabs ([#137](https://github.com/zhangwanli09/difftab/issues/137)) ([13f298b](https://github.com/zhangwanli09/difftab/commit/13f298b87e2f488002ba49ec87a04ea6667b35d3))

## [0.9.0](https://github.com/zhangwanli09/difftab/compare/v0.8.1...v0.9.0) (2026-10-18)


### Features

* **web:** add a preview toggle for SVG files ([#131](https://github.com/zhangwanli09/difftab/issues/131)) ([73ab0e2](https://github.com/zhangwanli09/difftab/commit/73ab0e20a50e2a9228b187267fefa8321993cca5))
* **web:** badge every branch and tag in the history list ([#134](https://github.com/zhangwanli09/difftab/issues/134)) ([6724873](https://github.com/zhangwanli09/difftab/commit/67248730c18cbd33df46f2a0278f2fc2e7aeb038))
* **web:** fit images to the panel and center them ([#126](https://github.com/zhangwanli09/difftab/issues/126)) ([fdc8853](https://github.com/zhangwanli09/difftab/commit/fdc88538be7d0bdf78c78fddef8761426e2e4267))
* **web:** fold unchanged lines and add a whitespace toggle to diffs ([#127](https://github.com/zhangwanli09/difftab/issues/127)) ([f486d94](https://github.com/zhangwanli09/difftab/commit/f486d94e67da318aa261c8b9768194b113e7aa4c))
* **web:** keep line numbers out of the diff's horizontal scroll ([#129](https://github.com/zhangwanli09/difftab/issues/129)) ([8059a0d](https://github.com/zhangwanli09/difftab/commit/8059a0d46c50040143e859ba93ffbfdb1a8e33b4))
* **web:** open a whole commit in one tab from the history list ([#136](https://github.com/zhangwanli09/difftab/issues/136)) ([0db7c61](https://github.com/zhangwanli09/difftab/commit/0db7c6152e1d094c4f76ec9e13a2cc24749d9b37))
* **web:** open SVG files in preview mode by default ([#133](https://github.com/zhangwanli09/difftab/issues/133)) ([90da5f7](https://github.com/zhangwanli09/difftab/commit/90da5f7d65233f1e5afacf5eb237688ef7401620))
* **web:** show incoming commits at the top of the history list ([#135](https://github.com/zhangwanli09/difftab/issues/135)) ([d32424d](https://github.com/zhangwanli09/difftab/commit/d32424da0cc6e030c2bfa491c062ea7d409d5826))
* **web:** show indent guides in both trees on hover ([#124](https://github.com/zhangwanli09/difftab/issues/124)) ([1bec194](https://github.com/zhangwanli09/difftab/commit/1bec1947fff0403fa19efa6480a6fc17daf27874))


### Bug Fixes

* **web:** align tree placeholders with file names ([#122](https://github.com/zhangwanli09/difftab/issues/122)) ([b19170a](https://github.com/zhangwanli09/difftab/commit/b19170a0a8d070e152514a039d99ebf1ec51d7ff))
* **web:** drop the border from pressed toggle buttons ([#132](https://github.com/zhangwanli09/difftab/issues/132)) ([b3b1372](https://github.com/zhangwanli09/difftab/commit/b3b137253caea2f6d488c5f1924bced79fb5d56f))
* **web:** leave the change list blank when the working tree is clean ([#128](https://github.com/zhangwanli09/difftab/issues/128)) ([76c3caf](https://github.com/zhangwanli09/difftab/commit/76c3caf66e2a75b30723046c56e48e820193213f))
* **web:** lighten tree indent guides ([#125](https://github.com/zhangwanli09/difftab/issues/125)) ([711734d](https://github.com/zhangwanli09/difftab/commit/711734d3f38c18798ab6f7021064f09e41c7093a))

## [0.8.1](https://github.com/zhangwanli09/difftab/compare/v0.8.0...v0.8.1) (2026-10-15)


### Bug Fixes

* **server:** treat ENOTCONN on stdout as a broken pipe on macOS ([#117](https://github.com/zhangwanli09/difftab/issues/117)) ([20172bd](https://github.com/zhangwanli09/difftab/commit/20172bd476a1bcd8b4d94e023d3ab7b0f3c81148))
* **web:** align the change list with VS Code Source Control ([#114](https://github.com/zhangwanli09/difftab/issues/114)) ([385cbba](https://github.com/zhangwanli09/difftab/commit/385cbbaea9dc3264058bfe0d1564203ef232d05e))

## [0.8.0](https://github.com/zhangwanli09/difftab/compare/v0.7.0...v0.8.0) (2026-10-14)


### Features

* **web:** color tab names by git status and show dirs only on clashes ([#110](https://github.com/zhangwanli09/difftab/issues/110)) ([eb93ee6](https://github.com/zhangwanli09/difftab/commit/eb93ee6981b396bbd24d3c82b77d8ebac737b491))
* **web:** show a VS Code-style shortcut list in the empty editor panel ([#112](https://github.com/zhangwanli09/difftab/issues/112)) ([69306ce](https://github.com/zhangwanli09/difftab/commit/69306ce8d23f87bd7917149d289e3d70a15866c6))


### Bug Fixes

* **web:** drop the redundant "Working tree clean" note ([#113](https://github.com/zhangwanli09/difftab/issues/113)) ([65d2713](https://github.com/zhangwanli09/difftab/commit/65d2713f3f433ba3637174c0657a4e408dce06b2))

## [0.7.0](https://github.com/zhangwanli09/difftab/compare/v0.6.0...v0.7.0) (2026-10-13)


### Features

* **web:** add a Copy file contents button to file tabs ([#106](https://github.com/zhangwanli09/difftab/issues/106)) ([5130643](https://github.com/zhangwanli09/difftab/commit/51306434ac54f28a0d76e6ab064e5b7c341667c1))
* **web:** add a side-by-side / inline toggle to diff tabs ([#107](https://github.com/zhangwanli09/difftab/issues/107)) ([5fab4dc](https://github.com/zhangwanli09/difftab/commit/5fab4dc8ad69e8bc32e5e6b1f2de797b27968d4b))
* **web:** align colors with VS Code's 2026 default themes ([#109](https://github.com/zhangwanli09/difftab/issues/109)) ([121cf21](https://github.com/zhangwanli09/difftab/commit/121cf2105ceeeb9a773d913ae2c303b346c06fab))


### Bug Fixes

* **web:** drop the hash and subject line atop commit tabs ([#105](https://github.com/zhangwanli09/difftab/issues/105)) ([e0b7ea2](https://github.com/zhangwanli09/difftab/commit/e0b7ea2c33556121d544e59690d586245404c9fa))
* **web:** put author and time on the hash line in commit tooltips ([#104](https://github.com/zhangwanli09/difftab/issues/104)) ([9840923](https://github.com/zhangwanli09/difftab/commit/984092351b21028f6e7ba9990ec961bbe86fdbbe))
* **web:** right-align ref badges in the history list ([#102](https://github.com/zhangwanli09/difftab/issues/102)) ([60f26d4](https://github.com/zhangwanli09/difftab/commit/60f26d4329a4eb5a125cf8dc973b7e7f3e1d935c))

## [0.6.0](https://github.com/zhangwanli09/difftab/compare/v0.5.5...v0.6.0) (2026-10-12)


### Features

* add Quick Open and full-repo search ([#101](https://github.com/zhangwanli09/difftab/issues/101)) ([bda89e3](https://github.com/zhangwanli09/difftab/commit/bda89e3b350db16fc2524a9760ca37ae9547952f))
* **web:** let the sidebar widen up to 960px ([#100](https://github.com/zhangwanli09/difftab/issues/100)) ([c84c985](https://github.com/zhangwanli09/difftab/commit/c84c9857dd8e15e4e6253348103ce45bd6f177fe))


### Bug Fixes

* **web:** right-align row actions on rows without a status badge ([#98](https://github.com/zhangwanli09/difftab/issues/98)) ([2afd0fa](https://github.com/zhangwanli09/difftab/commit/2afd0face47f49f595c119dead845f14537670ea))

## [0.5.5](https://github.com/zhangwanli09/difftab/compare/v0.5.4...v0.5.5) (2026-10-11)


### Bug Fixes

* **web:** show the upstream badge in History as an icon only ([#94](https://github.com/zhangwanli09/difftab/issues/94)) ([44945b3](https://github.com/zhangwanli09/difftab/commit/44945b35f79cfb9d3ae4acd6e901500d42737573))
