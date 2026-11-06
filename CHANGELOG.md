# Changelog







All notable changes to the **QAForge** extension will be documented in this file.







The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),



and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).







---

## [0.7.0] - 2026-11-05

### Added
- **High-Fidelity Executive HTML Dossiers Across All Executions**:
  - Every execution scope (individual request panel runs, single steps, partial steps, test cases, grouped test folders, and full collections) produces a complete, rich HTML report archived in `.qaforge/reports/`.
  - Comprehensive request details: HTTP method badges, resolved endpoints/targets, outgoing request headers, and full request body payloads (with JSON syntax highlighting and binary indicators).
  - Comprehensive response details: incoming response headers, HTTP status badges, duration, formatted JSON syntax highlighting, interactive sortable SQL tables, and preformatted blocks.
  - Granular assertion breakdowns with pass/fail badges, expected vs actual values, and prominent error banners.
  - Complete execution logs preserved per step.
  - Interactive executive toolbar: Real-time search filter, verdict filters (All / Passed / Failed), and Expand / Collapse All controls.
- **Hierarchical Cascading Execution for Grouped Test Cases**:
  - Subfolder and group hierarchies under `.qaforge/testcases` are now indexed into the Test Explorer and QAForge tree.
  - Running a folder or group automatically cascades and runs all nested test cases in sequence.
  - Inline run action added to test case and collection tree nodes for instant execution.

---

## [0.6.0] - 2025-07-14







### Fixed



- **Relative file path resolution**: Binary/file upload steps using `./testfiles/` paths now resolve correctly relative to the `.qaforge/` workspace root instead of `process.cwd()`. Fixes failures when the extension is launched from a different working directory.







### Added

- **Interactive Parameter Source Selection on Zephyr Export**:
  - When exporting test cases to Jira Zephyr Scale (XML or CSV), QAForge now prompts the tester to choose the parameter resolution strategy:
    1. **As defined in Test Case (Default parameters)**: Uses the test case parameter defaults directly, automatically falling back to active environment values for empty or placeholder definitions (e.g. `[Place PID]`).
    2. **From Active Environment: `<name>`**: Populates test case parameters using concrete runtime variables from the currently selected VS Code environment (e.g. `PALATAL_EXPANDER` for IPE test cases).
    3. **Choose another Environment...**: Allows selecting any configured environment in the workspace to inject into the exported test parameters.
  - Automatically resolves dynamic parameter expressions like `{{PID}}-{{SO}}` into concrete values upon export.

- **Save Report As... Direct Export (`qaforge.saveReportAs`)**:
  - Right-click any report item in the Execution Reports sidebar (or click the inline `$(save-as)` action icon) to save a copy directly to any folder location without having to open the report tab first.
  - Supports saving as HTML report (`.html`), JSON result dossier (`.json`), or JUnit XML (`.xml`). Also available on group folders to quickly save the latest execution report.

- **Hierarchical Report Organization by Entity Architecture**:
  - Execution history is now automatically categorized on disk into dedicated entity directories: `history/testcases/<testcase-id>/`, `history/collections/<collection-name>/`, and `history/suites/<suite-name>/`.
  - The Execution Reports sidebar now presents runs grouped cleanly by Test Case or Collection with badge counts (`Test Case · 3 runs`) and collapsible run history, while retaining backward compatibility with legacy flat report files.

- **Simplified Sidebar View Names**:
  - Streamlined view titles: renamed `Variables (Live Inspector)` to **`Variables`**, and `Execution Reports (History)` to **`Execution Reports`**.




- **Step-by-Step Test Case Execution & Interactive Debugger**:



  - **Hierarchical Test Case Tree**: Test cases in the sidebar can now be expanded to inspect each individual step (`[Cloud API]`, `[SQL Server]`, `[Filesystem]`, `[Manual]`), with step icons and direct links to step request definitions.



  - **Inline Single-Step Runner (`Run Step`)**: Run any individual step in isolation while retaining active environment variables, test case definitions, and current live runtime memory (`{{PID}}`, `{{SO}}`, `{{versionId}}`).



  - **Interactive Step Debugger (`qaforge.stepTestCase`)**: Step through complex E2E orchestrations one step at a time with interactive controls: **Execute Step**, **Retry Step** (re-run failed/waiting steps without restarting the entire suite), **Skip Step**, **Run Remaining Steps**, and live variable inspection.



  - **Run From Here (`qaforge.runFromStep`)**: Right-click any step in a test case to resume execution from that step onward without repeating completed prerequisite steps.



  - **Real-Time Live Variable Synchronization**: Step execution immediately updates the `Variables (Live Inspector)` sidebar so captured tokens, IDs, and filenames are visible in real time.



- **Native Simulator & File Drop Steps (`kind: "fileDrop"`)**:

  - Declarative step type to write order JSON files directly into simulator folders (e.g. Mule UNC shares `Z:\MX2\QAS\FAB\in_multi\`).

  - Automatic envelope wrapping: wraps into standard MES `transferMESOrders` (TMO) envelopes for multi-order inboxes.

  - Automatic lot and event generation: computes valid 9-digit lot numbers, event IDs, and auto-injects `PatientId`, `VIPOrderId`, and `TX_PLAN_VER_ID_U`.

  - Exposes output metadata to standard assertions and automatically captures `mule_filename`, `lot`, and `eventId`.

- **Persistent SQL Connection Pooling (Sub-50ms Polling Speed)**:

  - Cached connection pools per database/host/credentials reuse warm TCP sockets across queries and polling intervals.

  - Slashes polling latency from ~800ms down to <50ms per poll cycle.

  - Automatic connection recovery and graceful shutdown on environment change.

- **Environment Health Check & Diagnostics (`qaforge.checkEnvironment`)**:

  - One-click health check tool (`$(pulse)`) validating end-to-end connectivity:

    - **Cloud APIs**: Validates HTTP status and network round-trip time for all endpoints.

    - **SQL Server**: Validates TCP connection, database version, and login credentials.

    - **Network Shares**: Validates existence and read/write permissions on simulator inboxes (`\\prdmx2data11\...`).

    - **Variables Integrity**: Flags missing values or unconfigured template placeholders (`[Place PID]`).

- **Environment Drift & Difference Detector (`qaforge.compareEnvironments`)**:

  - Visual side-by-side comparison between environments (`$(diff)`), flagging mismatched database hostnames, drifting API URLs, and missing configuration keys.

- **Direct Jira Zephyr Scale API Integration (`qaforge.publishZephyr`)**:

  - Push automated test results directly to Jira Zephyr Scale via REST API (`$(cloud-upload)`).

  - Automatically creates/appends to Test Cycles, records test case execution statuses (`Pass`/`Fail`), logs duration, and returns direct Jira web links.

- **Quick Test Case Authoring (`qaforge.addStepToTestCase`)**:

  - Right-click any request in Collections -> **Add Request to Test Case...** to instantly append it to an existing test case with architecture layer tags.

- **AI-Powered Automated Step Healing (`aiProposeFix`)**:

  - AI analysis generates patch proposals for failed steps (correcting missing query parameters, malformed JSON bodies, or SQL syntax).

- **`__qaforgeRoot` runtime variable**: Automatically injected at test case execution time — no environment configuration needed. Used internally for portable path resolution.



- **`environments` field on Test Case**: `TestCaseDef` now supports an optional `environments` array to document the target environments for a test case (groundwork for future auto-selection).



- **Run notification**: Extension now shows an information message when a test case starts running ("QAForge ▶ Running: TC-XXX [env]…") so you don't have to switch to the Testing panel to confirm execution started.



- **Response Body always visible in reports**: Each step card in the HTML report now shows the response body inline (dark theme, always expanded) instead of behind a collapsible. Logs remain collapsible. Headers/status are secondary metadata.







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







