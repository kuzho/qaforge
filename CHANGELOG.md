# Changelog

All notable changes to the **QAForge** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.5.0] - 2026-11-01

### Added
- **Jira Zephyr Scale & Zephyr Squad Export**:
  - Export QAForge SQA Test Cases directly to standard Zephyr CSV format.
  - Full traceability mapping: Test Case Key, Title, Quality Objective, Preconditions, Gherkin BDD Acceptance Criteria (*Given-When-Then*), Priority, Status, Folder, Labels, and linked Jira Requirement Tickets (`Issue Links`).
  - Automatic extraction of step details: Architecture layer (`[Cloud API]`, `[SQL Server]`, etc.), HTTP method & URL, SQL queries, request payload data, and expected assertions list.
  - Windows Microsoft Excel compatibility with automatic UTF-8 BOM encoding.
- **VS Code UI Actions for Zephyr Export**:
  - Added `$(export)` title-bar button on the **Test Cases** view to export all workspace test cases with one click.
  - Added right-click context menu item on individual test cases: **Export to Zephyr (CSV)**.
  - Interactive save dialog with default path `.qaforge/zephyr_testcases.csv` and notifications with **Open CSV** and **Reveal in Explorer** shortcuts.
- **Headless CLI Command**:
  - Added `qaforge export-zephyr [targets...] [-o output.csv]` for automated CI/CD and release pipelines.

### Changed
- Refined activity bar icon to minimalist anvil/forge outline geometry for seamless theme integration.
- Updated high-resolution 512x512 geometric Q branding for extension marketplace display.

---

## [0.4.0] - 2026-11-01

### Added
- High-resolution SVG vector branding and transparent 512x512 assets.
- Improved live environment synchronization across all open request panels.
- Variable inspector enhancements: full rename and value modification support.

### Changed
- Optimized bundle packaging and tree view refresh performance.

---

## [0.3.0] - 2026-11-01

### Added
- Initial public release of **QAForge**: Next-generation API & SQA Automation Studio.
- Full HTTP client supporting JSON, forms, text, and binary/file uploads.
- Native T-SQL execution with connection pooling and response payload formatting.
- Cascaded variable interpolation (`runtime` -> `environment` -> `global` -> `secrets`) and dynamic helpers (`{{$guid}}`, `{{$timestamp}}`, `{{$randomInt}}`, `{{$env.VAR}}`).
- Auto-retry and polling for asynchronous states.
- Universal collection and environment importer (Bruno and Thunder Client support).
- Formal SQA test cases with Gherkin acceptance criteria, quality goals, and requirement traceability.
- AI Assistant integration via `vscode.lm` for auto-generating assertions and plain-language failure diagnostics.
- Embedded Report Viewer inside VS Code with external browser launch.
- Live Variables Inspector tree view and filterable Execution Reports history tree view.
- Headless CLI runner (`qaforge run`) supporting HTML, JUnit XML, and JSON reports.

