# QAForge 🛡️

> **Next-generation API & SQA Test Case Automation Studio for Visual Studio Code.**
> The modern, open-source alternative to Postman, Bruno, and Thunder Client with native SQL Server validation, Gherkin traceability, and AI assistance.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-0.5.0-green.svg)](https://github.com/kuzho/qaforge)

---

## ⚡ Highlights

- **📡 Complete HTTP Client**: GET, POST, PUT, DELETE, PATCH, OPTIONS with JSON, form-encoded, plain text, and binary/file uploads (3D assets, PDFs).
- **🗄️ Native T-SQL Step Execution**: Run queries against SQL Server directly inside the same execution sequence as your HTTP requests. Assert directly on `rowCount` or `rows[0].column`.
- **🔄 Auto-Retry & Polling**: Configure asynchronous retry conditions (e.g. wait until `res.body.status == 'APPROVED'`) without writing boilerplate code or manual sleep timers.
- **🔐 Enterprise Authentication**: Bearer token, Basic auth, API keys (header or query), and **OAuth 2.0 Client Credentials (Azure AD / Microsoft Online)** with automatic background token acquisition.
- **🤖 Native AI Assistant**: Integrated with VS Code Language Model API (`vscode.lm` - Copilot, Claude, Antigravity). Generate comprehensive assertions with a single click and diagnose failures in plain language.
- **🧪 Formal SQA Test Cases**: Define end-to-end test suites with Quality Objectives, Requirement Traceability IDs, Preconditions, and Gherkin Acceptance Criteria (*Given-When-Then*).
- **📋 Jira Zephyr Export**: Export test cases with steps, payloads, assertions, and Gherkin criteria directly to Jira Zephyr Scale / Squad CSV format with one click.
- **📊 Embedded Report Viewer & History**: View rich HTML Dossiers directly inside VS Code or in your browser. Search past executions with instant filtering.
- **📦 Universal Importer**: Import your existing collections and environments from Bruno or Thunder Client with automatic format detection.
- **💻 CLI for CI/CD**: Run your suites headless in Jenkins, GitHub Actions, or Azure Pipelines producing JUnit XML, JSON, and HTML reports.

---

## 🚀 Quick Start

### 1. Create or Import a Collection
- Click the **QAForge** icon in the Activity Bar.
- Click **QAForge: New Collection** or click the **Import** button (☁️) to import your existing collections.

### 2. Send Requests & Generate Assertions with AI
- Open any request, select your HTTP method and enter the URL.
- Use `{{variableName}}` syntax anywhere (URL, headers, body, auth).
- Click **Send** (`Ctrl + Enter`).
- In the response section, click **✨ AI Assertions** to automatically inspect the payload and populate visual assertions.

### 3. Add SQL Validation Steps
- Right-click any folder and select **New SQL Step**.
- Configure connection details (server, database, credentials) and your T-SQL query:
  ```sql
  SELECT order_number, state_name FROM PROCESS_ORDER WHERE order_number = '{{so}}'
  ```
- Assert directly: `body rows[0].state_name eq "Ready"`.

### 4. Run End-to-End Test Cases
- Navigate to the **Test Cases** panel.
- Create or run formal test cases chaining API calls, uploads, and database checks.
- View execution progress live in the **Variables (Live Inspector)** and review test logs in the **Execution Reports (History)** panel.

---

## 🧩 Variables & Dynamic Helpers

QAForge supports cascaded variable resolution:
1. **Runtime variables**: Live variables captured across requests (`{{token}}`, `{{orderId}}`).
2. **Environment variables**: Configured in `.qaforge/environments/<Name>.json`.
3. **Global variables**: Configured in `.qaforge/globals.json`.
4. **Protected Secrets**: Sensitive passwords and keys stored securely in VS Code `SecretStorage`.
5. **System Helpers**:
   - `{{$guid}}` or `{{$uuid}}`: Generates unique v4 UUID.
   - `{{$timestamp}}`: Current Unix epoch in ms.
   - `{{$isoTimestamp}}`: Current ISO 8601 string.
   - `{{$randomInt}}`: Random 6-digit integer.
   - `{{$env.NAME}}`: Reads environment variable from OS process.

---

## 🛠️ CLI Execution (CI/CD)

Run headless test suites directly from your terminal or CI pipeline:

```bash
# Run all test cases in the workspace
node dist/cli.js run

# Run a specific test case with an environment
node dist/cli.js run TC-001 -e "Production"

# Run data-driven with CSV rows
node dist/cli.js run TC-001 -e "QAS" --data ./orders.csv -f junit,html
```

---

## 📄 License

MIT © [kuzho](https://github.com/kuzho)

